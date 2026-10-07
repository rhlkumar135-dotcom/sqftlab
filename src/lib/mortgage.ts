/**
 * Mortgage maths (Day 14 Task D).
 *
 * Lives in one module because the calculator must update on every keystroke and slider
 * drag: doing that against `/sqftlab/mortgage/simulate` would be a network round trip per
 * input event. The risk of a client-side formula is that it silently drifts from the
 * server's, so `verify-day14.ts` asserts this module and that route agree to the dirham on
 * the same inputs.
 *
 * The formula is the standard annuity — identical in form to the route's.
 */

export interface MortgageInputs {
  price: number
  downPaymentPct: number
  ratePct: number
  termYears: number
}

export interface YearSplit {
  year: number
  principalPaid: number
  interestPaid: number
  remainingBalance: number
}

export interface MortgageResult {
  downPayment: number
  loanAmount: number
  monthly: number
  totalPayment: number
  totalInterest: number
  schedule: YearSplit[]
}

/**
 * UAE floor on the down payment. The brief states 20% for properties under AED 5M; above
 * that, lenders typically require more, so the floor is raised rather than asserted as an
 * exact figure — the UI labels it as indicative.
 */
export const UAE_MIN_DOWN_PCT_UNDER_5M = 20
export const UAE_MIN_DOWN_PCT_OVER_5M = 30
export const UAE_TRANSFER_FEE_PCT = 4
export const UAE_REGISTRATION_FEE_AED = 4000

export function minDownPaymentPct(price: number): number {
  return price > 5_000_000 ? UAE_MIN_DOWN_PCT_OVER_5M : UAE_MIN_DOWN_PCT_UNDER_5M
}

/** Monthly repayment. A zero rate is a valid input (some employer schemes) — handled, not NaN. */
export function monthlyPayment(loanAmount: number, annualRatePct: number, termYears: number): number {
  if (!Number.isFinite(loanAmount) || loanAmount <= 0) return 0
  const n = Math.round(termYears * 12)
  if (!Number.isFinite(n) || n <= 0) return 0
  const r = annualRatePct / 100 / 12
  if (!Number.isFinite(r) || r === 0) return loanAmount / n
  const growth = Math.pow(1 + r, n)
  const monthly = (loanAmount * r * growth) / (growth - 1)
  return Number.isFinite(monthly) ? monthly : 0
}

/**
 * Principal/interest split per year for the whole term.
 *
 * The brief's server route builds this for `Math.min(termYears, 5)` years, so its
 * "Year 25" figure — which the brief's own UI asks for — cannot exist for a 25-year term.
 * The full schedule is returned; the UI picks the years it wants to show.
 */
export function buildSchedule(loanAmount: number, annualRatePct: number, termYears: number): YearSplit[] {
  const monthly = monthlyPayment(loanAmount, annualRatePct, termYears)
  const r = annualRatePct / 100 / 12
  const months = Math.round(termYears * 12)
  const out: YearSplit[] = []
  let balance = loanAmount
  for (let year = 1; year <= termYears; year++) {
    let principal = 0
    let interest = 0
    for (let m = 0; m < 12; m++) {
      if (balance <= 0) break
      const interestPayment = balance * r
      // A final instalment can exceed the remaining balance when the term is rounded;
      // clamping keeps `remainingBalance` non-negative instead of flipping sign.
      const principalPayment = Math.min(monthly - interestPayment, balance)
      interest += interestPayment
      principal += principalPayment
      balance -= principalPayment
    }
    out.push({
      year,
      principalPaid: Math.round(principal),
      interestPaid: Math.round(interest),
      remainingBalance: Math.round(Math.max(0, balance)),
    })
  }
  return out
}

export function computeMortgage(input: MortgageInputs): MortgageResult {
  const price = Number.isFinite(input.price) && input.price > 0 ? input.price : 0
  const pct = Number.isFinite(input.downPaymentPct) ? Math.min(Math.max(input.downPaymentPct, 0), 100) : 0
  const term = Number.isFinite(input.termYears) && input.termYears > 0 ? input.termYears : 1
  const rate = Number.isFinite(input.ratePct) && input.ratePct >= 0 ? input.ratePct : 0

  const downPayment = price * (pct / 100)
  const loanAmount = price - downPayment
  const monthly = monthlyPayment(loanAmount, rate, term)
  const months = Math.round(term * 12)
  const totalPayment = monthly * months

  return {
    downPayment: Math.round(downPayment),
    loanAmount: Math.round(loanAmount),
    monthly: Math.round(monthly),
    totalPayment: Math.round(totalPayment),
    totalInterest: Math.round(totalPayment - loanAmount),
    schedule: buildSchedule(loanAmount, rate, term),
  }
}

export interface UpfrontCosts {
  transferFee: number
  registrationFee: number
  total: number
}

/**
 * Indicative UAE purchase costs. The 4% transfer fee and the AED 4,000 registration fee
 * are the figures the brief specifies; they are labelled indicative in the UI because the
 * transfer fee is normally split between buyer and seller and off-plan terms differ.
 */
export function upfrontCosts(price: number): UpfrontCosts {
  const transferFee = Math.round(price * (UAE_TRANSFER_FEE_PCT / 100))
  const registrationFee = price > 0 ? UAE_REGISTRATION_FEE_AED : 0
  return { transferFee, registrationFee, total: transferFee + registrationFee }
}
