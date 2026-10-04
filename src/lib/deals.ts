import { prisma } from './db'

// A listing is a deal when its PSF sits 8% or more below the area's 90-day DLD
// median PSF — i.e. under 92% of the local market level.
export const DEAL_DISCOUNT_THRESHOLD = 0.92

// Transaction types this schema stores for sales. The spec's `transactionType:
// 'Sales'` matches nothing here — filtering on it silently returns zero rows.
export const SALE_TXN_TYPES = ['sale', 'off_plan_sale'] as const

export const DEAL_WINDOW_DAYS = 90

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * The 90-day DLD median PSF for every community with qualifying sale
 * transactions.
 *
 * One query covers the whole window and the median is computed in memory:
 * Prisma has no median aggregate, and a query per listing would be N+1.
 */
export async function marketPsfByCommunity(
  communityIds?: string[],
  days = DEAL_WINDOW_DAYS,
): Promise<Map<string, number>> {
  const since = new Date()
  since.setDate(since.getDate() - days)

  const rows = await prisma.transaction.findMany({
    where: {
      transactionType: { in: [...SALE_TXN_TYPES] },
      transactionDate: { gte: since },
      pricePerSqft: { gt: 100 },
      ...(communityIds?.length ? { communityId: { in: communityIds } } : {}),
    },
    select: { communityId: true, pricePerSqft: true },
  })

  const byCommunity = new Map<string, number[]>()
  for (const row of rows) {
    const bucket = byCommunity.get(row.communityId)
    if (bucket) bucket.push(row.pricePerSqft)
    else byCommunity.set(row.communityId, [row.pricePerSqft])
  }

  return new Map([...byCommunity].map(([id, psfs]) => [id, median(psfs)]))
}

/**
 * Reset-then-flag deal detection across every community.
 *
 * Both statements per community run inside one `$transaction`, so a failure
 * partway through cannot leave a community with every listing cleared and none
 * re-flagged.
 */
export async function detectDeals(): Promise<number> {
  const communities = await prisma.community.findMany({ select: { id: true } })
  if (communities.length === 0) return 0

  const medians = await marketPsfByCommunity()

  // Reset every listing in the district, not just the sale ones: a stale flag on
  // a rent listing would otherwise survive forever, since only sales are
  // re-flagged below.
  const resets = communities.map((cm) =>
    prisma.listing.updateMany({
      where: { communityId: cm.id },
      data: { isDeal: false },
    }),
  )

  // A median below AED 100/sqft is a placeholder, not a real market level —
  // flagging against it would mark almost every listing in the district.
  const flags = communities.flatMap((cm) => {
    const medianPsf = medians.get(cm.id)
    if (!medianPsf || medianPsf <= 100) return []
    return [
      prisma.listing.updateMany({
        where: {
          communityId: cm.id,
          purpose: 'sale',
          pricePerSqft: { gt: 0, lt: medianPsf * DEAL_DISCOUNT_THRESHOLD },
        },
        data: { isDeal: true },
      }),
    ]
  })

  // One transaction, so a mid-flight failure cannot leave districts cleared but
  // unflagged.
  const results = await prisma.$transaction([...resets, ...flags])
  return results.slice(resets.length).reduce((sum, r) => sum + r.count, 0)
}
