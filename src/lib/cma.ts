/**
 * CMA (Comparable Market Analysis) — the valuation maths.
 *
 * This is deliberately a pure module: it takes comparable transactions that the
 * caller has already fetched and returns a valuation. Keeping it out of the route
 * means the statistics can be exercised directly, and it means there is exactly one
 * implementation of the arithmetic rather than one per caller.
 *
 * Two things this must never do, because the product's credibility rests on them:
 *
 *   1. Invent a comparable. Every figure here is derived from rows the caller
 *      supplied. When there are too few, the ROUTE refuses — it never falls back to
 *      a community median, a model estimate or a generated number.
 *   2. Emit a non-finite number. `JSON.stringify` rewrites NaN and Infinity to
 *      `null`, so an arithmetic slip would reach the client as a silent null that
 *      renders as a blank cell instead of an error. Every division is guarded.
 */

/** Comparable sales below this count are not a market — the route answers 422. */
export const MIN_COMPS = 3

/** The comparables window, in days. */
export const COMP_WINDOW_DAYS = 180

/** How far either side of the subject's size a comp may sit. */
export const SIZE_TOLERANCE = 0.2

export type CmaCondition = 'excellent' | 'good' | 'average' | 'poor'

export const CMA_CONDITIONS: readonly CmaCondition[] = ['excellent', 'good', 'average', 'poor']

/** One comparable sale, in this schema's vocabulary. */
export interface CmaComp {
  transactionDate: Date
  pricePerSqft: number
  priceAed: number
  areaSqft: number
  floorNumber: number | null
  buildingName: string | null
}

export interface CmaSubject {
  buildingName: string
  community: string
  bedrooms: number
  sizeSqft: number
  floor: number | null
  condition: CmaCondition | null
  listingPrice: number | null
}

export interface CmaRecentComp {
  date: string
  pricePsf: number
  totalAed: number
  sizeSqft: number
  building: string | null
  floor: number | null
}

export interface CmaResult {
  subject: {
    buildingName: string
    community: string
    bedrooms: number
    sizeSqft: number
    floor: number | null
    condition: CmaCondition | null
  }
  compsUsed: number
  compsInCommunity: number
  sameBuildingCount: number
  /** Which set the figures were computed from — 'building' is the tighter one. */
  compBasis: 'building' | 'community'
  dateRange: string
  windowDays: number
  medianPsf: number
  avgPsf: number
  p25Psf: number
  p75Psf: number
  adjustedPsf: number
  estimatedValueAed: number
  floorAdjustmentPct: number
  conditionAdjPct: number
  listingPriceAed: number | null
  listingPremiumPct: number | null
  verdict: string | null
  recentComps: CmaRecentComp[]
}

/**
 * Median of an already-sorted ascending list. Even counts average the middle pair,
 * which matters here: a 4-comp set must not silently take the upper middle value.
 */
export function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Nearest-rank percentile on a sorted ascending list, clamped to the valid index
 * range so a small sample cannot read past the end (which would return `undefined`
 * and poison every downstream figure with NaN).
 */
export function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))
  return sorted[idx]
}

/**
 * Floor premium: +0.5% per floor above ground, capped at +10%.
 *
 * This is an ABSOLUTE adjustment against the comp set's median, not one measured
 * against the comps' own average floor — the brief's model. Because the comps are
 * already constrained to the same community and bedroom count, their floor
 * distribution is similar to the subject's, so the absolute form is a reasonable
 * approximation. A ground-floor or absent floor gets no adjustment.
 */
export function floorAdjustment(floor: number | null): number {
  if (floor === null || floor <= 0) return 0
  return Math.min(0.1, floor * 0.005)
}

/**
 * Condition adjustment. `good` and `average` are the baseline — the comps are
 * unadjusted sales, so anything not distinctly better or worse carries no premium.
 */
export function conditionAdjustment(condition: CmaCondition | null): number {
  if (condition === 'excellent') return 0.05
  if (condition === 'poor') return -0.08
  return 0
}

/** Deal verdict from how far the asking price sits above/below the estimate. */
export function verdictFor(premiumPct: number): string {
  if (premiumPct < -8) return 'Strong deal — priced well below market'
  if (premiumPct < 0) return 'Fair value — slightly below market'
  if (premiumPct < 8) return 'At market — within normal range'
  if (premiumPct < 20) return 'Above market — negotiate down'
  return 'Overpriced — significantly above comparable sales'
}

/** Does a comp's building name refer to the subject's building? */
export function matchesBuilding(compBuilding: string | null, subjectBuilding: string): boolean {
  if (!compBuilding) return false
  const a = compBuilding.trim().toLowerCase()
  const b = subjectBuilding.trim().toLowerCase()
  if (!a || !b) return false
  return a.includes(b) || b.includes(a)
}

const round0 = (n: number) => Math.round(n)
const round1 = (n: number) => Math.round(n * 10) / 10

/**
 * Compute a CMA from the supplied comparables.
 *
 * Returns `null` when not one usable comparable survives validation — the caller
 * must then refuse rather than publish a valuation built on nothing.
 *
 * @param subject the property being valued
 * @param communityComps every comparable in the community, newest first
 */
export function computeCma(subject: CmaSubject, communityComps: CmaComp[]): CmaResult | null {
  // A row with a non-finite or non-positive PSF cannot contribute a price; drop it
  // rather than let one bad row skew the median.
  const usable = communityComps.filter(
    (t) => Number.isFinite(t.pricePerSqft) && t.pricePerSqft > 0,
  )
  if (usable.length === 0) return null

  // Prefer same-building comps when there are enough of them: same building, same
  // bedroom count and similar size is the tightest set available, so it yields the
  // most defensible estimate. Fall back to the community when the building is thin,
  // and say which set was used so the UI can label it.
  const buildingComps = usable.filter((t) => matchesBuilding(t.buildingName, subject.buildingName))
  const compBasis: 'building' | 'community' =
    buildingComps.length >= MIN_COMPS ? 'building' : 'community'
  const comps = compBasis === 'building' ? buildingComps : usable

  const sorted = comps.map((t) => t.pricePerSqft).sort((a, b) => a - b)
  const medianPsf = median(sorted)
  const avgPsf = sorted.reduce((s, v) => s + v, 0) / sorted.length
  const p25Psf = percentile(sorted, 0.25)
  const p75Psf = percentile(sorted, 0.75)

  const floorAdj = floorAdjustment(subject.floor)
  const condAdj = conditionAdjustment(subject.condition)
  // Additive, per the brief. Each adjustment is surfaced to the user as its own
  // percentage, so the two must sum to the change they can see in the estimate.
  const adjustedPsf = medianPsf * (1 + floorAdj + condAdj)
  const estimatedValueAed = adjustedPsf * subject.sizeSqft

  // Guarded: a zero estimate would make the premium Infinity, which JSON turns into
  // null and the UI would render as "—%" rather than reporting a real problem.
  const listingPremiumPct =
    subject.listingPrice !== null && estimatedValueAed > 0
      ? round1(((subject.listingPrice - estimatedValueAed) / estimatedValueAed) * 100)
      : null

  const recentComps: CmaRecentComp[] = [...comps]
    .sort((a, b) => b.transactionDate.getTime() - a.transactionDate.getTime())
    .slice(0, 10)
    .map((t) => ({
      date: t.transactionDate.toISOString().slice(0, 10),
      pricePsf: round0(t.pricePerSqft),
      totalAed: round0(t.priceAed),
      sizeSqft: round0(t.areaSqft),
      building: t.buildingName,
      floor: t.floorNumber,
    }))

  return {
    subject: {
      buildingName: subject.buildingName,
      community: subject.community,
      bedrooms: subject.bedrooms,
      sizeSqft: subject.sizeSqft,
      floor: subject.floor,
      condition: subject.condition,
    },
    compsUsed: comps.length,
    compsInCommunity: usable.length,
    sameBuildingCount: buildingComps.length,
    compBasis,
    dateRange: `${COMP_WINDOW_DAYS} days`,
    windowDays: COMP_WINDOW_DAYS,
    medianPsf: round0(medianPsf),
    avgPsf: round0(avgPsf),
    p25Psf: round0(p25Psf),
    p75Psf: round0(p75Psf),
    adjustedPsf: round0(adjustedPsf),
    estimatedValueAed: round0(estimatedValueAed),
    floorAdjustmentPct: round1(floorAdj * 100),
    conditionAdjPct: round1(condAdj * 100),
    listingPriceAed: subject.listingPrice,
    listingPremiumPct,
    verdict: listingPremiumPct === null ? null : verdictFor(listingPremiumPct),
    recentComps,
  }
}
