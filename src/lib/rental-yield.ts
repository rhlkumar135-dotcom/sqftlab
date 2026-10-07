import { prisma } from './db'
import { findCommunityByName } from './community-match'
import { SALE_TXN_TYPES } from './deals'

/**
 * Rental Yield (Day 9 Task B).
 *
 * The brief asks for a yield from "actual registered Ejari rent contracts, not
 * estimates". The honest position is that this deployment has none: `EjariContract`
 * is new and empty, and `src/lib/intelligence.ts` already says as much in
 * `computeYieldCurve()` — "Rents come from the listing table, which carries only a
 * current snapshot" of *asking* prices. So this module never invents an Ejari
 * figure. It prefers registered contracts when they exist and otherwise falls back
 * to the asking-rent snapshot the platform already holds, **labelling which one
 * answered** so a listing-derived yield can never be read as a contracted one.
 * That is the same provenance convention as `Community.psfSource` and
 * `Portfolio.valuationSource`.
 *
 * Deviations from the brief's implementation:
 *
 * - `mode: 'insensitive'` is Postgres-only and throws on SQLite (see
 *   `community-match.ts`), so area resolution goes through `findCommunityByName`
 *   and the contract filter uses exact keys rather than a SQL contains.
 * - The brief's `Transaction` fields (`amount`, `pricePsf`) do not exist; the real
 *   columns are `priceAed` and `pricePerSqft`, and sales are `SALE_TXN_TYPES`.
 * - The brief returns `grossYieldPct: 0` when no sale price is found, which reads
 *   as a measured 0% return. Zero and unknown are different answers, so an
 *   unavailable input yields `null`.
 */

/**
 * The platform's long-standing stand-in for unit size, carried over verbatim from
 * `refreshCommunityStats()`: "Average unit ≈ 1,000 sqft, so a PSF and an annual
 * rent are only comparable at that scale." Kept identical so a yield quoted here
 * matches the one already stored on the community row.
 */
export const ASSUMED_UNIT_SQFT = 1000

export type RentSource = 'ejari' | 'rent_listings' | 'none'
export type SaleSource = 'dld_transactions' | 'community_median' | 'none'

export interface RentalYieldResult {
  area: string
  slug: string | null
  communityId: string | null
  periodMonths: number
  periodStart: string
  avgAnnualRentAed: number | null
  avgSalePriceAed: number | null
  grossYieldPct: number | null
  contractCount: number
  saleSampleSize: number
  rentSource: RentSource
  saleSource: SaleSource
  sampleUnitSqft: number
  warnings: string[]
  methodology: string
  computedAt: string
  insufficientData?: boolean
  reason?: string
}

const round = (n: number, dp = 0) => Math.round(n * 10 ** dp) / 10 ** dp

export async function computeRentalYield(
  areaOrSlug: string,
  opts: { months?: number } = {},
): Promise<RentalYieldResult> {
  const months = opts.months ?? 12
  const since = new Date()
  since.setMonth(since.getMonth() - months)
  since.setHours(0, 0, 0, 0)

  const community =
    (await prisma.community.findUnique({ where: { slug: areaOrSlug } })) ??
    (await findCommunityByName(areaOrSlug))

  const base = {
    area: community?.nameEn ?? areaOrSlug,
    slug: community?.slug ?? null,
    communityId: community?.id ?? null,
    periodMonths: months,
    periodStart: since.toISOString(),
    sampleUnitSqft: ASSUMED_UNIT_SQFT,
    computedAt: new Date().toISOString(),
  }

  const warnings: string[] = []

  // ── Registered rents (Ejari) ───────────────────────────────────────────────
  // Exact keys only: the register's free-text `area` is matched against the
  // community's canonical name and slug, plus the FK when ingest resolved one.
  const rentKeys = community ? [community.nameEn, community.slug] : [areaOrSlug]
  const ejariWhere = {
    contractStart: { gte: since },
    OR: [
      ...(community ? [{ communityId: community.id }] : []),
      { area: { in: rentKeys } },
    ],
  }

  // No `.catch` here. An earlier draft swallowed the error and fell through to "0
  // contracts", which reads as "no registered rents in this area" rather than "the
  // query failed" — the exact silent-wrong-answer shape this module exists to avoid.
  const ejari = await prisma.ejariContract.aggregate({
    where: ejariWhere,
    _avg: { annualRentAed: true },
    _count: { _all: true },
  })

  const contractCount = ejari._count._all
  const ejariAvgRent = ejari._avg.annualRentAed

  // ── Sale prices ────────────────────────────────────────────────────────────
  const sales = community
    ? await prisma.transaction.aggregate({
        where: {
          communityId: community.id,
          transactionType: { in: [...SALE_TXN_TYPES] },
          transactionDate: { gte: since },
        },
        _avg: { priceAed: true },
        _count: { _all: true },
      })
    : null

  const saleSampleSize = sales?._count._all ?? 0
  let avgSalePrice: number | null = sales?._avg.priceAed ?? null
  let saleSource: SaleSource = 'none'

  if (avgSalePrice != null && saleSampleSize > 0) {
    saleSource = 'dld_transactions'
  } else if (community && community.medianAedSqft > 0) {
    // Same arithmetic the community row already uses: PSF × an assumed 1,000 sqft
    // unit. An assumption, so it is recorded as one rather than passed off as an
    // observed sale price.
    avgSalePrice = community.medianAedSqft * ASSUMED_UNIT_SQFT
    saleSource = 'community_median'
    warnings.push(
      `No DLD sales in the last ${months} months; the sale price is the community median ` +
        `PSF multiplied by an assumed ${ASSUMED_UNIT_SQFT} sqft unit, not an observed transaction.`,
    )
  } else {
    avgSalePrice = null
  }

  // ── Rent side of the yield ─────────────────────────────────────────────────
  let avgRent: number | null = null
  let rentSource: RentSource = 'none'

  if (contractCount > 0 && ejariAvgRent != null) {
    avgRent = ejariAvgRent
    rentSource = 'ejari'
  } else if (community && community.medianAnnualRentAed > 0) {
    avgRent = community.medianAnnualRentAed
    rentSource = 'rent_listings'
    warnings.push(
      'No registered Ejari contracts for this area; the rent is the average of current ' +
        'portal asking rents, which is not a contracted rent and typically runs above it.',
    )
  }

  // The brief's own caveat, kept.
  if (rentSource === 'ejari' && contractCount < 5) {
    warnings.push(
      `Fewer than 5 Ejari contracts found (${contractCount}). The yield may not be representative.`,
    )
  }

  const grossYield =
    avgRent != null && avgSalePrice != null && avgSalePrice > 0 && avgRent > 0
      ? round((avgRent / avgSalePrice) * 100, 2)
      : null

  const methodology =
    `Gross yield = average annual rent ÷ average sale price. Sale price from ` +
    `DLD registered sales (${saleSource === 'dld_transactions' ? 'observed transactions' : saleSource === 'community_median' ? 'community PSF × assumed unit' : 'unavailable'}); ` +
    `rent from ${rentSource === 'ejari' ? 'registered Ejari contracts' : rentSource === 'rent_listings' ? 'portal asking rents (no Ejari contracts)' : 'unavailable'}. ` +
    `Gross, before service charges, void periods and transaction costs.`

  if (rentSource === 'none' && saleSource === 'none') {
    return {
      ...base,
      avgAnnualRentAed: null,
      avgSalePriceAed: null,
      grossYieldPct: null,
      contractCount,
      saleSampleSize,
      rentSource,
      saleSource,
      warnings,
      methodology,
      insufficientData: true,
      reason:
        'Neither a sale price nor a rent is available for this area — no DLD sales, no ' +
        'Ejari contracts and no community median to fall back on, so no yield can be computed.',
    }
  }

  return {
    ...base,
    avgAnnualRentAed: avgRent == null ? null : round(avgRent),
    avgSalePriceAed: avgSalePrice == null ? null : round(avgSalePrice),
    grossYieldPct: grossYield,
    contractCount,
    saleSampleSize,
    rentSource,
    saleSource,
    warnings,
    methodology,
  }
}
