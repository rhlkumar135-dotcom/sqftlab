import { prisma } from './db'
import { SALE_TXN_TYPES } from './deals'
import { findCommunityByName } from './community-match'

/**
 * Developer positioning + building scorecard (Day 10).
 *
 * Every entity this module reads is empty in this deployment — `transactions` has
 * no rows, `building_profiles` has none, and `Listing` carries no `buildingName`
 * column at all, so there is no building-level fallback either. The endpoints are
 * written against the real schema so they answer correctly the moment the DLD
 * register is ingested, and until then they say so instead of inventing a market.
 *
 * The brief would not have said so. Three of its lines manufacture confidence from
 * an empty database, and they are corrected here because each one renders as a
 * specific, believable, wrong sentence:
 *
 * 1. `percentile` — `psfs.length > 0 ? ... : 50` reports the 50th percentile when
 *    there are no comparables at all. A launch handed "50th percentile" reads as
 *    the middle of a real market; `null` is the honest answer and the UI says so.
 * 2. `positioning.pctVsMarket` — `marketPsf > 0 ? ... : 0` reports exactly at-market
 *    when the market is empty, and `verdict` then prints "At-market — aligned with
 *    recent DLD transactions" with zero transactions behind it.
 * 3. The floor breakdown divides by `psfs.length` without checking it, so a floor
 *    range whose every transaction has a null PSF yields `NaN`, which serialises to
 *    `null` mid-object rather than being omitted.
 *
 * Field names are also the brief's, not the schema's: `Transaction.bedrooms` is
 * `beds`, `size` is `areaSqft`, `amount` is `priceAed`, `pricePsf` is `pricePerSqft`,
 * `floor` is `floorNumber`, and `mode: 'insensitive'` is Postgres-only and throws on
 * SQLite. `BuildingProfile` has no `slug`, `name`, `yearBuilt`, `totalUnits`,
 * `managementCo`, `serviceCharge` or `completionStatus` — its real fields are used
 * below instead.
 */

/** The schema's canonical slug for a building name. Also the URL key. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Resolve a URL slug back to a building name.
 *
 * `BuildingProfile` has no slug column and SQLite has no case-insensitive
 * `contains`, so matching happens in JS against the distinct names actually
 * stored. That keeps the slug stable for any name and avoids the brief's
 * `{ name: { equals, mode: 'insensitive' } }`, which throws on this database.
 *
 * Returns the stored spelling, which is what the exact-match queries need — the
 * URL slug and the stored name differ in case and punctuation for almost every
 * real building ("marina-gate-1" vs "Marina Gate 1").
 */
/**
 * The profile columns this module reads, in one place so the row type below is
 * derived from the query rather than hand-written. A `select` narrows the row, so a
 * type taken from an unselected `findMany` would not be assignable to it.
 */
async function loadBuildingProfiles() {
  return prisma.buildingProfile.findMany({
    select: {
      buildingNameEn: true,
      communityEn: true,
      district: true,
      totalDldUnits: true,
      psfTrend3m: true,
      psfTrend12m: true,
      psfVsCommunity: true,
      psfVsDistrict: true,
      avgDaysToResale: true,
      liquidityScore: true,
      transactionCount12m: true,
      ownerOccupierRatio: true,
      buyerHoldRate: true,
      ejariDensity: true,
      avgContractedRent: true,
      floorPremiumPct: true,
      floorPremiumSamples: true,
      floorPremiumR2: true,
      intelligenceScore: true,
    },
  })
}

export type BuildingProfileRow = Awaited<ReturnType<typeof loadBuildingProfiles>>[number]

export async function resolveBuilding(
  slugOrName: string,
): Promise<{ name: string; profile: BuildingProfileRow | null; source: 'profile' | 'transaction' | 'none' }> {
  const target = slugify(slugOrName)

  const profiles = await loadBuildingProfiles()

  const hit = profiles.find((p) => slugify(p.buildingNameEn) === target)
  if (hit) return { name: hit.buildingNameEn, profile: hit, source: 'profile' }

  // Fall back to names present on the transaction register, so a building can be
  // looked up before its profile row has been computed.
  const txNames = await distinctTransactionBuildings()
  const txHit = txNames.find((n) => slugify(n) === target)
  if (txHit) return { name: txHit, profile: null, source: 'transaction' }

  return { name: slugOrName.replace(/-/g, ' '), profile: null, source: 'none' }
}

/** Distinct non-null building names on the transaction register. */
export async function distinctTransactionBuildings(): Promise<string[]> {
  const rows = await prisma.transaction.findMany({
    where: { buildingName: { not: null } },
    select: { buildingName: true },
    distinct: ['buildingName'],
  })
  return rows.map((r) => r.buildingName).filter((n): n is string => !!n)
}

export interface BuildingSearchResult {
  name: string
  slug: string
  community: string | null
  source: 'profile' | 'transaction'
}

/**
 * Type-ahead over stored building names.
 *
 * Matching is a JS `includes` on the lowercased name rather than a SQL `contains`,
 * for the same reason as `resolveBuilding` — and it means a query like "gate 1"
 * finds "Marina Gate 1", which a prefix-only SQL match would miss.
 */
export async function searchBuildings(q: string, limit = 10): Promise<BuildingSearchResult[]> {
  const needle = q.trim().toLowerCase()
  if (needle.length < 2) return []

  const [profiles, txNames] = await Promise.all([
    prisma.buildingProfile.findMany({ select: { buildingNameEn: true, communityEn: true } }),
    distinctTransactionBuildings(),
  ])

  const out = new Map<string, BuildingSearchResult>()
  for (const p of profiles) {
    if (p.buildingNameEn.toLowerCase().includes(needle)) {
      out.set(slugify(p.buildingNameEn), {
        name: p.buildingNameEn,
        slug: slugify(p.buildingNameEn),
        community: p.communityEn,
        source: 'profile',
      })
    }
  }
  for (const n of txNames) {
    const slug = slugify(n)
    if (!out.has(slug) && n.toLowerCase().includes(needle)) {
      out.set(slug, { name: n, slug, community: null, source: 'transaction' })
    }
  }

  return [...out.values()].slice(0, limit)
}

export interface BuildingScorecard {
  buildingName: string
  slug: string
  matched: 'profile' | 'transaction' | 'none'
  community: string | null
  district: string | null
  profile: {
    totalDldUnits: number | null
    intelligenceScore: number | null
    liquidityScore: number | null
    transactionCount12m: number | null
    avgDaysToResale: number | null
    ownerOccupierRatio: number | null
    buyerHoldRate: number | null
    ejariDensity: number | null
    avgContractedRent: number | null
    psfTrend3m: number | null
    psfTrend12m: number | null
    psfVsCommunity: number | null
    psfVsDistrict: number | null
  } | null
  stats: {
    transactions: number
    medianPsfAed: number | null
    avgPsfAed: number | null
    period: string
  }
  recentTransactions: Array<{
    date: string
    beds: number
    areaSqft: number
    pricePerSqft: number | null
    priceAed: number
    floorNumber: number | null
  }>
  floorBreakdown: FloorRange[] | null
  floorPremium: { pct: number | null; samples: number | null; r2: number | null } | null
  floorBreakdownLocked: boolean
  source: 'dld_transactions' | 'none'
  methodology: string
  computedAt: string
  insufficientData?: boolean
  reason?: string
}

export interface FloorRange {
  range: string
  avgPsfAed: number | null
  count: number
}

export const FLOOR_RANGES: Array<{ range: string; test: (floor: number) => boolean }> = [
  { range: 'Low (1–5)', test: (f) => f <= 5 },
  { range: 'Mid (6–15)', test: (f) => f > 5 && f <= 15 },
  { range: 'High (16+)', test: (f) => f > 15 },
]

/** Median of a numeric list, or null when empty. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Group PSFs into floor bands.
 *
 * A band with no priced transactions reports `avgPsfAed: null`, not `NaN`. The
 * brief divides unconditionally, and `NaN` survives `JSON.stringify` as `null`
 * only because of how the value is boxed — leaving a band that looks priced.
 */
export function floorBreakdownFrom(
  rows: Array<{ floorNumber: number | null; pricePerSqft: number | null }>,
): FloorRange[] {
  return FLOOR_RANGES.map(({ range, test }) => {
    const psfs = rows
      .filter((r) => test(r.floorNumber ?? 0) && r.pricePerSqft != null && r.pricePerSqft > 0)
      .map((r) => r.pricePerSqft as number)
    return {
      range,
      avgPsfAed: psfs.length ? Math.round(psfs.reduce((s, v) => s + v, 0) / psfs.length) : null,
      count: psfs.length,
    }
  })
}

const SCORECARD_METHODOLOGY =
  'Median and range of DLD registered sale prices per square foot over the period, ' +
  'filtered to sales above AED 100/sqft to exclude non-market registrations ' +
  '(gifts, transfers between related parties).'

export async function getBuildingScorecard(
  slugOrName: string,
  opts: { includeFloorBreakdown: boolean; days?: number },
): Promise<BuildingScorecard> {
  const days = opts.days ?? 180
  const since = new Date()
  since.setDate(since.getDate() - days)

  const resolved = await resolveBuilding(slugOrName)
  const base = {
    buildingName: resolved.name,
    slug: slugify(resolved.name),
    matched: resolved.source,
    community: resolved.profile?.communityEn ?? null,
    district: resolved.profile?.district ?? null,
    periodDays: days,
  }

  const profile = resolved.profile
    ? {
        totalDldUnits: resolved.profile.totalDldUnits,
        intelligenceScore: resolved.profile.intelligenceScore,
        liquidityScore: resolved.profile.liquidityScore,
        transactionCount12m: resolved.profile.transactionCount12m,
        avgDaysToResale: resolved.profile.avgDaysToResale,
        ownerOccupierRatio: resolved.profile.ownerOccupierRatio,
        buyerHoldRate: resolved.profile.buyerHoldRate,
        ejariDensity: resolved.profile.ejariDensity,
        avgContractedRent: resolved.profile.avgContractedRent,
        psfTrend3m: resolved.profile.psfTrend3m,
        psfTrend12m: resolved.profile.psfTrend12m,
        psfVsCommunity: resolved.profile.psfVsCommunity,
        psfVsDistrict: resolved.profile.psfVsDistrict,
      }
    : null

  const floorPremium = resolved.profile
    ? {
        pct: resolved.profile.floorPremiumPct,
        samples: resolved.profile.floorPremiumSamples,
        r2: resolved.profile.floorPremiumR2,
      }
    : null

  const computedAt = new Date().toISOString()

  if (resolved.source === 'none') {
    return {
      ...base,
      profile: null,
      stats: { transactions: 0, medianPsfAed: null, avgPsfAed: null, period: `${days} days` },
      recentTransactions: [],
      floorBreakdown: null,
      floorPremium: null,
      // Reflects entitlement, not data availability: an Enterprise caller is not
      // locked out of floor data just because this building has none, and the UI
      // keys its blur off this flag.
      floorBreakdownLocked: !opts.includeFloorBreakdown,
      source: 'none',
      methodology: SCORECARD_METHODOLOGY,
      computedAt,
      insufficientData: true,
      reason:
        `No building named "${slugOrName.replace(/-/g, ' ')}" exists in this dataset, and no ` +
        'DLD transactions are loaded to derive one from. Nothing is shown rather than an ' +
        'empty scorecard that would read as a building with no sales.',
    }
  }

  // Exact match on the resolved stored spelling: `mode: 'insensitive'` is not
  // available here, and the stored value is what we just resolved to.
  //
  // `pricePerSqft > 100` is part of the methodology stated below, not an optional
  // narrowing: without it a AED 50/sqft transfer between related parties lands in the
  // median and the published methodology becomes false.
  const rows = await prisma.transaction.findMany({
    where: {
      buildingName: resolved.name,
      transactionType: { in: [...SALE_TXN_TYPES] },
      pricePerSqft: { gt: 100 },
      transactionDate: { gte: since },
    },
    select: {
      transactionDate: true,
      pricePerSqft: true,
      priceAed: true,
      areaSqft: true,
      beds: true,
      floorNumber: true,
    },
    orderBy: { transactionDate: 'desc' },
    take: 100,
  })

  const psfs = rows.map((r) => r.pricePerSqft).filter((p): p is number => p != null && p > 0)
  const stats = {
    transactions: rows.length,
    medianPsfAed: median(psfs) == null ? null : Math.round(median(psfs) as number),
    avgPsfAed: psfs.length ? Math.round(psfs.reduce((s, v) => s + v, 0) / psfs.length) : null,
    period: `${days} days`,
  }

  const recentTransactions = rows.slice(0, 20).map((r) => ({
    date: r.transactionDate.toISOString().slice(0, 10),
    beds: r.beds,
    areaSqft: r.areaSqft,
    pricePerSqft: r.pricePerSqft == null ? null : Math.round(r.pricePerSqft),
    priceAed: Math.round(r.priceAed),
    floorNumber: r.floorNumber,
  }))

  const noSales = rows.length === 0

  return {
    ...base,
    profile,
    stats,
    recentTransactions,
    // Gated server-side, not just blurred in CSS: a locked field must not be in
    // the payload, or the blur is decoration over data the caller already has.
    floorBreakdown: opts.includeFloorBreakdown && !noSales ? floorBreakdownFrom(rows) : null,
    floorPremium: opts.includeFloorBreakdown ? floorPremium : null,
    floorBreakdownLocked: !opts.includeFloorBreakdown,
    source: noSales ? 'none' : 'dld_transactions',
    methodology: SCORECARD_METHODOLOGY,
    computedAt,
    ...(noSales
      ? {
          insufficientData: true,
          reason:
            `No DLD sales are registered against ${resolved.name} in the last ${days} days, ` +
            'so no price per square foot can be reported.',
        }
      : {}),
  }
}

// ─── Developer positioning ───────────────────────────────────────────────────

export interface DeveloperPositionInput {
  projectName: string
  area: string
  beds: number
  launchPsfAed: number
  launchDate?: string | null
  compareMonths?: number
}

export interface DeveloperPositionResult {
  project: string
  area: string
  community: string | null
  beds: number
  launchPsfAed: number
  period: string
  dldComparables: number
  market: { avgPsfAed: number | null; minPsfAed: number | null; maxPsfAed: number | null } | null
  positioning: { pctVsMarket: number | null; percentile: number | null; verdict: string }
  demand: {
    transactions: number
    volumeTrendPct: number | null
    demandSignal: 'Rising' | 'Stable' | 'Declining' | 'Unknown'
  }
  methodology: string
  computedAt: string
  insufficientData?: boolean
  reason?: string
}

const MIN_COMPARABLES = 5

/** Position a launch price against registered sales in the same micro-market. */
export async function computeDeveloperPositioning(
  input: DeveloperPositionInput,
): Promise<DeveloperPositionResult> {
  const months = input.compareMonths ?? 6
  const since = new Date()
  since.setMonth(since.getMonth() - months)
  const prevSince = new Date()
  prevSince.setMonth(prevSince.getMonth() - months * 2)

  const community = await findCommunityByName(input.area)

  const base = {
    project: input.projectName,
    area: input.area,
    community: community?.nameEn ?? null,
    beds: input.beds,
    launchPsfAed: input.launchPsfAed,
    period: `${months} months`,
    computedAt: new Date().toISOString(),
    methodology:
      `Compares the launch price against DLD registered sales of the same bedroom count ` +
      `in this micro-market over the trailing ${months} months, filtered to sales above ` +
      'AED 100/sqft. Percentile is the share of registered comparables at or below the ' +
      'launch price.',
  }

  if (!community) {
    return {
      ...base,
      dldComparables: 0,
      market: null,
      positioning: { pctVsMarket: null, percentile: null, verdict: 'No comparable market' },
      demand: { transactions: 0, volumeTrendPct: null, demandSignal: 'Unknown' },
      insufficientData: true,
      reason: `"${input.area}" does not match any community in this dataset, so there is no micro-market to compare against.`,
    }
  }

  const where = {
    communityId: community.id,
    beds: input.beds,
    transactionType: { in: [...SALE_TXN_TYPES] },
    pricePerSqft: { gt: 100 },
    transactionDate: { gte: since },
  }

  const [agg, prevCount, psfRows] = await Promise.all([
    prisma.transaction.aggregate({
      where,
      _avg: { pricePerSqft: true },
      _min: { pricePerSqft: true },
      _max: { pricePerSqft: true },
      _count: { _all: true },
    }),
    prisma.transaction.count({
      where: { ...where, transactionDate: { gte: prevSince, lt: since } },
    }),
    prisma.transaction.findMany({
      where,
      select: { pricePerSqft: true },
      orderBy: { pricePerSqft: 'asc' },
    }),
  ])

  const comparables = agg._count._all
  const psfs = psfRows.map((r) => r.pricePerSqft).filter((p): p is number => p != null)

  // Below the sample floor there is no market read to give. Everything that
  // follows would otherwise be arithmetic on one or two sales presented as a
  // micro-market — so the numbers stop here and the reason is stated.
  if (comparables < MIN_COMPARABLES || psfs.length === 0) {
    return {
      ...base,
      dldComparables: comparables,
      market: null,
      positioning: { pctVsMarket: null, percentile: null, verdict: 'Insufficient comparables' },
      demand: { transactions: comparables, volumeTrendPct: null, demandSignal: 'Unknown' },
      insufficientData: true,
      reason:
        `Only ${comparables} registered DLD sale${comparables === 1 ? '' : 's'} of a ` +
        `${input.beds}-bed in ${community.nameEn} over the last ${months} months ` +
        `(minimum ${MIN_COMPARABLES} needed). DLD populates the register; the current ` +
        'dataset carries no such rows, so no positioning verdict is offered.',
    }
  }

  const marketPsf = agg._avg.pricePerSqft as number
  const pctVsMarket = Math.round(((input.launchPsfAed - marketPsf) / marketPsf) * 1000) / 10

  const verdict =
    pctVsMarket < -10
      ? 'Under-market launch — fast absorption expected'
      : pctVsMarket < 0
        ? 'Competitive pricing — below DLD market average'
        : pctVsMarket < 10
          ? 'At-market — aligned with recent DLD transactions'
          : pctVsMarket < 20
            ? 'Premium positioning — 10–20% above DLD market'
            : 'Aggressive launch — more than 20% above DLD market'

  const rank = psfs.filter((p) => p <= input.launchPsfAed).length
  const percentile = Math.round((rank / psfs.length) * 100)

  const volumeTrendPct = prevCount > 0 ? Math.round(((comparables - prevCount) / prevCount) * 1000) / 10 : null

  return {
    ...base,
    dldComparables: comparables,
    market: {
      avgPsfAed: Math.round(marketPsf),
      minPsfAed: agg._min.pricePerSqft == null ? null : Math.round(agg._min.pricePerSqft),
      maxPsfAed: agg._max.pricePerSqft == null ? null : Math.round(agg._max.pricePerSqft),
    },
    positioning: { pctVsMarket, percentile, verdict },
    demand: {
      transactions: comparables,
      volumeTrendPct,
      demandSignal:
        volumeTrendPct == null ? 'Unknown' : volumeTrendPct > 10 ? 'Rising' : volumeTrendPct > -10 ? 'Stable' : 'Declining',
    },
  }
}
