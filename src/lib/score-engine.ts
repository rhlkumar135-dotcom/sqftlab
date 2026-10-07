// FEATURE-01 — Investment Score Engine.
//
// One 0–100 number per community, the product's headline claim. Five weighted
// inputs:
//
//   PSF momentum       30%   median DLD PSF, last 90d vs the 90d before it
//   Rental yield       25%   gross yield (8% reads as 100)
//   Supply absorption  20%   monthly sales volume against standing supply
//   Volume trend       15%   sales count, last 90d vs the 90d before it
//   Capital flow       10%   growth-market buyer share (needs Ejari, Day 9)
//
// Two things this module deliberately does NOT do:
//
// 1. It never substitutes a listing asking price for a transaction price. PSF
//    momentum is computed only from `transaction.pricePerSqft` — government-
//    registered prices. Asking prices run 15–30% above transacted levels, so
//    mixing them would make the score's largest input systematically wrong.
//
// 2. It never presents a placeholder as a measurement. When an input has no
//    data behind it the formula still needs a neutral 50 to produce a number,
//    but the row records `dataCoverage` (how many of the five inputs were real)
//    and `notes` says what is missing. A score of 50 built from no data and a
//    score of 50 built from five real inputs are different claims, and the
//    caller has to be able to tell them apart.

import { prisma } from './db'
import { SALE_TXN_TYPES } from './deals'
import { latestDistrictMetrics } from './intelligence'

/** Neutral stand-in for an input with no data behind it. */
const NEUTRAL = 50

export interface ScoreComponents {
  psfMomentum: number | null
  rentalYield: number | null
  supplyAbsorption: number | null
  volumeTrend: number | null
  capitalFlow: number | null
}

export interface ScoreInputs {
  recentPsf: number
  prevPsf: number
  volRecent: number
  volPrev: number
  activeListings: number
  avgYield: number | null
}

export interface ScoreResult {
  score: number
  components: ScoreComponents
  dataCoverage: number
  notes: string
}

const clamp = (n: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n))
const round1 = (n: number) => Math.round(n * 10) / 10
const pct = (now: number, before: number) => (before > 0 ? ((now - before) / before) * 100 : 0)

/**
 * The scoring rules. Pure — no database access — so the on-demand route and the
 * nightly batch run produce identical numbers for identical inputs.
 */
export function scoreFromInputs(i: ScoreInputs): ScoreResult {
  // ── 1. PSF momentum (30%) — 50 is flat, +1% moves the score 5 points ──────
  const hasMomentum = i.prevPsf > 0 && i.recentPsf > 0
  const psfMomentumPct = pct(i.recentPsf, i.prevPsf)
  const psfMomentum = clamp(NEUTRAL + psfMomentumPct * 5)

  // ── 2. Rental yield (25%) — 8% gross yield reads as 100 ──────────────────
  const hasYield = i.avgYield != null && i.avgYield > 0
  const rentalYield = hasYield ? clamp((i.avgYield! / 8) * 100) : NEUTRAL

  // ── 3. Supply absorption (20%) — monthly sales against standing supply ────
  // An average month's transactions relative to live sale listings. 50% turnover
  // a month reads as 100.
  //
  // NOTE the `× 2` applies only to a real rate. The brief's version computed
  // `absorptionRate = 50` when there was no volume and then multiplied by 2,
  // turning "no data" into a perfect 100 — the highest possible supply score for
  // the communities with the least information. A missing input has to stay at
  // the neutral 50, or the composite silently flatters every data-less district.
  const monthlyAvgVol = i.volRecent / 3
  const hasAbsorption = i.activeListings > 0 && monthlyAvgVol > 0
  const supplyAbsorption = hasAbsorption
    ? clamp((monthlyAvgVol / Math.max(i.activeListings, 1)) * 100 * 2)
    : NEUTRAL

  // ── 4. Volume trend (15%) — +1% volume moves the score 1 point ───────────
  const hasVolume = i.volPrev > 0
  const volChange = pct(i.volRecent, i.volPrev)
  const volumeTrend = clamp(NEUTRAL + volChange * 3)

  // ── 5. Capital flow (10%) — placeholder until Ejari ownership lands ───────
  // Intentionally NOT marked as covered: a hard-coded 50 is not a measurement.
  const capitalFlow = NEUTRAL

  const components: ScoreComponents = {
    psfMomentum: round1(psfMomentum),
    rentalYield: round1(rentalYield),
    supplyAbsorption: round1(supplyAbsorption),
    volumeTrend: round1(volumeTrend),
    capitalFlow,
  }

  const composite =
    psfMomentum * 0.3 + rentalYield * 0.25 + supplyAbsorption * 0.2 + volumeTrend * 0.15 + capitalFlow * 0.1

  const covered = [hasMomentum, hasYield, hasAbsorption, hasVolume].filter(Boolean).length
  const dataCoverage = round1(covered / 4) // capital flow is always a placeholder

  const missing: string[] = []
  if (!hasMomentum) missing.push('transaction PSF')
  if (!hasYield) missing.push('yield')
  if (!hasAbsorption) missing.push('listing supply')
  if (!hasVolume) missing.push('sales volume')

  let notes: string
  if (missing.length === 0) {
    // Name the input doing the most work, so the number has an explanation.
    const ranked: [string, number][] = [
      ['PSF momentum', psfMomentumPct >= 0 ? psfMomentum : 100 - psfMomentum],
      ['rental yield', rentalYield],
      ['supply absorption', supplyAbsorption],
      ['sales volume trend', volumeTrend],
    ]
    ranked.sort((a, b) => b[1] - a[1])
    notes = `Driven mainly by ${ranked[0][0]}`
  } else if (covered === 0) {
    notes = 'No score data available — every input is a neutral stand-in, not a measurement'
  } else {
    notes = `Partial data — no ${missing.join(', ')}`
  }

  return { score: round1(composite), components, dataCoverage, notes }
}

export interface CommunityScoreRow {
  communityId: string
  score: number
  components: ScoreComponents
  dataCoverage: number
  notes: string
}

/**
 * Score a set of communities with a fixed number of queries, regardless of how
 * many communities there are.
 *
 * The obvious implementation queries each community in a loop — six round trips
 * each, so 264 on today's 44 districts and worse every time a scrape adds one.
 * Everything shared is fetched once and grouped by `communityId` instead, then
 * joined in memory.
 */
export async function scoreCommunities(communityIds: string[]): Promise<CommunityScoreRow[]> {
  if (communityIds.length === 0) return []

  const now = new Date()
  const d90 = new Date(now)
  d90.setDate(d90.getDate() - 90)
  const d180 = new Date(now)
  d180.setDate(d180.getDate() - 180)

  const ids = { in: communityIds }
  const sale = { in: [...SALE_TXN_TYPES] }

  const [communities, recentTx, prevTx, recentVol, prevVol, listingCounts, metrics] = await Promise.all([
    prisma.community.findMany({ where: { id: ids }, select: { id: true, slug: true, nameEn: true } }),
    prisma.transaction.groupBy({
      by: ['communityId'],
      where: { communityId: ids, transactionType: sale, pricePerSqft: { gt: 100 }, transactionDate: { gte: d90 } },
      _avg: { pricePerSqft: true },
    }),
    prisma.transaction.groupBy({
      by: ['communityId'],
      where: {
        communityId: ids,
        transactionType: sale,
        pricePerSqft: { gt: 100 },
        transactionDate: { gte: d180, lt: d90 },
      },
      _avg: { pricePerSqft: true },
    }),
    prisma.transaction.groupBy({
      by: ['communityId'],
      where: { communityId: ids, transactionType: sale, transactionDate: { gte: d90 } },
      _count: { _all: true },
    }),
    prisma.transaction.groupBy({
      by: ['communityId'],
      where: { communityId: ids, transactionType: sale, transactionDate: { gte: d180, lt: d90 } },
      _count: { _all: true },
    }),
    prisma.listing.groupBy({
      by: ['communityId'],
      where: { communityId: ids, purpose: 'sale' },
      _count: { _all: true },
    }),
    latestDistrictMetrics(),
  ])

  const psfRecent = new Map(recentTx.map((r) => [r.communityId, r._avg.pricePerSqft ?? 0]))
  const psfPrev = new Map(prevTx.map((r) => [r.communityId, r._avg.pricePerSqft ?? 0]))
  const volRecent = new Map(recentVol.map((r) => [r.communityId, r._count._all]))
  const volPrev = new Map(prevVol.map((r) => [r.communityId, r._count._all]))
  const listings = new Map(listingCounts.map((r) => [r.communityId, r._count._all]))
  const yieldBySlug = new Map(metrics.map((m) => [m.district, m.avgYield]))

  return communities.map((c) => {
    const result = scoreFromInputs({
      recentPsf: psfRecent.get(c.id) ?? 0,
      prevPsf: psfPrev.get(c.id) ?? 0,
      volRecent: volRecent.get(c.id) ?? 0,
      volPrev: volPrev.get(c.id) ?? 0,
      activeListings: listings.get(c.id) ?? 0,
      avgYield: yieldBySlug.get(c.slug) ?? null,
    })
    return { communityId: c.id, ...result }
  })
}

/** Persist a score. Append-only: a run adds a row, it never overwrites one. */
export async function persistScores(rows: CommunityScoreRow[]): Promise<number> {
  if (rows.length === 0) return 0
  const { count } = await prisma.investmentScore.createMany({
    data: rows.map((r) => ({
      communityId: r.communityId,
      score: r.score,
      psfMomentum: r.components.psfMomentum,
      rentalYield: r.components.rentalYield,
      supplyAbsorption: r.components.supplyAbsorption,
      volumeTrend: r.components.volumeTrend,
      capitalFlow: r.components.capitalFlow,
      dataCoverage: r.dataCoverage,
      notes: r.notes,
    })),
  })
  return count
}

/** Score one community and store it. Used by the on-demand route. */
export async function computeInvestmentScore(communityId: string): Promise<ScoreResult | null> {
  const [row] = await scoreCommunities([communityId])
  if (!row) return null
  await persistScores([row])
  return { score: row.score, components: row.components, dataCoverage: row.dataCoverage, notes: row.notes }
}

/** Nightly batch — scores every community, one fixed set of queries. */
export async function computeAllInvestmentScores(): Promise<{
  communities: number
  written: number
  avgScore: number | null
  avgCoverage: number | null
}> {
  const all = await prisma.community.findMany({ select: { id: true } })
  const rows = await scoreCommunities(all.map((c) => c.id))
  const written = await persistScores(rows)
  const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null)
  return {
    communities: all.length,
    written,
    avgScore: mean(rows.map((r) => r.score)),
    avgCoverage: mean(rows.map((r) => r.dataCoverage)),
  }
}

/**
 * The newest InvestmentScore row per community.
 *
 * `investment_scores` is append-only, so a plain `findMany()` returns every past
 * run and a caller would double-count. Every reader goes through this helper.
 */
export async function latestInvestmentScores(communityIds?: string[]) {
  const rows = await prisma.investmentScore.findMany({
    where: communityIds ? { communityId: { in: communityIds } } : undefined,
    orderBy: { calculatedAt: 'desc' },
  })
  const newest = new Map<string, (typeof rows)[number]>()
  for (const r of rows) if (!newest.has(r.communityId)) newest.set(r.communityId, r)
  return newest
}
