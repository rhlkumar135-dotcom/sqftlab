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
    // bare-fetch-ok: this IS the identity bootstrap. It has no identity to present yet,
    // and routing it through authedFetch would await itself.
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

/**
 * `fetch` with the caller's identity attached.
 *
 * Account-scoped routes resolve the caller FROM THE REQUEST, so a browser sending a
 * plain `fetch` arrives as a guest and is answered 401/403 no matter who is looking at
 * the screen. That is how the portfolio page came to show a "needs a Pro plan" paywall
 * to the very account that owns the holdings, and how an Enterprise user would have been
 * refused by the PDF export button.
 *
 * `ensureSession()` caches after its first call, so presenting the identity costs no
 * extra round-trip. Use this for anything under `/api/sqftlab/*` that is not public.
 */
export async function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const userId = await ensureSession()
  const headers = new Headers(init.headers)
  if (userId) headers.set('Authorization', `Bearer ${userId}`)
  return fetch(url, { ...init, headers })
}
