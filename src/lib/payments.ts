// Payment Kill Switch — Single Source of Truth
// Spec §5: NOTHING processes payment anywhere on the site

export const PAYMENTS_ENABLED = false

export type ToastFn = (msg: string) => void
let _toast: ToastFn | null = null

export function registerToast(fn: ToastFn) { _toast = fn }

export function handlePaymentAttempt(
  e?: React.MouseEvent | React.TouchEvent | Event
) {
  if (e) {
    e.preventDefault()
    e.stopPropagation()
    if ('nativeEvent' in e) (e as React.MouseEvent).nativeEvent.stopImmediatePropagation()
  }
  _toast?.('Paid plans launching soon — you\'ll be the first to know.')
  console.info('[sqftLab] Payment attempt blocked — PAYMENTS_ENABLED=false')
  return false
}
