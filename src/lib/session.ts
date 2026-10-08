// Session bootstrap for the browser.
//
// IDENTITY IS AN OPAQUE SESSION TOKEN, issued by the server and verified against
// its `sessions` table. The browser presents it two ways:
//
//   1. an HttpOnly cookie — the default, and the better one;
//   2. an `X-Sqftlab-Session` header.
//
// Why both. The managed preview edge strips `Set-Cookie` from proxied API
// responses — measured: a sign-in through `*.preview.shogo.ai` returns a correct
// `{ ok: true }` body and exactly one `set-cookie`, the edge's own. The app's
// cookie never reaches the browser, so on that origin the cookie can never be
// established and every account-scoped call is anonymous. The header is the same
// secret travelling a route the edge does not rewrite.
//
// This is NOT the removed `Authorization: Bearer <userId>` bypass. That was a
// caller-supplied *identity* the server believed. This is a 32-byte random value
// the server minted and can look up; holding it IS the session. It lives in
// sessionStorage, so it dies with the tab and never outlives a browser restart.

const STORAGE_KEY = 'sqftlab.session'

function readStored(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY)
  } catch {
    // Storage can be unavailable (sandboxed iframe, some privacy modes). The
    // in-memory value still works for the life of the page load.
    return null
  }
}

function persist(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(STORAGE_KEY, token)
    else sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    /* see readStored */
  }
}

let sessionToken: string | null = readStored()
let cachedUserId: string | null = null
let inflight: Promise<string | null> | null = null

/** The identity the server resolved on this page load, once `ensureSession` has run. */
export function getCachedUserId(): string | null {
  return cachedUserId
}

/**
 * Adopt a token returned by a sign-in response.
 *
 * Call this with `null` on sign-out so nothing keeps presenting the old session.
 */
export function setSessionToken(token: string | null): void {
  sessionToken = token
  persist(token)
  // Any identity resolved under the previous token is now wrong.
  cachedUserId = null
  inflight = null
}

/**
 * Request headers carrying this session.
 *
 * Every `/api/sqftlab/*` call should go through this (or through `authedFetch`).
 * A plain `fetch` still sends the cookie where cookies survive, but on the
 * preview origin that is exactly what does not survive.
 */
export function sessionHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init)
  if (sessionToken) headers.set('X-Sqftlab-Session', sessionToken)
  return headers
}

/**
 * Ensure this browser has a session, and return the account it resolved to.
 *
 * Returns null when the server has no account to give (signed out, or no demo
 * account configured) — callers should treat null as "expect 401" rather than as
 * an error.
 */
export function ensureSession(): Promise<string | null> {
  if (cachedUserId) return Promise.resolve(cachedUserId)
  if (!inflight) {
    // Raw fetch on purpose: authedFetch() awaits this, so routing it back through
    // authedFetch would recurse.
    inflight = fetch('/api/sqftlab/me', { credentials: 'same-origin', headers: sessionHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: unknown) => {
        const parsed = body as { user?: { id?: string }; sessionToken?: string } | null
        // The server echoes the token it resolved, which is how a browser behind a
        // cookie-stripping edge learns it in the first place.
        if (parsed?.sessionToken && parsed.sessionToken !== sessionToken) {
          sessionToken = parsed.sessionToken
          persist(sessionToken)
        }
        cachedUserId = parsed?.user?.id ?? null
        return cachedUserId
      })
      .catch(() => null)
  }
  return inflight
}

/** Drop the cached identity without discarding the token (kept for callers that need it). */
export function resetSession(): void {
  cachedUserId = null
  inflight = null
}

/**
 * `fetch` with the caller's session attached.
 *
 * `credentials: 'same-origin'` is explicit rather than assumed: it is the browser
 * default for same-origin URLs, but the whole point of this helper is the
 * session, and a future edit that made the URL absolute would silently break
 * every account-scoped call if the intent were left implicit.
 */
export async function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  await ensureSession()
  return fetch(url, { ...init, credentials: 'same-origin', headers: sessionHeaders(init.headers) })
}
