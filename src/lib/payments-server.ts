// Payment kill switch — the SERVER's single source of truth.
//
// `src/lib/payments.ts` holds a client-side flag for the UI, but that module runs
// in the browser: it cannot read `process.env`, and nothing it decides can be
// trusted anyway, because the bundle is public and editable by the visitor. This
// module is the flag that actually refuses money.
//
// Default is FALSE. `PAYMENTS_ENABLED` must be explicitly set to the string
// "true" to activate, so a missing, empty, mis-cased or misspelled value all mean
// "off" — the failure mode of a typo is that payments stay disabled, never that
// they quietly switch on.
export const PAYMENTS_ENABLED = process.env.PAYMENTS_ENABLED === 'true'

/** The body every payment endpoint returns while the kill switch is engaged. */
export const PAYMENTS_BLOCKED = {
  error: 'Payments not yet active. Coming soon.',
  paymentsEnabled: false,
} as const

/**
 * Refuse a payment request while payments are disabled.
 *
 * Returns null when payments ARE enabled, so a real implementation can continue
 * without the guard leaking into the happy path:
 *
 *   const blocked = paymentsBlocked(c)
 *   if (blocked) return blocked
 */
export function paymentsBlocked(c: { json: (body: unknown, status: number) => Response }): Response | null {
  if (PAYMENTS_ENABLED) return null
  return c.json(PAYMENTS_BLOCKED, 503)
}
