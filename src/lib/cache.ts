/**
 * A process-local TTL cache.
 *
 * The briefs for this project specify Redis for every cached route. This deployment has
 * no Redis — it is SQLite behind a single Bun process — so this is an in-process Map with
 * the same TTLs and the same caveat, which matters and is not a detail:
 *
 *   **It is PROCESS-LOCAL.** With more than one instance each process keeps its own copy,
 *   a write in one is invisible to the others until their entries expire, and there is no
 *   shared invalidation. Swap in Redis before scaling past one process.
 *
 * That caveat is also why writes invalidate explicitly rather than relying on the TTL:
 * a batch that recomputes a value can drop the stale entry itself, so a reader does not
 * serve yesterday's number for the rest of the window.
 *
 * Entry bodies are stored by reference. They are plain rows and computed results that no
 * caller mutates in place — `redactCommunityForGuest`, for instance, copies before
 * deleting keys — so sharing them is intentional and avoids a clone per read.
 */

interface Entry {
  body: unknown
  expiresAt: number
}

const store = new Map<string, Entry>()

/** The TTLs, named so a route does not carry a bare millisecond literal. */
export const CACHE_TTL = {
  /** Transaction aggregations. */
  transactions: 60 * 60 * 1000,
  /** Investment scores. */
  scores: 6 * 60 * 60 * 1000,
  /** Community lists and detail. */
  communities: 30 * 60 * 1000,
  /** Building scorecards. */
  buildings: 30 * 60 * 1000,
  /** Cross-border capital flow. */
  capitalFlow: 6 * 60 * 60 * 1000,
  /** Rental yield. */
  yield: 12 * 60 * 60 * 1000,
} as const

export function cacheRead<T>(key: string): T | null {
  const hit = store.get(key)
  if (!hit) return null
  if (hit.expiresAt <= Date.now()) {
    store.delete(key)
    return null
  }
  return hit.body as T
}

export function cacheWrite(key: string, body: unknown, ttlMs: number): void {
  store.set(key, { body, expiresAt: Date.now() + ttlMs })
  // The key space is bounded by the data it describes, so this is a safety valve rather
  // than a real eviction policy — it stops a pathological caller passing arbitrary keys
  // from pinning memory in a long-lived process.
  if (store.size > 500) {
    const now = Date.now()
    for (const [k, v] of store) if (v.expiresAt <= now) store.delete(k)
  }
}

/**
 * Drop every entry whose key starts with `prefix`. Returns how many were removed.
 * Used on write paths so a fresh value is visible immediately instead of after the TTL.
 */
export function cacheInvalidate(prefix: string): number {
  let removed = 0
  for (const k of [...store.keys()]) {
    if (k.startsWith(prefix)) {
      store.delete(k)
      removed++
    }
  }
  return removed
}

/** Everything. Escape hatch for a sync that rewrites a whole table. */
export function cacheClear(): void {
  store.clear()
}

/** Test/diagnostic helper — never used to make a request-time decision. */
export function cacheSize(): number {
  return store.size
}
