/**
 * Portfolio valuation jobs (Day 8). Server-side: this module touches Prisma, so the
 * pure arithmetic and summary rules live next door in `./portfolio`.
 *
 * Both entry points exist to keep the comparables query in one place — the add route
 * values a single holding on demand and the nightly job values every holding, and if
 * they fetched comps differently they would produce different numbers for the same
 * property.
 */

import { prisma } from './db'
import { SALE_TXN_TYPES } from './deals'
import { COMP_WINDOW_DAYS, SIZE_TOLERANCE, type CmaComp } from './cma'
import { valuateHolding } from './portfolio'

/** The comparable-sale window, as a Date. */
export function comparablesSince(now: Date = new Date()): Date {
  return new Date(now.getTime() - COMP_WINDOW_DAYS * 86_400_000)
}

/**
 * Comparable sales for a unit. `sale` and `off_plan_sale` are both market sales;
 * mortgage and gift rows record a transaction but not an arm's-length price.
 */
export async function fetchHoldingsComparables(
  communityId: string,
  beds: number,
  sizeSqft: number,
): Promise<CmaComp[]> {
  return prisma.transaction.findMany({
    where: {
      communityId,
      beds,
      areaSqft: {
        gte: sizeSqft * (1 - SIZE_TOLERANCE),
        lte: sizeSqft * (1 + SIZE_TOLERANCE),
      },
      transactionType: { in: [...SALE_TXN_TYPES] },
      pricePerSqft: { gt: 100 },
      transactionDate: { gte: comparablesSince() },
    },
    select: {
      transactionDate: true,
      pricePerSqft: true,
      priceAed: true,
      areaSqft: true,
      floorNumber: true,
      buildingName: true,
    },
    orderBy: { transactionDate: 'desc' },
    take: 200,
  })
}

export interface RevalueResult {
  considered: number
  valued: number
  /** Holdings with too few comparables to value — left untouched, never zeroed. */
  skipped: number
  queries: number
}

/**
 * Revalue every holding from recorded sales.
 *
 * Grouped by (community, bedrooms) with ONE query per group, then the size window is
 * applied in memory: the window is relative to each holding's own size, so a single
 * per-holding query would be a query per row. The Day 8 brief loops a query per
 * holding, which is N+1 and gets slower with every property a customer adds.
 *
 * A holding that cannot be valued is left exactly as it is. Writing 0 there would
 * turn "we could not value this" into "this is worth nothing", and writing the
 * purchase price would report a flat 0.0% return as a market outcome.
 */
export async function revalueAllHoldings(): Promise<RevalueResult> {
  const holdings = await prisma.portfolio.findMany({
    select: {
      id: true,
      communityId: true,
      beds: true,
      areaSqft: true,
      buildingName: true,
      community: { select: { nameEn: true } },
    },
  })
  if (holdings.length === 0) return { considered: 0, valued: 0, skipped: 0, queries: 0 }

  const groups = new Map<string, typeof holdings>()
  for (const h of holdings) {
    const key = `${h.communityId}\u0000${h.beds}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(h)
    else groups.set(key, [h])
  }

  const since = comparablesSince()
  let valued = 0
  let skipped = 0
  let queries = 0

  for (const group of groups.values()) {
    const { communityId, beds } = group[0]
    // Fetched once per group, deliberately wider than any single holding's window.
    const pool = await prisma.transaction.findMany({
      where: {
        communityId,
        beds,
        transactionType: { in: [...SALE_TXN_TYPES] },
        pricePerSqft: { gt: 100 },
        transactionDate: { gte: since },
      },
      select: {
        transactionDate: true,
        pricePerSqft: true,
        priceAed: true,
        areaSqft: true,
        floorNumber: true,
        buildingName: true,
      },
      take: 500,
    })
    queries += 1

    for (const h of group) {
      const comps = pool.filter(
        (t) =>
          t.areaSqft >= h.areaSqft * (1 - SIZE_TOLERANCE) &&
          t.areaSqft <= h.areaSqft * (1 + SIZE_TOLERANCE),
      )

      const valuation = valuateHolding(
        {
          buildingName: h.buildingName ?? '',
          community: h.community.nameEn,
          bedrooms: h.beds,
          sizeSqft: h.areaSqft,
          floor: null,
          condition: null,
          listingPrice: null,
        },
        comps,
      )

      if (!valuation) {
        skipped += 1
        continue
      }

      await prisma.portfolio.update({
        where: { id: h.id },
        data: {
          currentValue: valuation.valueAed,
          valuedAt: valuation.asOf,
          valuationSource: valuation.source,
          valuationComps: valuation.compsUsed,
        },
      })
      valued += 1
    }
  }

  return { considered: holdings.length, valued, skipped, queries }
}
