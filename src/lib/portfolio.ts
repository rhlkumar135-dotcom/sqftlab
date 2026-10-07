/**
 * Portfolio holdings — valuation and summarisation (Day 8).
 *
 * A pure module, kept out of the routes so the two rules below can be asserted
 * directly rather than through HTTP.
 *
 * THE RULE THAT MATTERS
 *
 * A holding's `currentValue` column defaults to 0 and, until this change, the add
 * route filled it with the *purchase price* when no valuation existed. That makes a
 * holding look like it was valued at exactly what was paid for it: a flat 0.0% return
 * presented as a market outcome, and — because the seeded rows carried fabricated
 * figures — a portfolio reading AED 10,941,214 against zero recorded transactions.
 *
 * So "has this been valued" is a separate question from "what is it worth", and it is
 * answered by `valuedAt`, which is only written by a valuation that actually ran. Until
 * then a holding's current value and gain are `null` — unknown — and it is excluded
 * from the portfolio's gain rather than counted as a break-even. `null` is the honest
 * answer and the UI has to render it as "not yet valued".
 */

import { computeCma, type CmaComp, type CmaSubject } from './cma'

/** Pro tracks up to five holdings. Nothing above pro is capped. */
export const PRO_PROPERTY_LIMIT = 5

/**
 * The holding cap for a tier, or `null` for uncapped.
 *
 * The Day 8 brief caps `pro` at five and calls `enterprise` unlimited without
 * mentioning `elite`, which sits between them in this app's ladder. It is left
 * uncapped to match the brief literally; tightening it is a one-line change here.
 */
export function propertyLimitFor(tier: string): number | null {
  return tier === 'pro' ? PRO_PROPERTY_LIMIT : null
}

export interface Valuation {
  valueAed: number
  psf: number
  compsUsed: number
  basis: 'building' | 'community'
  asOf: Date
  source: 'dld'
}

/**
 * Value a holding from real comparable sales, or return `null`.
 *
 * Delegates to `computeCma` so a holding, a CMA run and a client PDF report all use
 * one implementation of the arithmetic and cannot disagree. `null` means "no
 * valuation exists" and the caller must store nothing — never a substitute figure.
 */
export function valuateHolding(subject: CmaSubject, comps: CmaComp[]): Valuation | null {
  const result = computeCma(subject, comps)
  if (!result) return null
  return {
    valueAed: Math.round(result.estimatedValueAed),
    psf: Math.round(result.medianPsf),
    compsUsed: result.compsUsed,
    basis: result.compBasis,
    asOf: new Date(),
    source: 'dld',
  }
}

/** The columns the derived figures need. Structural, so a Prisma row satisfies it. */
export interface HoldingLike {
  purchasePrice: number
  areaSqft: number
  currentValue: number
  valuedAt: Date | null
}

export interface HoldingDerived {
  /** True only when a real valuation produced `currentValue`. */
  isValued: boolean
  currentValueAed: number | null
  gainAed: number | null
  gainPct: number | null
  /** Purchase PSF is always knowable — it is just price ÷ size. */
  purchasePsf: number | null
  currentPsf: number | null
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/**
 * The per-holding figures, with `null` wherever the answer is "not known yet".
 *
 * `valuedAt` and `currentValue > 0` are both required: a row can carry a non-zero
 * `currentValue` written before this column existed, or a zero from the column
 * default, and neither is evidence of a valuation.
 */
export function deriveHolding(row: HoldingLike): HoldingDerived {
  const isValued = Boolean(row.valuedAt) && row.currentValue > 0
  const purchasePsf = row.areaSqft > 0 ? Math.round(row.purchasePrice / row.areaSqft) : null

  if (!isValued) {
    return { isValued: false, currentValueAed: null, gainAed: null, gainPct: null, purchasePsf, currentPsf: null }
  }

  const gainAed = row.currentValue - row.purchasePrice
  return {
    isValued: true,
    currentValueAed: Math.round(row.currentValue),
    gainAed: Math.round(gainAed),
    gainPct: row.purchasePrice > 0 ? round1((gainAed / row.purchasePrice) * 100) : null,
    purchasePsf,
    currentPsf: row.areaSqft > 0 ? Math.round(row.currentValue / row.areaSqft) : null,
  }
}

export interface HoldingSummary {
  count: number
  /** How many holdings have a real valuation behind them. */
  valuedCount: number
  unvaluedCount: number
  /** Paid, across every holding. */
  purchaseAed: number
  /** Paid, across valued holdings only — the denominator `gainPct` uses. */
  valuedPurchaseAed: number
  /** Current value, across valued holdings only. */
  currentAed: number
  /** `null` when nothing is valued: an unknown gain is not a gain of zero. */
  gainAed: number | null
  gainPct: number | null
}

/**
 * Portfolio totals.
 *
 * The gain is computed over valued holdings only and is `null` when there are none.
 * The tempting alternative — treating an unvalued holding as worth its purchase price —
 * reports a confident 0.0% on a portfolio that has never been valued, which is exactly
 * the failure this module exists to prevent.
 */
export function summariseHoldings(rows: HoldingLike[]): HoldingSummary {
  let purchaseAed = 0
  let valuedPurchaseAed = 0
  let currentAed = 0
  let valuedCount = 0

  for (const row of rows) {
    purchaseAed += row.purchasePrice
    if (row.valuedAt && row.currentValue > 0) {
      valuedCount += 1
      valuedPurchaseAed += row.purchasePrice
      currentAed += row.currentValue
    }
  }

  const gain = valuedCount > 0 ? currentAed - valuedPurchaseAed : null

  return {
    count: rows.length,
    valuedCount,
    unvaluedCount: rows.length - valuedCount,
    purchaseAed: Math.round(purchaseAed),
    valuedPurchaseAed: Math.round(valuedPurchaseAed),
    currentAed: Math.round(currentAed),
    gainAed: gain === null ? null : Math.round(gain),
    gainPct: gain === null || valuedPurchaseAed <= 0 ? null : round1((gain / valuedPurchaseAed) * 100),
  }
}
