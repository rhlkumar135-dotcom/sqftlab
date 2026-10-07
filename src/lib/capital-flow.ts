import { prisma } from './db'
import { SALE_TXN_TYPES } from './deals'

/**
 * Capital Flow Tracker — who is buying in Dubai, by nationality (Day 9 Task A).
 *
 * Two corrections against the brief's version, both of which would have made the
 * figure wrong rather than merely different:
 *
 * 1. The brief computes its percentage base from the rows it just fetched:
 *
 *        const grouped = await prisma.transaction.groupBy({ ..., take: 15 })
 *        const total   = grouped.reduce((s, g) => s + g._count.id, 0)
 *
 *    With `take: 15` the base is the sum of the *returned slice*, not the market,
 *    so the percentages are shares of the top 15 and necessarily sum to 100%. A
 *    nationality holding 4% of the market reads as 20% whenever the tail is cut.
 *    The base is counted separately here so a share is a share of everything.
 *
 * 2. The brief queries `transactionType: 'Sales'`. This schema stores `sale` and
 *    `off_plan_sale` (see `SALE_TXN_TYPES`), so the literal `'Sales'` matches zero
 *    rows and the endpoint would have answered an empty market on a full table —
 *    a silent wrong answer rather than an error.
 *
 * The brief also filters with `mode: 'insensitive'`, which is Postgres-only and
 * throws on SQLite; see `community-match.ts`. Nothing here needs it: this module
 * groups on an exact `buyerNationality` column and filters area by a resolved id.
 */

export interface FlowAggregate {
  nationality: string
  count: number
  totalValueAed: number
}

export interface NationalityRow {
  nationality: string
  count: number
  pct: number
  totalValueAed: number
}

export type FlowSource = 'dld_transactions' | 'nationality_snapshot'

export interface CapitalFlowResult {
  scope: string
  area: string | null
  period: string
  periodStart: string
  totalBuyers: number
  nationalities: NationalityRow[]
  source: FlowSource
  sourceNote: string
  computedAt: string
  methodology: string
  insufficientData?: boolean
  reason?: string
}

const METHODOLOGY =
  'Share of DLD sales by buyer nationality over the trailing window. DLD populates ' +
  'buyerNationality on each registered sale; a sale without it is counted under ' +
  '"Unknown" rather than dropped, so the shares still describe the whole market.'

/** Trailing-window start, floored to the day. */
export function windowStart(months: number, now: Date = new Date()): Date {
  const d = new Date(now)
  d.setMonth(d.getMonth() - months)
  d.setHours(0, 0, 0, 0)
  return d
}

/**
 * Turn raw aggregates into rows with an honest percentage.
 *
 * Pure so the percentage base can be tested directly — the brief's version is
 * only wrong once `limit` actually truncates, which is exactly the case a
 * hand-checked sample would miss.
 */
export function summariseNationalities(
  aggregates: FlowAggregate[],
  totalBuyers: number,
  limit: number,
): NationalityRow[] {
  return aggregates
    .slice()
    .sort((a, b) => b.count - a.count || a.nationality.localeCompare(b.nationality))
    .slice(0, limit)
    .map((a) => ({
      nationality: a.nationality,
      count: a.count,
      // Against the market, not the slice. Guarded so an empty market yields 0
      // rather than NaN.
      pct: totalBuyers > 0 ? Math.round((a.count / totalBuyers) * 1000) / 10 : 0,
      totalValueAed: Math.round(a.totalValueAed),
    }))
}

/** Live aggregates straight off the DLD transaction register. */
export async function liveFlowAggregates(
  since: Date,
  communityId?: string,
): Promise<{ aggregates: FlowAggregate[]; totalBuyers: number }> {
  const where = {
    transactionType: { in: [...SALE_TXN_TYPES] },
    transactionDate: { gte: since },
    ...(communityId ? { communityId } : {}),
  }

  const [grouped, totalBuyers] = await Promise.all([
    prisma.transaction.groupBy({
      by: ['buyerNationality'],
      where,
      _count: { id: true },
      _sum: { priceAed: true },
      orderBy: { _count: { id: 'desc' } },
      take: 50,
    }),
    // The base, counted over the whole window rather than the returned slice.
    prisma.transaction.count({ where }),
  ])

  return {
    aggregates: grouped.map((g) => ({
      nationality: g.buyerNationality ?? 'Unknown',
      count: g._count.id,
      totalValueAed: g._sum.priceAed ?? 0,
    })),
    totalBuyers,
  }
}

/**
 * Aggregates from the newest persisted `nationalityFlow` snapshot.
 *
 * `NationalityFlow` is append-only (`computeMigrationSignal`, Task A4), so only
 * the newest `calculatedAt` batch is the current picture; summing across batches
 * would count each month once per past run.
 */
export async function snapshotFlowAggregates(
  since: Date,
  district?: string,
): Promise<{ aggregates: FlowAggregate[]; totalBuyers: number; snapshotAt: Date | null }> {
  const newest = await prisma.nationalityFlow.findFirst({
    orderBy: { calculatedAt: 'desc' },
    select: { calculatedAt: true },
  })
  if (!newest) return { aggregates: [], totalBuyers: 0, snapshotAt: null }

  const rows = await prisma.nationalityFlow.findMany({
    where: {
      calculatedAt: newest.calculatedAt,
      month: { gte: new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), 1)) },
      ...(district ? { district } : {}),
    },
    select: { nationality: true, transactionCount: true, totalValueAed: true },
  })

  const byNationality = new Map<string, FlowAggregate>()
  for (const r of rows) {
    const existing = byNationality.get(r.nationality)
    if (existing) {
      existing.count += r.transactionCount
      existing.totalValueAed += r.totalValueAed
    } else {
      byNationality.set(r.nationality, {
        nationality: r.nationality,
        count: r.transactionCount,
        totalValueAed: r.totalValueAed,
      })
    }
  }

  const aggregates = [...byNationality.values()]
  return {
    aggregates,
    totalBuyers: aggregates.reduce((s, a) => s + a.count, 0),
    snapshotAt: newest.calculatedAt,
  }
}

export interface CapitalFlowQuery {
  /** Human label for the response, e.g. 'Dubai' or a community name. */
  scope: string
  /** Community slug, when scoping to one area. */
  district?: string
  communityId?: string
  months?: number
  limit?: number
}

/**
 * Resolve a capital-flow answer for a scope.
 *
 * Live transactions are preferred because the window is a rolling one. The
 * persisted snapshot is the fallback, not a second opinion: it is derived from
 * the same register by the hourly pipeline, and it survives a purge of
 * `transactions`, so historical flow stays answerable after the raw rows are
 * gone. Which one answered is always reported, so a snapshot can never be
 * mistaken for live data.
 */
export async function computeCapitalFlow(opts: CapitalFlowQuery): Promise<CapitalFlowResult> {
  const months = opts.months ?? 3
  const limit = opts.limit ?? 15
  const since = windowStart(months)
  const period = `${months * 30} days`
  const base = {
    scope: opts.scope,
    area: opts.district ?? null,
    period,
    periodStart: since.toISOString(),
    computedAt: new Date().toISOString(),
    methodology: METHODOLOGY,
  }

  const live = await liveFlowAggregates(since, opts.communityId)
  if (live.totalBuyers > 0) {
    return {
      ...base,
      totalBuyers: live.totalBuyers,
      nationalities: summariseNationalities(live.aggregates, live.totalBuyers, limit),
      source: 'dld_transactions',
      sourceNote: `Live from ${live.totalBuyers} registered DLD sales in the trailing ${period}.`,
    }
  }

  const snap = await snapshotFlowAggregates(since, opts.district)
  if (snap.totalBuyers > 0) {
    return {
      ...base,
      totalBuyers: snap.totalBuyers,
      nationalities: summariseNationalities(snap.aggregates, snap.totalBuyers, limit),
      source: 'nationality_snapshot',
      sourceNote:
        `No DLD sales in the trailing ${period}; reporting the last computed snapshot` +
        (snap.snapshotAt ? ` from ${snap.snapshotAt.toISOString()}` : '') +
        '. Figures are historical, not live.',
    }
  }

  return {
    ...base,
    totalBuyers: 0,
    nationalities: [],
    source: 'dld_transactions',
    sourceNote: 'No nationality data is available for this scope.',
    insufficientData: true,
    reason:
      'No DLD sales carrying buyerNationality exist for this window. DLD populates ' +
      'this field on the transaction register; the current dataset has no such rows, ' +
      'so there is no capital-flow breakdown to report. Set DUBAI_PULSE_API_KEY and ' +
      'run the DLD sync to populate it.',
  }
}
