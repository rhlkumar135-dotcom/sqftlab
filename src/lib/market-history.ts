import { prisma } from './db'

/**
 * Market history: the two records of "how did we get here", kept deliberately apart
 * because they answer different questions and have very different reliability.
 *
 *  1. Daily snapshots (`market_snapshots`) — point-in-time metrics captured on every
 *     refresh. They only exist from the day the snapshot job was switched on, and they
 *     grow by one row per community per day. This is the reliable series going forward.
 *
 *  2. Listing supply (`listings.listed_at`) — the portal's own "first listed" date, which
 *     reaches back ~21 months. This is genuine history the portal recorded, not something
 *     we derived, but it is a *cohort* view rather than a market series: a listing carries
 *     the asking price it has TODAY, so bucketing by listed month answers "what are people
 *     who listed in month X asking now?", not "what was the market asking in month X?".
 *     The counts, by contrast, are a clean supply history. The distinction is carried into
 *     the response as `basis` so no caller can accidentally present one as the other.
 */

/**
 * The UAE calendar day (UTC+4) as YYYY-MM-DD.
 *
 * Grouping on a UTC instant would split a single Dubai evening across two rows, and the
 * UAE works a Sun–Thu week, so "today" has to mean the local day rather than the UTC one.
 */
export function uaeDay(at: Date = new Date()): string {
  const shifted = new Date(at.getTime() + 4 * 60 * 60 * 1000)
  return shifted.toISOString().substring(0, 10)
}

export interface CaptureResult {
  period: string
  communities: number
}

/**
 * Capture today's snapshot for every community.
 *
 * Idempotent by design: the unique key is (communityId, period), so running this again
 * later the same day updates that day's row in place — which is what makes the newest
 * refresh always win — while rows for earlier days are never touched. That is the whole
 * mechanism: "latest" is the mutable edge, everything behind it is immutable.
 *
 * Reads the community's already-computed columns rather than recomputing, so the snapshot
 * can never disagree with what the site was actually showing at that moment.
 */
export async function captureMarketSnapshot(at: Date = new Date()): Promise<CaptureResult> {
  const period = uaeDay(at)

  const [communities, saleCounts, rentCounts] = await Promise.all([
    prisma.community.findMany({
      select: {
        id: true,
        emirate: true,
        medianAedSqft: true,
        medianAnnualRentAed: true,
        grossYieldPct: true,
        psfSource: true,
      },
    }),
    prisma.listing.groupBy({
      by: ['communityId'],
      where: { purpose: 'sale' },
      _count: { _all: true },
    }),
    prisma.listing.groupBy({
      by: ['communityId'],
      where: { purpose: 'rent' },
      _count: { _all: true },
    }),
  ])

  const saleMap = new Map(saleCounts.map((r) => [r.communityId, r._count._all]))
  const rentMap = new Map(rentCounts.map((r) => [r.communityId, r._count._all]))

  if (communities.length === 0) return { period, communities: 0 }

  await prisma.$transaction(
    communities.map((cm) => {
      const capture = {
        emirate: cm.emirate,
        medianPsf: cm.medianAedSqft,
        medianRentAed: cm.medianAnnualRentAed,
        grossYieldPct: cm.grossYieldPct,
        psfSource: cm.psfSource,
        saleCount: saleMap.get(cm.id) ?? 0,
        rentCount: rentMap.get(cm.id) ?? 0,
        capturedAt: at,
      }
      return prisma.marketSnapshot.upsert({
        where: { communityId_period: { communityId: cm.id, period } },
        create: { communityId: cm.id, period, ...capture },
        update: capture,
      })
    })
  )

  return { period, communities: communities.length }
}

export interface MarketSnapshotRow {
  period: string
  emirate: string
  medianPsf: number
  psfSource: string
  saleCount: number
  rentCount: number
}

export interface DailyPoint {
  period: string
  districts: number
  medianPsf: number | null
  saleListings: number
  rentListings: number
  /** Districts whose PSF that day came from registered transactions rather than asking prices. */
  registerBacked: number
  /** Days the register-backed count rose past zero, so a reader can see the switch happen. */
  psfSource: string
}

/**
 * Collapse per-community rows into one market series.
 *
 * The market figure is an inventory-weighted mean of the district medians, not a median of
 * medians: districts hold wildly different listing counts, so an unweighted mean would let a
 * 3-listing district move the market as much as a 600-listing one. Weighting by `saleCount`
 * keeps the number tied to where the supply actually is.
 */
function toDailySeries(rows: MarketSnapshotRow[]): DailyPoint[] {
  const byDay = new Map<string, MarketSnapshotRow[]>()
  for (const r of rows) {
    const bucket = byDay.get(r.period)
    if (bucket) bucket.push(r)
    else byDay.set(r.period, [r])
  }

  return [...byDay.entries()]
    .map(([period, day]) => {
      let weighted = 0
      let weight = 0
      let saleListings = 0
      let rentListings = 0
      let registerBacked = 0
      const sources = new Set<string>()
      for (const r of day) {
        saleListings += r.saleCount
        rentListings += r.rentCount
        if (r.psfSource === 'dld') registerBacked++
        if (r.medianPsf > 0) sources.add(r.psfSource)
        if (r.medianPsf > 0 && r.saleCount > 0) {
          weighted += r.medianPsf * r.saleCount
          weight += r.saleCount
        }
      }
      return {
        period,
        districts: day.length,
        medianPsf: weight > 0 ? Math.round(weighted / weight) : null,
        saleListings,
        rentListings,
        registerBacked,
        // 'dld' only when a register actually backed every sourced district — otherwise the
        // series is asking prices and saying 'dld' would claim a government source it lacks.
        psfSource:
          sources.size === 0
            ? 'none'
            : sources.size === 1
              ? [...sources][0]
              : 'mixed',
      }
    })
    .sort((a, b) => a.period.localeCompare(b.period))
}

export interface HistoryResult {
  /** UAE day the snapshot job was first able to record — history before this does not exist. */
  firstPeriod: string | null
  lastPeriod: string | null
  daysRecorded: number
  daily: DailyPoint[]
  supply: SupplyPoint[]
  asOf: string
}

export interface SupplyPoint {
  month: string
  listings: number
  sale: number
  rent: number
  /** Median asking PSF of sale listings whose portal "first listed" date falls in this month. */
  medianAskingPsf: number | null
  /** Median asking annual rent of rent listings first listed in this month. */
  medianAskingRentAed: number | null
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return Math.round(
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  )
}

/**
 * Monthly supply history straight from the portal's own "first listed" timestamps.
 *
 * Fetched row-wise and bucketed in JS rather than with a SQL `substr(listed_at, 1, 7)`:
 * that expression works on SQLite where the column is ISO text, but Postgres holds a real
 * `timestamp` and it would fail there — and this schema is deployed to Postgres.
 */
export async function loadSupplyHistory(emirate?: string): Promise<SupplyPoint[]> {
  const listings = await prisma.listing.findMany({
    where: emirate ? { community: { emirate } } : undefined,
    select: { listedAt: true, pricePerSqft: true, priceAed: true, purpose: true },
  })

  const byMonth = new Map<string, { sale: number; rent: number; psfs: number[]; rents: number[] }>()
  for (const l of listings) {
    const month = l.listedAt.toISOString().substring(0, 7)
    const bucket = byMonth.get(month) ?? { sale: 0, rent: 0, psfs: [], rents: [] }
    if (l.purpose === 'sale') {
      bucket.sale++
      if (l.pricePerSqft > 0) bucket.psfs.push(l.pricePerSqft)
    } else if (l.purpose === 'rent') {
      bucket.rent++
      if (l.priceAed > 0) bucket.rents.push(l.priceAed)
    }
    byMonth.set(month, bucket)
  }

  return [...byMonth.entries()]
    .map(([month, b]) => ({
      month,
      listings: b.sale + b.rent,
      sale: b.sale,
      rent: b.rent,
      medianAskingPsf: median(b.psfs),
      medianAskingRentAed: median(b.rents),
    }))
    .sort((a, b) => a.month.localeCompare(b.month))
}

/** Everything the history surface needs, in one round trip. */
export async function loadMarketHistory(opts: {
  days?: number
  emirate?: string
} = {}): Promise<HistoryResult> {
  const days = Math.min(Math.max(opts.days ?? 90, 1), 3650)
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const rows = (await prisma.marketSnapshot.findMany({
    where: {
      period: { gte: uaeDay(since) },
      ...(opts.emirate ? { emirate: opts.emirate } : {}),
    },
    select: {
      period: true,
      emirate: true,
      medianPsf: true,
      psfSource: true,
      saleCount: true,
      rentCount: true,
    },
    orderBy: { period: 'asc' },
  })) as MarketSnapshotRow[]

  const daily = toDailySeries(rows)
  const periods = [...new Set(rows.map((r) => r.period))].sort()

  return {
    firstPeriod: periods[0] ?? null,
    lastPeriod: periods[periods.length - 1] ?? null,
    daysRecorded: periods.length,
    daily,
    supply: await loadSupplyHistory(opts.emirate),
    asOf: new Date().toISOString(),
  }
}
