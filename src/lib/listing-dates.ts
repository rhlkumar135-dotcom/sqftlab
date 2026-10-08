/**
 * Resolving a listing's "first listed" date.
 *
 * A CORRECTION I HAD TO MAKE TO MY OWN FIX. My first version of this clamped ANY future
 * `listed_date` down to the crawl moment, on the reasoning that a listing cannot be listed
 * after we saw it. That reasoning assumes our clock is right — and on this runtime it is
 * not: the sandbox clock ran **48 hours behind** real time, verified against the `Date`
 * header of three independent external servers (google.com, propertyfinder.ae,
 * news.google.com all said 10 Oct while the sandbox said 8 Oct). So the "future" dates were
 * not anomalous at all. They were correct portal dates, and clamping them rewrote real data
 * with a lagging timestamp — the fix caused the very corruption it was written to prevent.
 *
 * The lesson is that `listed_at` comes from the portal's clock and `scraped_at` from ours, so
 * the two are only comparable when both clocks agree. This version therefore does NOT treat
 * "ahead of our clock" as an error. It only replaces a value that is genuinely unusable —
 * absent, null (which `new Date()` silently turns into 1970) or unparseable — or one so far
 * ahead that it must be a parse fault rather than a clock disagreement.
 *
 * `scripts/check-clock.ts` reports the skew directly, because a lagging clock corrupts every
 * "last N days" window and every relative timestamp in the product, and that is worth seeing
 * rather than inferring.
 */

export interface ResolvedListedAt {
  listedAt: Date
  /** True when the supplied value was missing or unusable and the crawl moment was used. */
  fellBack: boolean
}

/**
 * How far ahead of our clock a source date may be before we treat it as a parse fault
 * instead of clock disagreement. Thirty days is far beyond any legitimate listing date or
 * plausible drift, but well inside the range a unit error would produce.
 */
const MAX_PLAUSIBLE_FUTURE_MS = 30 * 24 * 60 * 60 * 1000

let fallbackCount = 0

/** How many values were missing or unusable in this process. */
export function listedAtFallbackCount(): number {
  return fallbackCount
}

export function resetListedAtFallbackCount(): void {
  fallbackCount = 0
}

/**
 * Resolve a portal date field to something storable.
 *
 * `raw` is deliberately `unknown`: it arrives from untyped JSON and has been seen as a
 * string, null, and absent.
 */
export function resolveListedAt(raw: unknown, now: number = Date.now()): ResolvedListedAt {
  const parsed = typeof raw === 'string' || typeof raw === 'number' ? new Date(raw) : new Date(Number.NaN)

  if (Number.isNaN(parsed.getTime())) {
    fallbackCount += 1
    return { listedAt: new Date(now), fellBack: true }
  }

  if (parsed.getTime() - now > MAX_PLAUSIBLE_FUTURE_MS) {
    fallbackCount += 1
    return { listedAt: new Date(now), fellBack: true }
  }

  // Kept exactly as the portal stated it, including a date modestly ahead of our clock.
  return { listedAt: parsed, fellBack: false }
}
