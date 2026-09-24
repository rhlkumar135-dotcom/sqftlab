// Session bootstrap for the browser.
//
// Account-scoped API routes (portfolio, watchlist, alerts) now resolve the caller
// from the request instead of reading a hardcoded server-side user id, and answer
// 401 when there is none. `/api/sqftlab/me` is the identity bootstrap: it returns
// the current account, which the client then presents as a bearer token.
//
// This is identification, not authentication — the server takes the value at face
// value, so it is not a security boundary. It exists so the app has a per-caller
// identity to send instead of every visitor sharing one global account.

let cachedUserId: string | null = null
let inflight: Promise<string | null> | null = null

export function getCachedUserId(): string | null {
  return cachedUserId
}

export function ensureSession(): Promise<string | null> {
  if (cachedUserId) return Promise.resolve(cachedUserId)
  if (!inflight) {
    // Raw fetch on purpose: safeFetch() awaits this, so routing it back through
    // safeFetch would recurse.
    inflight = fetch('/api/sqftlab/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((body: unknown) => {
        const user = (body as { user?: { id?: string } } | null)?.user
        cachedUserId = user?.id ?? null
        return cachedUserId
      })
      .catch(() => null)
  }
  return inflight
}
