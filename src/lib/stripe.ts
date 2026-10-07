/**
 * Stripe configuration — the single place the payment routes reach the SDK.
 *
 * Three departures from the Day 5 sketch, each because the sketch as written
 * cannot work in this codebase:
 *
 * 1. LAZY, NOT EAGER. The sketch built the client at module scope and threw when
 *    `STRIPE_SECRET_KEY` was unset. `custom-routes.ts` imports this file, so that
 *    throw would take down the ENTIRE API in every environment that has no Stripe
 *    keys — dev, preview, CI — turning the kill switch (which exists precisely so
 *    the site runs without payments) into a boot crash. Missing credentials are a
 *    runtime condition the payment routes report, never a startup failure.
 *
 * 2. NO `apiVersion`. The sketch pinned '2024-06-20'; stripe@23 types no such
 *    version (it ships 2026-09-30.endive) and pinning an old version against a new
 *    SDK is a live hazard. The SDK's own pinned version is used instead.
 *
 * 3. `current_period_end` MOVED. It is no longer a field on the Subscription; as of
 *    Stripe's 2025-03-31 API it lives on each subscription item. `subscriptionPeriodEnd()`
 *    reads it from there — see the helper.
 */
import Stripe from 'stripe'

let client: Stripe | null = null

/**
 * The Stripe client, or null when `STRIPE_SECRET_KEY` is absent. Callers must
 * handle null by answering 503 with `missingStripeEnv()` — never by throwing.
 */
export function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return null
  if (!client) client = new Stripe(key, { typescript: true })
  return client
}

/** Price IDs, created in the Stripe dashboard. Empty string means "not configured". */
export const PRICE_IDS = {
  pro_monthly: process.env.STRIPE_PRICE_PRO_MONTHLY ?? '',
  pro_annual: process.env.STRIPE_PRICE_PRO_ANNUAL ?? '',
  enterprise_monthly: process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY ?? '',
  enterprise_annual: process.env.STRIPE_PRICE_ENTERPRISE_ANNUAL ?? '',
  institutional_monthly: process.env.STRIPE_PRICE_INSTITUTIONAL_MONTHLY ?? '',
  institutional_annual: process.env.STRIPE_PRICE_INSTITUTIONAL_ANNUAL ?? '',
} as const

export type PriceKey = keyof typeof PRICE_IDS

/** Tiers a customer can buy. `free` is the absence of a subscription, not a product. */
export const PAID_PLANS = ['pro', 'enterprise', 'institutional'] as const
export type PaidPlan = (typeof PAID_PLANS)[number]

export const BILLING_PERIODS = ['monthly', 'annual'] as const
export type BillingPeriod = (typeof BILLING_PERIODS)[number]

export function isPaidPlan(v: unknown): v is PaidPlan {
  return typeof v === 'string' && (PAID_PLANS as readonly string[]).includes(v)
}

export function isBillingPeriod(v: unknown): v is BillingPeriod {
  return typeof v === 'string' && (BILLING_PERIODS as readonly string[]).includes(v)
}

/** The configured price for a plan+period, or null when that env var is unset. */
export function priceIdFor(plan: PaidPlan, billing: BillingPeriod): string | null {
  const id: string = PRICE_IDS[`${plan}_${billing}` as PriceKey]
  return id.length > 0 ? id : null
}

/**
 * Which Stripe env vars are still missing. Returned to the caller on a 503 so an
 * operator sees the exact gap instead of "payments unavailable" and a guess.
 */
export function missingStripeEnv(): string[] {
  const missing: string[] = []
  if (!process.env.STRIPE_SECRET_KEY) missing.push('STRIPE_SECRET_KEY')
  if (!process.env.STRIPE_WEBHOOK_SECRET) missing.push('STRIPE_WEBHOOK_SECRET')
  for (const key of Object.keys(PRICE_IDS) as PriceKey[]) {
    if (!PRICE_IDS[key]) missing.push(`STRIPE_PRICE_${key.toUpperCase()}`)
  }
  return missing
}

/**
 * End of the current billing period, in Unix seconds, or null.
 *
 * Stripe moved this off the subscription object and onto its items
 * (API 2025-03-31). Reading `subscription.current_period_end` no longer compiles,
 * and a subscription can carry several items, so the latest boundary wins — that
 * is the one the customer is actually billed against.
 */
export function subscriptionPeriodEnd(sub: Stripe.Subscription): number | null {
  let latest: number | null = null
  for (const item of sub.items?.data ?? []) {
    const end = item.current_period_end
    if (typeof end === 'number' && (latest === null || end > latest)) latest = end
  }
  return latest
}

/** The customer id off a Subscription, whose `customer` may be an expanded object. */
export function customerIdOf(value: string | Stripe.Customer | Stripe.DeletedCustomer): string {
  return typeof value === 'string' ? value : value.id
}

/**
 * Stripe's subscription status mapped onto THIS project's vocabulary.
 *
 * The schema documents `active | trialing | past_due | cancelled | inactive`.
 * Stripe spells it `canceled` (one L) and also emits `incomplete`, `unpaid`,
 * `paused` and `incomplete_expired`. Writing `sub.status` straight into the column
 * (as the sketch did) would put two spellings of "cancelled" in one column and
 * leak a vocabulary the rest of the app does not know. Anything not entitled
 * collapses to `inactive`; the raw Stripe value is worth logging, not storing.
 */
export function normalizeStripeStatus(status: Stripe.Subscription.Status): string {
  switch (status) {
    case 'active':
      return 'active'
    case 'trialing':
      return 'trialing'
    case 'past_due':
      return 'past_due'
    case 'canceled':
      return 'cancelled'
    default:
      return 'inactive'
  }
}
