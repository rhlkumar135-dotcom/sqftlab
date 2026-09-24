import { prisma } from './db'

// A listing is a deal when its PSF is below 88% of its community's median PSF,
// i.e. more than 12% under the local market.
export const DEAL_DISCOUNT_THRESHOLD = 0.88

// Transaction types this schema stores for sales. The spec's `transactionType:
// 'Sales'` matches nothing here — filtering on it silently returns zero rows.
export const SALE_TXN_TYPES = ['sale', 'off_plan_sale'] as const

/**
 * Reset-then-flag deal detection across every community.
 *
 * Both statements per community run inside one `$transaction`, so a failure
 * partway through cannot leave a community with every listing cleared and none
 * re-flagged.
 */
export async function detectDeals(): Promise<number> {
  const communities = await prisma.community.findMany({
    select: { id: true, medianAedSqft: true },
  })

  // A median below AED 100/sqft is a placeholder, not a real market level —
  // flagging against it would mark almost every listing in the district.
  const candidates = communities.filter((cm) => cm.medianAedSqft > 100)
  if (candidates.length === 0) return 0

  const statements = candidates.flatMap((cm) => {
    const threshold = cm.medianAedSqft * DEAL_DISCOUNT_THRESHOLD
    return [
      prisma.listing.updateMany({
        where: { communityId: cm.id, purpose: 'sale' },
        data: { isDeal: false },
      }),
      prisma.listing.updateMany({
        where: {
          communityId: cm.id,
          purpose: 'sale',
          pricePerSqft: { gt: 0, lt: threshold },
        },
        data: { isDeal: true },
      }),
    ]
  })

  const results = await prisma.$transaction(statements)
  // Odd indices are the "set true" statements; even ones are the resets.
  return results.reduce((sum, r, i) => (i % 2 === 1 ? sum + r.count : sum), 0)
}
