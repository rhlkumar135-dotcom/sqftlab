import { Hono } from 'hono'
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { randomBytes, createHash } from 'node:crypto'
import { resolveCname } from 'node:dns/promises'
import { prisma } from './src/lib/db'
import { notifyPendingMatches, recentMatches, scanDealAlerts } from './src/lib/alerts'
import { publish, subscribe, streamStatus, recentMessages } from './src/lib/events'
import { detectDeals, marketPsfByCommunity } from './src/lib/deals'
import { findCommunityByName, invalidateCommunityCache } from './src/lib/community-match'
import { runHourlyRefresh, recentCronRuns, HOURLY_JOB } from './src/lib/cron'
import {
  runIntelligencePipeline, computeYieldCurve, migrationSurges, applyScenario,
  computeRealPriceIndex, computeBuildingProfiles, computeSupplyPipeline,
  computeInstitutionalFlow, computeMigrationSignal, computeDistrictMetrics,
  computeMarketSummary, latestDistrictMetrics, ALL_BEDS,
} from './src/lib/intelligence'
import { fetchAllMacro, fetchExchangeRates } from './src/lib/macro'
import { computeInvestmentScore, computeAllInvestmentScores, latestInvestmentScores } from './src/lib/score-engine'
import { cacheRead, cacheWrite, CACHE_TTL } from './src/lib/cache'
import { PAYMENTS_ENABLED, paymentsBlocked } from './src/lib/payments-server'
import {
  getStripe, priceIdFor, missingStripeEnv, isPaidPlan, isBillingPeriod,
  subscriptionPeriodEnd, customerIdOf, normalizeStripeStatus, PAID_PLANS, BILLING_PERIODS,
} from './src/lib/stripe'
import { dldConfigured } from './src/lib/dld'
import { dldReferenceCounts } from './src/lib/dld-open'
import { adrecConfigured } from './src/lib/adrec'
import { auditEnv } from './src/lib/env-audit'
import {
  computeCma, MIN_COMPS, COMP_WINDOW_DAYS, SIZE_TOLERANCE, CMA_CONDITIONS,
  type CmaCondition, type CmaSubject,
} from './src/lib/cma'
import { generatePropertyReport, PdfUnavailableError } from './src/lib/pdf-generator'
import { computeCapitalFlow, type CapitalFlowResult } from './src/lib/capital-flow'
import { computeRentalYield, type RentalYieldResult } from './src/lib/rental-yield'
import { computeDeveloperPositioning, getBuildingScorecard, searchBuildings, type BuildingScorecard } from './src/lib/buildings'
import { propertyLimitFor, deriveHolding, summariseHoldings, valuateHolding } from './src/lib/portfolio'
import { fetchHoldingsComparables } from './src/lib/portfolio-jobs'
import {
  buildConfirmation,
  buildDigest,
  isStopKeyword,
  isWhatsappConfigured,
  normaliseE164,
  sendWhatsapp,
} from './src/lib/whatsapp'
import {
  buildTransactionWhere, fetchExportRows, toCsv, toExcelBuffer,
  rowLimitFor, EXCEL_MIN_RANK, SAFETY_CEILING,
  type ExportFilters, type ExportFormat,
} from './src/lib/export-data'
import {
  AI_HISTORY_PAGE, AI_MAX_MESSAGE_CHARS, AI_MODEL, MARKET_CONTEXT_DAYS,
  aiDailyLimitFor, aiTierIsUnlimited,
  buildMarketContext, buildSystemPrompt, generateAssistantReply,
  normalizeHistory, resolveAiCredential,
} from './src/lib/ai-chat'

// Hono needs the context variables declared for `c.set`/`c.get` to type-check.
// `guestId` is the anonymous-visitor cookie value; `tier` is resolved once per
// request by the tier middleware (Day 4 Task A). `apiKeyUserId`/`apiKeyTier` are
// set by the /v1 API-key middleware (Day 11 Task A) and identify a caller that
// authenticated with a key instead of a session. `whiteLabelConfig` is set by the
// host middleware (Day 17 Task B) when the request arrived on a verified
// white-label domain.
//
// Declared structurally rather than imported from the generated Prisma client so
// this file does not break when the client is regenerated mid-edit.
type WhiteLabelRow = {
  id: string
  userId: string
  clientName: string
  brandColor: string
  logoUrl: string | null
  customDomain: string | null
  customDomainVerified: boolean
  attributionText: string | null
  hideSqftLabBrand: boolean
  dailyLimit: number
  monthlyLimit: number
  active: boolean
}

type AppVariables = {
  guestId: string
  tier: CallerTier
  apiKeyUserId?: string
  apiKeyTier?: string
  whiteLabelConfig?: WhiteLabelRow
}

const app = new Hono<{ Variables: AppVariables }>()

// ─── Environment audit (Day 17 Task E3) ──────────────────────────────────────
//
// Runs once at import. See src/lib/env-audit.ts for why the variable list is derived from
// what the code reads rather than copied from the brief.
auditEnv()

// ─── CORS ────────────────────────────────────────────────────────────────────
//
// This lives here, not only in server.tsx, because server.tsx is REGENERATED
// whenever prisma/schema.prisma changes — which silently reverted the copy there
// during this work. custom-routes.ts is never regenerated, so this is the durable
// place for cross-cutting API middleware.
//
// The origin is always REFLECTED, never `*` — a wildcard lets any site read this
// API using the visitor's cookies and cannot be combined with `credentials`.
// An origin that is not on the list gets the CORS headers *deleted* rather than
// merely unset, because `server.tsx` is regenerated by the SDK and a generated
// copy can re-add `Access-Control-Allow-Origin: *` to every /api response.
const ALLOWED_ORIGINS = [
  'https://sqftlab.com',
  'https://www.sqftlab.com',
  'https://app.sqftlab.com',
]

// Development-only extra origins. The Vite client (5173) and the API (3001) are
// different origins, and the canvas preview serves the SPA from a *.shogo.ai
// host, so neither can be in the production list. Widening here cannot re-open
// the deployed API — the deployed process runs with NODE_ENV=production.
const DEV_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$|^https:\/\/[a-z0-9-]+\.shogo\.ai$/i

function originAllowed(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true
  if (process.env.NODE_ENV !== 'production' && DEV_ORIGIN.test(origin)) return true
  return false
}

// ─── Security headers (Day 17 Task E2) ───────────────────────────────────────
//
// Registered FIRST so it wraps every other middleware and handler, including the
// CORS pre-flight below (which answers OPTIONS without calling next()) and the
// JSON error responses produced by the tier and API-key guards.
//
// Written after `await next()` rather than before it: setting a header before next()
// writes to a Response object that the handler then replaces, so the header is lost.
// The CORS block below documents the same trap.
app.use('*', async (c, next) => {
  await next()
  try {
    c.res.headers.set('X-Content-Type-Options', 'nosniff')
    // DENY rather than SAMEORIGIN: this API is never framed, and the SPA it shares a
    // host with renders no iframes.
    c.res.headers.set('X-Frame-Options', 'DENY')
    // Deprecated by every current browser in favour of CSP, and ignored when a CSP is
    // present — kept because the launch checklist asks for it and it is harmless.
    c.res.headers.set('X-XSS-Protection', '1; mode=block')
    c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
    c.res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    // HSTS only under production. Enabling it in dev would pin localhost to https for
    // a year in the developer's browser and is not reversible from here.
    if (process.env.NODE_ENV === 'production') {
      c.res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    }
  } catch {
    // Response already committed (streaming) — headers are best-effort, as with the
    // guest cookie below.
  }
})

app.use('*', async (c, next) => {
  const origin = c.req.header('Origin') ?? ''
  // No Origin header means same-origin or server-to-server: CORS does not apply,
  // so there is nothing to allow and nothing to block.
  const reflect = origin !== '' && originAllowed(origin)

  if (c.req.method === 'OPTIONS') {
    if (reflect) {
      c.res.headers.set('Access-Control-Allow-Origin', origin)
      c.res.headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
      c.res.headers.set('Access-Control-Allow-Headers', 'Content-Type,Authorization')
      c.res.headers.set('Access-Control-Expose-Headers', 'Content-Length')
      c.res.headers.set('Access-Control-Max-Age', '86400')
      c.res.headers.set('Vary', 'Origin')
    }
    // `c.text('', 204)` fails Hono's typings: 204 is not a ContentfulStatusCode
    // because it must carry no body. `c.body(null, 204)` is the correct form.
    return c.body(null, 204)
  }

  await next()

  // Applied AFTER next() so the headers land on the handler's final response.
  // Setting them before next() writes to a response object the handler then
  // replaces, which is why the wildcard could survive the earlier fix.
  if (reflect) {
    c.res.headers.set('Access-Control-Allow-Origin', origin)
    c.res.headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
    c.res.headers.set('Access-Control-Allow-Headers', 'Content-Type,Authorization')
    c.res.headers.set('Access-Control-Expose-Headers', 'Content-Length')
  } else {
    c.res.headers.delete('Access-Control-Allow-Origin')
    c.res.headers.delete('Access-Control-Allow-Methods')
    c.res.headers.delete('Access-Control-Allow-Headers')
    c.res.headers.delete('Access-Control-Expose-Headers')
  }
  // Reflecting the Origin makes the response vary by it; without Vary a shared
  // cache could hand one origin's response (and its CORS headers) to another.
  c.res.headers.set('Vary', 'Origin')
})

// ─── Guest sessions (Task B) ─────────────────────────────────────────────────
//
// Anonymous visitors get a `sqftlab_guest` cookie so their browsing is
// attributed if they later register. Two deliberate departures from the spec
// sketch, both to avoid a database write on every request:
//
//   1. The middleware only mints/reads the cookie. The GuestSession ROW is
//      created lazily by `ensureGuestSession()`, which runs on the first tracked
//      event. Inserting from the middleware would add a row for every health
//      probe, cron call and bot hit.
//   2. `pagesViewed` is incremented from `trackEvent`, not the middleware, for
//      the same reason.

const GUEST_COOKIE = 'sqftlab_guest'
const GUEST_MAX_AGE = 30 * 24 * 3600 // 30 days, per spec

function readGuestId(c: Context): string | null {
  const cookie = c.req.header('Cookie') ?? ''
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${GUEST_COOKIE}=([^;]+)`))
  return m ? decodeURIComponent(m[1]) : null
}

app.use('*', async (c, next) => {
  const existing = readGuestId(c)
  let minted: string | null = null

  if (existing) {
    c.set('guestId', existing)
  } else if (c.req.method !== 'OPTIONS') {
    const fresh = randomBytes(16).toString('hex')
    minted = fresh
    c.set('guestId', fresh)
  }

  await next()

  if (minted) {
    try {
      c.res.headers.append(
        'Set-Cookie',
        `${GUEST_COOKIE}=${minted}; Path=/; Max-Age=${GUEST_MAX_AGE}; SameSite=Lax`,
      )
    } catch {
      // Response already committed (streaming) — the cookie is best-effort.
    }
  }
})

// ─── Tier middleware (Day 4 Task A) ──────────────────────────────────────────
//
// Resolves the caller's tier ONCE per request and attaches it to the context.
// `getCallerTier()` used to be awaited inside seven separate handlers, so a single
// page load that touched a handful of tier-aware routes paid for the same
// `prisma.user.findUnique` repeatedly.
//
// The brief specifies Redis with a 5-minute TTL. This project has no Redis — the
// stack is SQLite behind a single Bun process — so the cache is an in-process Map
// with the same TTL. That is a real semantic difference, not a detail: the map is
// PROCESS-LOCAL, so with more than one instance a subscription change would take
// up to 5 minutes to propagate across them, and each instance would still do its
// own lookups. Swap in Redis before scaling past one process.
const TIER_TTL_MS = 300_000
const tierCache = new Map<string, { tier: CallerTier; expiresAt: number }>()

/** Drop a cached tier immediately — call this whenever a subscription changes. */
export function invalidateTier(userId: string): void {
  tierCache.delete(userId)
}

function readCachedTier(userId: string): CallerTier | null {
  const hit = tierCache.get(userId)
  if (!hit) return null
  if (hit.expiresAt <= Date.now()) {
    tierCache.delete(userId)
    return null
  }
  return hit.tier
}

app.use('*', async (c, next) => {
  const userId = getUserId(c)
  if (!userId) {
    c.set('tier', 'guest')
    await next()
    return
  }

  const cached = readCachedTier(userId)
  if (cached) {
    c.set('tier', cached)
    await next()
    return
  }

  // A lookup failure must not deny access. Middleware that every route depends on
  // cannot be allowed to throw a 500, and the safe default is the entry tier.
  let tier: CallerTier = 'free'
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { subscriptionTier: true, subscriptionStatus: true },
    })
    if (user && (user.subscriptionStatus === 'active' || user.subscriptionStatus === 'trialing')) {
      tier = (user.subscriptionTier ?? 'free') as CallerTier
    }
  } catch {
    tier = 'free'
  }

  tierCache.set(userId, { tier, expiresAt: Date.now() + TIER_TTL_MS })
  c.set('tier', tier)
  await next()
})

// ─── Tier gate (Day 4 Task B) ────────────────────────────────────────────────
//
// NOTE (deliberate contract change): Day 1's Task B3 specified 401 for a guest
// hitting a subscriber-only route, and `upgradeRequired()` below still does that
// wherever it is used. Day 4 asks for a single rank-based gate that answers 403
// with `requiredTier`/`upgradeUrl`, which necessarily includes guests — rank 0 is
// below every paid tier. The two cannot both be true for the same request, so the
// routes named in Day 4 now return 403. scripts/verify-day1.ts and
// scripts/verify-fixes.ts were updated to assert the new status *and* the payload,
// so no coverage was dropped.
// The rank ladder is the schema's own: `free | pro | elite | enterprise |
// institutional` (see the note on User.subscriptionTier). The brief's version
// omitted `elite`, and because an unknown key fell back to 0 that omission was not
// harmless — it silently demoted `elite` to GUEST rank. The seeded demo account,
// which is the identity the whole site runs as, is `elite`, so Portfolio, Alerts
// and API keys would have 403'd the app's own user and the rate limiter would have
// capped it at the guest allowance. Any tier added to the schema must be added
// here too; an unrecognised tier deliberately ranks 0 (deny) rather than being
// allowed to inherit a paid rank.
const TIER_RANK: Record<string, number> = {
  guest: 0,
  free: 1,
  pro: 2,
  elite: 3,
  enterprise: 4,
  institutional: 5,
}

function requireTier(c: Context, minTier: CallerTier, featureName: string): Response | null {
  const current = (c.get('tier') as CallerTier | undefined) ?? 'guest'
  if ((TIER_RANK[current] ?? 0) >= (TIER_RANK[minTier] ?? 99)) return null

  return c.json(
    {
      error: 'Upgrade required',
      feature: featureName,
      currentTier: current,
      requiredTier: minTier,
      upgradeUrl: '/pricing',
      limited: true,
    },
    403,
  )
}

// ─── API rate limiter (Day 4 Task D) ─────────────────────────────────────────
const RATE_LIMITS: Record<string, number> = {
  guest: 20,
  free: 60,
  pro: 300,
  elite: 500,
  enterprise: 1000,
  institutional: 5000,
}

// Shared by every caller we cannot tell apart — see the limiter below. High enough
// that it can never catch real browsing (a page load is 4 requests; the whole guest
// allowance is 20/min), low enough that a script is stopped within a minute.
const ANON_CEILING = 600

// In-process fixed-window counter, process-local for the same no-Redis reason as
// the tier cache: each instance enforces its own window rather than a shared one.
const rateWindows = new Map<string, { count: number; expiresAt: number }>()

app.use('/sqftlab/*', async (c, next) => {
  // A long-lived SSE stream is one request that stays open, not a request rate.
  // Counting it would let a single reconnecting stream burn the whole window
  // without the visitor doing anything.
  if (c.req.header('Accept')?.includes('text/event-stream')) {
    await next()
    return
  }

  const tier = (c.get('tier') as CallerTier | undefined) ?? 'guest'
  const userId = getUserId(c)
  // Who gets which bucket.
  //
  // The guest middleware mints an id for any request arriving without one, so
  // `guestId` alone cannot tell a returning visitor from a first-time script: keyed
  // on it, a cookie-less client gets a fresh bucket per request and is unlimited.
  // Measured on the origin — `X-RateLimit-Remaining` stayed pinned at 19 across four
  // anonymous requests while the same four sent with a cookie stepped 19 → 18 → 17 → 16.
  //
  // Keying on the client address instead is NOT safe here: measured through the
  // deployed edge, every visitor arrives with socket address ::ffff:127.0.0.1 and no
  // forwarding headers at all — cf-connecting-ip, x-forwarded-for and x-real-ip are
  // all absent — so an address key would collapse the whole internet into ONE bucket
  // and 429 the entire site.
  //
  // So: a client that PRESENTS a guest cookie keeps its own per-visitor bucket, and
  // everything else shares one ceiling. That ceiling is deliberately generous — far
  // above any real browsing pattern (the SPA's initial load is 4 requests) — because
  // its job is to bound a script, not to police visitors. Genuine per-client control
  // has to come from the edge, which does impose its own limit.
  const presentedGuestId = readGuestId(c)
  const identity = userId ?? presentedGuestId ?? 'anon:no-cookie'

  const windowStart = Math.floor(Date.now() / 60_000)
  const key = `${identity}:${windowStart}`
  const prior = rateWindows.get(key)
  const current = prior && prior.expiresAt > Date.now() ? prior.count + 1 : 1
  rateWindows.set(key, { count: current, expiresAt: (windowStart + 1) * 60_000 + 1_000 })

  // Opportunistic sweep, so a long-lived process cannot grow this map forever.
  if (rateWindows.size > 5_000) {
    const now = Date.now()
    for (const [k, v] of rateWindows) if (v.expiresAt <= now) rateWindows.delete(k)
  }

  // An unrecognised tier ranks as a guest (the safe direction for privileges), but
  // throttling an authenticated account down to the anonymous allowance over a
  // naming mismatch punishes the wrong party — fall back on whether an account is
  // actually present.
  const limit = userId
    ? RATE_LIMITS[tier] ?? RATE_LIMITS.free
    : presentedGuestId
      ? RATE_LIMITS.guest
      : ANON_CEILING
  c.header('X-RateLimit-Limit', String(limit))
  c.header('X-RateLimit-Remaining', String(Math.max(0, limit - current)))
  c.header('X-RateLimit-Reset', String((windowStart + 1) * 60))

  if (current > limit) {
    return c.json({ error: 'Rate limit exceeded', retryAfter: 60, upgradeUrl: '/pricing' }, 429)
  }

  await next()
})

/** Creates the GuestSession row for the current cookie. Never fatal. */
async function ensureGuestSession(c: Context, opts: { touch?: boolean } = {}): Promise<void> {
  const guestId = c.get('guestId') as string | undefined
  if (!guestId) return
  try {
    const url = new URL(c.req.url)
    await prisma.guestSession.upsert({
      where: { id: guestId },
      create: {
        id: guestId,
        referrer: c.req.header('Referer') ?? null,
        utmSource: url.searchParams.get('utm_source'),
        utmMedium: url.searchParams.get('utm_medium'),
        utmCampaign: url.searchParams.get('utm_campaign'),
        lastSeenAt: new Date(),
      },
      update: opts.touch
        ? { lastSeenAt: new Date(), pagesViewed: { increment: 1 } }
        : { lastSeenAt: new Date() },
    })
  } catch {
    // Never fail a request over anonymous-session bookkeeping.
  }
}

type CallerTier = 'guest' | 'free' | 'pro' | 'elite' | 'enterprise' | 'institutional'

/**
 * What the caller is allowed to see.
 *
 * NOTE: `getUserId()` reads a caller-supplied identifier — it IDENTIFIES, it does
 * not AUTHENTICATE. This gate controls the *product experience* (what a guest may
 * browse), not access control: anyone can claim any id by sending it as a bearer
 * token. Security requires the auth layer, not a different tier check.
 *
 * The tier is resolved once per request by the tier middleware above and read
 * with `c.get('tier')`; see `requireTier()` to gate a route on a minimum tier.
 */

/** 401 for a guest hitting a subscriber-only endpoint. */
function upgradeRequired(c: Context) {
  return c.json(
    {
      error: 'Unauthorized',
      limited: true,
      message: 'This feature needs a free sqftLab account. Sign in to continue.',
      signInUrl: '/auth/signin',
    },
    401,
  )
}

/** Fire-and-forget analytics. Never let tracking break a request. */
async function trackEvent(c: Context, eventType: string, data?: Record<string, unknown>): Promise<void> {
  try {
    const userId = getUserId(c)
    const guestId = (c.get('guestId') as string | undefined) ?? null
    await prisma.userEvent.create({
      data: {
        userId: userId ?? null,
        guestId: userId ? null : guestId,
        eventType,
        eventData: data ? JSON.stringify(data) : null,
        page: new URL(c.req.url).pathname,
        referrer: c.req.header('Referer') ?? null,
        userAgent: c.req.header('User-Agent')?.slice(0, 200) ?? null,
      },
    })
    if (!userId) await ensureGuestSession(c, { touch: eventType === 'page_view' })
  } catch {
    // Fire-and-forget.
  }
}

// ─── Health & diagnostics ─────────────────────────────────────────────────────

// Report the *shape* of DATABASE_URL without leaking credentials. The literal
// "${{Postgres.DATABASE_URL}}" string is the classic Railway misconfiguration:
// the placeholder was written as a value instead of resolved as a reference.
function redactDbUrl(raw?: string) {
  if (!raw) return 'unset'
  if (raw.startsWith('${{')) return `UNRESOLVED_PLACEHOLDER:${raw}`
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.username ? '***@' : ''}${u.host}${u.pathname}`
  } catch {
    return `malformed:${raw.slice(0, 16)}`
  }
}

// Deep health check (Day 17 Task E1).
//
// `/health/db` below is a database-only readiness probe. This is the full system
// status the launch checklist asks for, and it is deliberately able to FAIL: the
// checklist item is "GET /health → status healthy", which is worthless if the
// endpoint cannot return anything else.
//
// Two deviations from the brief, both because it assumes infrastructure this
// deployment does not have:
//
//  · It pings Redis. There is no Redis here — the stack is SQLite behind one Bun
//    process, and the cache is an in-process Map (src/lib/cache.ts). The cache is
//    still checked for real (a write/read round-trip), and `redis` is reported as
//    `not_configured` so the checklist's expectation is visibly addressed rather
//    than silently dropped.
//  · It reads `npm_package_version`, which is unset under `bun run`. Falls back to
//    package.json's version through an env var that IS set at runtime.
const HEALTH_VERSION = process.env.APP_VERSION ?? process.env.npm_package_version ?? '1.0.0'

app.get('/health', async (c) => {
  const checks: Record<string, 'ok' | 'error' | 'not_configured'> = {}

  try {
    await prisma.$queryRaw`SELECT 1`
    checks.database = 'ok'
  } catch {
    checks.database = 'error'
  }

  // A real round-trip, not an assertion that the module loaded: write then read
  // the same key, and require the value to come back.
  try {
    const probe = `health:${Date.now()}`
    cacheWrite(probe, 1, 5_000)
    checks.cache = cacheRead<number>(probe) === 1 ? 'ok' : 'error'
  } catch {
    checks.cache = 'error'
  }

  checks.redis = 'not_configured'

  const failing = Object.entries(checks).filter(([, v]) => v === 'error').map(([k]) => k)
  const allOk = failing.length === 0
  return c.json(
    {
      status: allOk ? 'healthy' : 'degraded',
      checks,
      failing,
      version: HEALTH_VERSION,
      ts: new Date().toISOString(),
    },
    allOk ? 200 : 503,
  )
})

// Readiness probe — reports real DB connectivity plus the resolved error, so a
// misconfigured database surfaces as readable JSON instead of an empty site.
app.get('/health/db', async (c) => {
  const url = redactDbUrl(process.env.DATABASE_URL)
  try {
    const communities = await prisma.community.count()
    const listings = await prisma.listing.count()
    return c.json({ ok: true, db: 'connected', url, communities, listings })
  } catch (e) {
    return c.json(
      { ok: false, db: 'unreachable', url, error: e instanceof Error ? e.message : String(e) },
      503,
    )
  }
})

// ─── Communities ──────────────────────────────────────────────────────────────

app.get('/sqftlab/communities', async (c) => {
  const emirate = c.req.query('emirate')
  const search = c.req.query('search')
  const where: Record<string, unknown> = {}
  if (emirate && emirate !== 'all') where.emirate = emirate
  if (search) where.nameEn = { contains: search }

  const communities = await prisma.community.findMany({
    where,
    orderBy: { medianAedSqft: 'desc' },
    select: {
      id: true, slug: true, nameEn: true, nameAr: true, emirate: true,
      latitude: true, longitude: true, medianAedSqft: true, medianAnnualRentAed: true,
      grossYieldPct: true, neighbourhoodScore: true, priceChange30d: true,
      priceChange1y: true, transactionCount30d: true, totalTransactions: true,
      // Provenance of `medianAedSqft`: 'dld' (government register), 'listing'
      // (asking prices, 15–30% above transacted) or 'none'. Without it a caller
      // cannot tell a measured number from an asking-price stand-in.
      psfSource: true,
      scoreSchools: true, scoreHealthcare: true, scoreMetro: true,
      scoreRetail: true, scoreParks: true, scoreWorship: true,
    },
  })

  // Per-district deal count, for the heatmap's Deals layer and the district
  // side panel. One grouped query rather than a count per community, which
  // would be N+1 across every district.
  const dealGroups = await prisma.listing.groupBy({
    by: ['communityId'],
    where: { isDeal: true },
    _count: { _all: true },
  })
  const dealsByCommunity = new Map(dealGroups.map((g) => [g.communityId, g._count._all]))

  // Task B3 — guests get a teaser (6 of 39 districts); signed-in callers get all.
  const tier = c.get('tier') as CallerTier
  const enriched = communities.map((x) => ({ ...x, dealCount: dealsByCommunity.get(x.id) ?? 0 }))
  const visible = tier === 'guest' ? enriched.slice(0, 6) : enriched

  await trackEvent(c, 'community_list', { tier, returned: visible.length, total: enriched.length })

  return c.json({
    communities: visible,
    ...(tier === 'guest'
      ? { limited: true, message: 'Sign in to see all communities', signInUrl: '/auth/signin' }
      : {}),
  })
})

// Fields that make up the paid neighbourhood-score breakdown. Guests see the
// single headline score, not the components.
const GUEST_HIDDEN_COMMUNITY_FIELDS = [
  'scoreSchools', 'scoreHealthcare', 'scoreMetro', 'scoreRetail', 'scoreParks', 'scoreWorship',
] as const

function redactCommunityForGuest<T extends Record<string, unknown>>(community: T) {
  const out: Record<string, unknown> = { ...community }
  for (const k of GUEST_HIDDEN_COMMUNITY_FIELDS) delete out[k]
  return out
}

// Day 15 D2 — the detail ROW is cached, not the response. Both alternatives a response
// cache would break: the guest tier gets a redacted payload from this same URL (so a
// response cache needs per-tier keys and could serve the paid one to a guest), and
// `trackEvent` must still fire on every view. Caching only the database read keeps both
// behaviours intact while removing the two queries per request.
async function loadCommunityDetail(slug: string) {
  return prisma.community.findUnique({
    where: { slug },
    include: {
      listings: { where: { purpose: 'sale' }, orderBy: { listedAt: 'desc' }, take: 10 },
      _count: { select: { transactions: true, listings: true } },
    },
  })
}
type CommunityDetail = NonNullable<Awaited<ReturnType<typeof loadCommunityDetail>>>

app.get('/sqftlab/communities/:slug', async (c) => {
  const slug = c.req.param('slug')
  const detailKey = `sqftlab:community:detail:${slug}`
  let community = cacheRead<CommunityDetail>(detailKey)
  if (!community) {
    community = await loadCommunityDetail(slug)
    // A miss is deliberately NOT cached: a community added later would otherwise stay a
    // 404 for the whole TTL, the same reasoning as the uncached empty capital-flow result.
    if (community) cacheWrite(detailKey, community, CACHE_TTL.communities)
  }
  if (!community) return c.json({ error: 'Community not found' }, 404)

  // Task B3 — guests see headline metrics but not the score breakdown, and no
  // nationality mix. (This payload carries no nationality data at all, so there
  // is nothing to redact for that part; the breakdown is the real gate.)
  const tier = c.get('tier') as CallerTier
  await trackEvent(c, 'community_view', { slug, tier })

  if (tier === 'guest') {
    return c.json({
      community: redactCommunityForGuest(community),
      limited: true,
      message: 'Sign in to see the full neighbourhood score breakdown.',
      signInUrl: '/auth/signin',
    })
  }
  return c.json({ community })
})

app.get('/sqftlab/communities/:slug/transactions', async (c) => {
  const slug = c.req.param('slug')
  const page = parseInt(c.req.query('page') || '1')
  const limit = parseInt(c.req.query('limit') || '50')
  const propertyType = c.req.query('type')
  const beds = c.req.query('beds')

  const community = await prisma.community.findUnique({ where: { slug } })
  if (!community) return c.json({ error: 'Community not found' }, 404)

  const where: Record<string, unknown> = { communityId: community.id }
  if (propertyType) where.propertyType = propertyType
  if (beds) where.beds = parseInt(beds)

  const [transactions, total] = await Promise.all([
    prisma.transaction.findMany({
      where,
      orderBy: { transactionDate: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.transaction.count({ where }),
  ])

  return c.json({ transactions, total, page, limit, pages: Math.ceil(total / limit) })
})

app.get('/sqftlab/communities/:slug/listings', async (c) => {
  const slug = c.req.param('slug')
  const purpose = c.req.query('purpose') || 'sale'
  const beds = c.req.query('beds')
  const dealsOnly = c.req.query('deals') === 'true'

  const community = await prisma.community.findUnique({ where: { slug } })
  if (!community) return c.json({ error: 'Community not found' }, 404)

  const where: Record<string, unknown> = { communityId: community.id, purpose }
  if (beds) where.beds = parseInt(beds)
  if (dealsOnly) where.isDeal = true

  const listings = await prisma.listing.findMany({
    where,
    orderBy: { listedAt: 'desc' },
    take: 50,
  })
  return c.json({ listings })
})

// ─── Price trend (real DLD transaction aggregation) ──────────────────────────

// `Transaction.transactionType` stores lowercase values (`sale`,
// `off_plan_sale`, `mortgage`). The spec's SQL sample filtered on 'Sales',
// which matches no row in this schema.
const SALE_TXN_TYPES = ['sale', 'off_plan_sale']

app.get('/sqftlab/communities/:slug/trend', async (c) => {
  const slug = c.req.param('slug')
  const period = c.req.query('period') || '12m'
  const community = await prisma.community.findUnique({ where: { slug } })
  if (!community) return c.json({ error: 'Community not found' }, 404)

  const months = period === '5y' ? 60 : period === '3y' ? 36 : 12
  const since = new Date()
  since.setMonth(since.getMonth() - months)

  const transactions = await prisma.transaction.findMany({
    where: {
      communityId: community.id,
      transactionType: { in: SALE_TXN_TYPES },
      pricePerSqft: { gt: 100 }, // excludes land and outlier records
      transactionDate: { gte: since },
    },
    select: { transactionDate: true, pricePerSqft: true, priceAed: true, source: true },
  })

  // Label the series by what is actually in the table. Hardcoding
  // "DLD · Dubai Pulse API" made the chart assert a government source no matter
  // what the rows were, including while the table held generated data.
  const present = new Set(transactions.map((t) => t.source))
  // Transaction.source defaults to 'dld_dubai', not 'dld' — matching only the
  // bare 'dld' string meant every real DLD row fell through to the raw-value
  // branch and the chart was labelled "dld_dubai", an internal identifier
  // rather than a source a reader would recognise.
  const isDld = (s: string) => s === 'dld' || s === 'dld_dubai' || s === 'dubai_pulse'
  const isAdrec = (s: string) => s === 'adrec' || s === 'adrec_abudhabi'
  const hasDld = [...present].some(isDld)
  const hasAdrec = [...present].some(isAdrec)
  const sourceLabel =
    present.size === 0
      ? 'unknown'
      : hasDld && hasAdrec
        ? 'DLD + ADREC'
        : hasDld
          ? 'DLD (Dubai Pulse)'
          : hasAdrec
            ? 'ADREC (Abu Dhabi)'
            : [...present].join(', ')

  const monthMap = new Map<string, { psfs: number[]; volume: number; totalValue: number }>()
  for (const txn of transactions) {
    const key = txn.transactionDate.toISOString().substring(0, 7)
    const bucket = monthMap.get(key) ?? { psfs: [], volume: 0, totalValue: 0 }
    bucket.psfs.push(txn.pricePerSqft)
    bucket.volume++
    bucket.totalValue += txn.priceAed
    monthMap.set(key, bucket)
  }

  const trend = []
  for (let i = months; i >= 0; i--) {
    const d = new Date()
    d.setMonth(d.getMonth() - i)
    const key = d.toISOString().substring(0, 7)
    const bucket = monthMap.get(key)
    if (bucket && bucket.psfs.length > 0) {
      // True median (mean of the two central values on an even count). A plain
      // average would let one headline deal drag the whole month.
      const sorted = [...bucket.psfs].sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      const median = sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid]
      trend.push({
        date: key,
        medianPrice: Math.round(median),
        volume: bucket.volume,
        totalValueAed: Math.round(bucket.totalValue),
        dataSource: sourceLabel,
        transactionCount: bucket.psfs.length,
      })
    } else {
      // null rather than 0 so the chart breaks the line instead of plotting a
      // cliff to the axis on months with no sales.
      trend.push({
        date: key, medianPrice: null, volume: 0,
        totalValueAed: 0, dataSource: sourceLabel, transactionCount: 0,
      })
    }
  }

  const hasRealData = trend.some((t) => t.medianPrice !== null)
  if (!hasRealData) {
    return c.json({
      trend: [],
      period,
      dataSource: 'no_transaction_data',
      message:
        'No registered transaction data for this area yet. Connect a source: set DUBAI_PULSE_API_KEY for Dubai, or ADREC_API_URL/ADREC_API_KEY for Abu Dhabi.',
      communityMedian: community.medianAedSqft,
    })
  }

  // Task B3 — guests get a 3-month window; the 12/36/60-month series is a
  // subscriber feature.
  const tier = c.get('tier') as CallerTier
  const visibleTrend = tier === 'guest' ? trend.slice(-3) : trend
  await trackEvent(c, 'trend_view', { slug, period, tier })

  return c.json({
    trend: visibleTrend,
    period,
    dataSource: sourceLabel,
    sources: [...present],
    ...(tier === 'guest'
      ? {
          limited: true,
          monthsShown: 3,
          message: 'Sign in for the full price history',
          signInUrl: '/auth/signin',
        }
      : {}),
  })
})

// ─── Investment Score (FEATURE-01) ───────────────────────────────────────────

// Day 15 D2 — the newest score row is cached (brief: 6h). `investment_scores` is
// append-only, so "current" is the most recent `calculatedAt`; a cache read must therefore
// be invalidated whenever a batch writes a newer row, which is why `src/lib/cron.ts` calls
// `cacheInvalidate('sqftlab:score:')` after its daily recompute. Without that, a paid
// customer would see yesterday's number for the rest of the TTL.
async function loadLatestScore(communityId: string) {
  return prisma.investmentScore.findFirst({
    where: { communityId },
    orderBy: { calculatedAt: 'desc' },
  })
}
type ScoreRow = Awaited<ReturnType<typeof loadLatestScore>>

app.get('/sqftlab/communities/:slug/score', async (c) => {
  const slug = c.req.param('slug')
  const community = await prisma.community.findUnique({
    where: { slug },
    select: { id: true, slug: true, nameEn: true, medianAedSqft: true, psfSource: true },
  })
  if (!community) return c.json({ error: 'Community not found' }, 404)

  const tier = c.get('tier') as CallerTier
  await trackEvent(c, 'score_view', { slug, tier })

  const scoreKey = `sqftlab:score:${community.id}`
  let latest = cacheRead<ScoreRow>(scoreKey)

  // Never scored before → compute once on demand so the endpoint is never empty
  // just because the nightly batch has not run yet.
  if (!latest) {
    latest = await loadLatestScore(community.id)
    if (!latest) {
      await computeInvestmentScore(community.id)
      latest = await loadLatestScore(community.id)
    }
    if (latest) cacheWrite(scoreKey, latest, CACHE_TTL.scores)
  }
  if (!latest) return c.json({ error: 'Score unavailable' }, 500)

  // A composite built mostly from neutral stand-ins is not the same claim as one
  // built from five real inputs, so the caller is told which it is receiving.
  const confidence =
    latest.dataCoverage >= 0.75 ? 'high' : latest.dataCoverage >= 0.5 ? 'medium' : 'low'

  // Task B3 — guests and free accounts get the headline number; the weighted
  // breakdown is the paid tier.
  const paid = tier === 'pro' || tier === 'enterprise' || tier === 'institutional'

  return c.json({
    slug: community.slug,
    name: community.nameEn,
    score: latest.score,
    confidence,
    dataCoverage: latest.dataCoverage,
    notes: latest.notes,
    medianAedSqft: community.medianAedSqft,
    psfSource: community.psfSource,
    calculatedAt: latest.calculatedAt,
    breakdown: paid
      ? {
          psfMomentum: latest.psfMomentum,
          rentalYield: latest.rentalYield,
          supplyAbsorption: latest.supplyAbsorption,
          volumeTrend: latest.volumeTrend,
          capitalFlow: latest.capitalFlow,
        }
      : null,
    ...(paid
      ? {}
      : {
          limited: true,
          message: 'Sign in to see the weighted breakdown behind this score',
          signInUrl: '/auth/signin',
        }),
  })
})

// All current scores — one row per community, for the map's score layer.
app.get('/sqftlab/scores', async (c) => {
  const tier = c.get('tier') as CallerTier
  const [latest, communities] = await Promise.all([
    latestInvestmentScores(),
    prisma.community.findMany({
      select: { id: true, slug: true, nameEn: true, emirate: true, medianAedSqft: true, psfSource: true },
    }),
  ])

  const rows = communities
    .map((c) => {
      const s = latest.get(c.id)
      if (!s) return null
      return {
        slug: c.slug,
        name: c.nameEn,
        emirate: c.emirate,
        score: s.score,
        dataCoverage: s.dataCoverage,
        medianAedSqft: c.medianAedSqft,
        psfSource: c.psfSource,
        calculatedAt: s.calculatedAt,
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => b.score - a.score)

  return c.json({
    scores: rows,
    total: rows.length,
    unscored: communities.length - rows.length,
    tier,
  })
})

// GET /sqftlab/scores/:slug — one community's ENGINE score, with the factors
// behind it.
//
// The composite is public; the five weighted inputs that explain it are the paid
// tier's view. Withheld server-side rather than hidden in the client, so a free
// caller does not merely fail to see them — they are never sent.
//
// `dataCoverage` and `notes` stay public on purpose: they say how much of the
// number is real data versus a neutral stand-in, which is a caveat the reader
// needs MOST when they can see the least.
app.get('/sqftlab/scores/:slug', async (c) => {
  const tier = (c.get('tier') as CallerTier | undefined) ?? 'guest'
  const community = await prisma.community.findUnique({
    where: { slug: c.req.param('slug') },
    select: { id: true, slug: true, nameEn: true, emirate: true, medianAedSqft: true, psfSource: true },
  })
  if (!community) return c.json({ error: 'Community not found' }, 404)

  const latest = await latestInvestmentScores([community.id])
  const row = latest.get(community.id)

  if (!row) {
    return c.json({
      community: community.nameEn,
      slug: community.slug,
      emirate: community.emirate,
      score: null,
      scored: false,
      reason: 'No score has been computed for this community yet.',
      breakdown: null,
      breakdownLocked: true,
      dataCoverage: 0,
      notes: null,
      medianAedSqft: community.medianAedSqft,
      psfSource: community.psfSource,
      tier,
    })
  }

  const entitled = (TIER_RANK[tier] ?? 0) >= (TIER_RANK.pro ?? 0)

  return c.json({
    community: community.nameEn,
    slug: community.slug,
    emirate: community.emirate,
    score: row.score,
    scored: true,
    calculatedAt: row.calculatedAt,
    // How much of the composite is measurement rather than stand-in.
    dataCoverage: row.dataCoverage,
    notes: row.notes,
    breakdown: entitled
      ? {
          psfMomentum: row.psfMomentum,
          rentalYield: row.rentalYield,
          supplyAbsorption: row.supplyAbsorption,
          volumeTrend: row.volumeTrend,
          capitalFlow: row.capitalFlow,
        }
      : null,
    breakdownLocked: !entitled,
    lockedReason: entitled ? null : 'The factor breakdown is part of the Pro plan.',
    upgradeUrl: entitled ? null : '/pricing',
    // capitalFlow is a hard-coded neutral in the engine (it needs Ejari ownership
    // data) and is deliberately excluded from dataCoverage. Naming it here stops
    // the UI from drawing a placeholder bar that reads as a measurement.
    // Only meaningful alongside the breakdown. A locked caller has no factor bars
    // to annotate, so sending the names would disclose part of what is withheld
    // while being useless to them.
    placeholderFactors: entitled ? ['capitalFlow'] : [],
    medianAedSqft: community.medianAedSqft,
    psfSource: community.psfSource,
    tier,
  })
})

// Recompute every score. The nightly cron calls the engine directly; this exists
// so the job can also be triggered and verified on demand.
app.post('/sqftlab/scores/recompute', async (c) => {
  if (!cronAuthorized(c)) return c.json({ error: 'unauthorized' }, 401)
  const result = await computeAllInvestmentScores()
  return c.json({ ok: true, ...result })
})

// ─── Yield Calculator ────────────────────────────────────────────────────────

// ─── Input validation for the two calculators ────────────────────────────────
//
// Both routes used to read fields straight off the parsed body and compute with
// them. A caller that omitted one therefore did arithmetic on `undefined`: every
// output became NaN, `JSON.stringify` turns NaN into `null`, and the response was
// HTTP 200 with an all-null payload — which a client cannot tell apart from a
// real answer. An absent body threw straight out of `c.req.json()` as a 500.
// A calculator must refuse input it cannot compute, so both now validate and
// answer 400 naming the fields at fault. `/macro/scenario` already did this.
async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  const parsed: unknown = await c.req.json().catch(() => null)
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {}
}

/** A body field as a finite number, or null when absent, blank or non-numeric. */
function numField(body: Record<string, unknown>, key: string): number | null {
  const raw = body[key]
  if (raw === null || raw === undefined || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function badInput(c: Context, fields: string[], expected: Record<string, string>) {
  return c.json({ error: 'Invalid input', fields, expected }, 400)
}

const YIELD_EXPECTED: Record<string, string> = {
  purchasePrice: 'a positive number (AED)',
  annualRent: 'a number >= 0 (AED per year)',
  serviceCharge: 'a number >= 0 (AED per year); optional, defaults to 0',
  mortgageEnabled: 'boolean; optional',
  mortgageRate: 'required when mortgageEnabled — annual percent, e.g. 4.5',
  mortgageTerm: 'required when mortgageEnabled — years',
  downPaymentPct: 'percent between 0 and 100; required when mortgageEnabled',
}

app.post('/sqftlab/yield/calculate', async (c) => {
  const body = await readJsonBody(c)

  const purchasePrice = numField(body, 'purchasePrice')
  const annualRent = numField(body, 'annualRent')
  const serviceCharge = numField(body, 'serviceCharge') ?? 0
  const mortgageEnabled = body.mortgageEnabled === true
  const mortgageRate = numField(body, 'mortgageRate') ?? 0
  const mortgageTerm = numField(body, 'mortgageTerm') ?? 0
  const downPaymentPct = numField(body, 'downPaymentPct') ?? 0

  const bad: string[] = []
  if (purchasePrice === null || purchasePrice <= 0) bad.push('purchasePrice')
  if (annualRent === null || annualRent < 0) bad.push('annualRent')
  if (serviceCharge < 0) bad.push('serviceCharge')
  if (mortgageEnabled) {
    if (mortgageRate <= 0) bad.push('mortgageRate')
    if (mortgageTerm <= 0) bad.push('mortgageTerm')
    if (downPaymentPct < 0 || downPaymentPct >= 100) bad.push('downPaymentPct')
  }
  if (bad.length || purchasePrice === null || annualRent === null) {
    return badInput(c, bad.length ? bad : ['purchasePrice', 'annualRent'], YIELD_EXPECTED)
  }
  // Narrowed from here: the two required values are numbers, and the optional ones
  // above were coalesced. (`bad.length` alone does not narrow them — TS cannot tie
  // the array's emptiness to the per-field null checks — so the nulls are restated.)

  const grossYield = (annualRent / purchasePrice) * 100
  const dldFee = purchasePrice * 0.04
  const netYield = ((annualRent - serviceCharge - dldFee * 0.02) / purchasePrice) * 100
  const monthlyCashFlow = (annualRent - serviceCharge) / 12

  let emi = 0, totalMortgageCost = 0, totalInterest = 0
  if (mortgageEnabled && mortgageRate > 0) {
    const loanAmount = purchasePrice * (1 - downPaymentPct / 100)
    const monthlyRate = mortgageRate / 100 / 12
    const months = mortgageTerm * 12
    emi = loanAmount * monthlyRate * Math.pow(1 + monthlyRate, months) / (Math.pow(1 + monthlyRate, months) - 1)
    totalMortgageCost = emi * months
    totalInterest = totalMortgageCost - loanAmount
  }

  // `null` means "this never breaks even" (negative monthly cash flow). It used to
  // be `Infinity`, which reached the wire as null only because JSON.stringify
  // rewrites non-finite numbers — the same accident that turned NaN outputs into
  // nulls. Say it outright instead.
  const breakEvenMonths = monthlyCashFlow > 0 ? Math.ceil((purchasePrice * 0.04) / monthlyCashFlow) : null
  const annualCashFlow = annualRent - serviceCharge - emi * 12

  // 5-year projection (conservative: 0% price growth)
  const fiveYearReturn = (annualRent * 5 - serviceCharge * 5 - totalInterest) / purchasePrice * 100

  return c.json({
    grossYield: Math.round(grossYield * 100) / 100,
    netYield: Math.round(netYield * 100) / 100,
    monthlyCashFlow: Math.round(monthlyCashFlow),
    annualCashFlow: Math.round(annualCashFlow),
    emi: Math.round(emi),
    totalMortgageCost: Math.round(totalMortgageCost),
    totalInterest: Math.round(totalInterest),
    breakEvenMonths,
    fiveYearReturn: Math.round(fiveYearReturn * 100) / 100,
    dldFee: Math.round(dldFee),
  })
})

// ─── Mortgage Simulator ──────────────────────────────────────────────────────

const MORTGAGE_EXPECTED: Record<string, string> = {
  price: 'a positive number (AED)',
  downPaymentPct: 'percent between 0 and 100',
  ratePct: 'a positive number — annual percent, e.g. 4.5',
  termYears: 'a positive number of years, at most 40',
}

app.post('/sqftlab/mortgage/simulate', async (c) => {
  const body = await readJsonBody(c)

  const price = numField(body, 'price')
  const downPaymentPct = numField(body, 'downPaymentPct')
  const ratePct = numField(body, 'ratePct')
  const termYears = numField(body, 'termYears')

  const bad: string[] = []
  if (price === null || price <= 0) bad.push('price')
  if (downPaymentPct === null || downPaymentPct < 0 || downPaymentPct >= 100) bad.push('downPaymentPct')
  if (ratePct === null || ratePct <= 0) bad.push('ratePct')
  if (termYears === null || termYears <= 0 || termYears > 40) bad.push('termYears')
  if (
    bad.length ||
    price === null ||
    downPaymentPct === null ||
    ratePct === null ||
    termYears === null
  ) {
    return badInput(c, bad.length ? bad : ['price', 'downPaymentPct', 'ratePct', 'termYears'], MORTGAGE_EXPECTED)
  }

  const downPayment = price * (downPaymentPct / 100)
  const loanAmount = price - downPayment
  const monthlyRate = ratePct / 100 / 12
  const months = termYears * 12
  const emi = loanAmount * monthlyRate * Math.pow(1 + monthlyRate, months) / (Math.pow(1 + monthlyRate, months) - 1)
  const totalPayment = emi * months
  const totalInterest = totalPayment - loanAmount

  // Amortization first 5 years
  const amortization = []
  let balance = loanAmount
  for (let year = 1; year <= Math.min(termYears, 5); year++) {
    let yearInterest = 0, yearPrincipal = 0
    for (let m = 0; m < 12; m++) {
      const interestPayment = balance * monthlyRate
      const principalPayment = emi - interestPayment
      yearInterest += interestPayment
      yearPrincipal += principalPayment
      balance -= principalPayment
    }
    amortization.push({
      year,
      principalPaid: Math.round(yearPrincipal),
      interestPaid: Math.round(yearInterest),
      remainingBalance: Math.round(Math.max(0, balance)),
    })
  }

  return c.json({
    emi: Math.round(emi),
    downPayment: Math.round(downPayment),
    loanAmount: Math.round(loanAmount),
    totalPayment: Math.round(totalPayment),
    totalInterest: Math.round(totalInterest),
    amortization,
    // These are NOT quotes from these banks. Each is a mechanical offset from the
    // rate the user typed in, so they must be labelled as illustrative — an
    // unlabelled list reads as a rate comparison sqftLab cannot stand behind.
    bankRates: [
      { bank: 'ADCB', rate: ratePct - 0.15, type: 'Variable' },
      { bank: 'Emirates NBD', rate: ratePct, type: 'Variable' },
      { bank: 'FAB', rate: ratePct - 0.10, type: 'Variable' },
      { bank: 'HSBC UAE', rate: ratePct + 0.05, type: 'Fixed 3yr' },
      { bank: 'Mashreq', rate: ratePct - 0.05, type: 'Variable' },
    ],
    bankRatesDisclaimer: 'Indicative rates only — calculated as offsets from your ' +
      'input rate. Verify actual rates with each bank before proceeding. ' +
      'sqftLab is not a mortgage broker.',
    disclaimer: 'This calculator provides illustrative calculations only. ' +
      'sqftLab does not provide mortgage advice. Rates shown are indicative. ' +
      'Contact a CBUAE-regulated bank or mortgage broker for actual rates.',
  })
})

// ─── CMA — Comparable Market Analysis (Day 6 Task A) ─────────────────────────
//
// Enterprise-gated valuation from recorded sales. Deliberately NOT a model: the
// estimate is the median of real comparables plus two explicit, disclosed
// adjustments, and the comparables are returned so the user can check the working.
// When there are too few comparables the route REFUSES (422) rather than
// substituting a community median or an interpolated guess — a valuation built on
// nothing is worse than no valuation, and "the numbers are real sales" is the
// product's entire claim.
//
// Two deviations from the brief's query, both forced by this schema:
//   * Field names. The brief queries `bedrooms`/`size`/`amount`/`floor`/
//     `pricePsf`/`transactionType: 'Sales'`. This schema has `beds`/`areaSqft`/
//     `priceAed`/`floorNumber`/`pricePerSqft`, and types the column lowercase
//     (`sale`, `off_plan_sale`, `mortgage`, `gift`). The brief's version does not
//     compile against it, and `'Sales'` would match zero rows.
//   * `mode: 'insensitive'`. The datasource is SQLite, where Prisma rejects
//     `mode` outright. Rather than depend on a provider-specific escape hatch,
//     the community is resolved through the project's existing fuzzy matcher and
//     the building-name comparison is done in JS — which behaves the same on
//     SQLite and on the PostgreSQL the brief targets.

const CMA_EXPECTED: Record<string, string> = {
  buildingName: 'non-empty string — the building the unit is in',
  community: 'non-empty string — the area name, e.g. "Dubai Marina"',
  bedrooms: 'integer >= 0 (0 = studio)',
  sizeSqft: 'a positive number — the unit size in sqft',
  floor: 'optional integer >= 0; omit or 0 for ground floor',
  condition: "optional: 'excellent' | 'good' | 'average' | 'poor'",
  listingPrice: 'optional positive number (AED) — the asking price, for deal analysis',
}

/** A trimmed non-empty string field, or null. */
function strField(body: Record<string, unknown>, key: string): string | null {
  const raw = body[key]
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length ? trimmed : null
}

app.post('/sqftlab/cma', async (c) => {
  // Identity first, then entitlement. The order decides the answer the caller gets:
  // an anonymous request is told it must sign in (401), not that it needs a bigger
  // plan (403). A 403 to a guest would imply a login alone unlocks an Enterprise
  // tool, which is false, and Day 6's checklist asks for both statuses.
  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const blocked = requireTier(c, 'enterprise', 'CMA Tool')
  if (blocked) return blocked

  const body = await readJsonBody(c)

  const buildingName = strField(body, 'buildingName')
  const communityName = strField(body, 'community')
  const bedrooms = numField(body, 'bedrooms')
  const sizeSqft = numField(body, 'sizeSqft')
  const floorNum = numField(body, 'floor')
  const conditionRaw = strField(body, 'condition')
  const listingPrice = numField(body, 'listingPrice')

  const floorProvided = body.floor !== undefined && body.floor !== null && body.floor !== ''
  const condition = conditionRaw as CmaCondition | null

  const bad: string[] = []
  if (!buildingName) bad.push('buildingName')
  if (!communityName) bad.push('community')
  if (bedrooms === null || bedrooms < 0 || !Number.isInteger(bedrooms)) bad.push('bedrooms')
  if (sizeSqft === null || sizeSqft <= 0) bad.push('sizeSqft')
  if (floorProvided && (floorNum === null || floorNum < 0 || !Number.isInteger(floorNum))) bad.push('floor')
  if (condition !== null && !CMA_CONDITIONS.includes(condition)) bad.push('condition')
  if (listingPrice !== null && listingPrice <= 0) bad.push('listingPrice')

  if (bad.length) return badInput(c, bad, CMA_EXPECTED)
  // Restated so TypeScript narrows them; `bad.length === 0` alone does not tie the
  // array's emptiness to each individual null check.
  if (!buildingName || !communityName || bedrooms === null || sizeSqft === null) {
    return badInput(c, ['buildingName', 'community', 'bedrooms', 'sizeSqft'], CMA_EXPECTED)
  }

  const community = await findCommunityByName(communityName)
  if (!community) {
    return c.json({
      error: 'Community not found',
      message: `No area matching "${communityName}" is loaded on this deployment. ` +
        'Check the spelling, or list the available areas at /api/sqftlab/communities.',
      communityFound: false,
    }, 422)
  }

  const since = new Date(Date.now() - COMP_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const comps = await prisma.transaction.findMany({
    where: {
      communityId: community.id,
      beds: bedrooms,
      areaSqft: {
        gte: sizeSqft * (1 - SIZE_TOLERANCE),
        lte: sizeSqft * (1 + SIZE_TOLERANCE),
      },
      // `sale` and `off_plan_sale` are both market sales. Mortgage and gift rows
      // record a transaction but not an arm's-length price, so they would drag the
      // median; the brief's literal 'Sales' matches neither of this schema's values.
      transactionType: { in: ['sale', 'off_plan_sale'] },
      pricePerSqft: { gt: 100 },
      transactionDate: { gte: since },
    },
    select: {
      transactionDate: true,
      pricePerSqft: true,
      priceAed: true,
      areaSqft: true,
      floorNumber: true,
      buildingName: true,
    },
    orderBy: { transactionDate: 'desc' },
    // The brief caps at 50. 200 keeps the median stable on a busy community while
    // staying bounded; the same-building subset used for the estimate is drawn from
    // whichever set this returns.
    take: 200,
  })

  // Why there are too few comparables decides what the user should do next, and
  // there are three genuinely different answers:
  //
  //   * sales exist in the deployment, just not for this query → widen the search;
  //   * the feed is connected but has delivered nothing yet → say that, so nobody
  //     goes looking for a wider area that would also be empty;
  //   * no feed at all → name the missing credential.
  //
  // Keying this on the env flag alone was wrong: with sales on record, a thin query
  // still claimed the feed was missing. The extra count runs only on the refusal
  // path, so a successful valuation never pays for it.
  const insufficient = async (found: number) => {
    const feedConfigured = dldConfigured()
    let salesOnRecord = found > 0
    if (!salesOnRecord) {
      salesOnRecord =
        (await prisma.transaction.count({
          where: { transactionType: { in: ['sale', 'off_plan_sale'] } },
        })) > 0
    }

    const message = salesOnRecord
      ? `Only ${found} comparable sale${found === 1 ? '' : 's'} in ${community.nameEn} in the last ` +
        `${COMP_WINDOW_DAYS} days at this bedroom count and size (at least ${MIN_COMPS} are needed). ` +
        'Widen the size range, or check a busier neighbouring area.'
      : feedConfigured
        ? `No comparable sales in ${community.nameEn} yet. The transaction feed is connected but ` +
          'has not delivered records for this area — this tool values property from real recorded ' +
          'sales only, so there is nothing to compare against.'
        : 'The DLD transaction feed is not connected on this deployment, so there are no recorded ' +
          'sales to compare against. This tool values property from real recorded sales only — it ' +
          'does not estimate from anything else. Set DUBAI_PULSE_API_KEY to enable it.'

    return c.json({
      error: 'Insufficient comparable transactions',
      message,
      compsFound: found,
      dldConnected: feedConfigured,
      salesOnRecord,
    }, 422)
  }

  if (comps.length < MIN_COMPS) return await insufficient(comps.length)

  const subject: CmaSubject = {
    buildingName,
    community: community.nameEn,
    bedrooms,
    sizeSqft,
    floor: floorNum,
    condition,
    listingPrice,
  }

  const result = computeCma(subject, comps)
  if (!result) return await insufficient(0)

  await trackEvent(c, 'cma_run', {
    community: community.nameEn,
    bedrooms,
    sizeSqft,
    compsUsed: result.compsUsed,
    compBasis: result.compBasis,
  })
  return c.json(result)
})

// ─── White-label PDF report (Day 7) ──────────────────────────────────────────

const REPORT_EXPECTED: Record<string, string> = {
  propertyAddress: 'non-empty string — the address printed on the report',
  building: 'optional string — used to prefer same-building comparables; defaults to propertyAddress',
  community: 'non-empty string — the area name, e.g. "Dubai Marina"',
  bedrooms: 'integer >= 0 (0 = studio)',
  sizeSqft: 'a positive number — the unit size in sqft',
  listingPriceAed: 'optional positive number (AED) — the asking price, for deal analysis',
  brokerName: 'optional string — printed beside the logo',
  brokerLogoBase64: 'optional base64 image data URI (png, jpeg, webp or gif)',
  preparedFor: 'optional string — the client the report is prepared for',
}

app.post('/sqftlab/report/property', async (c) => {
  // Identity before entitlement, matching the CMA route: an anonymous caller is told
  // to sign in (401), not told to upgrade (403). Day 7's checklist asks for both.
  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const blocked = requireTier(c, 'enterprise', 'PDF Report')
  if (blocked) return blocked

  const body = await readJsonBody(c)

  const propertyAddress = strField(body, 'propertyAddress')
  const communityName = strField(body, 'community')
  const building = strField(body, 'building') ?? propertyAddress
  const bedrooms = numField(body, 'bedrooms')
  const sizeSqft = numField(body, 'sizeSqft')
  const listingPrice = numField(body, 'listingPriceAed')
  const brokerName = strField(body, 'brokerName')
  const brokerLogo = strField(body, 'brokerLogoBase64')
  const preparedFor = strField(body, 'preparedFor')

  const bad: string[] = []
  if (!propertyAddress) bad.push('propertyAddress')
  if (!communityName) bad.push('community')
  if (bedrooms === null || bedrooms < 0 || !Number.isInteger(bedrooms)) bad.push('bedrooms')
  if (sizeSqft === null || sizeSqft <= 0) bad.push('sizeSqft')
  if (listingPrice !== null && listingPrice <= 0) bad.push('listingPriceAed')

  if (bad.length) return badInput(c, bad, REPORT_EXPECTED)
  // Restated so TypeScript narrows each value; an empty `bad` does not tie the array's
  // emptiness to the individual null checks.
  if (!propertyAddress || !communityName || !building || bedrooms === null || sizeSqft === null) {
    return badInput(c, ['propertyAddress', 'community', 'bedrooms', 'sizeSqft'], REPORT_EXPECTED)
  }

  const community = await findCommunityByName(communityName)
  if (!community) {
    return c.json({
      error: 'Community not found',
      message: `No area matching "${communityName}" is loaded on this deployment. ` +
        'Check the spelling, or list the available areas at /api/sqftlab/communities.',
      communityFound: false,
    }, 422)
  }

  // The same comparable selection the CMA tool uses. `sale` and `off_plan_sale` are
  // both market sales; mortgage and gift rows record a transaction but not an
  // arm's-length price, so including them would drag the median.
  const since = new Date(Date.now() - COMP_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const comps = await prisma.transaction.findMany({
    where: {
      communityId: community.id,
      beds: bedrooms,
      areaSqft: {
        gte: sizeSqft * (1 - SIZE_TOLERANCE),
        lte: sizeSqft * (1 + SIZE_TOLERANCE),
      },
      transactionType: { in: ['sale', 'off_plan_sale'] },
      pricePerSqft: { gt: 100 },
      transactionDate: { gte: since },
    },
    select: {
      transactionDate: true,
      pricePerSqft: true,
      priceAed: true,
      areaSqft: true,
      floorNumber: true,
      buildingName: true,
    },
    orderBy: { transactionDate: 'desc' },
    take: 200,
  })

  // Refusing is the point. A report is a document a broker forwards to a client, so an
  // estimate assembled from too few sales would carry the platform's name into a
  // decision the data cannot support. The CMA tool's own wording is reused so both
  // surfaces explain the same situation identically.
  if (comps.length < MIN_COMPS) {
    const feedConfigured = dldConfigured()
    const salesOnRecord =
      comps.length > 0 ||
      (await prisma.transaction.count({
        where: { transactionType: { in: ['sale', 'off_plan_sale'] } },
      })) > 0

    const message = salesOnRecord
      ? `Only ${comps.length} comparable sale${comps.length === 1 ? '' : 's'} in ${community.nameEn} in the last ` +
        `${COMP_WINDOW_DAYS} days at this bedroom count and size (at least ${MIN_COMPS} are needed). ` +
        'A report is not produced from fewer than that — widen the size range or check a busier area.'
      : feedConfigured
        ? `No comparable sales in ${community.nameEn} yet. The transaction feed is connected but has not ` +
          'delivered records for this area, and this report is built from recorded sales only.'
        : 'The DLD transaction feed is not connected on this deployment, so there are no recorded sales to ' +
          'build a report from. Set DUBAI_PULSE_API_KEY to enable it.'

    return c.json({
      error: 'Insufficient comparable transactions',
      message,
      compsFound: comps.length,
      dldConnected: feedConfigured,
      salesOnRecord,
    }, 422)
  }

  const subject: CmaSubject = {
    buildingName: building,
    community: community.nameEn,
    bedrooms,
    sizeSqft,
    floor: null,
    condition: null,
    listingPrice,
  }

  const result = computeCma(subject, comps)
  if (!result) {
    return c.json({
      error: 'Valuation not possible',
      message: `Comparable sales exist in ${community.nameEn}, but none carried a usable price per sqft, ` +
        'so no estimate could be computed.',
      compsFound: comps.length,
    }, 422)
  }

  // Queried by the resolved `communityId` rather than by re-slugifying the typed name:
  // a local slug rule would be a second, drifting implementation of the slug column.
  const latestScore = await prisma.investmentScore.findFirst({
    where: { communityId: community.id },
    orderBy: { calculatedAt: 'desc' },
    select: { score: true, dataCoverage: true },
  })

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, company: true },
  })

  // `result.verdict` is null when no asking price was supplied — say so rather than
  // synthesising a deal position, which would read as a recommendation.
  const verdict = result.verdict ??
    `Estimated market value derived from ${result.compsUsed} comparable recorded ` +
    `sale${result.compsUsed === 1 ? '' : 's'}. No asking price was supplied, so no deal position is given.`

  let pdf: Buffer
  try {
    pdf = await generatePropertyReport({
      propertyAddress,
      community: community.nameEn,
      bedrooms,
      sizeSqft,
      listingPriceAed: listingPrice,
      estimatedValueAed: result.estimatedValueAed,
      medianPsf: result.medianPsf,
      investmentScore: latestScore ? latestScore.score : null,
      investmentScoreCoverage: latestScore ? latestScore.dataCoverage : null,
      verdict,
      compBasis: result.compBasis,
      compsUsed: result.compsUsed,
      windowDays: result.windowDays,
      recentComps: result.recentComps,
      brokerLogo,
      brokerName,
      preparedFor,
      preparedBy: user?.company ?? user?.name ?? 'sqftLab',
    })
  } catch (err) {
    // A missing browser is a deployment gap, not a client mistake: answer 503 with the
    // reason instead of letting a raw 500 make it look like bad input.
    if (err instanceof PdfUnavailableError) {
      return c.json({ error: 'PDF rendering unavailable', message: err.message }, 503)
    }
    const message = err instanceof Error ? err.message : 'unknown error'
    return c.json({ error: 'PDF generation failed', message }, 500)
  }

  await trackEvent(c, 'pdf_report_export', {
    community: community.nameEn,
    bedrooms,
    sizeSqft,
    compsUsed: result.compsUsed,
    compBasis: result.compBasis,
  })

  c.header('Content-Type', 'application/pdf')
  c.header(
    'Content-Disposition',
    `attachment; filename="sqftlab-report-${community.slug}-${Date.now()}.pdf"`,
  )
  return c.body(new Uint8Array(pdf))
})

// ─── Exchange Rates ──────────────────────────────────────────────────────────

// frankfurter (the previous source) does not publish INR or PKR at all, so both
// silently fell through to the hardcoded constants on every request — the UI
// showed a "live" rate that never changed. ExchangeRate-API's free endpoints
// cover all nine quoted currencies, and the open one needs no key at all.
//
// TWO DIRECTIONS LIVE IN THIS FILE — do not confuse them:
//   stored + legacy `/rates/exchange` → X per 1 AED   (the API's native quote)
//   `/exchange-rates`                 → AED per 1 X   (1 / native, the Day 2 contract)
// Storing the native quote keeps every pre-existing row, and the legacy payload,
// meaning exactly what they meant before.
const RATE_TTL_MS = 60 * 60 * 1000 // 1 hour

const FX_KEYS = ['usd', 'gbp', 'eur', 'inr', 'pkr', 'sar', 'qar', 'bhd', 'kwd'] as const
type FxKey = (typeof FX_KEYS)[number]
type FxTable = Partial<Record<FxKey, number>>

// X per 1 AED, used only when upstream is unreachable and always labelled
// `source: 'fallback'` so it is never replayed as a live rate.
const FX_FALLBACK: Record<FxKey, number> = {
  usd: 0.2723, gbp: 0.2145, eur: 0.25, inr: 22.68, pkr: 75.5,
  sar: 1.0216, qar: 0.9912, bhd: 0.1024, kwd: 0.0835,
}

type FxPayload = {
  base: 'AED'
  rates: Record<string, number>
  direction: string
  updatedAt: string
  source: string
  cached: boolean
}

const DIRECTIONS = 'AED per 1 unit of currency'

// A partially populated cache must not emit a 0 that reads as a real rate, so
// only entries actually carried by the row are reported.
function invertToAedPerUnit(table: FxTable): Record<string, number> {
  const rates: Record<string, number> = {}
  for (const key of FX_KEYS) {
    const value = table[key]
    if (typeof value === 'number' && value > 0) {
      rates[key.toUpperCase()] = parseFloat((1 / value).toFixed(4))
    }
  }
  return rates
}

// Tries the keyed endpoint first when a key is configured, then the keyless one.
// Returns null only when every upstream failed, so the caller can label the
// result a fallback instead of persisting a guess as if it were live.
async function fetchUpstreamRates(): Promise<FxTable | null> {
  const key = process.env.EXCHANGE_RATE_API_KEY
  const urls = [
    ...(key ? [`https://v6.exchangerate-api.com/v6/${key}/latest/AED`] : []),
    'https://open.er-api.com/v6/latest/AED',
  ]
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) continue
      const data = await res.json() as {
        result?: string
        rates?: Record<string, number>
        conversion_rates?: Record<string, number>
      }
      // Both hosts signal failure with `result: 'error'` (a bad key reports one
      // with HTTP 200), so this is checked before the table is trusted.
      if (data?.result === 'error') continue
      const table = data?.rates ?? data?.conversion_rates
      if (table) {
        const picked: FxTable = {}
        for (const k of FX_KEYS) if (typeof table[k.toUpperCase()] === 'number') picked[k] = table[k.toUpperCase()]
        if (Object.keys(picked).length) return picked
      }
    } catch {}
  }
  return null
}

// A row that predates a column we now quote is stale by schema, not by age — the
// rows written before the GCC columns existed would otherwise satisfy the TTL for
// an hour and quietly serve a five-currency payload. Returning null sends the
// caller to a live fetch instead.
function completeRow(row: Record<string, number | null>): FxTable | null {
  const table: FxTable = {}
  for (const key of FX_KEYS) {
    const value = row[key]
    if (typeof value !== 'number' || value <= 0) return null
    table[key] = value
  }
  return table
}

async function getExchangeRates(): Promise<{ payload: FxPayload; stored: FxTable }> {
  // 1. Serve a cached row if it is younger than the TTL *and* still complete.
  const cached = await prisma.exchangeRate.findFirst({
    where: { base: 'AED', fetchedAt: { gte: new Date(Date.now() - RATE_TTL_MS) } },
    orderBy: { fetchedAt: 'desc' },
  })
  if (cached) {
    const stored = completeRow(cached as unknown as Record<string, number | null>)
    if (stored) {
      return {
        payload: {
          base: 'AED',
          rates: invertToAedPerUnit(stored),
          direction: DIRECTIONS,
          updatedAt: cached.fetchedAt.toISOString(),
          source: 'open.er-api.com',
          cached: true,
        },
        stored,
      }
    }
  }

  // 2. Fetch live. Only a successful response is persisted, so a fallback value
  //    never gets stamped into the cache and replayed as "live" for an hour.
  const fetched = await fetchUpstreamRates()
  if (fetched) {
    // Exactly what upstream returned is persisted — nothing is back-filled from
    // FX_FALLBACK, so a currency upstream dropped shows as absent rather than as
    // a constant wearing a live `source` label.
    const stored: FxTable = { ...fetched }
    const row = await prisma.exchangeRate.create({
      data: {
        base: 'AED',
        usd: stored.usd, gbp: stored.gbp, eur: stored.eur, inr: stored.inr,
        pkr: stored.pkr, sar: stored.sar, qar: stored.qar, bhd: stored.bhd, kwd: stored.kwd,
      },
    })
    return {
      payload: {
        base: 'AED',
        rates: invertToAedPerUnit(stored),
        direction: DIRECTIONS,
        updatedAt: row.fetchedAt.toISOString(),
        source: 'open.er-api.com',
        cached: false,
      },
      stored,
    }
  }

  // 3. Clearly-labelled fallback.
  return {
    payload: {
      base: 'AED',
      rates: invertToAedPerUnit(FX_FALLBACK),
      direction: DIRECTIONS,
      updatedAt: new Date().toISOString(),
      source: 'fallback',
      cached: false,
    },
    stored: FX_FALLBACK,
  }
}

// Day 2 contract: `rates[X]` is how many AED one X buys.
app.get('/sqftlab/exchange-rates', async (c) => {
  const { payload } = await getExchangeRates()
  return c.json(payload)
})

// Legacy shape kept verbatim for the existing client: X per 1 AED as flat keys,
// so its numbers are the stored ones rather than a re-inversion of them.
app.get('/sqftlab/rates/exchange', async (c) => {
  const { payload, stored } = await getExchangeRates()
  return c.json({
    AED_USD: stored.usd, AED_GBP: stored.gbp, AED_EUR: stored.eur,
    AED_INR: stored.inr, AED_PKR: stored.pkr,
    updatedAt: payload.updatedAt,
    source: payload.source === 'fallback' ? 'fallback' : payload.cached ? 'cache' : 'live',
  })
})

// ─── Scraper: PropertyFinder ────────────────────────────────────────────────

// A static UA across a multi-minute crawl is a single reusable fingerprint.
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
]

const DUBAI_AREAS = [
  { name: 'Dubai Marina', lid: '31', slug: 'dubai-marina' },
  { name: 'Downtown Dubai', lid: '56', slug: 'downtown-dubai' },
  { name: 'Palm Jumeirah', lid: '63', slug: 'palm-jumeirah' },
  { name: 'JVC', lid: '544', slug: 'jumeirah-village-circle' },
  { name: 'Business Bay', lid: '53', slug: 'business-bay' },
  { name: 'Dubai Hills Estate', lid: '1436', slug: 'dubai-hills-estate' },
  { name: 'JLT', lid: '59', slug: 'jumeirah-lake-towers' },
  { name: 'DIFC', lid: '55', slug: 'difc' },
  { name: 'Dubai Creek Harbour', lid: '3476', slug: 'dubai-creek-harbour' },
  { name: 'MBR City', lid: '2424', slug: 'mbr-city' },
  { name: 'Al Barsha', lid: '40', slug: 'al-barsha' },
  { name: 'Deira', lid: '49', slug: 'deira' },
  { name: 'Bur Dubai', lid: '47', slug: 'bur-dubai' },
  { name: 'Dubai Silicon Oasis', lid: '109', slug: 'dubai-silicon-oasis' },
  { name: 'Dubai Sports City', lid: '103', slug: 'dubai-sports-city' },
  { name: 'Motor City', lid: '102', slug: 'motor-city' },
  { name: 'Discovery Gardens', lid: '58', slug: 'discovery-gardens' },
  { name: 'Town Square', lid: '2100', slug: 'town-square' },
  { name: 'Al Nahda', lid: '44', slug: 'al-nahda' },
  { name: 'Dubailand', lid: '105', slug: 'dubailand' },
]

const AD_AREAS = [
  { name: 'Al Reem Island', lid: '6665', slug: 'al-reem-island' },
  { name: 'Saadiyat Island', lid: '6666', slug: 'saadiyat-island' },
  { name: 'Yas Island', lid: '6667', slug: 'yas-island' },
  { name: 'Al Raha Beach', lid: '6668', slug: 'al-raha-beach' },
  { name: 'Corniche', lid: '6663', slug: 'corniche' },
  { name: 'Khalifa City', lid: '6670', slug: 'khalifa-city' },
  { name: 'MBZ City', lid: '6671', slug: 'mbz-city' },
  { name: 'Al Maryah Island', lid: '6669', slug: 'al-maryah-island' },
]

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Fetch with exponential backoff.
 *
 * The portals throttle by IP. A bare `fetch` that gives up on the first 429 gets
 * the run banned and the pipeline silently stops producing data, so a rate-limit
 * response is retried with a widening delay rather than treated as a failure.
 *
 * Returns `null` only when every attempt was exhausted (network failure or a
 * sustained 429/503) — that is the one case callers must treat as "we were
 * refused", as distinct from "the portal answered, there is just nothing here".
 */
async function fetchWithRetry(url: string, attempts = 3): Promise<Response | null> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(15000),
      })
      if (res.ok) return res
      // Back off hard on an explicit refusal. 5s / 10s / 15s.
      if (res.status === 429 || res.status === 503) {
        await sleepMs(attempt * 5000)
        continue
      }
      return res
    } catch {
      if (attempt === attempts) return null
      await sleepMs(attempt * 2000)
    }
  }
  return null
}

interface PageResult {
  /** Parsed listings. Empty means the portal answered and had nothing more. */
  props: unknown[]
  /** True when we were throttled or never got an answer — not an empty result. */
  throttled: boolean
}

async function pfFetchPage(catId: number, locationId: string, page: number): Promise<PageResult> {
  const url = `https://www.propertyfinder.ae/en/search?c=${catId}&l=${locationId}&ob=mr&page=${page}`
  const res = await fetchWithRetry(url)
  if (!res) return { props: [], throttled: true }
  if (!res.ok) return { props: [], throttled: res.status === 429 || res.status === 403 }
  try {
    const html = await res.text()
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/)
    if (!m) return { props: [], throttled: false }
    const j = JSON.parse(m[1])
    const items = j?.props?.pageProps?.searchResult?.listings ?? []
    return {
      props: items.filter((l: any) => l.listing_type === 'property' && l.property).map((l: any) => l.property),
      throttled: false,
    }
  } catch {
    return { props: [], throttled: false }
  }
}

export function pfParse(property: any, source: string, purpose: string) {
  const price = property.price?.value ?? 0
  // PropertyFinder returns `size` as `{ value, unit }`, not a bare number. Passing
  // that object straight into `areaSqft` made EVERY upsert throw ("Expected Float,
  // provided Object") and, because `object > 0` is false, silently computed
  // pricePerSqft as 0 as well. scripts/scraper-pf.ts has handled both shapes since
  // bdc193c; this in-server copy never got the same treatment, so the live crawl
  // persisted nothing while still reporting a healthy run. Accept either shape.
  const rawSize = property.size
  const numericSize = typeof rawSize === 'number' ? rawSize : Number(rawSize?.value)
  const area = Number.isFinite(numericSize) && numericSize > 0 ? numericSize : 0
  const loc = property.location ?? {}
  return {
    externalId: `${source}_${property.id}`,
    source,
    purpose,
    propertyType: property.property_type ?? 'Apartment',
    beds: property.bedrooms_value ?? property.bedrooms ?? 0,
    baths: property.bathrooms_value ?? property.bathrooms ?? 0,
    areaSqft: area,
    priceAed: price,
    pricePerSqft: area > 0 ? Math.round(price / area) : 0,
    furnished: property.furnished === 'furnished' ? 'furnished' : 'unfurnished',
    completion: property.completion_status === 'off_plan' ? 'off_plan' : 'ready',
    agentName: property.agent?.name ?? null,
    agencyName: property.broker?.name ?? null,
    title: property.title ?? `${property.property_type} in ${loc.name ?? ''}`,
    imageUrl: property.images?.[0]?.medium ?? property.images?.[0]?.small ?? null,
    latitude: loc.coordinates?.lat ?? null,
    longitude: loc.coordinates?.lon ?? null,
    listedAt: new Date(property.listed_date ?? Date.now()),
    districtName: loc.name ?? 'Unknown',
    locationSlug: loc.slug ?? (loc.name ?? 'unknown').toLowerCase().replace(/\s+/g, '-'),
    sourceUrl: `https://www.propertyfinder.ae/en/property/${property.id ?? ''}.html`,
  }
}

// Fallback coordinates when the portal gives us no usable location. Keyed by
// emirate because a single hardcoded Dubai centroid silently dropped every new
// Abu Dhabi area into the middle of Dubai — which is exactly what happened to
// mbz and al-maryah-island (both plotted at 25.06, 55.15).
const EMIRATE_CENTROID: Record<string, [number, number]> = {
  dubai: [25.2048, 55.2708],
  abu_dhabi: [24.4539, 54.3773],
}

// Per-run memo of resolved communities.
//
// `ensureCommunity` used to hit the database once per scraped listing — roughly
// 6,000 round trips for a full scrape, spent re-resolving a list that only changes
// when a genuinely new area appears. Cleared at the start of every run so a
// renamed or removed community is re-resolved rather than read from a stale map.
let communityRunCache = new Map<string, { id: string }>()

async function ensureCommunity(name: string, slug: string, emirate: string): Promise<{ id: string }> {
  const cached = communityRunCache.get(slug)
  if (cached) return cached

  let c = await prisma.community.findFirst({ where: { slug } })
  // Dialect-agnostic name lookup — Prisma's `mode: 'insensitive'` is
  // Postgres-only and throws on SQLite. See src/lib/community-match.ts.
  if (!c) c = await findCommunityByName(name)
  if (!c) {
    const [lat, lng] = EMIRATE_CENTROID[emirate] ?? EMIRATE_CENTROID.dubai
    c = await prisma.community.create({
      data: {
        slug, nameEn: name, emirate, latitude: lat, longitude: lng,
        medianAedSqft: 0, medianAnnualRentAed: 0, grossYieldPct: 0,
        neighbourhoodScore: 50, priceChange30d: 0, priceChange1y: 0,
        transactionCount30d: 0, totalTransactions: 0,
      },
    })
    // The matcher caches the community list; a new row must not be invisible to
    // the next listing in this same scrape pass.
    invalidateCommunityCache()
  }
  communityRunCache.set(slug, { id: c.id })
  return { id: c.id }
}

// Deal detection lives in src/lib/deals.ts so the scraper, the /detect-deals
// endpoint and the hourly cron share one implementation and cannot drift apart.
// It used to be defined here, which meant the cron would have needed a copy.

app.get('/sqftlab/scrape', async (c) => {
  if (!cronAuthorized(c)) return c.json({ error: 'unauthorized' }, 401)

  const startedAt = Date.now()
  let totalSaved = 0
  let saveFailures = 0
  let firstSaveError: string | null = null
  const logs: string[] = []

  // Any row still marked 'running' when a new run starts belongs to a process
  // that died mid-crawl — a deploy, a crash, or a request the caller killed. This
  // handler is the only writer, so the row cannot belong to a live run. Left
  // alone it keeps the health view showing an active scrape that ended hours ago.
  await prisma.scraperLog
    .updateMany({
      where: { source: 'propertyfinder', status: 'running' },
      data: { status: 'error', errorMsg: 'Interrupted — superseded by a newer run', finishedAt: new Date() },
    })
    .catch(() => {})

  // Best-effort audit row. A missing/failing log table must never abort a scrape.
  const logRun = await prisma.scraperLog
    .create({ data: { source: 'propertyfinder', status: 'running', startedAt: new Date() } })
    .catch(() => null)

  // Circuit breaker. A refusal (429/403, or retries exhausted) is the signal
  // worth tripping on. Left unchecked this crawls 22 areas × 2 categories × 3
  // pages against a host that is already saying no.
  let consecutiveFailures = 0
  let throttledResponses = 0
  let circuitBroken = false
  const MAX_FAILURES = 3

  // Each run resolves communities afresh — a run must never inherit the previous
  // run's view of the table.
  communityRunCache = new Map()

  try {
  // Scrape Dubai + Abu Dhabi
  for (const areas of [DUBAI_AREAS, AD_AREAS]) {
    const emirate = areas === DUBAI_AREAS ? 'dubai' : 'abu_dhabi'
    for (const area of areas) {
      for (const catId of [1, 2]) {
        const purpose = catId === 1 ? 'sale' : 'rent'
        for (let page = 1; page <= 3; page++) {
          const { props, throttled } = await pfFetchPage(catId, area.lid, page)

          // Only a refusal counts toward the breaker. An empty page from a portal
          // that answered normally is just the end of this area's results —
          // counting it as a failure abandoned the remaining areas after three
          // genuinely thin ones.
          if (throttled) {
            throttledResponses++
            consecutiveFailures++
            if (consecutiveFailures >= MAX_FAILURES) {
              circuitBroken = true
              logs.push(`Circuit breaker tripped: ${MAX_FAILURES} consecutive refusals — stopping scrape`)
            }
            break
          }
          consecutiveFailures = 0
          if (props.length === 0) break // no further pages of this size

          for (const p of props) {
            try {
              const parsed = pfParse(p, 'propertyfinder', purpose)
              if (parsed.priceAed <= 0) continue
              // Attribute to the AREA being scraped, not `parsed.locationSlug`.
              // PropertyFinder's card carries the BUILDING's slug, so trusting it
              // created one community per building — a single run added 484 rows
              // like `jumeirah-lake-towers-jlt-cluster-e-global-lake-view`, every
              // one with zero listings and the wrong emirate. A listing returned
              // by the "Dubai Marina" search belongs to Dubai Marina.
              const community = await ensureCommunity(area.name, area.slug, emirate)
              await prisma.listing.upsert({
                where: { externalId: parsed.externalId },
                create: {
                  externalId: parsed.externalId, source: parsed.source,
                  communityId: community.id, purpose: parsed.purpose,
                  propertyType: parsed.propertyType, beds: parsed.beds,
                  baths: parsed.baths, areaSqft: parsed.areaSqft,
                  priceAed: parsed.priceAed, pricePerSqft: parsed.pricePerSqft,
                  furnished: parsed.furnished, completion: parsed.completion,
                  agentName: parsed.agentName, agencyName: parsed.agencyName,
                  title: parsed.title, imageUrl: parsed.imageUrl,
                  sourceUrl: parsed.sourceUrl,
                  latitude: parsed.latitude, longitude: parsed.longitude,
                  listedAt: parsed.listedAt, isDeal: false,
                },
                update: {
                  priceAed: parsed.priceAed, pricePerSqft: parsed.pricePerSqft,
                  title: parsed.title, imageUrl: parsed.imageUrl,
                  sourceUrl: parsed.sourceUrl,
                  agentName: parsed.agentName, agencyName: parsed.agencyName,
                  scrapedAt: new Date(),
                },
              })
              totalSaved++
            } catch (err) {
              // Never let one bad listing abort the crawl — but never lose it
              // silently either. A bare `catch {}` here hid a total write failure
              // (every listing rejected by Prisma) behind a run that reported
              // success having saved 0. Count it, keep the first message, report both.
              saveFailures++
              if (!firstSaveError) firstSaveError = err instanceof Error ? err.message : String(err)
            }
          }
          // Jittered 3–6s. The random component is the point: a fixed interval is
          // a trivially detectable pattern over a multi-minute crawl.
          await sleepMs(3000 + Math.random() * 3000)
        }
        if (circuitBroken) break
      }
      if (circuitBroken) break
    }
    if (circuitBroken) break
  }

  // Cleanup old listings (>30 days)
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
  const deleted = await prisma.listing.deleteMany({ where: { scrapedAt: { lt: thirtyDaysAgo } } })

  // ── Community stats: batched, and PSF sourced from DLD transactions ────────
  // This previously ran four queries per community inside a loop (4 × 39 round
  // trips) and derived PSF from listing asking prices — the opposite of what the
  // product claims. Now: five grouped queries total, and medianAedSqft prefers
  // the government register, recording which source won in `psfSource`.
  const [statsCommunities, listingPsfByComm, rentByComm, txCountByComm, txPsfByComm] = await Promise.all([
    prisma.community.findMany({
      select: { id: true, medianAedSqft: true, medianAnnualRentAed: true, grossYieldPct: true },
    }),
    prisma.listing.groupBy({
      by: ['communityId'],
      where: { purpose: 'sale', pricePerSqft: { gt: 0 } },
      _avg: { pricePerSqft: true },
    }),
    prisma.listing.groupBy({
      by: ['communityId'],
      where: { purpose: 'rent', priceAed: { gt: 0 } },
      _avg: { priceAed: true },
    }),
    prisma.transaction.groupBy({ by: ['communityId'], _count: { _all: true } }),
    prisma.transaction.groupBy({
      by: ['communityId'],
      where: { transactionType: { in: SALE_TXN_TYPES }, pricePerSqft: { gt: 100 } },
      _avg: { pricePerSqft: true },
    }),
  ])

  const listPsfMap = new Map(listingPsfByComm.map((r) => [r.communityId, r._avg.pricePerSqft ?? 0]))
  const rentMap = new Map(rentByComm.map((r) => [r.communityId, r._avg.priceAed ?? 0]))
  const txCountMap = new Map(txCountByComm.map((r) => [r.communityId, r._count._all]))
  const txPsfMap = new Map(txPsfByComm.map((r) => [r.communityId, r._avg.pricePerSqft ?? 0]))

  await prisma.$transaction(
    statsCommunities.map((comm) => {
      const txPsf = txPsfMap.get(comm.id) ?? 0
      const listPsf = listPsfMap.get(comm.id) ?? 0
      // A transaction-derived level is government-registered, so it wins over
      // asking prices whenever we actually have one.
      const mp = Math.round(txPsf > 0 ? txPsf : listPsf)
      const mr = Math.round(rentMap.get(comm.id) ?? 0)
      const yld = mp > 0 && mr > 0 ? Math.round((mr / (mp * 1000)) * 10000) / 100 : 0
      return prisma.community.update({
        where: { id: comm.id },
        data: {
          medianAedSqft: mp || comm.medianAedSqft,
          medianAnnualRentAed: mr || comm.medianAnnualRentAed,
          grossYieldPct: yld || comm.grossYieldPct,
          totalTransactions: txCountMap.get(comm.id) ?? 0,
          psfSource: txPsf > 0 ? 'dld' : 'listing',
        },
      })
    })
  )

  // ── Deal detection ────────────────────────────────────────────────────────
  const dealsDetected = await detectDeals()

  const elapsed = Math.round((Date.now() - startedAt) / 1000)
  const finalCount = await prisma.listing.count()

  if (saveFailures > 0) {
    logs.push(`${saveFailures} listing(s) failed to persist — first error: ${firstSaveError}`)
  }

  if (logRun) {
    await prisma.scraperLog
      .update({
        where: { id: logRun.id },
        data: {
          // A run that saved nothing because every write threw is not a success.
          status: circuitBroken || saveFailures > 0 ? 'partial' : 'success',
          recordsNew: totalSaved,
          errorMsg: firstSaveError ?? undefined,
          finishedAt: new Date(),
          durationMs: Date.now() - startedAt,
        },
      })
      .catch(() => {})
  }

  return c.json({
    ok: true,
    saved: totalSaved,
    saveFailures,
    firstSaveError,
    deleted: deleted.count,
    dealsDetected,
    totalListings: finalCount,
    communities: statsCommunities.length,
    circuitBroken,
    throttledResponses,
    logs,
    elapsed: `${elapsed}s`,
  })
  } catch (err) {
    // The audit row must reach a terminal state. Without this a scrape that threw
    // mid-run left its ScraperLog stuck on 'running' forever, so the health view
    // showed an active run that had actually died minutes earlier.
    if (logRun) {
      await prisma.scraperLog
        .update({
          where: { id: logRun.id },
          data: {
            status: 'error',
            errorMsg: String(err).slice(0, 1000),
            finishedAt: new Date(),
            durationMs: Date.now() - startedAt,
          },
        })
        .catch(() => {})
    }
    throw err
  }
})

// ─── Scraper status ─────────────────────────────────────────────────────────

app.get('/sqftlab/scrape/status', async (c) => {
  const [listingCount, communityCount, transactionCount, oldestListing, newestListing] = await Promise.all([
    prisma.listing.count(),
    prisma.community.count(),
    prisma.transaction.count(),
    prisma.listing.findFirst({ orderBy: { scrapedAt: 'asc' }, select: { scrapedAt: true } }),
    prisma.listing.findFirst({ orderBy: { scrapedAt: 'desc' }, select: { scrapedAt: true } }),
  ])

  const byPurpose = await prisma.listing.groupBy({ by: ['purpose'], _count: true })
  const bySource = await prisma.listing.groupBy({ by: ['source'], _count: true })

  return c.json({
    listings: listingCount,
    communities: communityCount,
    transactions: transactionCount,
    oldestListing: oldestListing?.scrapedAt,
    newestListing: newestListing?.scrapedAt,
    byPurpose: Object.fromEntries(byPurpose.map(r => [r.purpose, r._count])),
    bySource: Object.fromEntries(bySource.map(r => [r.source, r._count])),
  })
})

// ─── Identity ────────────────────────────────────────────────────────────────

// Account-scoped routes resolve the caller from the request. This replaces the
// old hardcoded demo-user constant, which meant every visitor was served the
// same person's portfolio, watchlist and alerts regardless of who they were.
//
// NOTE: this is *identification*, not authentication. A bearer value or cookie
// is taken at face value, so it is not a security boundary — anyone can claim
// any user id. Its purpose is to stop account-scoped routes leaking a single
// global identity; real auth belongs in front of it.
function getUserId(c: Context): string | null {
  const auth = c.req.header('Authorization')
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim() || null
  const cookie = c.req.header('Cookie') ?? ''
  // `next-auth.session-token` is the cookie name establishSession() issues.
  // Bare `session` stays accepted as a fallback for earlier links.
  const match =
    cookie.match(/(?:^|;\s*)(?:__Secure-)?next-auth\.session-token=([^;]+)/) ??
    cookie.match(/(?:^|;\s*)session=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

// The seeded demo account, resolved by email (falling back to the oldest user)
// so no cuid is baked into the source.
/**
 * The demo account this deployment runs as, for the routes that answer without a
 * session.
 *
 * This used to ask for `demo@sqftlab.ae`, which does not exist — the seeded account
 * is `demo@sqftlab.com` — so it always fell through to "oldest user". That looked
 * harmless only because the two happened to be the same row: the moment a second
 * account exists, the fallback would silently bind the site to whichever user was
 * created first. Look the demo addresses up explicitly and honour the env override.
 */
async function seededUserId(): Promise<string | null> {
  const candidates = [process.env.DEMO_USER_EMAIL, 'demo@sqftlab.com', 'demo@sqftlab.ae'].filter(
    (e): e is string => !!e &&
      e.length > 0
  )
  // One query rather than one per candidate (Day 15 D3). This runs on the identity
  // bootstrap, so it is on the path of every first request from a fresh browser. The
  // candidate ORDER still decides the winner when several rows exist, because that is
  // the precedence this always had — `in` does not preserve order, so it is reapplied
  // here instead of trusting whatever the database returns first.
  if (candidates.length > 0) {
    const found = await prisma.user.findMany({
      where: { email: { in: candidates } },
      select: { id: true, email: true },
    })
    for (const email of candidates) {
      const hit = found.find((u) => u.email === email)
      if (hit) return hit.id
    }
  }
  const oldest = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } })
  return oldest?.id ?? null
}

// ─── Portfolio ───────────────────────────────────────────────────────────────
//
// A holding's current value is only ever what a valuation produced. `valuedAt` is the
// marker: written by the valuation paths in `src/lib/portfolio-jobs.ts` and by nothing
// else, so a non-null `valuedAt` is evidence a valuation ran, and a null one means "not
// valued yet".
//
// The previous version of this route summed `currentValue` across every row. The three
// seeded holdings were written by a seeder using `price * (1 + random*0.2)` and are
// backed by zero transactions, so the screen presented AED 10,941,214 of invented
// market value as DLD valuations. Unvalued holdings are now excluded from the totals
// and the gain is `null` — unknown — rather than a reassuring 0.0%.

/** The columns the serialised holding needs. Structural, so a Prisma row satisfies it. */
interface PortfolioRowLike {
  id: string
  title: string
  buildingName: string | null
  propertyType: string
  beds: number
  areaSqft: number
  floor: number | null
  unitNumber: string | null
  purchasePrice: number
  purchaseDate: Date
  annualRent: number
  serviceCharge: number
  mortgageBalance: number
  currentValue: number
  valuedAt: Date | null
  valuationSource: string | null
  valuationComps: number | null
  community: { nameEn: string; slug: string; medianAedSqft: number; grossYieldPct: number }
}

/**
 * One serialiser for the list AND the add response.
 *
 * They previously disagreed: the list reported `currentValue: null` for an unvalued
 * holding, while the add response spread the raw row and so reported `currentValue: 0`.
 * The same holding therefore looked "valued at nothing" to one caller and "not valued"
 * to another, and a client reading `currentValue` could not tell which it was getting.
 */
function serialiseHolding(p: PortfolioRowLike) {
  const d = deriveHolding(p)
  return {
    id: p.id,
    title: p.title,
    buildingName: p.buildingName,
    propertyType: p.propertyType,
    beds: p.beds,
    areaSqft: p.areaSqft,
    floor: p.floor,
    unitNumber: p.unitNumber,
    purchasePrice: p.purchasePrice,
    purchaseDate: p.purchaseDate,
    purchasePsf: d.purchasePsf,
    annualRent: p.annualRent,
    serviceCharge: p.serviceCharge,
    mortgageBalance: p.mortgageBalance,
    // `null`, never the purchase price and never 0: an unvalued holding has no value.
    currentValue: d.currentValueAed,
    currentPsf: d.currentPsf,
    valuedAt: p.valuedAt,
    valuationSource: p.valuationSource,
    valuationComps: p.valuationComps,
    isValued: d.isValued,
    gainAed: d.gainAed,
    gainPct: d.gainPct,
    community: p.community,
  }
}

app.get('/sqftlab/portfolio', async (c) => {
  const blocked = requireTier(c, 'pro', 'Portfolio')
  if (blocked) return blocked
  const userId = getUserId(c)
  if (!userId) return upgradeRequired(c)

  const rows = await prisma.portfolio.findMany({
    where: { userId },
    orderBy: { purchaseDate: 'desc' },
    include: { community: { select: { nameEn: true, slug: true, medianAedSqft: true, grossYieldPct: true } } },
  })

  // The cap limits what is returned, but the counts describe the user's real portfolio.
  // A capped list that looks complete would make "5 of 5" indistinguishable from "5 of 9".
  const tier = (c.get('tier') as CallerTier | undefined) ?? 'guest'
  const limit = propertyLimitFor(tier)
  const visible = limit === null ? rows : rows.slice(0, limit)

  const items = visible.map(serialiseHolding)

  const summary = summariseHoldings(visible)
  const totalAnnualRent = visible.reduce((s, i) => s + i.annualRent, 0)
  const monthlyCashFlow = visible.reduce(
    (s, i) => s + (i.annualRent - i.serviceCharge) / 12 - i.mortgageBalance * (i.mortgageRate / 100 / 12),
    0,
  )

  await trackEvent(c, 'portfolio_view', { propertyCount: visible.length, valuedCount: summary.valuedCount })

  return c.json({
    items,
    summary: {
      // Legacy keys, kept for their existing callers. They now mean "across valued
      // holdings"; `valuedCount`/`unvaluedCount` say how much of the portfolio that is,
      // and the gain is null rather than 0 when nothing has been valued.
      totalValue: summary.currentAed,
      totalCost: summary.purchaseAed,
      totalGainLoss: summary.gainAed,
      gainLossPct: summary.gainPct,
      totalAnnualRent: Math.round(totalAnnualRent),
      weightedYield: summary.currentAed > 0 ? Math.round((totalAnnualRent / summary.currentAed) * 10000) / 100 : 0,
      monthlyCashFlow: Math.round(monthlyCashFlow),
      propertyCount: visible.length,
      // The Day 8 contract.
      count: summary.count,
      totalPurchaseAed: summary.purchaseAed,
      totalCurrentAed: summary.currentAed,
      totalGainAed: summary.gainAed,
      totalGainPct: summary.gainPct,
      valuedCount: summary.valuedCount,
      unvaluedCount: summary.unvaluedCount,
      valuedPurchaseAed: summary.valuedPurchaseAed,
      totalPropertyCount: rows.length,
    },
    ...(limit !== null
      ? {
          limit,
          // Reported at the limit as well as over it: "5 of 5" has to be visible to the
          // user who is about to be refused, not only to the one who already is.
          atLimit: rows.length >= limit,
          totalCount: rows.length,
          ...(rows.length > limit
            ? {
                limited: true,
                message: `Pro tracks up to ${limit} properties. Upgrade to Enterprise to track all ${rows.length}.`,
              }
            : {}),
        }
      : {}),
  })
})

// Add a holding. The spec showed `data: { userId, ...body }`, which spreads arbitrary
// client input straight into the row (mass assignment — a caller could set
// `purchaseDate` to any value, or `currentValue` to whatever they liked). Field
// validation was added then, but the row still wrote
// `currentValue: num(body.currentValue, purchasePrice)` — so a caller could still
// lodge an arbitrary figure as the market value, and with no client value the purchase
// price was stored as one, reporting a flat 0.0% return as a market outcome. Client
// input can no longer reach the valuation columns at all; they are written only by a
// valuation that actually ran.

const PORTFOLIO_EXPECTED: Record<string, string> = {
  communitySlug: 'non-empty string — the district slug, e.g. "dubai-marina"',
  title: 'optional string — the holding name; defaults to the building name',
  buildingName: 'optional string — defaults to title',
  propertyType: 'optional string — defaults to "apartment"',
  beds: 'integer >= 0 (0 = studio)',
  areaSqft: 'a positive number — the unit size in sqft',
  purchasePrice: 'a positive number (AED)',
  purchaseDate: 'optional ISO date — defaults to today; cannot be in the future',
  floor: 'optional integer',
  unitNumber: 'optional string',
  annualRent: 'optional non-negative number (AED)',
  serviceCharge: 'optional non-negative number (AED)',
}

app.post('/sqftlab/portfolio', async (c) => {
  const blocked = requireTier(c, 'pro', 'Portfolio')
  if (blocked) return blocked
  const userId = getUserId(c)
  if (!userId) return upgradeRequired(c)

  const tier = (c.get('tier') as CallerTier | undefined) ?? 'guest'
  const limit = propertyLimitFor(tier)
  const count = await prisma.portfolio.count({ where: { userId } })
  if (limit !== null && count >= limit) {
    return c.json({
      error: 'Portfolio limit reached',
      message: `Pro tracks up to ${limit} properties. Upgrade to Enterprise for unlimited.`,
      limit,
      count,
      upgradeUrl: '/pricing',
      limited: true,
    }, 403)
  }

  const body = await readJsonBody(c)

  const communitySlug = strField(body, 'communitySlug') ?? strField(body, 'community')
  const title = strField(body, 'title')
  const buildingName = strField(body, 'buildingName')
  const propertyType = strField(body, 'propertyType')
  const unitNumber = strField(body, 'unitNumber')
  const beds = numField(body, 'beds')
  const areaSqft = numField(body, 'areaSqft')
  const purchasePrice = numField(body, 'purchasePrice')
  const floor = numField(body, 'floor')
  const annualRent = numField(body, 'annualRent') ?? 0
  const serviceCharge = numField(body, 'serviceCharge') ?? 0
  const rawDate = strField(body, 'purchaseDate')

  const bad: string[] = []
  if (!communitySlug) bad.push('communitySlug')
  if (beds === null || beds < 0 || !Number.isInteger(beds)) bad.push('beds')
  if (areaSqft === null || areaSqft <= 0) bad.push('areaSqft')
  if (purchasePrice === null || purchasePrice <= 0) bad.push('purchasePrice')
  if (floor !== null && !Number.isInteger(floor)) bad.push('floor')
  if (annualRent < 0) bad.push('annualRent')
  if (serviceCharge < 0) bad.push('serviceCharge')
  if (bad.length) return badInput(c, bad, PORTFOLIO_EXPECTED)
  // Restated so TypeScript narrows each value; an empty `bad` does not tie the array's
  // emptiness to the individual checks above.
  if (!communitySlug || beds === null || areaSqft === null || purchasePrice === null) {
    return badInput(c, ['communitySlug', 'beds', 'areaSqft', 'purchasePrice'], PORTFOLIO_EXPECTED)
  }

  const purchaseDate = rawDate ? new Date(rawDate) : new Date()
  if (Number.isNaN(purchaseDate.getTime())) {
    return c.json({ error: 'purchaseDate must be a valid date', expected: PORTFOLIO_EXPECTED.purchaseDate }, 400)
  }
  // A purchase in the future is a typo, not a holding; it would also park the row
  // outside every "since purchase" window the analytics use.
  if (purchaseDate.getTime() > Date.now() + 86_400_000) {
    return c.json({ error: 'purchaseDate cannot be in the future' }, 400)
  }

  const community = await prisma.community.findUnique({
    where: { slug: communitySlug },
    select: { id: true, nameEn: true },
  })
  if (!community) return c.json({ error: `Unknown district "${communitySlug}"` }, 400)

  const comps = await fetchHoldingsComparables(community.id, beds, areaSqft)
  const valuation = valuateHolding(
    {
      buildingName: buildingName ?? title ?? '',
      community: community.nameEn,
      bedrooms: beds,
      sizeSqft: areaSqft,
      floor,
      condition: null,
      listingPrice: null,
    },
    comps,
  )

  const item = await prisma.portfolio.create({
    data: {
      userId,
      communityId: community.id,
      title: title ?? buildingName ?? 'Untitled holding',
      propertyType: propertyType ?? 'apartment',
      beds,
      areaSqft,
      purchasePrice,
      purchaseDate,
      buildingName: buildingName ?? null,
      floor,
      unitNumber: unitNumber ?? null,
      annualRent,
      serviceCharge,
      // Only a valuation that ran writes these. With no comparables the columns keep
      // their defaults and `valuedAt` stays null, which is what tells the UI this
      // holding has not been valued — as opposed to being worth what was paid for it.
      currentValue: valuation?.valueAed ?? 0,
      valuedAt: valuation?.asOf ?? null,
      valuationSource: valuation?.source ?? null,
      valuationComps: valuation?.compsUsed ?? null,
    },
    // Included so the add response carries the same community shape the list returns;
    // one serialiser for both keeps them from drifting apart again.
    include: { community: { select: { nameEn: true, slug: true, medianAedSqft: true, grossYieldPct: true } } },
  })

  await trackEvent(c, 'portfolio_add', { community: communitySlug, bedrooms: beds, valued: Boolean(valuation) })

  return c.json({
    item: serialiseHolding(item),
    valued: Boolean(valuation),
    comparableSalesFound: comps.length,
    ...(valuation
      ? {}
      : {
          message:
            `Added, but not yet valued: only ${comps.length} comparable sale` +
            `${comps.length === 1 ? '' : 's'} matched this unit in ${community.nameEn} (at least ` +
            `${MIN_COMPS} are needed). ` +
            (dldConfigured()
              ? 'The nightly job will value it once more sales are recorded.'
              : 'The DLD transaction feed is not connected on this deployment — set DUBAI_PULSE_API_KEY to enable it.'),
        }),
  }, 201)
})

// Remove a holding.
app.delete('/sqftlab/portfolio/:id', async (c) => {
  const blocked = requireTier(c, 'pro', 'Portfolio')
  if (blocked) return blocked
  const userId = getUserId(c)
  if (!userId) return upgradeRequired(c)

  // Scoped by userId inside the DELETE rather than fetched first and authorised after:
  // authorise-after-read is one refactor away from deleting another account's row, and
  // reading first still leaks whether an id exists.
  const result = await prisma.portfolio.deleteMany({ where: { id: c.req.param('id'), userId } })
  if (result.count === 0) return c.json({ error: 'Not found' }, 404)

  await trackEvent(c, 'portfolio_remove', { id: c.req.param('id') })
  return c.json({ deleted: true })
})

// ─── Watchlist ───────────────────────────────────────────────────────────────

app.get('/sqftlab/watchlist', async (c) => {
  const userId = getUserId(c)
  if (!userId) return upgradeRequired(c)

  const items = await prisma.watchlist.findMany({
    where: { userId },
    include: { community: true },
    orderBy: { addedAt: 'desc' },
  })
  return c.json({ items })
})

// ─── Deals ───────────────────────────────────────────────────────────────────

// Re-run deal detection without a full scrape. Same secret as /scrape so it can
// be driven from the cron without exposing a mutation to the public.
app.get('/sqftlab/detect-deals', async (c) => {
  if (!cronAuthorized(c)) return c.json({ error: 'unauthorized' }, 401)

  const dealsDetected = await detectDeals()
  return c.json({ ok: true, dealsDetected })
})

app.get('/sqftlab/deals', async (c) => {
  const deals = await prisma.listing.findMany({
    where: { isDeal: true, purpose: 'sale' },
    include: { community: { select: { nameEn: true, slug: true, medianAedSqft: true } } },
    orderBy: { listedAt: 'desc' },
    take: 30,
  })

  // How far below the district median each listing sits. Without this the UI can
  // only show a "deal" badge with no magnitude behind it.
  const dealsWithDiscount = deals.map((d) => ({
    ...d,
    discountPct:
      d.community.medianAedSqft > 0 && d.pricePerSqft > 0
        ? Math.round((1 - d.pricePerSqft / d.community.medianAedSqft) * 100 * 10) / 10
        : 0,
  }))

  // An empty list is otherwise indistinguishable from a broken feature. The
  // deal rule is defined against the 90-day DLD median (see src/lib/deals.ts),
  // so with no registered transactions this is the expected result until a
  // DLD source is connected — say which, rather than returning a bare [].
  if (dealsWithDiscount.length === 0) {
    const [saleListings, medians] = await Promise.all([
      prisma.listing.count({ where: { purpose: 'sale' } }),
      marketPsfByCommunity(),
    ])
    const communitiesWithMedian = [...medians.values()].filter((m) => m > 100).length
    return c.json({
      deals: [],
      basis: 'dld_90d_median',
      saleListings,
      communitiesWithDldMedian: communitiesWithMedian,
      ...(communitiesWithMedian === 0
        ? {
            insufficientData: true,
            message:
              'No deals can be evaluated yet: the 8% rule compares each listing against its area\u2019s 90-day DLD median, and no registered transactions are loaded. Set DUBAI_PULSE_API_KEY to activate.',
          }
        : { message: `No listings are currently 8% or more below their area's DLD median (${saleListings} sale listings evaluated).` }),
    })
  }

  return c.json({ deals: dealsWithDiscount, basis: 'dld_90d_median' })
})

// ─── Listings search ─────────────────────────────────────────────────────────

app.get('/sqftlab/listings', async (c) => {
  const purpose = c.req.query('purpose') || 'sale'
  const emirate = c.req.query('emirate')
  const beds = c.req.query('beds')
  const propertyType = c.req.query('type')
  const dealsOnly = c.req.query('deals') === 'true'
  const priceMin = c.req.query('priceMin')
  const priceMax = c.req.query('priceMax')
  const page = parseInt(c.req.query('page') || '1')
  const limit = 20

  const where: Record<string, unknown> = { purpose }
  if (dealsOnly) where.isDeal = true
  if (beds) where.beds = parseInt(beds)
  if (propertyType) where.propertyType = propertyType
  if (priceMin || priceMax) {
    where.priceAed = {}
    if (priceMin) (where.priceAed as Record<string, number>).gte = parseInt(priceMin)
    if (priceMax) (where.priceAed as Record<string, number>).lte = parseInt(priceMax)
  }
  if (emirate && emirate !== 'all') {
    where.community = { emirate }
  }

  const [listings, total] = await Promise.all([
    prisma.listing.findMany({
      where,
      include: { community: { select: { nameEn: true, slug: true, emirate: true, medianAedSqft: true } } },
      orderBy: { listedAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.listing.count({ where }),
  ])

  // Task B3 — guests get the first 10 rows and no deal badge. `isDeal` is the
  // paid signal (it is the whole point of the deals feed), so it is stripped
  // rather than merely hidden in the UI.
  const tier = c.get('tier') as CallerTier
  const visibleListings =
    tier === 'guest' ? listings.slice(0, 10).map(({ isDeal: _isDeal, ...rest }) => rest) : listings

  await trackEvent(c, 'search', { tier, returned: visibleListings.length, total })

  return c.json({
    listings: visibleListings,
    total,
    page,
    pages: Math.ceil(total / limit),
    ...(tier === 'guest'
      ? { limited: true, message: 'Sign in to browse every listing', signInUrl: '/auth/signin' }
      : {}),
  })
})

// Single listing by id. The property page previously fetched a *page* of the
// list and searched it client-side, but that list defaults to `purpose=sale`,
// so opening any rental resolved to nothing and rendered "Property not found".
// Look the row up directly instead of scanning a page that may not contain it.
app.get('/sqftlab/listings/:id', async (c) => {
  const id = c.req.param('id')
  const listing = await prisma.listing.findUnique({
    where: { id },
    include: {
      community: {
        select: {
          nameEn: true, slug: true, emirate: true,
          medianAedSqft: true, grossYieldPct: true, totalTransactions: true,
        },
      },
    },
  })
  if (!listing) return c.json({ error: 'Listing not found' }, 404)

  // Comparable registered sales for this district. Empty until a registry
  // source (Dubai Pulse) is connected — deliberately not back-filled from the
  // listing itself, which is how the old page asserted DLD data it never had.
  const comps = await prisma.transaction.findMany({
    where: { communityId: listing.communityId, transactionType: 'sale' },
    orderBy: { transactionDate: 'desc' },
    take: 5,
  })

  const tier = c.get('tier') as CallerTier
  const { isDeal: _isDeal, ...rest } = listing

  return c.json({
    listing: tier === 'guest' ? rest : listing,
    comps,
    compsSource: comps.length > 0 ? 'dld' : null,
    ...(tier === 'guest'
      ? { limited: true, message: 'Sign in to see deal pricing', signInUrl: '/auth/signin' }
      : {}),
  })
})

// ─── Alerts ──────────────────────────────────────────────────────────────────

// Legacy rule-based alerts (Alert model). The Deal Alert Engine (TASK 12) owns
// /sqftlab/alerts, so these stay reachable at their own path rather than
// shadowing the new CRUD routes.
app.get('/sqftlab/alert-rules', async (c) => {
  const userId = getUserId(c)
  if (!userId) return upgradeRequired(c)

  const alerts = await prisma.alert.findMany({
    where: { userId },
    include: { community: { select: { nameEn: true, slug: true } } },
    orderBy: { createdAt: 'desc' },
  })
  return c.json({ alerts })
})

// ─── Market Analytics ────────────────────────────────────────────────────────

app.get('/sqftlab/market/analytics', async (c) => {
  const [communities, transactions, listings] = await Promise.all([
    prisma.community.findMany({
      orderBy: { medianAedSqft: 'desc' },
      select: {
        id: true, nameEn: true, slug: true, emirate: true,
        medianAedSqft: true, medianAnnualRentAed: true, grossYieldPct: true,
        priceChange30d: true, priceChange1y: true, transactionCount30d: true,
        totalTransactions: true,
      },
    }),
    prisma.transaction.groupBy({
      by: ['transactionType'],
      _count: true,
      _avg: { priceAed: true, pricePerSqft: true },
    }),
    prisma.listing.groupBy({
      by: ['purpose', 'propertyType'],
      _count: true,
      _avg: { priceAed: true, pricePerSqft: true },
    }),
  ])

  const totalTransactions = communities.reduce((s, c) => s + c.totalTransactions, 0)
  const totalTx30d = communities.reduce((s, c) => s + c.transactionCount30d, 0)
  const avgPsf = Math.round(communities.reduce((s, c) => s + c.medianAedSqft, 0) / communities.length)
  const avgYield = Math.round(communities.reduce((s, c) => s + c.grossYieldPct, 0) / communities.length * 100) / 100
  const avgPriceChange30d = Math.round(communities.reduce((s, c) => s + c.priceChange30d, 0) / communities.length * 100) / 100
  const avgPriceChange1y = Math.round(communities.reduce((s, c) => s + c.priceChange1y, 0) / communities.length * 100) / 100

  const topGainers = [...communities].sort((a, b) => b.priceChange30d - a.priceChange30d).slice(0, 10)
  const topLosers = [...communities].sort((a, b) => a.priceChange30d - b.priceChange30d).slice(0, 10)
  const highestYield = [...communities].sort((a, b) => b.grossYieldPct - a.grossYieldPct).slice(0, 10)
  const mostActive = [...communities].sort((a, b) => b.transactionCount30d - a.transactionCount30d).slice(0, 10)

  const priceBuckets = [
    { label: '< AED 1K', min: 0, max: 1000, count: 0 },
    { label: 'AED 1K-1.5K', min: 1000, max: 1500, count: 0 },
    { label: 'AED 1.5K-2K', min: 1500, max: 2000, count: 0 },
    { label: 'AED 2K-3K', min: 2000, max: 3000, count: 0 },
    { label: 'AED 3K-5K', min: 3000, max: 5000, count: 0 },
    { label: 'AED 5K+', min: 5000, max: Infinity, count: 0 },
  ]
  communities.forEach(c => {
    const bucket = priceBuckets.find(b => c.medianAedSqft >= b.min && c.medianAedSqft < b.max)
    if (bucket) bucket.count++
  })

  return c.json({
    summary: {
      communities: communities.length,
      totalTransactions,
      totalTx30d,
      totalListings: listings.reduce((s, l) => s + l._count, 0),
      avgPsf,
      avgYield,
      avgPriceChange30d,
      avgPriceChange1y,
    },
    topGainers,
    topLosers,
    highestYield,
    mostActive,
    priceBuckets,
    transactionTypes: transactions.map(t => ({
      type: t.transactionType,
      count: t._count,
      avgPrice: Math.round(t._avg.priceAed ?? 0),
      avgPsf: Math.round(t._avg.pricePerSqft ?? 0),
    })),
    listingsByType: listings.map(l => ({
      purpose: l.purpose,
      propertyType: l.propertyType,
      count: l._count,
      avgPrice: Math.round(l._avg.priceAed ?? 0),
    })),
  })
})

// ─── Price Predictions ──────────────────────────────────────────────────────

app.get('/sqftlab/predictions', async (c) => {
  const communities = await prisma.community.findMany({
    orderBy: { medianAedSqft: 'desc' },
    select: {
      id: true, nameEn: true, slug: true, emirate: true,
      medianAedSqft: true, medianAnnualRentAed: true, grossYieldPct: true,
      priceChange30d: true, priceChange1y: true, transactionCount30d: true,
      totalTransactions: true, neighbourhoodScore: true,
    },
  })

  const predictions = communities.map(c => {
    const momentum = c.priceChange30d * 12
    const historicalGrowth = c.priceChange1y
    const yieldSignal = c.grossYieldPct > 7 ? 1 : c.grossYieldPct > 5 ? 0 : -1
    const volumeSignal = c.transactionCount30d > 100 ? 1 : c.transactionCount30d > 50 ? 0 : -1
    const scoreSignal = c.neighbourhoodScore > 70 ? 1 : c.neighbourhoodScore > 50 ? 0 : -1

    const rawScore = momentum * 0.3 + historicalGrowth * 0.4 + yieldSignal * 5 + volumeSignal * 3 + scoreSignal * 2
    const confidence = Math.min(95, Math.max(45, 60 + c.transactionCount30d * 0.1 + (c.totalTransactions > 100 ? 10 : 0)))

    // A district with no listings has no price to project from. Dividing by it
    // produced NaN, which JSON serialises as null (rendered "+null%") and which
    // failed every branch of the momentum ladder below — labelling all 14
    // unmeasured districts "Declining trend", a fabricated downward signal.
    // Forecast only where a price actually exists.
    const measurable = c.medianAedSqft > 0
    const forecast6m = measurable ? Math.round(c.medianAedSqft * (1 + (rawScore / 100) * 0.5) * 100) / 100 : null
    const forecast12m = measurable ? Math.round(c.medianAedSqft * (1 + (rawScore / 100) * 1.0) * 100) / 100 : null
    // Named `projectedChange*` so the identifier itself says these are
    // extrapolations, not promises. The old "Strong Buy / Buy / Hold / Sell /
    // Avoid" labels are gone: they read as licensed investment advice while
    // being derived from a five-line arithmetic formula.
    const projectedChange6m = forecast6m === null ? null : Math.round((forecast6m / c.medianAedSqft - 1) * 10000) / 100
    const projectedChange12m = forecast12m === null ? null : Math.round((forecast12m / c.medianAedSqft - 1) * 10000) / 100

    const change6m = projectedChange6m
    const momentumLabel =
      change6m === null ? 'Not enough data'
      : change6m > 5 ? 'Strong upward trend'
      : change6m > 2 ? 'Moderate upward trend'
      : change6m > -2 ? 'Stable'
      : change6m > -5 ? 'Moderate downward trend'
      : 'Declining trend'

    const riskLevel = confidence > 75 ? 'Low' : confidence > 60 ? 'Medium' : 'High'

    return {
      community: c.nameEn,
      slug: c.slug,
      emirate: c.emirate,
      currentPsf: c.medianAedSqft,
      forecast6m,
      forecast12m,
      projectedChange6m,
      projectedChange12m,
      momentumLabel,
      confidence: Math.round(confidence),
      riskLevel,
      momentum: Math.round(momentum * 100) / 100,
      yield: c.grossYieldPct,
      volume: c.transactionCount30d,
      score: c.neighbourhoodScore,
    }
  })

  // Momentum buckets replace the buy/sell buckets: they describe the trend
  // rather than advising an action, and the response carries a disclaimer.
  // Only measured districts are bucketed — an unmeasured one has no projection,
  // so filing it under "Stable" would invent a reading.
  const measuredChanges = predictions.map(p => p.projectedChange6m).filter((n): n is number => n !== null)
  const rising = measuredChanges.filter(n => n > 2).length
  const stable = measuredChanges.filter(n => n <= 2 && n >= -2).length
  const falling = measuredChanges.filter(n => n < -2).length

  return c.json({
    disclaimer: 'Projections are based on historical trend extrapolation only. ' +
      'Not financial advice. Past performance does not predict future results. ' +
      'Consult a RERA-licensed agent before transacting.',
    predictions,
    summary: {
      rising,
      stable,
      falling,
      // Districts with no price produced no projection, so they are not counted
      // as analysed — the three buckets above partition exactly this set.
      totalAnalyzed: measuredChanges.length,
    },
    topMomentum: [...predictions].sort((a, b) => (b.projectedChange6m ?? -Infinity) - (a.projectedChange6m ?? -Infinity)).slice(0, 5),
    topGrowth: [...predictions].sort((a, b) => (b.projectedChange12m ?? -Infinity) - (a.projectedChange12m ?? -Infinity)).slice(0, 5),
    topYield: [...predictions].sort((a, b) => b.yield - a.yield).slice(0, 5),
  })
})

// ─── Transaction Analytics ──────────────────────────────────────────────────

app.get('/sqftlab/market/transactions', async (c) => {
  const communities = await prisma.community.findMany({
    select: { id: true, nameEn: true, slug: true },
  })

  const transactionsByType = await prisma.transaction.groupBy({
    by: ['transactionType'],
    _count: true,
    _avg: { priceAed: true, pricePerSqft: true },
    _sum: { priceAed: true },
  })

  const transactionsByProperty = await prisma.transaction.groupBy({
    by: ['propertyType'],
    _count: true,
    _avg: { priceAed: true, pricePerSqft: true },
  })

  const transactionsByBeds = await prisma.transaction.groupBy({
    by: ['beds'],
    _count: true,
    _avg: { priceAed: true, pricePerSqft: true },
    orderBy: { beds: 'asc' },
  })

  const recentTransactions = await prisma.transaction.findMany({
    orderBy: { transactionDate: 'desc' },
    take: 50,
    include: { community: { select: { nameEn: true, slug: true } } },
  })

  const priceRanges = [
    { label: '< AED 500K', min: 0, max: 500000, count: 0, totalValue: 0 },
    { label: 'AED 500K-1M', min: 500000, max: 1000000, count: 0, totalValue: 0 },
    { label: 'AED 1M-2M', min: 1000000, max: 2000000, count: 0, totalValue: 0 },
    { label: 'AED 2M-5M', min: 2000000, max: 5000000, count: 0, totalValue: 0 },
    { label: 'AED 5M-10M', min: 5000000, max: 10000000, count: 0, totalValue: 0 },
    { label: 'AED 10M+', min: 10000000, max: Infinity, count: 0, totalValue: 0 },
  ]

  recentTransactions.forEach(t => {
    const bucket = priceRanges.find(r => t.priceAed >= r.min && t.priceAed < r.max)
    if (bucket) {
      bucket.count++
      bucket.totalValue += t.priceAed
    }
  })

  return c.json({
    summary: {
      totalTransactions: recentTransactions.length,
      totalValue: priceRanges.reduce((s, r) => s + r.totalValue, 0),
      avgPrice: Math.round(recentTransactions.reduce((s, t) => s + t.priceAed, 0) / recentTransactions.length),
      avgPsf: Math.round(recentTransactions.reduce((s, t) => s + t.pricePerSqft, 0) / recentTransactions.length),
    },
    byType: transactionsByType.map(t => ({
      type: t.transactionType,
      count: t._count,
      avgPrice: Math.round(t._avg.priceAed ?? 0),
      avgPsf: Math.round(t._avg.pricePerSqft ?? 0),
      totalValue: Number(t._sum.priceAed ?? 0),
    })),
    byProperty: transactionsByProperty.map(t => ({
      type: t.propertyType,
      count: t._count,
      avgPrice: Math.round(t._avg.priceAed ?? 0),
      avgPsf: Math.round(t._avg.pricePerSqft ?? 0),
    })),
    byBeds: transactionsByBeds.map(t => ({
      beds: t.beds,
      count: t._count,
      avgPrice: Math.round(t._avg.priceAed ?? 0),
      avgPsf: Math.round(t._avg.pricePerSqft ?? 0),
    })),
    priceRanges,
    recent: recentTransactions.slice(0, 20),
  })
})

// ─── Stats for dashboard ─────────────────────────────────────────────────────

app.get('/sqftlab/stats', async (c) => {
  const [communityCount, transactionCount, listingCount, dealCount] = await Promise.all([
    prisma.community.count(),
    prisma.transaction.count(),
    prisma.listing.count(),
    prisma.listing.count({ where: { isDeal: true } }),
  ])

  const topCommunities = await prisma.community.findMany({
    orderBy: { priceChange30d: 'desc' },
    take: 5,
    select: { nameEn: true, slug: true, priceChange30d: true, medianAedSqft: true },
  })

  // `transactionCount: 0` is ambiguous and the UI was rendering it as a market fact
  // ("Transactions 0") when the real meaning is "no government feed is configured" —
  // DLD and ADREC both need credentials that this deployment does not have, and every
  // derived dataset (real price index, supply pipeline, deal detection) is downstream
  // of them. Say which case it is so the client can label it instead of asserting zero.
  const sources = { dld: dldConfigured(), adrec: adrecConfigured() }
  return c.json({
    communityCount,
    transactionCount,
    listingCount,
    dealCount,
    topCommunities,
    transactionSource: sources.dld || sources.adrec ? 'live' : 'unconfigured',
    sources,
  })
})

// ─── Pro Tier Intelligence (spec Part 8.3) ───────────────────────────────────

const UAE_CPI_YOY = [3.1, 3.4, 3.2, 2.9, 2.7, 2.8, 3.0, 3.3, 3.5, 3.2, 2.9, 2.6]
const UAE_GDP_GROWTH = 3.9
const AED_PER_USD = 3.6725

app.get('/sqftlab/intelligence', async (c) => {
  const [communities, txns, listingGroups] = await Promise.all([
    prisma.community.findMany({ orderBy: { medianAedSqft: 'desc' } }),
    prisma.transaction.findMany({
      select: {
        communityId: true,
        priceAed: true,
        pricePerSqft: true,
        transactionType: true,
        transactionDate: true,
      },
    }),
    prisma.listing.groupBy({ by: ['purpose'], _count: { _all: true } }),
  ])

  const byId = new Map(communities.map((x) => [x.id, x]))
  const buckets = new Map<string, Map<string, { sum: number; n: number }>>()
  const valueByCommunity = new Map<string, number>()
  const typeBuckets = new Map<string, { volume: number; count: number }>()

  for (const t of txns) {
    const month = t.transactionDate.toISOString().substring(0, 7)
    const m = buckets.get(month) ?? new Map<string, { sum: number; n: number }>()
    const cell = m.get(t.communityId) ?? { sum: 0, n: 0 }
    cell.sum += t.pricePerSqft
    cell.n += 1
    m.set(t.communityId, cell)
    buckets.set(month, m)

    valueByCommunity.set(t.communityId, (valueByCommunity.get(t.communityId) ?? 0) + t.priceAed)

    const tb = typeBuckets.get(t.transactionType) ?? { volume: 0, count: 0 }
    tb.volume += t.priceAed
    tb.count += 1
    typeBuckets.set(t.transactionType, tb)
  }

  const months = [...buckets.keys()].sort()
  const seriesDistricts = communities.slice(0, 6)
  const series = months.map((month) => {
    const row: Record<string, number | string> = { month }
    for (const d of seriesDistricts) {
      const cell = buckets.get(month)?.get(d.id)
      row[d.slug] = cell && cell.n > 0 ? Math.round(cell.sum / cell.n) : 0
    }
    return row
  })

  const totalValue = [...valueByCommunity.values()].reduce((a, b) => a + b, 0)
  const avgPsf = communities.length
    ? Math.round(communities.reduce((a, d) => a + d.medianAedSqft, 0) / communities.length)
    : 0
  const avgYield = communities.length
    ? communities.reduce((a, d) => a + d.grossYieldPct, 0) / communities.length
    : 0
  const avgMomentum = communities.length
    ? communities.reduce((a, d) => a + d.priceChange30d, 0) / communities.length
    : 0
  const activeListings = listingGroups.reduce((a, g) => a + g._count._all, 0)

  const gainers = [...communities].sort((a, b) => b.priceChange30d - a.priceChange30d)
  const losers = [...communities].sort((a, b) => a.priceChange30d - b.priceChange30d)
  const breadth = {
    gainers: communities.filter((d) => d.priceChange30d > 0.5).length,
    flat: communities.filter((d) => d.priceChange30d >= -0.5 && d.priceChange30d <= 0.5).length,
    losers: communities.filter((d) => d.priceChange30d < -0.5).length,
  }

  const scatter = communities.map((d) => ({
    slug: d.slug,
    name: d.nameEn,
    psf: d.medianAedSqft,
    yield: d.grossYieldPct,
    volume: d.transactionCount30d,
    momentum: d.priceChange30d,
  }))

  const flow = [...valueByCommunity.entries()]
    .map(([id, value]) => {
      const d = byId.get(id)
      if (!d) return null
      const perTxn = value / Math.max(1, d.transactionCount30d || 1)
      return {
        slug: d.slug,
        name: d.nameEn,
        valueAed: Math.round(value),
        perTxnAed: Math.round(perTxn),
        txnCount: d.transactionCount30d,
        direction: d.priceChange30d >= 0 ? 'inflow' : 'outflow',
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.valueAed - a.valueAed)

  const flowTotal = flow.reduce((a, d) => a + d.valueAed, 0)
  const topFlowCut = flow.slice(0, 8).reduce((a, d) => a + d.valueAed, 0)

  return c.json({
    overview: {
      avgPsf,
      avgYield: Number(avgYield.toFixed(2)),
      momentumIndex: Number(avgMomentum.toFixed(2)),
      transactionCount: txns.length,
      totalValueAed: Math.round(totalValue),
      activeListings,
      districtsTracked: communities.length,
      breadth,
    },
    gainers: gainers.slice(0, 5).map((d) => ({
      slug: d.slug, name: d.nameEn, change: d.priceChange30d, psf: d.medianAedSqft,
    })),
    losers: losers.slice(0, 5).map((d) => ({
      slug: d.slug, name: d.nameEn, change: d.priceChange30d, psf: d.medianAedSqft,
    })),
    seriesDistricts: seriesDistricts.map((d) => ({ slug: d.slug, name: d.nameEn })),
    series,
    scatter,
    scatterMedian: {
      psf: scatter.length
        ? Math.round(scatter.map((s) => s.psf).sort((a, b) => a - b)[Math.floor(scatter.length / 2)])
        : 0,
      yield: scatter.length
        ? Number(scatter.map((s) => s.yield).sort((a, b) => a - b)[Math.floor(scatter.length / 2)].toFixed(2))
        : 0,
    },
    flow: flow.slice(0, 10),
    flowSummary: {
      totalValueAed: flowTotal,
      topDistrictsSharePct: flowTotal ? Math.round((topFlowCut / flowTotal) * 1000) / 10 : 0,
      inflow: flow.filter((f) => f.direction === 'inflow').length,
      outflow: flow.filter((f) => f.direction === 'outflow').length,
    },
    transactionTypes: [...typeBuckets.entries()].map(([type, v]) => ({
      type, volumeAed: Math.round(v.volume), count: v.count,
    })),
    economic: {
      cpiYoyPct: UAE_CPI_YOY[new Date().getUTCMonth()],
      cpiSeries: months.map((m, i) => ({ month: m, cpi: UAE_CPI_YOY[i % UAE_CPI_YOY.length] })),
      gdpGrowthPct: UAE_GDP_GROWTH,
      aedPerUsd: AED_PER_USD,
      fxNote: 'AED is pegged to USD at 3.6725 — FX moves are a US-dollar story, not a dirham story.',
    },
    computedAt: new Date().toISOString(),
  })
})

// ─── Waitlist (spec Part 8.9) ────────────────────────────────────────────────

app.post('/sqftlab/waitlist', async (c) => {
  let body: { email?: string; tier?: string; source?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const email = (body.email ?? '').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return c.json({ error: 'Please enter a valid email address.' }, 400)
  }

  const tier = body.tier === 'elite' ? 'elite' : 'pro'
  const source = (body.source ?? 'waitlist_page').slice(0, 60)

  const existing = await prisma.waitlist.findUnique({ where: { email } })
  if (existing) {
    const count = await prisma.waitlist.count()
    return c.json({ ok: true, alreadyRegistered: true, position: count, email })
  }

  await prisma.waitlist.create({ data: { email, interestTier: tier, source } })
  const count = await prisma.waitlist.count()
  return c.json({ ok: true, alreadyRegistered: false, position: count, email })
})

app.get('/sqftlab/waitlist', async (c) => {
  const count = await prisma.waitlist.count()
  return c.json({ count })
})

// ─── TASK 8 — District market table ──────────────────────────────────────────
// One row per district with the spec's columns. Every value is aggregated from
// the register — nothing is synthesized, so a district with thin data reports
// null for a change rather than inventing a number.
app.get('/sqftlab/markets', async (c) => {
  const emirate = c.req.query('emirate')
  const propertyType = c.req.query('type')

  const communityWhere: Record<string, unknown> = {}
  if (emirate && emirate !== 'all') communityWhere.emirate = emirate

  const communities = await prisma.community.findMany({
    where: communityWhere,
    select: {
      id: true, slug: true, nameEn: true, emirate: true,
      medianAedSqft: true, grossYieldPct: true, priceChange30d: true,
      priceChange1y: true, transactionCount30d: true, totalTransactions: true,
      medianAnnualRentAed: true,
    },
  })

  // Sale listings per district, respecting the property-type filter.
  const listingWhere: Record<string, unknown> = { purpose: 'sale' }
  if (propertyType && propertyType !== 'any') listingWhere.propertyType = propertyType
  const listingGroups = await prisma.listing.groupBy({
    by: ['communityId'],
    where: listingWhere,
    _count: { _all: true },
  })
  const listingsByCommunity = new Map(listingGroups.map((g) => [g.communityId, g._count._all]))

  // 3-month change: mean realised PSF over the last 3 months vs the 3 before it.
  const sixMonthsAgo = new Date()
  sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6)
  const threeMonthsAgo = new Date()
  threeMonthsAgo.setUTCMonth(threeMonthsAgo.getUTCMonth() - 3)

  const txns = await prisma.transaction.findMany({
    where: { transactionDate: { gte: sixMonthsAgo }, pricePerSqft: { gt: 0 } },
    select: { communityId: true, transactionDate: true, pricePerSqft: true },
  })

  const recent = new Map<string, number[]>()
  const prior = new Map<string, number[]>()
  for (const t of txns) {
    const target = t.transactionDate >= threeMonthsAgo ? recent : prior
    const list = target.get(t.communityId)
    if (list) list.push(t.pricePerSqft)
    else target.set(t.communityId, [t.pricePerSqft])
  }
  const mean = (a?: number[]) => (a && a.length ? a.reduce((s, v) => s + v, 0) / a.length : null)

  const rows = communities.map((k) => {
    const recentMean = mean(recent.get(k.id))
    const priorMean = mean(prior.get(k.id))
    const change3m =
      recentMean != null && priorMean != null && priorMean > 0
        ? ((recentMean - priorMean) / priorMean) * 100
        : null

    // Momentum blends 30-day price movement with yield — a district that is both
    // appreciating and yielding well scores high.
    const momentum = (k.priceChange30d ?? 0) + (k.grossYieldPct ?? 0) * 0.5

    return {
      slug: k.slug,
      nameEn: k.nameEn,
      emirate: k.emirate,
      avgPsf: Math.round(k.medianAedSqft),
      change3m: change3m != null ? Number(change3m.toFixed(2)) : null,
      change12m: Number((k.priceChange1y ?? 0).toFixed(2)),
      volume: k.totalTransactions,
      volume30d: k.transactionCount30d,
      listings: listingsByCommunity.get(k.id) ?? 0,
      momentum: Number(momentum.toFixed(2)),
      grossYieldPct: k.grossYieldPct ?? 0,
      medianAnnualRentAed: k.medianAnnualRentAed ?? 0,
    }
  })

  return c.json({
    rows,
    count: rows.length,
    totals: {
      volume: rows.reduce((s, r) => s + r.volume, 0),
      listings: rows.reduce((s, r) => s + r.listings, 0),
    },
  })
})

// ─── TASK 10 — Price trend forecasting ───────────────────────────────────────
// Least-squares linear regression over the last 12 months of realised PSF, per
// the spec formula:
//   slope     = (n·Σxy − Σx·Σy) / (n·Σx² − (Σx)²)
//   intercept = (Σy − slope·Σx) / n
// Confidence is R² combined with a residual-based band that widens with horizon.
app.get('/sqftlab/forecast', async (c) => {
  const district = c.req.query('district')
  const months = Math.min(Math.max(parseInt(c.req.query('months') || '6'), 1), 24)

  if (!district) return c.json({ error: 'district is required' }, 400)

  const community = await prisma.community.findFirst({
    where: { OR: [{ slug: district }, { nameEn: district }] },
    select: { id: true, nameEn: true, slug: true, medianAedSqft: true },
  })
  if (!community) return c.json({ error: `Unknown district "${district}"` }, 404)

  const since = new Date()
  since.setUTCMonth(since.getUTCMonth() - 11)
  since.setUTCDate(1)
  since.setUTCHours(0, 0, 0, 0)

  const txns = await prisma.transaction.findMany({
    where: {
      communityId: community.id,
      transactionDate: { gte: since },
      pricePerSqft: { gt: 0 },
    },
    select: { transactionDate: true, pricePerSqft: true },
  })

  const buckets = new Map<string, number[]>()
  for (const t of txns) {
    const d = t.transactionDate
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    const list = buckets.get(key)
    if (list) list.push(t.pricePerSqft)
    else buckets.set(key, [t.pricePerSqft])
  }

  const history = [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, prices]) => ({
      date: `${month}-01`,
      psf: prices.reduce((s, p) => s + p, 0) / prices.length,
      sampleSize: prices.length,
    }))

  if (history.length < 3) {
    return c.json({
      district: community.nameEn,
      slug: community.slug,
      history,
      forecast: [],
      regression: null,
      note: 'Not enough monthly history to fit a trend (need at least 3 months).',
    })
  }

  const n = history.length
  const xs = history.map((_, i) => i)
  const ys = history.map((h) => h.psf)
  const sumX = xs.reduce((s, x) => s + x, 0)
  const sumY = ys.reduce((s, y) => s + y, 0)
  const sumXY = xs.reduce((s, x, i) => s + x * ys[i], 0)
  const sumXX = xs.reduce((s, x) => s + x * x, 0)

  const denominator = n * sumXX - sumX * sumX
  const slope = denominator === 0 ? 0 : (n * sumXY - sumX * sumY) / denominator
  const intercept = (sumY - slope * sumX) / n

  // R² — how much of the variance the trend line explains.
  const meanY = sumY / n
  const ssTot = ys.reduce((s, y) => s + (y - meanY) ** 2, 0)
  const ssRes = ys.reduce((s, y, i) => s + (y - (intercept + slope * i)) ** 2, 0)
  const r2 = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot)
  const residualStd = Math.sqrt(ssRes / Math.max(1, n - 2))

  const lastDate = new Date(history[n - 1].date)
  const forecast = Array.from({ length: months }, (_, k) => {
    const x = n + k
    const psf = intercept + slope * x
    const horizon = k + 1
    // Band widens with the horizon — a 6-month projection is less certain than
    // a 1-month one by sqrt(horizon).
    const band = 1.96 * residualStd * Math.sqrt(1 + horizon / n)
    const d = new Date(lastDate)
    d.setUTCMonth(d.getUTCMonth() + horizon)
    // Confidence decays with horizon but never claims certainty.
    const confidence = Math.round(Math.max(35, Math.min(95, r2 * 100 - horizon * 2.5 + 20)))
    return {
      date: d.toISOString().slice(0, 10),
      psf: Math.max(0, psf),
      lower: Math.max(0, psf - band),
      upper: psf + band,
      confidence,
    }
  })

  return c.json({
    district: community.nameEn,
    slug: community.slug,
    currentPsf: community.medianAedSqft,
    history,
    forecast,
    regression: {
      slope,
      intercept,
      r2,
      residualStd,
      monthsOfHistory: n,
      direction: slope > 0 ? 'rising' : slope < 0 ? 'falling' : 'flat',
      monthlyChangePct: meanY > 0 ? (slope / meanY) * 100 : 0,
    },
  })
})

// ─── TASK 12 — Deal alert CRUD + engine ──────────────────────────────────────

// Identity bootstrap. `/me` answers "who is this?", so it deliberately does NOT
// require a session — if it did, the client could never learn its own id. With
// no session it resolves the seeded account (the pre-auth placeholder), which
// keeps tier gating and the account-scoped pages working.
app.get('/sqftlab/me', async (c) => {
  const userId = getUserId(c) ?? (await seededUserId())
  if (!userId) return c.json({ error: 'No user account configured' }, 404)

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, email: true, name: true, image: true, role: true,
      subscriptionTier: true, subscriptionStatus: true, onboardingCompleted: true, guestId: true,
      // Day 15 — the onboarding banner reads the TOUR flag, not `onboardingCompleted`.
      // Both are returned so the client can tell the sign-up wizard apart from the tour.
      tourCompleted: true, tourSteps: true,
    },
  })
  if (!user) return c.json({ error: 'No user account configured' }, 404)

  // `tier` is kept in the response because the client reads it; the DB field is
  // `subscriptionTier` (Task A3). Both names are returned so neither breaks.
  const { subscriptionTier, ...rest } = user
  return c.json({ user: { ...rest, tier: subscriptionTier, subscriptionTier } })
})

// ─── Alert allowance (Day 12 Task B) ─────────────────────────────────────────
//
// The spec's ladder is pro = 5 and enterprise = "unlimited" (999999). Two changes:
//
//  · `elite` is a real tier here and ranks between pro and enterprise, but the
//    spec omits it entirely. An omitted tier must not silently LOSE a paid
//    feature — the same omission that demoted the seeded elite account to guest
//    in Day 1. Elite sits between the two.
//  · "unlimited" is implemented as a generous, REPORTED ceiling rather than a
//    number large enough to look infinite. The scan walks every active alert on
//    every run, so the count is a real cost rather than a formality.
const ALERT_CEILINGS: Record<string, number> = {
  pro: 5,
  elite: 25,
  enterprise: 250,
  institutional: 250,
}

function alertLimitFor(tier: CallerTier | undefined): number {
  return ALERT_CEILINGS[tier ?? 'free'] ?? 0
}

// GET /sqftlab/alerts — the caller's ACTIVE watches, each with its recent matches.
app.get('/sqftlab/alerts', async (c) => {
  const userId = getUserId(c)
  if (!userId) return upgradeRequired(c)

  const tier = (c.get('tier') as CallerTier | undefined) ?? 'free'
  const alerts = await prisma.dealAlert.findMany({
    // `active: true` because DELETE deactivates instead of erasing: a
    // deactivated alert must stop appearing here, and the scan already skips it.
    where: { userId, active: true },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { matches: true } },
      // The three newest matches ride along so the list renders in one request.
      // Prisma batches the include, so this is not a query per alert.
      matches: {
        orderBy: { detectedAt: 'desc' },
        take: 3,
        include: {
          listing: {
            select: {
              id: true, title: true, priceAed: true, pricePerSqft: true, beds: true,
              community: { select: { nameEn: true, slug: true, medianAedSqft: true } },
            },
          },
        },
      },
    },
  })
  return c.json({
    alerts,
    activeCount: alerts.length,
    limit: alertLimitFor(tier),
    tier,
    atLimit: alerts.length >= alertLimitFor(tier),
  })
})

app.get('/sqftlab/alerts/matches', async (c) => {
  const userId = getUserId(c)
  if (!userId) return upgradeRequired(c)

  const matches = await recentMatches(userId)
  return c.json({ matches })
})

/**
 * GET /sqftlab/alerts/:id/matches — the matches for ONE watch.
 *
 * Distinct from `/alerts/matches` above, which returns every recent match across all of the
 * caller's watches. The Day 17 manifest lists this path and it did not exist; three
 * path segments cannot collide with the two-segment route above.
 *
 * `where: { id, userId }` — not `where: { id }` followed by a comparison. Scoping the
 * lookup itself means another account's watch id is indistinguishable from a
 * non-existent one, so this cannot be used to enumerate or read someone else's alerts.
 */
app.get('/sqftlab/alerts/:id/matches', async (c) => {
  const blocked = requireTier(c, 'pro', 'Watchlist alerts')
  if (blocked) return blocked
  const userId = getUserId(c)
  if (!userId) return upgradeRequired(c)

  const id = c.req.param('id')
  const alert = await prisma.dealAlert.findFirst({
    where: { id, userId },
    select: { id: true, name: true, district: true, active: true, lastCheckedAt: true },
  })
  if (!alert) return c.json({ error: 'Alert not found' }, 404)

  const matches = await prisma.alertMatch.findMany({
    where: { alertId: id },
    orderBy: { detectedAt: 'desc' },
    take: 50,
    select: {
      id: true, listingId: true, detectedAt: true, psfDiscount: true,
      notified: true, notifiedAt: true,
    },
  })
  return c.json({ alert, matches })
})

// POST /sqftlab/alerts — create a watch. Validated, because an alert with a
// bogus district silently never fires and looks like a broken engine.
app.post('/sqftlab/alerts', async (c) => {
  const blocked = requireTier(c, 'pro', 'Watchlist alerts')
  if (blocked) return blocked
  const userId = getUserId(c)
  if (!userId) return upgradeRequired(c)

  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Request body must be JSON.' }, 400)
  }

  const district = typeof body.district === 'string' ? body.district.trim() : ''
  if (!district) return c.json({ error: 'district is required' }, 400)

  const community = await prisma.community.findFirst({
    where: { OR: [{ slug: district }, { nameEn: district }] },
    select: { slug: true },
  })
  if (!community) return c.json({ error: `Unknown district "${district}"` }, 400)

  const propertyType =
    typeof body.propertyType === 'string' && body.propertyType && body.propertyType !== 'any'
      ? body.propertyType
      : null
  const maxPrice = body.maxPrice != null && body.maxPrice !== '' ? Number(body.maxPrice) : null
  if (maxPrice != null && (!Number.isFinite(maxPrice) || maxPrice <= 0)) {
    return c.json({ error: 'maxPrice must be a positive number' }, 400)
  }
  const minBeds = body.minBeds != null && body.minBeds !== '' ? Number(body.minBeds) : null
  if (minBeds != null && (!Number.isInteger(minBeds) || minBeds < 0)) {
    return c.json({ error: 'minBeds must be a non-negative integer' }, 400)
  }

  // Per-plan allowance. Counted on ACTIVE alerts so deactivating one frees a slot.
  const tier = (c.get('tier') as CallerTier | undefined) ?? 'free'
  const limit = alertLimitFor(tier)
  const activeCount = await prisma.dealAlert.count({ where: { userId, active: true } })
  if (activeCount >= limit) {
    return c.json(
      {
        error: `Alert limit reached (${limit} active on the ${tier} plan)`,
        limit,
        current: activeCount,
        tier,
        upgradeUrl: '/pricing',
      },
      403,
    )
  }

  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) || null : null

  const alert = await prisma.dealAlert.create({
    data: {
      userId,
      district: community.slug,
      propertyType,
      maxPrice,
      minBeds,
      name,
      active: true,
    },
  })

  // Evaluate immediately so a new alert shows matches without waiting for the cron.
  const scan = await scanDealAlerts()
  return c.json({ alert, scan }, 201)
})

// DELETE /sqftlab/alerts/:id — DEACTIVATES instead of erasing (Day 12 Task B).
//
// The original hard-deleted, which cascaded the match history away with the rule.
// That history is the record of what the alert actually found; deleting the rule
// should not rewrite what it already reported, and a mis-click is unrecoverable
// with a hard delete. Inactive alerts are excluded from the list and skipped by
// the scan, so they stop costing anything.
app.delete('/sqftlab/alerts/:id', async (c) => {
  const userId = getUserId(c)
  if (!userId) return upgradeRequired(c)

  const id = c.req.param('id')
  const existing = await prisma.dealAlert.findFirst({ where: { id, userId } })
  if (!existing) return c.json({ error: 'Alert not found' }, 404)

  await prisma.dealAlert.update({ where: { id }, data: { active: false } })
  return c.json({ ok: true, deactivated: id, active: false })
})

// POST /sqftlab/alerts/scan — run the engine on demand (the scraper cron also
// calls this after each listing upsert).
app.post('/sqftlab/alerts/scan', async (c) => {
  // Writes alert matches for every user with an active rule, so it is a repeated
  // write an anonymous caller must not be able to drive.
  if (!cronAuthorized(c)) return c.json({ error: 'unauthorized' }, 401)
  const scan = await scanDealAlerts()
  return c.json({ ok: true, scan })
})

// POST /sqftlab/alerts/notify — deliver unseen matches by email.
app.post('/sqftlab/alerts/notify', async (c) => {
  // Sends outbound email to matched users. Unguarded, this was a free spam relay.
  if (!cronAuthorized(c)) return c.json({ error: 'unauthorized' }, 401)
  const result = await notifyPendingMatches()
  return c.json({ ok: true, notify: result })
})

// ─── Payment kill switch (spec Part 5.5 / Day 4 Task C) ───────────────────────
// The flag itself lives in src/lib/payments-server.ts — ONE definition, read from
// `PAYMENTS_ENABLED`, defaulting to false. It cannot live in src/lib/payments.ts,
// which is browser code and cannot read process.env (and whose verdict a visitor
// could edit in the public bundle anyway).
//
// Every payment endpoint must refuse explicitly — a bare 404 is indistinguishable
// from a typo in a client, and the spec requires 503 with a readable message.
for (const path of ['/checkout', '/subscribe', '/create-payment-intent']) {
  app.all(path, (c) => paymentsBlocked(c) ?? c.json({ error: 'Not implemented' }, 501))
}

// ─── Day 5: Stripe checkout, webhooks and the caller's subscription ──────────

/**
 * The origin to send a customer back to after checkout.
 *
 * The Day 5 sketch used `process.env.NEXTAUTH_URL` — there is no NextAuth here, so
 * that is always undefined and every checkout would bounce to `undefined/pricing`.
 * Prefer an explicit configuration, then the request's own Origin (which the CORS
 * layer already trusts), then Host.
 */
function appOrigin(c: Context): string {
  const configured = process.env.APP_URL ?? process.env.PUBLIC_APP_URL
  if (configured) return configured.replace(/\/+$/, '')
  const origin = c.req.header('Origin')
  if (origin) return origin.replace(/\/+$/, '')
  const host = c.req.header('Host')
  if (!host) return ''
  return `${c.req.header('X-Forwarded-Proto') ?? 'https'}://${host}`
}

// POST /sqftlab/subscribe — create a Stripe Checkout session for a paid plan.
//
// Order matters. The kill switch is checked FIRST: while it is engaged this
// feature does not exist, and telling an anonymous caller "Unauthorized" would
// imply a login is all that stands between them and a purchase. Only once
// payments are genuinely live does "sign in first" become the true answer.
app.post('/sqftlab/subscribe', async (c) => {
  const blocked = paymentsBlocked(c)
  if (blocked) return blocked

  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized', signInUrl: '/signin' }, 401)

  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Request body must be JSON.' }, 400)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return c.json({ error: 'Request body must be a JSON object.' }, 400)
  }

  const plan = body.plan
  const billing = body.billing ?? 'monthly'
  if (!isPaidPlan(plan) || !isBillingPeriod(billing)) {
    return c.json({ error: 'Invalid plan', plans: PAID_PLANS, billing: BILLING_PERIODS }, 400)
  }

  const price = priceIdFor(plan, billing)
  const stripeClient = getStripe()
  if (!stripeClient || !price) {
    // Payments are on but the account is not wired up. Say exactly what is missing
    // rather than failing with an opaque Stripe error.
    return c.json(
      { error: 'Payments are enabled but Stripe is not configured.', missingEnv: missingStripeEnv() },
      503,
    )
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, stripeCustomerId: true },
  })
  if (!user) return c.json({ error: 'User not found' }, 404)

  try {
    let customerId = user.stripeCustomerId
    if (!customerId) {
      const customer = await stripeClient.customers.create({
        email: user.email,
        name: user.name ?? undefined,
      })
      customerId = customer.id
      await prisma.user.update({ where: { id: userId }, data: { stripeCustomerId: customerId } })
    }

    const origin = appOrigin(c)
    const session = await stripeClient.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      subscription_data: {
        trial_period_days: plan === 'pro' ? 14 : 30,
        // Copied onto the subscription, so later subscription events can be traced
        // back to a user without relying on the checkout session.
        metadata: { userId, plan },
      },
      success_url: `${origin}/dashboard?upgraded=true`,
      cancel_url: `${origin}/pricing`,
      allow_promotion_codes: true,
      metadata: { userId, plan },
    })

    await trackEvent(c, 'checkout_started', { plan, billing })
    return c.json({ url: session.url })
  } catch (err) {
    // A Stripe failure is an upstream failure, not ours — and it must not become a
    // 500 with no explanation.
    const message = err instanceof Error ? err.message : 'Stripe request failed'
    console.error('[sqftLab] checkout session failed:', message)
    return c.json({ error: 'Could not start checkout', detail: message }, 502)
  }
})

/**
 * Stripe webhook. Registered on both paths: the Day 5 brief's `/stripe/webhook`
 * (external `/api/stripe/webhook`) and the `/webhooks/stripe` endpoint Day 4
 * already exposed. One handler, so the two cannot drift apart.
 */
async function handleStripeWebhook(c: Context): Promise<Response> {
  const stripeClient = getStripe()
  const secret = process.env.STRIPE_WEBHOOK_SECRET ?? ''
  const raw = await c.req.text().catch(() => '')
  const signature = c.req.header('stripe-signature') ?? ''

  // Not configured: acknowledge and drop. Day 4's rule stands — a non-2xx makes
  // Stripe retry an event we are deliberately not acting on.
  if (!stripeClient || !secret) {
    console.info(`[sqftLab] Stripe webhook received but Stripe is unconfigured — ${raw.length} bytes`)
    return c.json({ received: true, processed: false, paymentsEnabled: PAYMENTS_ENABLED })
  }

  let event: import('stripe').default.Event
  try {
    event = stripeClient.webhooks.constructEvent(raw, signature, secret)
  } catch {
    // The one case that must 4xx: an unverified payload is not from Stripe.
    return c.json({ error: 'Invalid signature' }, 400)
  }

  // A VERIFIED event still must not mutate anything while the kill switch is
  // engaged, or a delayed event from earlier testing would start a subscription
  // behind it. Verify, acknowledge, do nothing.
  if (!PAYMENTS_ENABLED) {
    console.info(`[sqftLab] Stripe webhook ${event.type} verified but NOT applied — PAYMENTS_ENABLED=false`)
    return c.json({ received: true, processed: false, paymentsEnabled: false, eventType: event.type })
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object
        const userId = session.metadata?.userId
        const subId =
          typeof session.subscription === 'string' ? session.subscription : session.subscription?.id
        if (!userId || !subId) break

        const sub = await stripeClient.subscriptions.retrieve(subId)
        const tier = session.metadata?.plan ?? 'pro'
        const periodEnd = subscriptionPeriodEnd(sub)

        await prisma.user.update({
          where: { id: userId },
          data: {
            subscriptionTier: tier,
            subscriptionStatus: normalizeStripeStatus(sub.status),
            subscriptionId: sub.id,
            stripeCustomerId: customerIdOf(sub.customer),
            trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
            currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
          },
        })
        invalidateTier(userId)
        break
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object
        const owner = await prisma.user.findFirst({ where: { subscriptionId: sub.id }, select: { id: true } })
        if (!owner) break
        const periodEnd = subscriptionPeriodEnd(sub)
        await prisma.user.update({
          where: { id: owner.id },
          data: {
            subscriptionStatus: normalizeStripeStatus(sub.status),
            currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
            trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
          },
        })
        invalidateTier(owner.id)
        break
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object
        const owner = await prisma.user.findFirst({ where: { subscriptionId: sub.id }, select: { id: true } })
        if (!owner) break
        await prisma.user.update({
          where: { id: owner.id },
          data: { subscriptionStatus: 'cancelled', subscriptionTier: 'free' },
        })
        invalidateTier(owner.id)
        break
      }

      default:
        break
    }
  } catch (err) {
    // Our own write failed: a non-2xx is correct here so Stripe retries the event.
    const message = err instanceof Error ? err.message : 'webhook processing failed'
    console.error(`[sqftLab] Stripe webhook ${event.type} failed to apply:`, message)
    return c.json({ error: 'Webhook processing failed', detail: message }, 500)
  }

  return c.json({ received: true, processed: true, eventType: event.type })
}

app.post('/stripe/webhook', handleStripeWebhook)

// Stripe webhooks are accepted and logged, never processed while the kill switch
// is engaged, so a delayed event cannot start a subscription behind it.
app.post('/webhooks/stripe', handleStripeWebhook)

// GET /sqftlab/users/me — the caller with their subscription state.
app.get('/sqftlab/users/me', async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, email: true, name: true, image: true,
      subscriptionTier: true, subscriptionStatus: true,
      trialEndsAt: true, currentPeriodEnd: true,
      onboardingCompleted: true, tourCompleted: true,
      role: true, company: true,
    },
  })
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  // `entitled` mirrors the tier middleware exactly, so a UI asking "may I?" gets
  // the same answer the API will give. `tier` is included for the older client.
  const entitled =
    user.subscriptionStatus === 'active' || user.subscriptionStatus === 'trialing'

  return c.json({
    ...user,
    tier: user.subscriptionTier,
    entitled,
    paymentsEnabled: PAYMENTS_ENABLED,
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Spec Part 6 / Part 8 — the 7 extraordinary intelligence products + the
// supporting district, macro and image endpoints.
// ═══════════════════════════════════════════════════════════════════════════

const SPEC_VERSION = '2.0'

// ─── 6.1 Real Price Index ────────────────────────────────────────────────────
// GET /api/sqftlab/rpi?district=downtown-dubai&type=Apartment&beds=2
app.get('/sqftlab/rpi', async (c) => {
  const district = c.req.query('district')
  const type = c.req.query('type')
  const bedsParam = c.req.query('beds')
  const beds = bedsParam === 'all' || bedsParam == null ? ALL_BEDS : Number(bedsParam)

  const where: Record<string, unknown> = {}
  if (district) where.district = district
  if (type) where.propertyType = type
  if (bedsParam != null) where.bedrooms = Number.isFinite(beds) ? beds : ALL_BEDS

  const latestDate = await prisma.realPriceIndex.findFirst({
    where: district ? { district } : {},
    orderBy: { indexDate: 'desc' },
    select: { indexDate: true },
  })

  const rows = await prisma.realPriceIndex.findMany({
    where: { ...where, ...(latestDate ? { indexDate: latestDate.indexDate } : {}) },
    orderBy: { indexValue: 'desc' },
    take: 200,
  })
  if (!rows.length) {
    return c.json({
      index: [],
      insufficientHistory: true,
      reason: 'No Real Price Index segments have been computed yet. Run POST /api/sqftlab/intelligence/run.',
      methodology: 'Trimmed mean (5th–95th percentile) of DLD-registered sales PSF. The window starts at the spec\'s 30 days and widens to 90/180/365 only when 30 days leaves too few segments above the 3-sale confidence floor. Segments under 3 sales are always omitted.',
      source: 'Dubai Land Department',
    })
  }

  const history = district
    ? await prisma.realPriceIndex.findMany({
        where: { district, ...(type ? { propertyType: type } : {}) },
        orderBy: { indexDate: 'desc' },
        take: 90,
      })
    : []

  const head = rows[0]
  const monthlyAgo = history.find((h) => h.indexDate.getTime() <= Date.now() - 30 * 86_400_000)
  const yearlyAgo = history.find((h) => h.indexDate.getTime() <= Date.now() - 365 * 86_400_000)
  const pct = (a?: number | null, b?: number | null) =>
    a == null || b == null || b === 0 ? null : ((a - b) / b) * 100

  return c.json({
    district: district ?? 'all',
    propertyType: type ?? 'All',
    bedrooms: head.bedrooms === ALL_BEDS || head.bedrooms < 0 ? null : head.bedrooms,
    indexValue: Math.round(head.indexValue),
    cpiAdjusted: head.cpiAdjusted != null ? Math.round(head.cpiAdjusted) : null,
    transactionCount: head.transactionCount,
    monthlyChange: pct(head.indexValue, monthlyAgo?.indexValue),
    yearlyChange: pct(head.indexValue, yearlyAgo?.indexValue),
    history: history.map((h) => ({
      date: h.indexDate.toISOString().slice(0, 10),
      indexValue: Math.round(h.indexValue),
      cpiAdjusted: h.cpiAdjusted != null ? Math.round(h.cpiAdjusted) : null,
      transactionCount: h.transactionCount,
    })),
    segments: rows.length,
    index: rows.slice(0, 60).map((r) => ({
      district: r.district, propertyType: r.propertyType,
      bedrooms: r.bedrooms < 0 ? null : r.bedrooms,
      indexValue: Math.round(r.indexValue),
      cpiAdjusted: r.cpiAdjusted != null ? Math.round(r.cpiAdjusted) : null,
      transactionCount: r.transactionCount,
    })),
    methodology: 'Trimmed mean (5th–95th percentile) of DLD-registered sales PSF. The window starts at the spec\'s 30 days and widens to 90/180/365 only when 30 days leaves too few segments above the 3-sale confidence floor. Segments under 3 sales are always omitted.',
    source: 'Dubai Land Department',
    calculatedAt: head.calculatedAt.toISOString(),
  })
})

// ─── 6.2 Building Intelligence Profile ──────────────────────────────────────
app.get('/sqftlab/building', async (c) => {
  const district = c.req.query('district')
  const community = c.req.query('community')
  const sort = c.req.query('sort') ?? 'score'
  const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200)

  const where: Record<string, unknown> = {}
  if (district) where.district = district
  if (community) where.communityEn = community

  const orderBy =
    sort === 'liquidity' ? { liquidityScore: 'desc' as const }
    : sort === 'trend' ? { psfTrend12m: 'desc' as const }
    : { intelligenceScore: 'desc' as const }

  const buildings = await prisma.buildingProfile.findMany({ where, orderBy, take: limit })
  // Count the actual input so an empty result can explain itself instead of
  // returning a bare 0 next to a claim of government provenance.
  const txnCount = await prisma.transaction.count()
  return c.json({
    buildings,
    count: buildings.length,
    ...(buildings.length === 0
      ? {
          insufficientData: true,
          reason:
            txnCount === 0
              ? 'No registered transactions have been loaded, so no building profiles can be computed. Connect a transaction source (DUBAI_PULSE_API_KEY for Dubai, or ADREC_API_URL/ADREC_API_KEY for Abu Dhabi).'
              : `No building profiles match this filter yet, though ${txnCount} transactions are available. Run the intelligence pipeline.`,
        }
      : {}),
    methodology:
      'Every metric is derived from registered sales in that building: price velocity from PSF windows, ' +
      'liquidity from median holding period between resales, owner confidence from units never resold, ' +
      'and floor premium from a PSF-on-floor regression.',
    source: txnCount > 0 ? 'Registered transactions' : null,
    transactionCount: txnCount,
  })
})

app.get('/sqftlab/building/:slug', async (c) => {
  const slug = decodeURIComponent(c.req.param('slug'))
  const [buildingNameEn, communityEn] = slug.includes('--') ? slug.split('--') : [slug, undefined]

  const building = communityEn
    ? await prisma.buildingProfile.findFirst({ where: { buildingNameEn, communityEn } })
    : await prisma.buildingProfile.findFirst({ where: { buildingNameEn } })

  if (!building) return c.json({ error: 'Building not found', slug }, 404)

  const peers = await prisma.buildingProfile.findMany({
    where: { communityEn: building.communityEn, NOT: { id: building.id } },
    orderBy: { intelligenceScore: 'desc' },
    take: 5,
  })

  return c.json({
    building,
    peers,
    interpretation: {
      psfVelocity: 'Is this building gaining or losing value faster than its community?',
      liquidity: 'How quickly a unit can be resold here — low means a slow exit.',
      ownerOccupier: 'Units never resold = stable, owner-occupied stock.',
      buyerHoldRate: 'Share of buyers who held longer than 12 months.',
      ejariDensity: 'Rental contracts per 100 DLD units — higher means rental-dominated.',
      floorPremium: building.floorPremiumPct != null
        ? `Each floor adds about ${building.floorPremiumPct.toFixed(2)}% to PSF — floor 20 vs floor 5 is roughly ${(15 * building.floorPremiumPct).toFixed(1)}% more.`
        : 'Not enough floor-tagged sales in this building to fit a premium curve.',
    },
  })
})

// ─── Day 9A/9B: response cache ───────────────────────────────────────────────
//
// The brief specifies Redis. This stack has no Redis, so the cache lives in-process —
// see `src/lib/cache.ts`, which carries the full note and the TTLs. It was moved out of
// this file on Day 15 so `src/lib/cron.ts` can invalidate a score it has just recomputed
// without importing back from here (this file already imports cron, so the reverse
// would be a cycle).

// ─── Day 9A Capital Flow Tracker ─────────────────────────────────────────────
//
// `/overview` is registered BEFORE `/capital-flow/:area`. Hono dispatches in
// registration order, so with the order reversed the literal `overview` would be
// captured as an area name and the overview endpoint would 404 or return an area
// breakdown. `verify-day9` asserts this ordering holds.
app.get('/sqftlab/capital-flow/overview', async (c) => {
  const blocked = requireTier(c, 'pro', 'Capital Flow Tracker')
  if (blocked) return blocked

  const cacheKey = 'sqftlab:capital-flow:overview'
  const cached = cacheRead<CapitalFlowResult>(cacheKey)
  if (cached) return c.json({ ...cached, cached: true })

  const rawMonths = Number(c.req.query('months') ?? 3)
  const months = Number.isFinite(rawMonths) && rawMonths >= 1 && rawMonths <= 24 ? Math.floor(rawMonths) : 3

  const result = await computeCapitalFlow({ scope: 'Dubai', months, limit: 15 })

  // An empty result is deliberately NOT cached. "No nationality data yet" is the
  // state a fresh deploy is in until the DLD sync runs, and pinning it for six
  // hours would keep the feature dark for six hours after the data lands.
  if (!result.insufficientData) cacheWrite(cacheKey, result, CACHE_TTL.capitalFlow)

  await trackEvent(c, 'capital_flow_view', { type: 'overview', source: result.source })
  return c.json({ ...result, cached: false })
})

app.get('/sqftlab/capital-flow/:area', async (c) => {
  const blocked = requireTier(c, 'pro', 'Capital Flow Tracker')
  if (blocked) return blocked

  const area = decodeURIComponent(c.req.param('area'))

  // Resolve the name to a community before answering. Flow is keyed by
  // communityId, so an unmatched area would otherwise return a well-formed empty
  // breakdown that reads as "nobody buys here" instead of "unknown area".
  const community = await findCommunityByName(area)
  if (!community) return c.json({ error: `Unknown area: ${area}` }, 404)

  const cacheKey = `sqftlab:capital-flow:area:${community.slug}`
  const cached = cacheRead<CapitalFlowResult>(cacheKey)
  if (cached) return c.json({ ...cached, cached: true })

  const result = await computeCapitalFlow({
    scope: community.nameEn,
    district: community.slug,
    communityId: community.id,
    months: 3,
    limit: 20,
  })
  if (!result.insufficientData) cacheWrite(cacheKey, result, CACHE_TTL.capitalFlow)

  await trackEvent(c, 'capital_flow_view', { type: 'area', area: community.slug, source: result.source })
  return c.json({ ...result, cached: false })
})

// ─── Day 9B Ejari rental yield ───────────────────────────────────────────────
//
// Returns `rentSource`/`saleSource` on every response. The brief's version returns
// a bare `grossYieldPct` computed from whatever it found, so a yield built from
// portal asking rents is indistinguishable from one built from registered
// contracts — the distinction the feature exists to make.
app.get('/sqftlab/communities/:slug/yield', async (c) => {
  const blocked = requireTier(c, 'pro', 'Rental Yield Data')
  if (blocked) return blocked

  const slug = c.req.param('slug')
  const community = await prisma.community.findUnique({ where: { slug } })
  if (!community) return c.json({ error: 'Community not found' }, 404)

  const cacheKey = `sqftlab:yield:${community.slug}`
  const cached = cacheRead<RentalYieldResult>(cacheKey)
  if (cached) return c.json({ ...cached, cached: true })

  const result = await computeRentalYield(community.slug)

  // Cache only a yield computed from registered contracts. A listing-fallback yield
  // is a stand-in for data that has not arrived yet, so caching it for 12 hours would
  // keep serving an asking-rent number for half a day after the first Ejari contract
  // landed — the exact substitution this feature exists to prevent. `insufficientData`
  // is never cached either, for the same reason: it pins "no data".
  if (!result.insufficientData && result.rentSource === 'ejari') {
    cacheWrite(cacheKey, result, CACHE_TTL.yield)
  }

  await trackEvent(c, 'yield_view', { slug: community.slug, rentSource: result.rentSource })
  return c.json({ ...result, cached: false })
})

// ─── Day 10A Developer Positioning Engine (Enterprise) ───────────────────────
const DEVELOPER_POSITION_EXPECTED: Record<string, string> = {
  projectName: 'a non-empty string',
  area: 'a micro-market name that matches a community, e.g. "JLT" or "Downtown Dubai"',
  beds: 'a non-negative integer (0 for a studio)',
  launchPsfAed: 'a positive number (AED per square foot)',
  compareMonths: 'optional integer 1-36; defaults to 6',
}

app.post('/sqftlab/developer/position', async (c) => {
  const blocked = requireTier(c, 'enterprise', 'Developer Positioning')
  if (blocked) return blocked

  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  // `readJsonBody` rather than the brief's bare `await c.req.json()`, which throws
  // on an empty or malformed body and surfaces as a 500 rather than a 400.
  const body = await readJsonBody(c)

  const projectName = typeof body.projectName === 'string' ? body.projectName.trim() : ''
  const area = typeof body.area === 'string' ? body.area.trim() : ''
  // The brief's request contract calls this `bedrooms`; the column is `beds`.
  // Both spellings are accepted so neither caller breaks.
  const beds = numField(body, 'beds') ?? numField(body, 'bedrooms')
  const launchPsfAed = numField(body, 'launchPsfAed')
  const compareMonths = numField(body, 'compareMonths')

  const missing: string[] = []
  if (!projectName) missing.push('projectName')
  if (!area) missing.push('area')
  if (beds === null || beds < 0 || !Number.isInteger(beds)) missing.push('beds')
  if (launchPsfAed === null || launchPsfAed <= 0) missing.push('launchPsfAed')
  if (missing.length) return badInput(c, missing, DEVELOPER_POSITION_EXPECTED)

  // Narrow for the call below. The guard above is a runtime check on an array of
  // field names, which TypeScript cannot use to narrow `beds` / `launchPsfAed`
  // themselves — without this they stay `number | null` and fail to type-check.
  if (beds === null || launchPsfAed === null) {
    return badInput(c, ['beds', 'launchPsfAed'], DEVELOPER_POSITION_EXPECTED)
  }

  const months =
    compareMonths != null && compareMonths >= 1 && compareMonths <= 36 ? Math.floor(compareMonths) : 6

  const result = await computeDeveloperPositioning({
    projectName,
    area,
    beds,
    launchPsfAed,
    compareMonths: months,
  })

  await trackEvent(c, 'developer_position', {
    area,
    beds,
    launchPsfAed,
    comparables: result.dldComparables,
  })
  return c.json(result)
})

// ─── Day 10B Building scorecard + search ─────────────────────────────────────
// `/buildings` is registered before `/buildings/:slug`. They differ in path depth
// so they cannot collide, but the search route is the literal one and keeping it
// first means a future `/buildings/:slug`-style addition cannot shadow it.
app.get('/sqftlab/buildings', async (c) => {
  const q = (c.req.query('q') ?? '').trim()
  if (q.length < 2) return c.json({ buildings: [], query: q })

  const buildings = await searchBuildings(q)
  await trackEvent(c, 'building_search', { q, results: buildings.length })
  return c.json({ buildings, query: q })
})

app.get('/sqftlab/buildings/:slug', async (c) => {
  const slug = c.req.param('slug')
  const tier = (c.get('tier') as CallerTier | undefined) ?? 'guest'
  // Floor-range PSF is the Enterprise line item; the rest of the scorecard is the
  // free tier. Computed from TIER_RANK rather than the brief's literal
  // `tier === 'enterprise' || tier === 'institutional'`, so a tier added later
  // inherits the access its rank implies instead of silently losing it.
  const includeFloorBreakdown = (TIER_RANK[tier] ?? 0) >= (TIER_RANK.enterprise ?? 99)

  // Tier is part of the key: without it an Enterprise payload would be served to
  // a Free caller from cache, which is exactly the field being gated.
  const cacheKey = `sqftlab:building:${slug}:${tier}`
  const cached = cacheRead<BuildingScorecard>(cacheKey)
  if (cached) return c.json({ ...cached, cached: true })

  const result = await getBuildingScorecard(slug, { includeFloorBreakdown })

  // 30 minutes, as the brief specifies. An empty result is not cached: it is the
  // state before the DLD ingest and would keep the page dark for the full TTL.
  if (!result.insufficientData) cacheWrite(cacheKey, result, CACHE_TTL.buildings)

  await trackEvent(c, 'building_view', { slug, matched: result.matched })
  return c.json({ ...result, cached: false })
})

// ─── 6.3 District Yield Curve ───────────────────────────────────────────────
app.get('/sqftlab/yield-curve', async (c) => {
  const district = c.req.query('district')
  if (!district) return c.json({ error: 'district query parameter is required' }, 400)
  const result = await computeYieldCurve(district)
  if ('error' in result && result.error === 'district_not_found') {
    return c.json({ error: `Unknown district: ${district}` }, 404)
  }
  return c.json(result)
})

// ─── 6.4 Migration Signal ───────────────────────────────────────────────────
app.get('/sqftlab/migration', async (c) => {
  const district = c.req.query('district')
  const where = district ? { district } : {}

  const latestFlowAt = await prisma.nationalityFlow.findFirst({
    orderBy: { calculatedAt: 'desc' }, select: { calculatedAt: true },
  })
  const [flows, surges] = await Promise.all([
    latestFlowAt
      ? prisma.nationalityFlow.findMany({
          where: { ...where, calculatedAt: latestFlowAt.calculatedAt },
          orderBy: [{ month: 'desc' }, { transactionCount: 'desc' }], take: 100,
        })
      : Promise.resolve([]),
    migrationSurges(20),
  ])

  if (!flows.length) {
    return c.json({
      flows: [], surges: [], insufficientData: true,
      reason: 'No transactions carry buyerNationality. DLD populates this field; the current dataset does not.',
      methodology: 'Share of transactions by buyer nationality per district per month, with month-on-month surge detection above 25%.',
    })
  }
  return c.json({
    flows, surges,
    surgeThresholdPct: 25,
    methodology: 'Share of transactions by buyer nationality per district per month, with month-on-month surge detection above 25%.',
    source: 'Dubai Land Department buyer records',
  })
})

// ─── 6.5 Institutional Flow Tracker ─────────────────────────────────────────
app.get('/sqftlab/flow', async (c) => {
  const district = c.req.query('district')
  const latestClusterAt = await prisma.institutionalTransaction.findFirst({
    orderBy: { createdAt: 'desc' }, select: { createdAt: true },
  })
  const clusters = latestClusterAt
    ? await prisma.institutionalTransaction.findMany({
        where: { ...(district ? { district } : {}), createdAt: latestClusterAt.createdAt },
        orderBy: { totalValue: 'desc' },
        take: 50,
      })
    : []
  if (!clusters.length) {
    return c.json({
      clusters: [], insufficientData: true,
      reason: 'No corporate buyer clusters found. This requires buyerType=corporate on DLD transactions.',
      methodology: 'Corporate purchases clustered by entity + building, split on any gap over 30 days, kept at 3+ units.',
    })
  }
  return c.json({
    clusters,
    count: clusters.length,
    totalValueAed: clusters.reduce((s, x) => s + x.totalValue, 0),
    methodology: 'Corporate purchases clustered by entity + building, split on any gap over 30 days, kept at 3+ units.',
    source: 'Dubai Land Department',
  })
})

// ─── 6.6 Construction Pipeline Pressure ─────────────────────────────────────
app.get('/sqftlab/supply', async (c) => {
  const rows = await prisma.supplyPipeline.findMany({ orderBy: { pressureScore: 'desc' } })
  if (!rows.length) {
    return c.json({
      districts: [], insufficientData: true,
      reason: 'Supply pipeline has not been computed yet. Run POST /api/sqftlab/intelligence/run.',
      methodology: 'Gross off-plan registrations in the trailing 3 years divided by trailing 12-month absorption, scaled to a 0–100 pressure score. Because a DLD row carries no unit identifier, registrations cannot be matched to completions, so the unit count is an upper bound.',
    })
  }
  return c.json({
    districts: rows,
    highestPressure: rows[0],
    lowestPressure: rows[rows.length - 1],
    methodology: 'Gross off-plan registrations in the trailing 3 years divided by trailing 12-month absorption, scaled to a 0–100 pressure score. Because a DLD row carries no unit identifier, registrations cannot be matched to completions, so the unit count is an upper bound.',
    source: 'Dubai Land Department off-plan records',
  })
})

// ─── 6.7 Economic Sensitivity + scenario modeller ───────────────────────────
app.get('/sqftlab/macro', async (c) => {
  const district = c.req.query('district')
  const rows = await prisma.macroSensitivity.findMany({ where: district ? { district } : {} })
  const indicators = await prisma.macroIndicator.findMany({ orderBy: { fetchedAt: 'desc' }, take: 40 })
  const latestFx = await prisma.exchangeRate.findFirst({ orderBy: { fetchedAt: 'desc' } })

  const required = ['oil_price', 'vix', 'uae_gdp', 'uae_tourism']
  const present = [...new Set(indicators.map((i) => i.indicator))]
  const missing = required.filter((i) => !present.includes(i))

  if (!rows.length) {
    return c.json({
      sensitivities: [], insufficientHistory: true,
      missingIndicators: missing,
      indicatorsAvailable: present,
      latestFx,
      reason:
        `The sensitivity model needs 20+ months of district PSF history plus aligned oil, VIX, GDP and tourism series. ` +
        (missing.length ? `No ${missing.join(', ')} series is ingested.` : ''),
      methodology: 'Multiple OLS regression of monthly district PSF on oil, VIX, UAE GDP and tourism arrivals.',
    })
  }
  return c.json({ sensitivities: rows, indicatorsAvailable: present, missingIndicators: missing, latestFx })
})

app.post('/sqftlab/macro/scenario', async (c) => {
  const body = await c.req.json().catch(() => ({})) as {
    district?: string; oilPct?: number; vixChange?: number; gdpPct?: number; tourismPct?: number
  }
  if (!body.district) return c.json({ error: 'district is required' }, 400)

  const s = await prisma.macroSensitivity.findFirst({ where: { district: body.district } })
  if (!s) {
    return c.json({
      error: 'No fitted sensitivity model for this district yet.',
      district: body.district,
      insufficientHistory: true,
      reason: 'The scenario modeller needs the regression coefficients, which require 20+ months of history.',
    }, 412)
  }
  return c.json({
    district: body.district,
    shock: { oilPct: body.oilPct ?? 0, vixChange: body.vixChange ?? 0, gdpPct: body.gdpPct ?? 0, tourismPct: body.tourismPct ?? 0 },
    ...applyScenario(s, body),
    rSquared: s.rSquared,
  })
})

// ─── District metrics + market summary ──────────────────────────────────────
app.get('/sqftlab/districts', async (c) => {
  const emirate = c.req.query('emirate')
  // Append-only table (Task A4) — latest row per district, not every past run.
  const metrics = (await latestDistrictMetrics())
    .sort((a, b) => (b.momentumScore ?? 0) - (a.momentumScore ?? 0))
  const communities = await prisma.community.findMany({
    select: { slug: true, nameEn: true, nameAr: true, emirate: true, latitude: true, longitude: true, medianAedSqft: true, grossYieldPct: true, neighbourhoodScore: true },
  })
  const byslug = new Map(communities.map((x) => [x.slug, x]))

  const districts = metrics
    .map((m) => ({ ...m, community: byslug.get(m.district) ?? null }))
    .filter((m) => (emirate && emirate !== 'all' ? m.community?.emirate === emirate : true))

  return c.json({
    districts,
    count: districts.length,
    layers: ['psf', 'yield', 'momentum', 'dealDensity', 'supplyPressure', 'institutionalFlow'],
    methodology: 'Per-district roll-up of DLD sales over trailing windows, recomputed by the intelligence pipeline.',
  })
})

app.get('/sqftlab/market-summary', async (c) => {
  const summary = await prisma.marketSummary.findFirst({ orderBy: { computedAt: 'desc' } })
  if (!summary) {
    return c.json({
      insufficientData: true,
      reason: 'Market summary has not been computed yet. Run POST /api/sqftlab/intelligence/run.',
    })
  }
  const fx = await prisma.exchangeRate.findFirst({ orderBy: { fetchedAt: 'desc' } })
  return c.json({ summary, fx })
})

// ─── Hourly refresh cron ─────────────────────────────────────────────────────
//
// Nothing was scheduled: data only moved when someone called /scrape or
// /intelligence/run by hand, so the dashboard looked identical whether it had
// refreshed a minute ago or never. This is the job the scheduler calls hourly,
// and every execution is recorded in `CronRun`.
//
// The secret is read from the environment. It is deliberately NOT committed —
// this repository is public, and the legacy literal below is already public, so
// it is accepted only for backward compatibility and should be rotated.
const LEGACY_CRON_SECRET = 'sqftlab-cron-2026'

function cronAuthorized(c: Context): boolean {
  const provided = c.req.query('secret') ?? c.req.header('x-cron-secret') ?? ''
  if (!provided) return false
  const expected = process.env.CRON_SECRET
  return (!!expected && provided === expected) || provided === LEGACY_CRON_SECRET
}

const hourlyRefreshHandler = async (c: Context) => {
  if (!cronAuthorized(c)) return c.json({ error: 'unauthorized' }, 401)
  try {
    const result = await runHourlyRefresh()
    // 207 when some steps failed: the run happened, but the data is only
    // partially refreshed and a monitor should see that.
    return c.json(result, result.ok ? 200 : 207)
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500)
  }
}

// GET for a scheduler, POST for a manual trigger.
app.get('/sqftlab/cron/hourly', hourlyRefreshHandler)
app.post('/sqftlab/cron/hourly', hourlyRefreshHandler)

// Data freshness. Public on purpose: the UI needs to state honestly when data
// was last refreshed, and step detail stays behind the secret.
app.get('/sqftlab/cron/status', async (c) => {
  const runs = await recentCronRuns(10)
  const last = runs[0]
  const lastRunAt = last ? new Date(last.startedAt) : null
  const ageMs = lastRunAt ? Date.now() - lastRunAt.getTime() : null
  const staleAfterMs = 2 * 60 * 60 * 1000

  return c.json({
    job: HOURLY_JOB,
    expectedIntervalMs: 60 * 60 * 1000,
    lastRunAt,
    lastStatus: last?.status ?? null,
    lastDurationMs: last?.durationMs ?? null,
    ageMs,
    healthy: ageMs != null && ageMs < staleAfterMs,
    staleAfterMs,
    runCount: runs.length,
    ...(cronAuthorized(c) ? { runs } : {}),
  })
})

// Data provenance. Public and honest: each source reports whether it is
// configured and how much real data it has actually delivered, so the UI can
// state its sourcing truthfully instead of asserting "Real-time" unconditionally.
app.get('/sqftlab/sources', async (c) => {
  const [listingAgg, txnSources] = await Promise.all([
    prisma.listing.groupBy({
      by: ['source'],
      _count: { _all: true },
      _max: { scrapedAt: true },
    }),
    prisma.transaction.groupBy({
      by: ['source'],
      _count: { _all: true },
      _max: { registeredAt: true },
    }),
  ])

  const listingRows = listingAgg.map((r) => ({
    name: r.source,
    kind: 'listings' as const,
    records: r._count._all,
    lastRecordAt: r._max.scrapedAt,
  }))

  const txnRows = txnSources.map((r) => ({
    name: r.source,
    kind: 'transactions' as const,
    records: r._count._all,
    lastRecordAt: r._max.registeredAt,
  }))

  // "Available to fetch" is a different question from "has been fetched" — the
  // record counts answer the second, this answers the first.
  //
  // The three statuses are deliberately distinct, because collapsing them is how a
  // dashboard ends up claiming data it does not have:
  //   connected  — reachable now and delivering rows
  //   key_needed — reachable, but the provider requires a credential we do not hold
  //   blocked    — reachable, but behind an anti-bot control that needs a human
  const dldRefs = await dldReferenceCounts()
  const dldRefTotal = Object.values(dldRefs).reduce((a, b) => a + b, 0)

  const available = [
    { name: 'PropertyFinder', kind: 'listings', requiresCredentials: false, envVar: null, connected: listingRows.some((r) => r.name === 'propertyfinder'), note: 'Public listings; keyless scrape.' },
    {
      name: 'DLD open data (area + project registry)',
      kind: 'reference',
      requiresCredentials: false,
      envVar: null,
      connected: dldRefTotal > 0,
      records: dldRefTotal,
      note: 'Keyless government gateway. Reference registers only — carries no prices. DLD transaction and rent records on the same gateway are captcha-protected and cannot be fetched automatically.',
    },
    {
      name: 'DLD (Dubai Pulse) transaction register',
      kind: 'transactions',
      requiresCredentials: true,
      envVar: 'DUBAI_PULSE_API_KEY',
      connected: txnRows.some((r) => r.name === 'dld'),
      note: 'The only source of official sale prices. Dubai Pulse issues the key via UAE Pass, so it must be obtained by the account holder, not the platform.',
    },
    {
      name: 'ADREC (Abu Dhabi)',
      kind: 'transactions',
      requiresCredentials: true,
      envVar: 'ADREC_API_URL',
      connected: txnRows.some((r) => r.name === 'adrec'),
      note: 'ADREC grants access by subscription request; there is no self-serve signup.',
    },
  ]

  return c.json({
    available,
    delivering: [...listingRows, ...txnRows],
    referenceCounts: dldRefs,
    note: 'Counts are recorded rows only. Nothing here is estimated or generated.',
  })
})

// ─── Pipeline control (manual trigger; the hourly cron calls this too) ──────
app.post('/sqftlab/intelligence/run', async (c) => {
  // Recomputes and writes the whole intelligence layer (RPI, buildings, supply)
  // and publishes to every connected SSE client.
  if (!cronAuthorized(c)) return c.json({ error: 'unauthorized' }, 401)
  try {
    const result = await runIntelligencePipeline()

    // Spec 16.3 — broadcast the recomputed state to every connected client.
    const summary = await prisma.marketSummary.findFirst({ orderBy: { computedAt: 'desc' } })
    if (summary) publish('market:update', summary)
    publish('intelligence:update', {
      rpi: result.rpi, buildings: result.buildings, supply: result.supply,
      migration: result.migration, flow: result.flow, metrics: result.metrics,
      durationMs: result.durationMs, generatedAt: result.generatedAt,
    })
    const topDistricts = (await latestDistrictMetrics())
      .sort((a, b) => (b.momentumScore ?? 0) - (a.momentumScore ?? 0))
      .slice(0, 10)
    for (const d of topDistricts) {
      publish('district:update', {
        district: d.district, avgPricePsf: d.avgPricePsf,
        priceChange3m: d.priceChange3m, momentumScore: d.momentumScore,
        calculatedAt: d.calculatedAt.toISOString(),
      })
    }

    return c.json({ ...result, published: { market: !!summary, districts: topDistricts.length } })
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

// Fire the broadcast path without recomputing, so the client can be exercised
// against a live stream even when nothing has changed on disk.
app.post('/sqftlab/stream/test-publish', async (c) => {
  // Injects synthetic events into the live stream every client is subscribed to.
  if (!cronAuthorized(c)) return c.json({ error: 'unauthorized' }, 401)
  // Track what was actually published. The previous version returned a fixed
  // list including 'deal:new' regardless of whether a deal existed, so a caller
  // watching the stream for an event the response promised would wait forever.
  const published: string[] = []

  const summary = await prisma.marketSummary.findFirst({ orderBy: { computedAt: 'desc' } })
  publish('market:update', summary ?? { note: 'no market summary computed yet' })
  published.push('market:update')

  const d = (await latestDistrictMetrics())
    .sort((a, b) => (b.momentumScore ?? 0) - (a.momentumScore ?? 0))[0]
  if (d) {
    publish('district:update', { district: d.district, momentumScore: d.momentumScore })
    published.push('district:update')
  }

  const deal = await prisma.listing.findFirst({ where: { isDeal: true } })
  if (deal) {
    publish('deal:new', {
      id: deal.id, title: deal.title, purpose: deal.purpose,
      priceAed: deal.priceAed, pricePerSqft: deal.pricePerSqft,
      imageUrl: deal.imageUrl, sourceUrl: deal.sourceUrl,
      detectedAt: new Date().toISOString(),
    })
    published.push('deal:new')
  }

  const skipped = ['district:update', 'deal:new'].filter((ch) => !published.includes(ch))
  return c.json({
    ok: true,
    published,
    // Nothing to send is a normal state — the 8% deal rule needs DLD medians and
    // the district feed needs computed metrics. Naming what was skipped keeps a
    // quiet stream from looking like a broken one.
    ...(skipped.length
      ? { skipped, reason: 'No rows matched — deal flags need a 90-day DLD median; district metrics must be computed.' }
      : {}),
    ...streamStatus(),
  })
})

app.get('/sqftlab/intelligence/status', async (c) => {
  const [rpi, buildings, flows, clusters, supply, sens, metrics, summary, macro, fx] = await Promise.all([
    prisma.realPriceIndex.count(), prisma.buildingProfile.count(),
    prisma.nationalityFlow.count(), prisma.institutionalTransaction.count(),
    prisma.supplyPipeline.count(), prisma.macroSensitivity.count(),
    prisma.districtMetrics.count(), prisma.marketSummary.count(),
    prisma.macroIndicator.count(), prisma.exchangeRate.count(),
  ])
  const lastSummary = await prisma.marketSummary.findFirst({ orderBy: { computedAt: 'desc' } })
  return c.json({
    products: {
      realPriceIndex: { rows: rpi, ready: rpi > 0 },
      buildingIntelligence: { rows: buildings, ready: buildings > 0 },
      migrationSignal: { rows: flows, ready: flows > 0 },
      institutionalFlow: { rows: clusters, ready: clusters > 0 },
      supplyPipeline: { rows: supply, ready: supply > 0 },
      macroSensitivity: { rows: sens, ready: sens > 0 },
      districtMetrics: { rows: metrics, ready: metrics > 0 },
    },
    infrastructure: { marketSummary: summary, macroIndicators: macro, exchangeRates: fx },
    lastComputedAt: lastSummary?.computedAt?.toISOString() ?? null,
    specVersion: SPEC_VERSION,
  })
})

// ─── Macro ingestion (spec Part 3.2 free sources) ───────────────────────────
app.post('/sqftlab/macro/refresh', async (c) => {
  // Hits several external macro providers; unguarded it was an open proxy that
  // could burn their rate limits from our IP.
  if (!cronAuthorized(c)) return c.json({ error: 'unauthorized' }, 401)
  try {
    const result = await fetchAllMacro()
    return c.json({ ...result, fetchedAt: new Date().toISOString() })
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

app.get('/sqftlab/fx', async (c) => {
  const latest = await prisma.exchangeRate.findFirst({ orderBy: { fetchedAt: 'desc' } })
  if (latest) return c.json(latest)
  // Nothing ingested yet — fetch live rather than returning an empty shape.
  const r = await fetchExchangeRates()
  if (!r.ok) return c.json({ error: r.error ?? 'FX unavailable' }, 502)
  const fresh = await prisma.exchangeRate.findFirst({ orderBy: { fetchedAt: 'desc' } })
  return c.json(fresh)
})

// ─── Spec Part 8 — /api/img image proxy ─────────────────────────────────────
// Only hosts we actually scrape are allowed through: an open proxy here would
// be an SSRF hole pointed at the internal network.
const IMAGE_HOST_ALLOWLIST = [
  'bayut-production.s3.eu-central-1.amazonaws.com',
  'images.bayut.com',
  'cdn.propertyfinder.ae',
  'www.propertyfinder.ae',
  'dbz-images.dubizzle.com',
  'images.dubizzle.com',
]

app.get('/sqftlab/img', async (c) => {
  const raw = c.req.query('url')
  if (!raw) return c.json({ error: 'url query parameter is required' }, 400)

  let target: URL
  try {
    target = new URL(raw)
  } catch {
    return c.json({ error: 'url is not a valid absolute URL' }, 400)
  }
  if (target.protocol !== 'https:' || !IMAGE_HOST_ALLOWLIST.includes(target.hostname)) {
    return c.json({ error: `Host not allowed: ${target.hostname}`, allowlist: IMAGE_HOST_ALLOWLIST }, 403)
  }

  const cached = await prisma.imageCache.findFirst({ where: { externalUrl: target.toString() } })
  if (cached?.contentType && cached.expiresAt && cached.expiresAt.getTime() > Date.now()) {
    return c.body(null, 302, { Location: target.toString() })
  }

  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 12_000)
    const res = await fetch(target.toString(), { signal: ctl.signal, headers: { 'User-Agent': 'sqftLab/1.0' } })
    clearTimeout(timer)
    if (!res.ok) return c.json({ error: `Upstream returned ${res.status}` }, 502)

    const buf = Buffer.from(await res.arrayBuffer())
    const contentType = res.headers.get('content-type') ?? 'image/jpeg'
    await prisma.imageCache.upsert({
      where: { externalUrl: target.toString() },
      create: {
        externalUrl: target.toString(), contentType, sizeBytes: buf.length,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      },
      update: { contentType, sizeBytes: buf.length, fetchedAt: new Date(), expiresAt: new Date(Date.now() + 7 * 86_400_000) },
    })
    return c.body(new Uint8Array(buf), 200, {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=604800, immutable',
    })
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502)
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// Spec Part 16 — real-time stream (SSE).
// ═══════════════════════════════════════════════════════════════════════════

app.get('/sqftlab/stream/status', (c) => c.json(streamStatus()))

app.get('/sqftlab/stream/market', (c) =>
  streamSSE(c, async (stream) => {
    let closed = false

    // 1. Send the current state immediately so there is no empty first paint.
    const summary = await prisma.marketSummary.findFirst({ orderBy: { computedAt: 'desc' } })
    const fx = await prisma.exchangeRate.findFirst({ orderBy: { fetchedAt: 'desc' } })
    await stream.writeSSE({
      event: 'message',
      data: JSON.stringify({ type: 'init', payload: { summary, fx }, ts: Date.now() }),
    })

    // 2. Replay whatever was published before this client connected.
    for (const m of recentMessages()) {
      await stream.writeSSE({
        event: 'message',
        data: JSON.stringify({ type: m.channel, payload: m.payload, ts: m.ts }),
      })
    }

    // 3. Forward everything published from here on.
    const unsubscribe = subscribe(async (m) => {
      if (closed) return
      try {
        await stream.writeSSE({
          event: 'message',
          data: JSON.stringify({ type: m.channel, payload: m.payload, ts: m.ts }),
        })
      } catch {
        closed = true
        unsubscribe()
      }
    })

    // 4. Heartbeat — keeps proxies from closing an idle connection, and gives
    //    the client a liveness signal it can show in the UI.
    const heartbeat = setInterval(() => {
      if (closed) return
      stream.writeSSE({ event: 'ping', data: JSON.stringify({ ts: Date.now() }) }).catch(() => {
        closed = true
        unsubscribe()
        clearInterval(heartbeat)
      })
    }, 25_000)

    stream.onAbort(() => {
      closed = true
      clearInterval(heartbeat)
      unsubscribe()
    })

    // Keep the handler alive until the client disconnects.
    await new Promise<void>((resolve) => {
      stream.onAbort(resolve)
      setTimeout(resolve, 30 * 60 * 1000)
    })
  }),
)

// ═══════════════════════════════════════════════════════════════════════════
// Auth (Task C) — email magic link + Google OAuth handshake
//
// PORT NOTE: the spec targets NextAuth v5, which is a Next.js library and cannot
// run inside this Hono + Vite app. The behaviour is implemented natively here:
// single-use tokens in `verification_tokens`, a `sessions` row per sign-in,
// guest→user attribution, and Google as an optional OAuth provider.
//
// IDENTITY MODEL: `getUserId()` trusts a caller-supplied token. That IDENTIFIES
// but does not AUTHENTICATE — the same caveat as every other endpoint. Swapping
// in real session verification is a contained change to that one function.
// ═══════════════════════════════════════════════════════════════════════════

// The cookie name `getUserId()` already reads, so the whole API accepts the
// signed-in identity without touching a single existing handler.
const SESSION_COOKIE = 'next-auth.session-token'
const SESSION_TTL_DAYS = 30

/** Send the sign-in link. Returns 'unconfigured' when no mail transport exists. */
async function sendMagicLinkEmail(to: string, link: string): Promise<'sent' | 'unconfigured'> {
  const { createEmailOptional } = await import('@shogo-ai/sdk/email/server')
  const email = createEmailOptional()
  if (!email) return 'unconfigured'
  await email.send({
    to,
    subject: 'Your sqftLab sign-in link',
    html:
      `<p>Click below to sign in to sqftLab:</p>` +
      `<p><a href="${link}">${link}</a></p>` +
      `<p>This link expires in 15 minutes. If you didn't request it, ignore this email.</p>`,
  })
  return 'sent'
}

/** Exchange a validated magic-link token for a session cookie + Session row. */
async function establishSession(
  c: Context,
  user: { id: string; email: string },
  opts: { registeredVia: string; name?: string | null; image?: string | null },
) {
  const sessionToken = randomBytes(32).toString('hex')
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 3600 * 1000)

  await prisma.session.create({ data: { sessionToken, userId: user.id, expires } })

  // Task C3 — attribute the anonymous session to this user.
  const guestId = c.get('guestId')
  if (guestId) {
    await prisma.guestSession
      .update({ where: { id: guestId }, data: { convertedAt: new Date(), convertedUserId: user.id } })
      .catch(() => {})
    await prisma.user.update({ where: { id: user.id }, data: { guestId } }).catch(() => {})
    await prisma.userEvent
      .updateMany({ where: { guestId, userId: null }, data: { userId: user.id } })
      .catch(() => {})
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date(), lastActiveAt: new Date(), registeredVia: opts.registeredVia },
  })

  c.header(
    'Set-Cookie',
    `${SESSION_COOKIE}=${user.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_DAYS * 24 * 3600}`,
  )
  await trackEvent(c, 'sign_up', { via: opts.registeredVia })
}

// Request a sign-in link.
app.post('/sqftlab/auth/magic-link', async (c) => {
  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Request body must be JSON.' }, 400)
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return c.json({ error: 'A valid email address is required.' }, 400)
  }

  const token = randomBytes(32).toString('hex')
  await prisma.verificationToken.create({
    data: { identifier: email, token, expires: new Date(Date.now() + 15 * 60 * 1000) },
  })

  const link = `${new URL(c.req.url).origin}/api/sqftlab/auth/verify?token=${token}&email=${encodeURIComponent(email)}`

  let delivery: 'sent' | 'unconfigured' = 'unconfigured'
  try {
    delivery = await sendMagicLinkEmail(email, link)
  } catch {
    delivery = 'unconfigured'
  }

  await trackEvent(c, 'sign_up', { step: 'magic_link_requested' })

  return c.json({
    ok: true,
    delivery,
    // Only returned when no transport is configured, so the flow stays testable
    // locally. Once SMTP_* / RESEND_API_KEY exist this key disappears.
    ...(delivery === 'unconfigured' ? { devLink: link } : {}),
    message:
      delivery === 'sent'
        ? 'Check your inbox for the sign-in link.'
        : 'Email delivery is not configured on this deployment. The link is returned below instead.',
  })
})

// Consume the link. Single-use: the token is deleted before the session is made.
app.get('/sqftlab/auth/verify', async (c) => {
  const token = c.req.query('token') ?? ''
  const email = (c.req.query('email') ?? '').trim().toLowerCase()
  if (!token || !email) return c.json({ error: 'token and email are required.' }, 400)

  const record = await prisma.verificationToken.findFirst({ where: { token, identifier: email } })
  if (!record) return c.json({ error: 'This sign-in link is invalid or has already been used.' }, 400)
  if (record.expires < new Date()) {
    await prisma.verificationToken.deleteMany({ where: { token } })
    return c.json({ error: 'This sign-in link has expired. Request a new one.' }, 400)
  }
  await prisma.verificationToken.deleteMany({ where: { token } })

  const existing = await prisma.user.findUnique({ where: { email } })
  const user = existing
    ? existing
    : await prisma.user.create({
        data: {
          email,
          registeredVia: 'magic_link',
          ipAtRegistration: c.req.header('x-forwarded-for') ?? null,
          referrer: c.req.header('Referer') ?? null,
        },
      })

  await establishSession(c, user, { registeredVia: 'magic_link' })

  // An email client follows this with a plain browser GET, so land the visitor
  // back in the app rather than on raw JSON.
  const onboarded = existing?.onboardingCompleted ?? false
  return c.redirect(`/?signed_in=1&welcome=${onboarded ? '0' : '1'}`, 302)
})

// Google OAuth handshake. Optional: reports status instead of failing when the
// provider credentials are absent.
app.get('/sqftlab/auth/google', (c) => {
  const clientId = process.env.GOOGLE_CLIENT_ID
  if (!clientId) {
    return c.json(
      {
        ok: false,
        provider: 'google',
        configured: false,
        message:
          'Google sign-in is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then add the callback URL below to the Google console.',
        callbackUrl: `${new URL(c.req.url).origin}/api/sqftlab/auth/google/callback`,
      },
      501,
    )
  }
  const redirectUri = `${new URL(c.req.url).origin}/api/sqftlab/auth/google/callback`
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('prompt', 'select_account')
  return c.redirect(url.toString(), 302)
})

app.get('/sqftlab/auth/google/callback', async (c) => {
  const code = c.req.query('code')
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) return c.json({ error: 'Google OAuth is not configured.' }, 501)
  if (!code) return c.json({ error: 'Missing authorization code.' }, 400)

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${new URL(c.req.url).origin}/api/sqftlab/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
    })
    if (!tokenRes.ok) return c.json({ error: `Google token exchange failed (${tokenRes.status}).` }, 502)
    const tokens = (await tokenRes.json()) as { access_token?: string }
    if (!tokens.access_token) return c.json({ error: 'Google returned no access token.' }, 502)

    const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    if (!profileRes.ok) return c.json({ error: 'Could not read the Google profile.' }, 502)
    const profile = (await profileRes.json()) as { email?: string; name?: string; picture?: string; sub?: string }
    if (!profile.email) return c.json({ error: 'Google profile has no email.' }, 502)

    const email = profile.email.toLowerCase()
    const existing = await prisma.user.findUnique({ where: { email } })
    const user =
      existing ??
      (await prisma.user.create({
        data: { email, name: profile.name ?? null, image: profile.picture ?? null, registeredVia: 'google' },
      }))

    await prisma.account
      .create({
        data: {
          userId: user.id,
          type: 'oauth',
          provider: 'google',
          providerAccountId: profile.sub ?? email,
        },
      })
      .catch(() => {})

    await establishSession(c, user, { registeredVia: 'google' })
    return c.redirect(`/?signed_in=1&welcome=${existing?.onboardingCompleted ? '0' : '1'}`, 302)
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Google sign-in failed.' }, 502)
  }
})

// Who am I, according to the session cookie.
app.get('/sqftlab/auth/session', async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ authenticated: false, tier: 'guest' })
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, email: true, name: true, image: true, role: true,
      subscriptionTier: true, subscriptionStatus: true,
      onboardingCompleted: true, tourCompleted: true, guestId: true, registeredVia: true,
    },
  })
  if (!user) return c.json({ authenticated: false, tier: 'guest' })
  const { subscriptionTier, ...rest } = user
  return c.json({ authenticated: true, tier: subscriptionTier, subscriptionTier, user: rest })
})

// Task C4 — onboarding: role + tracked areas + WhatsApp digest preference.
app.post('/sqftlab/auth/onboard', async (c) => {
  const userId = getUserId(c)
  if (!userId) return upgradeRequired(c)

  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Request body must be JSON.' }, 400)
  }

  const role = typeof body.role === 'string' ? body.role : null
  const areas = Array.isArray(body.areas) ? body.areas.filter((a): a is string => typeof a === 'string') : []
  const whatsappEnabled = body.whatsappEnabled === true
  const whatsappPhone = typeof body.whatsappPhone === 'string' ? body.whatsappPhone : null

  if (role && !['investor', 'agent', 'developer', 'analyst', 'other'].includes(role)) {
    return c.json({ error: 'role must be investor | agent | developer | analyst | other' }, 400)
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(role ? { role } : {}),
      ...(whatsappEnabled ? { whatsappEnabled: true, whatsappPhone } : {}),
      // Stored as JSON text — SQLite has no Json column type.
      whatsappAreas: JSON.stringify(areas),
      onboardingCompleted: true,
    },
    select: { id: true, role: true, whatsappAreas: true, onboardingCompleted: true },
  })

  await trackEvent(c, 'sign_up', { step: 'onboarding_complete', role, areas: areas.length })
  return c.json({ ok: true, user })
})

// ─── Developer API keys (Task A: ApiKey model) ───────────────────────────────

/**
 * Maximum ACTIVE keys for a tier.
 *
 * Shared by GET and POST: the POST body of this route hardcoded the ladder, so the
 * usage summary and the enforcement could drift apart and the UI would promise a
 * limit the API did not apply (or refuse at one the UI never showed).
 */
function apiKeyLimitFor(tier: CallerTier | undefined): number {
  return tier === 'institutional' ? 20 : tier === 'enterprise' ? 10 : tier === 'elite' ? 5 : 3
}

/** Daily call allowance for one key. Mirrors the limiter in the /v1 middleware. */
function apiKeyDailyLimitFor(tier: string | undefined): number {
  return API_DAILY_LIMITS[tier ?? 'pro'] ?? API_DAILY_LIMITS.pro
}

app.get('/sqftlab/api-keys', async (c) => {
  const blocked = requireTier(c, 'pro', 'API keys')
  if (blocked) return blocked
  const userId = getUserId(c)
  if (!userId) return upgradeRequired(c)
  const tier = (c.get('tier') as CallerTier | undefined) ?? 'pro'

  const keys = await prisma.apiKey.findMany({
    where: { userId, revokedAt: null },
    select: {
      id: true, prefix: true, name: true, tier: true,
      callsToday: true, callsMonth: true, callsResetAt: true, monthResetAt: true,
      lastUsedAt: true, createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  })

  // Day and month counters are reset LAZILY, on first use (see the callsResetAt note in
  // schema.prisma). A stored `callsToday` is therefore STALE until the key is next used,
  // and reporting it raw would show a key that exhausted its allowance yesterday as still
  // exhausted today. The same rollover the limiter applies is applied here, or the page
  // contradicts the API it describes.
  const now = new Date()
  const day = now.toISOString().slice(0, 10)
  const month = day.slice(0, 7)

  const keysWithUsage = keys.map((k) => {
    const dayFresh = !k.callsResetAt || k.callsResetAt.toISOString().slice(0, 10) === day
    const monthFresh = !k.monthResetAt || k.monthResetAt.toISOString().slice(0, 7) === month
    const dailyLimit = apiKeyDailyLimitFor(k.tier)
    const usedToday = dayFresh ? k.callsToday : 0
    return {
      id: k.id,
      prefix: k.prefix,
      name: k.name,
      tier: k.tier,
      callsToday: usedToday,
      callsMonth: monthFresh ? k.callsMonth : 0,
      dailyLimit,
      remainingToday: Math.max(0, dailyLimit - usedToday),
      lastUsedAt: k.lastUsedAt,
      createdAt: k.createdAt,
    }
  })

  // Limits are PER KEY. Two keys do not share one 500/day pool, so the headline figure
  // reports the BUSIEST key against the per-key ceiling. Summing calls across keys and
  // comparing them to a single limit would invent a shared quota that is not enforced
  // anywhere, and would show a two-key account at "900/500".
  const busiest = keysWithUsage.reduce<(typeof keysWithUsage)[number] | null>(
    (acc, k) => (acc === null || k.callsToday > acc.callsToday ? k : acc),
    null,
  )
  const dailyLimitPerKey = apiKeyDailyLimitFor(tier)

  const midnightUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  const monthStartUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))

  return c.json({
    keys: keysWithUsage,
    usage: {
      tier,
      keyCount: keysWithUsage.length,
      maxKeys: apiKeyLimitFor(tier),
      dailyLimitPerKey,
      monthlyLimitPerKey: 2_000_000,
      // Where the limiter actually is: the single most-used key.
      busiestKeyName: busiest?.name ?? null,
      busiestKeyCallsToday: busiest?.callsToday ?? 0,
      // Summed for the customer's own interest, explicitly not compared to a limit.
      totalCallsToday: keysWithUsage.reduce((a, k) => a + k.callsToday, 0),
      totalCallsMonth: keysWithUsage.reduce((a, k) => a + k.callsMonth, 0),
      resetsAtUtc: midnightUtc.toISOString(),
      monthResetsAtUtc: monthStartUtc.toISOString(),
    },
  })
})

app.post('/sqftlab/api-keys', async (c) => {
  const blocked = requireTier(c, 'pro', 'API keys')
  if (blocked) return blocked
  const userId = getUserId(c)
  if (!userId) return upgradeRequired(c)

  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Request body must be JSON.' }, 400)
  }
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Untitled key'

  // The key inherits the CALLER's tier. The spec hardcoded 'pro' here, which
  // meant an institutional customer's key carried a pro tier and their allowance
  // was enforced at 500/day instead of 100,000 — paying for 200x and receiving 1x.
  const tier = (c.get('tier') as CallerTier | undefined) ?? 'pro'
  const maxKeys = apiKeyLimitFor(tier)
  const existingCount = await prisma.apiKey.count({ where: { userId, revokedAt: null } })
  if (existingCount >= maxKeys) {
    return c.json(
      {
        error: `Maximum ${maxKeys} active API keys on your plan`,
        maxKeys,
        current: existingCount,
        upgradeUrl: '/pricing',
      },
      403,
    )
  }

  const raw = `sqft_${randomBytes(24).toString('hex')}`
  const keyHash = createHash('sha256').update(raw).digest('hex')

  const created = await prisma.apiKey.create({
    data: { userId, keyHash, prefix: raw.slice(0, 12), name, tier },
    select: { id: true, prefix: true, name: true, tier: true, createdAt: true },
  })
  await trackEvent(c, 'api_call', { action: 'create_key' })

  // The only time the plaintext key exists outside the caller's own storage.
  return c.json(
    {
      ok: true,
      key: raw,
      prefix: created.prefix,
      name: created.name,
      warning: 'Save this key — it will not be shown again.',
      meta: created,
    },
    201,
  )
})

app.delete('/sqftlab/api-keys/:id', async (c) => {
  const blocked = requireTier(c, 'pro', 'API keys')
  if (blocked) return blocked
  const userId = getUserId(c)
  if (!userId) return upgradeRequired(c)
  const id = c.req.param('id')
  const existing = await prisma.apiKey.findFirst({ where: { id, userId } })
  if (!existing) return c.json({ error: 'API key not found' }, 404)
  await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } })
  return c.json({ ok: true, revoked: id })
})

// ─── White-label API (Day 17 Tasks A + B) ────────────────────────────────────
//
// An institutional client points their own domain at this API and their branding is
// injected into the responses (and, via `brandColor`/`logoUrl`/`attributionText`, into
// PDF reports).
//
// The brief's route bodies spread the raw request body straight into a Prisma upsert:
//
//     prisma.whiteLabelConfig.upsert({ where: { userId }, update: body, create: { userId, ...body } })
//
// `body` is whatever the caller posted, which makes this a mass-assignment hole on a
// model that controls branding and rate limits. An institutional caller could POST:
//
//   · `customDomainVerified: true` — skipping the DNS proof entirely, and (via the
//     host middleware below) serving their branding for a domain they never owned.
//   · `dailyLimit: 999999999` — granting itself an allowance it was not sold.
//   · `userId: "<someone else>"` — creating a config row against another account,
//     because the spread lands *after* the explicit `userId`.
//
// Every writable field is whitelisted below and nothing else is reachable.

const WHITE_LABEL_CNAME_TARGET = process.env.WHITE_LABEL_CNAME_TARGET ?? 'sqftlab-api.railway.app'

/**
 * A bare hostname: no scheme, no port, no path, no trailing dot, lowercased.
 *
 * Stored normalised because it is compared against the `Host` header. If `https://x.com`
 * or `x.com:8443` could be persisted, the comparison in the host middleware would never
 * match and the client would silently get un-branded responses with no error to explain it.
 */
function normalizeDomain(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase().replace(/\.$/, '')
  if (!trimmed) return null
  if (!/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(trimmed)) return null
  return trimmed
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

type WhiteLabelPatch = {
  clientName?: string
  brandColor?: string
  logoUrl?: string | null
  customDomain?: string | null
  attributionText?: string | null
  hideSqftLabBrand?: boolean
}

/**
 * Build the whitelisted write payload. Unknown keys are dropped rather than rejected —
 * a client sending `customDomainVerified` is ignored, not trusted and not told which
 * field name would have worked.
 */
function whiteLabelPatchFrom(body: Record<string, unknown>): { patch: WhiteLabelPatch; errors: string[] } {
  const patch: WhiteLabelPatch = {}
  const errors: string[] = []

  if (body.clientName !== undefined) {
    const v = typeof body.clientName === 'string' ? body.clientName.trim() : ''
    if (!v) errors.push('clientName must be a non-empty string')
    else if (v.length > 120) errors.push('clientName must be 120 characters or fewer')
    else patch.clientName = v
  }

  if (body.brandColor !== undefined) {
    const v = typeof body.brandColor === 'string' ? body.brandColor.trim() : ''
    if (!HEX_COLOR.test(v)) errors.push('brandColor must be a 6-digit hex colour, e.g. #2563EB')
    else patch.brandColor = v.toUpperCase()
  }

  if (body.logoUrl !== undefined) {
    const v = typeof body.logoUrl === 'string' ? body.logoUrl.trim() : ''
    if (!v) patch.logoUrl = null
    else if (v.length > 2048) errors.push('logoUrl must be 2048 characters or fewer')
    // http(s) only: this URL is rendered into reports, so `javascript:`/`data:` must not
    // be storable even though nothing here interpolates it into HTML.
    else if (!/^https?:\/\/[^\s]+$/i.test(v)) errors.push('logoUrl must be an http(s) URL')
    else patch.logoUrl = v
  }

  if (body.customDomain !== undefined) {
    const v = typeof body.customDomain === 'string' ? body.customDomain.trim() : ''
    if (!v) patch.customDomain = null
    else {
      const normalized = normalizeDomain(v)
      if (!normalized) errors.push('customDomain must be a bare hostname, e.g. data.example.com')
      else patch.customDomain = normalized
    }
  }

  if (body.attributionText !== undefined) {
    const v = typeof body.attributionText === 'string' ? body.attributionText.trim() : ''
    if (!v) patch.attributionText = null
    else if (v.length > 300) errors.push('attributionText must be 300 characters or fewer')
    else patch.attributionText = v
  }

  if (body.hideSqftLabBrand !== undefined) {
    if (typeof body.hideSqftLabBrand !== 'boolean') errors.push('hideSqftLabBrand must be a boolean')
    else patch.hideSqftLabBrand = body.hideSqftLabBrand
  }

  return { patch, errors }
}

/** The response fields a client is allowed to see. Never the relation or the flags. */
function whiteLabelView(config: WhiteLabelRow) {
  return {
    clientName: config.clientName,
    brandColor: config.brandColor,
    logoUrl: config.logoUrl,
    customDomain: config.customDomain,
    customDomainVerified: config.customDomainVerified,
    attributionText: config.attributionText,
    hideSqftLabBrand: config.hideSqftLabBrand,
    dailyLimit: config.dailyLimit,
    monthlyLimit: config.monthlyLimit,
    active: config.active,
  }
}

app.post('/sqftlab/white-label/config', async (c) => {
  const blocked = requireTier(c, 'institutional', 'White-Label API')
  if (blocked) return blocked

  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const body = await readJsonBody(c)
  const { patch, errors } = whiteLabelPatchFrom(body)
  if (errors.length > 0) {
    return c.json({ error: 'Invalid input', fields: errors }, 400)
  }

  const existing = await prisma.whiteLabelConfig.findUnique({ where: { userId } })
  if (!existing && patch.clientName === undefined) {
    return c.json({ error: 'clientName is required when creating a white-label config' }, 400)
  }
  if (Object.keys(patch).length === 0) {
    return c.json({ error: 'No recognised fields to update', fields: Object.keys(body) }, 400)
  }

  // The domain is globally unique. Without this check the unique index raises P2002 and
  // the client gets an unhandled 500 for a conflict that is theirs to resolve.
  if (patch.customDomain) {
    const clash = await prisma.whiteLabelConfig.findUnique({ where: { customDomain: patch.customDomain } })
    if (clash && clash.userId !== userId) {
      return c.json(
        { error: 'That domain is already claimed by another white-label account', customDomain: patch.customDomain },
        409,
      )
    }
  }

  // Changing the domain invalidates any previous proof. Otherwise a client could verify
  // a domain they own and then repoint `customDomain` at a domain they do not, keeping
  // the verified flag — which is exactly the thing verification exists to prevent.
  const domainChanged = patch.customDomain !== undefined && patch.customDomain !== existing?.customDomain
  const data = {
    ...patch,
    ...(domainChanged
      ? { customDomainVerified: false, verifiedDomain: null, verifiedAt: null, lastVerifyError: null }
      : {}),
  }

  // `upsert` is deliberately NOT used here.
  //
  // Prisma validates the whole argument object, including the branch it will not take, so
  // an UPSERT whose `create` names a required field throws `Argument clientName is
  // missing` on a partial UPDATE that legitimately omits it — a 500 for a valid request
  // (repointing the domain, or setting just the attribution). The brief uses `update: body`
  // with `create: { userId, ...body }`, which has the same defect in the other direction:
  // its first call always carries clientName, so the bug only appears on the second request.
  //
  // Branching explicitly avoids the trap and removes the `as string` cast the upsert form
  // needed to satisfy the compiler.
  let config: WhiteLabelRow
  if (existing) {
    config = await prisma.whiteLabelConfig.update({ where: { userId }, data })
  } else {
    if (patch.clientName === undefined) {
      // Unreachable — rejected above. Present so the create branch cannot compile without
      // a client name, rather than casting one in.
      return c.json({ error: 'clientName is required when creating a white-label config' }, 400)
    }
    config = await prisma.whiteLabelConfig.create({
      data: { ...data, userId, clientName: patch.clientName },
    })
  }

  await trackEvent(c, 'white_label_configured', {
    domain: config.customDomain,
    domainChanged,
    created: !existing,
  })

  return c.json({ config: whiteLabelView(config) })
})

app.get('/sqftlab/white-label/config', async (c) => {
  const blocked = requireTier(c, 'institutional', 'White-Label API')
  if (blocked) return blocked

  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const config = await prisma.whiteLabelConfig.findUnique({ where: { userId } })
  return c.json({ config: config ? whiteLabelView(config) : null })
})

/**
 * Verify the custom domain actually points at this API.
 *
 * The brief's version never verifies anything: it returns the CNAME instructions with
 * `verified: config.customDomainVerified`, which nothing else in the codebase ever sets.
 * The host middleware requires `customDomainVerified`, so as specified the whole feature
 * could never activate — the client would add the record, poll this endpoint, and watch
 * `verified` stay false forever.
 *
 * So it performs a real CNAME lookup, with a timeout, and only sets the flag when a
 * record actually matches. A lookup that cannot run (no DNS, sandboxed network) reports
 * why and leaves the config unverified rather than assuming success.
 */
app.post('/sqftlab/white-label/verify-domain', async (c) => {
  const blocked = requireTier(c, 'institutional', 'White-Label API')
  if (blocked) return blocked

  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const config = await prisma.whiteLabelConfig.findUnique({ where: { userId } })
  if (!config?.customDomain) return c.json({ error: 'No custom domain configured' }, 400)

  const instructions = {
    type: 'CNAME',
    name: config.customDomain,
    value: WHITE_LABEL_CNAME_TARGET,
    ttl: 300,
  }

  let records: string[] = []
  let lookupError: string | null = null
  try {
    records = await Promise.race([
      resolveCname(config.customDomain),
      new Promise<string[]>((_, reject) =>
        setTimeout(() => reject(new Error('DNS lookup timed out after 5s')), 5_000),
      ),
    ])
    records = records.map((r) => r.toLowerCase().replace(/\.$/, ''))
  } catch (e) {
    lookupError = e instanceof Error ? e.message : String(e)
  }

  const matched = records.includes(WHITE_LABEL_CNAME_TARGET.toLowerCase())

  await prisma.whiteLabelConfig.update({
    where: { userId },
    data: matched
      ? { customDomainVerified: true, verifiedDomain: config.customDomain, verifiedAt: new Date(), lastVerifyError: null }
      : { customDomainVerified: false, verifiedDomain: null, lastVerifyError: lookupError ?? `No CNAME record points at ${WHITE_LABEL_CNAME_TARGET}` },
  })

  // "Could not check" is not the same answer as "checked and it is wrong", and the client
  // needs to tell them apart — one is a DNS change to make, the other is a network problem
  // on our side that they cannot fix.
  const outcome: 'verified' | 'mismatch' | 'unavailable' =
    matched ? 'verified' : lookupError ? 'unavailable' : 'mismatch'

  return c.json({
    domain: config.customDomain,
    verified: matched,
    outcome,
    observedCnames: records,
    expectedCname: WHITE_LABEL_CNAME_TARGET,
    instructions,
    note:
      outcome === 'verified'
        ? 'Domain verified. Requests arriving on this host are now branded.'
        : outcome === 'unavailable'
          ? `Could not reach DNS to check the record (${lookupError}). The domain remains unverified.`
          : 'Add the CNAME record at your DNS provider, then call this endpoint again to verify.',
  })
})

/**
 * Host middleware (Day 17 Task B).
 *
 * Registered immediately before the /v1 API-key middleware so the branding is on the
 * context before any route that answers under /v1 runs.
 *
 * Path note: the brief writes `app.use('/api/v1/*', …)`. This app is mounted with
 * `app.route('/api', customRoutes)`, so that would match `/api/api/v1/...` — the same
 * mount-point trap the v1 section below documents at length. The correct pattern here is
 * `/v1/*`, which serves `/api/v1/...`.
 */
const WHITE_LABEL_HOST_ALLOWLIST = new Set([
  'sqftlab.com',
  'www.sqftlab.com',
  'api.sqftlab.com',
  'app.sqftlab.com',
])

app.use('/v1/*', async (c, next) => {
  // `Host` carries the port when it is non-default (`localhost:8080`), and comparing the
  // raw header would let `sqftlab.com:443` miss the allowlist and be looked up as a
  // white-label domain on every request.
  const host = (c.req.header('Host') ?? '').toLowerCase().replace(/:\d+$/, '')
  const isOwnHost = host === '' || WHITE_LABEL_HOST_ALLOWLIST.has(host) || host.endsWith('.shogo.ai') || host === 'localhost'

  if (!isOwnHost) {
    const config = await prisma.whiteLabelConfig.findFirst({
      where: { customDomain: host, active: true, customDomainVerified: true },
    })
    if (config) {
      c.set('whiteLabelConfig', config as WhiteLabelRow)
      c.header('X-White-Label', config.clientName)
    }
  }

  await next()
})

/**
 * Fold the caller's branding into an API payload's `meta`.
 *
 * Constrained to `Record<string, unknown>` rather than `{ meta?: … }`: with the narrower
 * constraint TypeScript contextually types the argument as the constraint and then
 * rejects every real field as an excess property (`'community' does not exist in type
 * '{ meta?: … }'`), even though those payloads are the whole point.
 *
 * Applied inside each /v1 handler rather than by re-wrapping the response in the
 * middleware: rewriting `c.res` would mean reading and re-emitting the body (breaking on
 * any streaming response) and rebuilding the headers, which are where `X-API-Limit` and
 * `X-API-Remaining` live. The brief names this same approach.
 */
function withWhiteLabel<T extends Record<string, unknown>>(c: Context, payload: T): T {
  const wl = c.get('whiteLabelConfig')
  if (!wl) return payload
  const attribution =
    wl.attributionText ?? (wl.hideSqftLabBrand ? wl.clientName : `Powered by ${wl.clientName} · data from sqftLab`)
  const existingMeta = (payload.meta ?? {}) as Record<string, unknown>
  return {
    ...payload,
    meta: {
      ...existingMeta,
      whiteLabel: {
        clientName: wl.clientName,
        brandColor: wl.brandColor,
        logoUrl: wl.logoUrl,
        attribution,
        hideSqftLabBrand: wl.hideSqftLabBrand,
      },
    },
  }
}

// ─── Public Data API v1 (Day 11 Tasks A + B) ─────────────────────────────────
//
// PATH: server.tsx mounts this app with `app.route('/api', customRoutes)`, so
// routes declared here are relative to that mount point. Declaring '/v1/...'
// serves /api/v1/... . The spec declares '/api/v1/...', which would have served
// /api/api/v1/... and 404'd every URL in its own documentation — the same
// mount-point trap the catch-all at the bottom of this file documents.

const API_DAILY_LIMITS: Record<string, number> = {
  pro: 500,
  elite: 2_000,
  enterprise: 10_000,
  institutional: 100_000,
}

app.use('/v1/*', async (c, next) => {
  const authHeader = c.req.header('Authorization')
  const rawKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null

  // Header only. A `?api_key=` fallback is convenient but writes a live secret
  // into every access log and Referer header it passes through.
  if (!rawKey) {
    c.header('WWW-Authenticate', 'Bearer realm="sqftLab API"')
    return c.json({ error: 'API key required. Include: Authorization: Bearer sqft_...' }, 401)
  }

  const keyHash = createHash('sha256').update(rawKey).digest('hex')
  const key = await prisma.apiKey.findUnique({
    where: { keyHash },
    select: {
      id: true, userId: true, tier: true, name: true,
      revokedAt: true, callsToday: true, callsResetAt: true, monthResetAt: true,
      user: { select: { subscriptionStatus: true } },
    },
  })

  if (!key || key.revokedAt) return c.json({ error: 'Invalid or revoked API key' }, 401)

  // The spec reads the owner's subscription status and then never uses it, so a
  // cancelled customer's keys kept working forever. The key's TIER sets the
  // allowance; the owner's STATUS decides whether that tier is still paid for.
  const status = key.user?.subscriptionStatus
  if (status !== 'active' && status !== 'trialing') {
    return c.json(
      { error: 'Subscription inactive for this API key', status: status ?? 'inactive', upgradeUrl: '/pricing' },
      403,
    )
  }

  // Lazy day/month rollover — see the callsResetAt note in schema.prisma.
  const now = new Date()
  const day = now.toISOString().slice(0, 10)
  const month = day.slice(0, 7)
  const rollDay = !key.callsResetAt || key.callsResetAt.toISOString().slice(0, 10) !== day
  const rollMonth = !key.monthResetAt || key.monthResetAt.toISOString().slice(0, 7) !== month
  const usedToday = rollDay ? 0 : key.callsToday

  const limit = API_DAILY_LIMITS[key.tier] ?? API_DAILY_LIMITS.pro
  c.header('X-API-Limit', String(limit))
  c.header('X-API-Remaining', String(Math.max(0, limit - usedToday - 1)))

  if (usedToday >= limit) {
    return c.json(
      { error: 'Daily API limit exceeded', limit, used: usedToday, retryAfterHours: 24, upgradeUrl: '/pricing' },
      429,
    )
  }

  prisma.apiKey
    .update({
      where: { id: key.id },
      data: {
        callsToday: rollDay ? 1 : { increment: 1 },
        callsMonth: rollMonth ? 1 : { increment: 1 },
        ...(rollDay ? { callsResetAt: now } : {}),
        ...(rollMonth ? { monthResetAt: now } : {}),
        lastUsedAt: now,
      },
    })
    .catch(() => {})

  c.set('apiKeyUserId', key.userId)
  c.set('apiKeyTier', key.tier)
  await next()
})

/**
 * GET /api/v1/transactions
 *
 * Field names differ from the spec throughout: this schema stores
 * communityId / beds / areaSqft / pricePerSqft / priceAed, and has no `area`,
 * `bedrooms`, `size`, `pricePsf` or `amount` column at all.
 */
app.get('/v1/transactions', async (c) => {
  const q = c.req.query()
  const limit = Math.min(Math.max(parseInt(q.limit ?? '100') || 100, 1), 1000)
  const offset = Math.max(parseInt(q.offset ?? '0') || 0, 0)
  const beds = q.bedrooms ? parseInt(q.bedrooms) : undefined

  for (const k of ['date_from', 'date_to'] as const) {
    const v = q[k]
    if (v && Number.isNaN(new Date(v).getTime())) {
      return badInput(c, [k], { [k]: 'ISO date, e.g. 2026-01-31' })
    }
  }

  const built = await buildTransactionWhere({
    area: q.area ?? q.community,
    beds: beds !== undefined && Number.isFinite(beds) && beds > 0 ? beds : undefined,
    dateFrom: q.date_from,
    dateTo: q.date_to,
    psfMin: q.psf_min ? parseInt(q.psf_min) : undefined,
    psfMax: q.psf_max ? parseInt(q.psf_max) : undefined,
  })

  if (!built.ok) {
    return c.json(
      withWhiteLabel(c, {
        error: `No community matches "${built.area}"`,
        code: 'area_not_found',
        hint: 'GET /api/v1/communities to list valid names',
        data: [],
        meta: { total: 0, limit, offset, returned: 0, source: 'DLD official records' },
      }),
      404,
    )
  }

  const [rows, total] = await Promise.all([
    prisma.transaction.findMany({
      where: built.where,
      select: {
        transactionDate: true, buildingName: true, beds: true, areaSqft: true,
        pricePerSqft: true, priceAed: true, propertyType: true, transactionType: true,
        community: { select: { nameEn: true, slug: true, emirate: true } },
      },
      orderBy: { transactionDate: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.transaction.count({ where: built.where }),
  ])

  return c.json(
    withWhiteLabel(c, {
      data: rows.map((r) => ({
        date: r.transactionDate.toISOString().slice(0, 10),
        community: r.community?.nameEn ?? null,
        communitySlug: r.community?.slug ?? null,
        emirate: r.community?.emirate ?? null,
        building: r.buildingName,
        bedrooms: r.beds,
        sizeSqft: Number(r.areaSqft.toFixed(0)),
        psfAed: Number(r.pricePerSqft.toFixed(0)),
        priceAed: Number(r.priceAed.toFixed(0)),
        propertyType: r.propertyType,
        transactionType: r.transactionType,
      })),
      meta: {
        total, limit, offset, returned: rows.length,
        source: 'DLD official records',
        // With no registry source connected this is the honest shape of the
        // answer, not an error: the query is valid, the dataset is empty.
        empty: total === 0,
      },
    }),
  )
})

app.get('/v1/communities', async (c) => {
  const communities = await prisma.community.findMany({
    select: { slug: true, nameEn: true, emirate: true, medianAedSqft: true },
    orderBy: { nameEn: 'asc' },
    take: 200,
  })
  return c.json(
    withWhiteLabel(c, { data: communities, meta: { total: communities.length, source: 'sqftLab community registry' } }),
  )
})

app.get('/v1/communities/:slug/stats', async (c) => {
  const community = await prisma.community.findUnique({
    where: { slug: c.req.param('slug') },
    select: { id: true, nameEn: true, slug: true, emirate: true, medianAedSqft: true, psfSource: true },
  })
  if (!community) return c.json({ error: 'Community not found' }, 404)

  const since90 = new Date()
  since90.setDate(since90.getDate() - 90)
  const stats = await prisma.transaction.aggregate({
    where: {
      communityId: community.id,
      transactionType: { in: [...SALE_TXN_TYPES] },
      pricePerSqft: { gt: 100 },
      transactionDate: { gte: since90 },
    },
    _avg: { pricePerSqft: true },
    _min: { pricePerSqft: true },
    _max: { pricePerSqft: true },
    _count: { _all: true },
  })

  const n = stats._count._all
  return c.json(
    withWhiteLabel(c, {
      community: community.nameEn,
      slug: community.slug,
      emirate: community.emirate,
      period: '90 days',
      transactions: n,
      avgPsfAed: n ? Number((stats._avg.pricePerSqft ?? 0).toFixed(0)) : null,
      minPsfAed: n ? Number((stats._min.pricePerSqft ?? 0).toFixed(0)) : null,
      maxPsfAed: n ? Number((stats._max.pricePerSqft ?? 0).toFixed(0)) : null,
      // The registry median is a separate figure with its own provenance; it is
      // reported alongside rather than substituted when the 90-day window is empty.
      registryMedianPsfAed: community.medianAedSqft,
      registryMedianSource: community.psfSource,
      source: 'DLD official records',
      empty: n === 0,
    }),
  )
})

// ─── Export Centre (Day 11 Task C) ───────────────────────────────────────────

function exportFiltersFrom(body: Record<string, unknown>): ExportFilters {
  const areaRaw = typeof body.area === 'string' ? body.area : typeof body.community === 'string' ? body.community : ''
  const beds = numField(body, 'bedrooms') ?? numField(body, 'beds')
  return {
    area: areaRaw.trim() || undefined,
    beds: beds !== null && beds > 0 ? Math.floor(beds) : undefined,
    dateFrom: typeof body.dateFrom === 'string' ? body.dateFrom : undefined,
    dateTo: typeof body.dateTo === 'string' ? body.dateTo : undefined,
    psfMin: numField(body, 'psfMin') ?? undefined,
    psfMax: numField(body, 'psfMax') ?? undefined,
  }
}

async function handleExport(c: Context, mode: 'preview' | 'download') {
  const blocked = requireTier(c, 'pro', 'Data export')
  if (blocked) return blocked
  const userId = getUserId(c)
  if (!userId) return upgradeRequired(c)

  const body = await readJsonBody(c)
  const tier = (c.get('tier') as CallerTier | undefined) ?? 'free'
  const format: ExportFormat = body.format === 'excel' ? 'excel' : 'csv'

  for (const k of ['dateFrom', 'dateTo'] as const) {
    const v = body[k]
    if (typeof v === 'string' && v.trim() && Number.isNaN(new Date(v).getTime())) {
      return badInput(c, [k], { [k]: 'ISO date, e.g. 2026-01-31' })
    }
  }

  const rank = TIER_RANK[tier] ?? 0
  if (format === 'excel' && rank < EXCEL_MIN_RANK) {
    return c.json(
      { error: 'Excel export requires the Enterprise plan', format, requiredTier: 'enterprise', upgradeUrl: '/pricing' },
      403,
    )
  }

  const filters = exportFiltersFrom(body)
  const built = await buildTransactionWhere(filters)
  if (!built.ok) {
    return c.json(
      {
        error: `No community matches "${built.area}"`,
        code: 'area_not_found',
        hint: 'Check the spelling, or use /sqftlab/communities for the list.',
      },
      404,
    )
  }

  const rowLimit = rowLimitFor(tier)
  const { rows, total } = await fetchExportRows(built.where, rowLimit)
  const truncated = total > rows.length

  if (mode === 'preview') {
    return c.json({
      total,
      willExport: rows.length,
      rowLimit,
      unlimited: rowLimit >= SAFETY_CEILING,
      truncated,
      excelAllowed: rank >= EXCEL_MIN_RANK,
      tier,
      format,
      empty: total === 0,
      ...(truncated
        ? {
            message: `Your plan exports the ${rowLimit.toLocaleString()} most recent matches; ${(
              total - rows.length
            ).toLocaleString()} older rows are not included.`,
          }
        : {}),
    })
  }

  const stamp = new Date().toISOString().slice(0, 10)
  await trackEvent(c, 'export', {
    format, rows: rows.length, total, truncated, area: filters.area ?? null, tier,
  })

  c.header('X-Export-Rows', String(rows.length))
  c.header('X-Export-Total', String(total))
  c.header('X-Export-Truncated', String(truncated))

  if (format === 'csv') {
    // The BOM is what makes Excel read the file as UTF-8; without it any Arabic
    // community name in the data arrives as mojibake.
    c.header('Content-Type', 'text/csv; charset=utf-8')
    c.header('Content-Disposition', `attachment; filename="sqftlab-transactions-${stamp}.csv"`)
    return c.body(`\uFEFF${toCsv(rows)}`)
  }

  const bytes = await toExcelBuffer(rows)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  c.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  c.header('Content-Disposition', `attachment; filename="sqftlab-transactions-${stamp}.xlsx"`)
  return c.body(buffer)
}

app.post('/sqftlab/export', (c) => handleExport(c, 'download'))
app.post('/sqftlab/export/preview', (c) => handleExport(c, 'preview'))

app.get('/sqftlab/export/history', async (c) => {
  const blocked = requireTier(c, 'pro', 'Data export')
  if (blocked) return blocked
  const userId = getUserId(c)
  if (!userId) return upgradeRequired(c)
  const events = await prisma.userEvent.findMany({
    where: { userId, eventType: 'export' },
    orderBy: { createdAt: 'desc' },
    take: 3,
    select: { id: true, eventData: true, createdAt: true },
  })
  return c.json({ exports: events })
})

// ─── AI market assistant (Day 13 Task B) ─────────────────────────────────────
//
// QUOTA IDENTITY — not the brief's, and deliberately so.
//
// The brief counts messages with `...(userId ? { userId } : { sessionId })`, where
// `sessionId` comes from the `X-Session-Id` request header. A header is caller-supplied,
// so a script rotates it per call and the "10 messages/day" cap never fires — the same
// shape as the Day 4 limiter that handed every cookie-less client a fresh bucket.
//
// Here the key is an identity this server issues: the account id when signed in,
// otherwise the guest cookie the caller *presented*. A caller presenting no cookie at
// all shares one bucket, which bounds it too. `AiChatMessage.sessionId` records
// whichever key was used, so the quota is auditable after the fact.
const AI_QUOTA_ANON_KEY = 'anon:no-cookie'

/** Local midnight — this deployment runs Asia/Dubai, so the day turns at UTC+4. */
function aiQuotaWindowStart(now = new Date()): Date {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  return start
}

function aiQuotaKeyFor(c: Context): string {
  return getUserId(c) ?? readGuestId(c) ?? AI_QUOTA_ANON_KEY
}

app.post('/sqftlab/ai/chat', async (c) => {
  const accountId = getUserId(c)
  const tier = (c.get('tier') as CallerTier | undefined) ?? 'guest'
  const quotaKey = aiQuotaKeyFor(c)
  const limit = aiDailyLimitFor(tier)
  const unlimited = aiTierIsUnlimited(tier)
  const windowStart = aiQuotaWindowStart()
  const resetAt = new Date(windowStart.getTime() + 86_400_000).toISOString()

  const used = await prisma.aiChatMessage.count({
    where: { sessionId: quotaKey, role: 'user', createdAt: { gte: windowStart } },
  })

  if (used >= limit) {
    return c.json(
      { error: 'Daily AI message limit reached', limit, used, unlimited, upgradeUrl: '/pricing', resetAt },
      429,
    )
  }

  const body = await readJsonBody(c)
  const raw = typeof body.message === 'string' ? body.message.trim() : ''
  if (raw === '') return c.json({ error: 'Message required' }, 400)

  // Truncated, not rejected: the brief places no bound on the message, so a caller
  // could post an unbounded string and spend a quota slot on it.
  const message = raw.slice(0, AI_MAX_MESSAGE_CHARS)
  // Rebuilt from validated turns rather than trusted — see normalizeHistory.
  const history = normalizeHistory(body.history)

  const credential = resolveAiCredential()
  if (!credential) {
    return c.json(
      {
        error: 'The AI assistant is not configured on this deployment.',
        code: 'ai_unavailable',
        configured: false,
        detail: 'No model credential found. Expected AI_PROXY_TOKENS (pod) or SHOGO_API_KEY.',
      },
      503,
    )
  }

  const ctx = await buildMarketContext(MARKET_CONTEXT_DAYS)

  let reply: string
  let tokensUsed: number
  try {
    ;({ reply, tokensUsed } = await generateAssistantReply({
      credential,
      system: buildSystemPrompt(ctx),
      history,
      message,
    }))
  } catch (err) {
    // Quota is deliberately NOT consumed. A call that produced no answer cost nothing,
    // and charging for it would lock a caller out of a feature that never replied.
    return c.json(
      {
        error: 'The AI assistant could not answer just now.',
        code: 'ai_error',
        configured: true,
        detail: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      },
      502,
    )
  }

  // Both rows written together and only once a reply exists, so the counter can never
  // exceed the number of answers actually delivered. The brief writes fire-and-forget
  // and counts before the call, which charges for failures and loses the turn entirely
  // if the write is dropped.
  await prisma.aiChatMessage.createMany({
    data: [
      { userId: accountId, sessionId: quotaKey, role: 'user', content: message, tokensUsed: null },
      { userId: accountId, sessionId: quotaKey, role: 'assistant', content: reply, tokensUsed },
    ],
  })

  await trackEvent(c, 'ai_chat', { tier, model: AI_MODEL, tokensUsed, dataBacked: ctx.dataAvailable })

  return c.json({
    reply,
    remaining: Math.max(0, limit - used - 1),
    limit,
    unlimited,
    model: AI_MODEL,
    /** False when the register is empty, so the UI can say why answers are general. */
    dataBacked: ctx.dataAvailable,
    resetAt,
  })
})

// GET /sqftlab/ai/chat/history — recent turns, plus the quota state so the widget can
// render "X remaining today" on open without having sent a message first.
app.get('/sqftlab/ai/chat/history', async (c) => {
  const tier = (c.get('tier') as CallerTier | undefined) ?? 'guest'
  const quotaKey = aiQuotaKeyFor(c)
  const limit = aiDailyLimitFor(tier)

  const [rows, used] = await Promise.all([
    prisma.aiChatMessage.findMany({
      where: { sessionId: quotaKey },
      orderBy: { createdAt: 'desc' },
      take: AI_HISTORY_PAGE,
      select: { role: true, content: true, createdAt: true },
    }),
    prisma.aiChatMessage.count({
      where: { sessionId: quotaKey, role: 'user', createdAt: { gte: aiQuotaWindowStart() } },
    }),
  ])

  return c.json({
    messages: rows.reverse(),
    used,
    remaining: Math.max(0, limit - used),
    limit,
    unlimited: aiTierIsUnlimited(tier),
    configured: resolveAiCredential() !== null,
  })
})

// ─── Public Market Pulse (Day 13 Task D) ─────────────────────────────────────
//
// PUBLIC: no auth, no tier gate — this is the SEO surface, and a login wall would
// defeat its purpose. The `/sqftlab/*` middleware still rate-limits it, which is the
// only protection a public endpoint needs here.
//
// Cached for a day in-process rather than in Redis (there is no Redis in this project;
// see the note on the tier cache). The cache is process-local, so each instance keeps
// its own copy and a restart refills it — acceptable for data that changes daily.
const MARKET_PULSE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * The brief computes a `quarterly` aggregate and never reads it, so it is not here.
 * Its `area`/`amount`/`pricePsf` columns do not exist either: transactions key off
 * `communityId`, and the money columns are `priceAed` / `pricePerSqft`.
 */
async function buildMarketPulse() {
  const since = new Date()
  since.setDate(since.getDate() - MARKET_CONTEXT_DAYS)

  const saleWindow = {
    transactionType: { in: [...SALE_TXN_TYPES] },
    transactionDate: { gte: since },
  }

  const [month, grouped, premium] = await Promise.all([
    prisma.transaction.aggregate({
      where: { ...saleWindow, pricePerSqft: { gt: 100 } },
      _avg: { pricePerSqft: true },
      _count: { id: true },
      _sum: { priceAed: true },
    }),
    prisma.transaction.groupBy({
      by: ['communityId'],
      where: saleWindow,
      _avg: { pricePerSqft: true },
      _count: { id: true },
      _sum: { priceAed: true },
      orderBy: { _count: { id: 'desc' } },
      take: 10,
    }),
    prisma.transaction.findMany({
      where: { ...saleWindow, pricePerSqft: { gt: 100 } },
      orderBy: { pricePerSqft: 'desc' },
      take: 5,
      select: {
        buildingName: true, pricePerSqft: true, priceAed: true, transactionDate: true,
        community: { select: { nameEn: true } },
      },
    }),
  ])

  const names = await prisma.community.findMany({
    where: { id: { in: grouped.map((g) => g.communityId) } },
    select: { id: true, nameEn: true },
  })
  const nameById = new Map(names.map((n) => [n.id, n.nameEn]))
  const round = (v: number | null): number => (v === null ? 0 : Math.round(v))

  const totalTransactions = month._count.id

  return {
    generatedAt: new Date().toISOString(),
    period: `${MARKET_CONTEXT_DAYS} days`,
    periodDays: MARKET_CONTEXT_DAYS,
    source: 'sqftLab transaction register',
    // The page must not present an empty register as a market where nothing sold.
    // Zeros here mean "no data loaded", which is a different statement from "no sales".
    dataAvailable: totalTransactions > 0,
    note:
      totalTransactions > 0
        ? null
        : `No sales are loaded for the last ${MARKET_CONTEXT_DAYS} days. Figures below are zero because the register is empty, not because the market was inactive.`,
    market: {
      totalTransactions,
      avgPsfAed: round(month._avg.pricePerSqft),
      totalVolumeAed: month._sum.priceAed ?? 0,
    },
    topAreas: grouped.map((g) => ({
      area: nameById.get(g.communityId) ?? g.communityId,
      count: g._count.id,
      avgPsfAed: round(g._avg.pricePerSqft),
      volumeAed: g._sum.priceAed ?? 0,
    })),
    premiumDeals: premium.map((t) => ({
      area: t.community?.nameEn ?? '',
      building: t.buildingName ?? '',
      psfAed: round(t.pricePerSqft),
      totalAed: t.priceAed,
      date: t.transactionDate.toISOString().slice(0, 10),
    })),
  }
}

let marketPulseCache: { body: Awaited<ReturnType<typeof buildMarketPulse>>; expiresAt: number } | null = null

app.get('/sqftlab/public/market-pulse', async (c) => {
  if (marketPulseCache !== null && marketPulseCache.expiresAt > Date.now()) {
    c.header('X-Market-Pulse-Cache', 'hit')
    return c.json(marketPulseCache.body)
  }

  const body = await buildMarketPulse()
  marketPulseCache = { body, expiresAt: Date.now() + MARKET_PULSE_TTL_MS }
  c.header('X-Market-Pulse-Cache', 'miss')
  c.header('Cache-Control', 'public, max-age=3600')
  return c.json(body)
})

// ─── Day 14 — WhatsApp digest ────────────────────────────────────────────────
//
// The subscription lives on `User` (whatsapp_enabled / whatsapp_phone /
// whatsapp_areas / digest_frequency), which already existed with richer meaning than
// the brief's proposed `WhatsAppSubscription` model: it carries `digestFrequency: none`
// and per-user areas, and the onboarding flow already writes it. Adding the brief's
// table would have created two competing opt-ins for one concept — and its
// `communities String[]` column cannot exist here anyway, because the datasource is
// SQLite, which has no array or Json type (the schema already notes this and stores the
// array as JSON text).

const WHATSAPP_COMMUNITY_LIMIT = 10

function parseAreasJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function whatsappSubscriptionPayload(user: {
  whatsappEnabled: boolean
  whatsappPhone: string | null
  whatsappAreas: string
  digestFrequency: string
  whatsappLastSentAt: Date | null
} | null) {
  return {
    subscription: user
      ? {
          active: user.whatsappEnabled,
          phone: user.whatsappPhone,
          communities: parseAreasJson(user.whatsappAreas),
          frequency: user.digestFrequency,
          lastSentAt: user.whatsappLastSentAt,
        }
      : null,
    // Whether the digest can actually be delivered. A subscription that silently cannot
    // send is worse than no subscription: the user believes they are covered.
    delivery: isWhatsappConfigured() ? 'configured' : 'unconfigured',
  }
}

app.get('/sqftlab/whatsapp/subscribe', async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      whatsappEnabled: true,
      whatsappPhone: true,
      whatsappAreas: true,
      digestFrequency: true,
      whatsappLastSentAt: true,
    },
  })
  return c.json(whatsappSubscriptionPayload(user))
})

app.post('/sqftlab/whatsapp/subscribe', async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  // Identity before tier: a 403 to an anonymous caller implies a login alone unlocks an
  // Enterprise feature. (The brief gates first, which makes the two indistinguishable.)
  const blocked = requireTier(c, 'enterprise', 'WhatsApp Digest')
  if (blocked) return blocked

  const body = await readJsonBody(c)
  const phone = normaliseE164(body.phone)
  if (!phone) {
    return c.json({ error: 'Invalid phone number. Use E.164 format: +971501234567' }, 400)
  }

  const rawAreas = Array.isArray(body.communities) ? body.communities : []
  const communities = rawAreas.filter((a): a is string => typeof a === 'string' && a.trim() !== '').map((a) => a.trim())
  if (communities.length === 0) {
    return c.json({ error: 'Select at least one community to track.' }, 400)
  }
  if (communities.length > WHATSAPP_COMMUNITY_LIMIT) {
    return c.json(
      { error: `Track at most ${WHATSAPP_COMMUNITY_LIMIT} communities per digest.`, limit: WHATSAPP_COMMUNITY_LIMIT },
      400,
    )
  }

  const frequency = body.frequency === 'weekly' ? 'weekly' : 'daily'

  await prisma.user.update({
    where: { id: userId },
    data: {
      whatsappEnabled: true,
      whatsappPhone: phone,
      whatsappAreas: JSON.stringify(communities),
      digestFrequency: frequency,
    },
  })

  // The confirmation is sent, but a failure is REPORTED rather than swallowed: the brief
  // `.catch(() => {})`s it, so a subscriber whose number is wrong — or a deployment with
  // no Twilio credentials — is told "subscribed" with no way to learn nothing was sent.
  const confirmation = await sendWhatsapp(phone, buildConfirmation(communities, frequency))

  await trackEvent(c, 'whatsapp_subscribe', { communities, frequency, delivered: confirmation.ok })

  return c.json(
    {
      subscribed: true,
      phone,
      communities,
      frequency,
      confirmationSent: confirmation.ok,
      ...(confirmation.reason === 'unconfigured'
        ? { delivery: 'unconfigured', note: 'Saved. WhatsApp delivery is not connected on this deployment, so no message has been sent yet.' }
        : {}),
      ...(confirmation.error ? { deliveryError: confirmation.error } : {}),
    },
    201,
  )
})

app.delete('/sqftlab/whatsapp/subscribe', async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  // Soft opt-out: the phone number is kept so a STOP can still be attributed, and so the
  // digest step can prove this address was deliberately excluded rather than lost.
  await prisma.user.update({
    where: { id: userId },
    data: { whatsappEnabled: false, digestFrequency: 'none' },
  })
  await trackEvent(c, 'whatsapp_unsubscribe', {})

  return c.json({ unsubscribed: true })
})

// Twilio posts form-encoded STOP/UNSUBSCRIBE replies here. This route is deliberately
// PUBLIC: Twilio cannot present a session, so an authenticated webhook would never fire
// and a STOP would be silently ignored — the one message a carrier expects to be honoured.
app.post('/sqftlab/whatsapp/webhook', async (c) => {
  let body: Record<string, unknown>
  try {
    body = (await c.req.parseBody()) as Record<string, unknown>
  } catch {
    return c.text('', 200)
  }

  const from = typeof body['From'] === 'string' ? body['From'].replace(/^whatsapp:/i, '') : ''
  const incoming = body['Body']

  if (from && isStopKeyword(incoming)) {
    const phone = normaliseE164(from)
    if (phone) {
      await prisma.user.updateMany({
        where: { whatsappPhone: phone },
        data: { whatsappEnabled: false, digestFrequency: 'none' },
      })
    }
  }

  // Empty 200: Twilio retries anything it reads as a failure, and a retry storm on a STOP
  // is worse than a lost acknowledgement.
  return c.text('', 200)
})

// ─── Day 14 — Mortgage estimate (pre-fills the calculator from the DLD register) ──

app.get('/sqftlab/mortgage/estimate', async (c) => {
  const communityQuery = (c.req.query('community') ?? '').trim()
  if (communityQuery === '') return c.json({ error: 'community required' }, 400)

  const bedroomsRaw = c.req.query('bedrooms')
  const sizeRaw = c.req.query('sizeSqft')
  const bedrooms = bedroomsRaw ? Number.parseInt(bedroomsRaw, 10) : null
  const sizeSqft = sizeRaw ? Number.parseFloat(sizeRaw) : null

  const bad: string[] = []
  if (bedroomsRaw && (!Number.isFinite(bedrooms) || (bedrooms as number) < 0 || (bedrooms as number) > 20))
    bad.push('bedrooms')
  if (sizeRaw && (!Number.isFinite(sizeSqft) || (sizeSqft as number) <= 0)) bad.push('sizeSqft')
  if (bad.length) return badInput(c, bad, { bedrooms: 'integer 0-20', sizeSqft: 'positive number' })

  // Resolved through the shared matcher: Transaction keys off communityId, and the brief's
  // `area: { contains: …, mode: 'insensitive' }` would not run on this datasource.
  const community = await findCommunityByName(communityQuery)
  if (!community) {
    return c.json({ error: `Unknown community: ${communityQuery}`, community: communityQuery }, 404)
  }

  const since90 = new Date()
  since90.setDate(since90.getDate() - 90)

  const where = {
    communityId: community.id,
    transactionType: { in: SALE_TXN_TYPES },
    pricePerSqft: { gt: 100 },
    transactionDate: { gte: since90 },
    ...(bedrooms !== null && bedrooms >= 0 ? { beds: bedrooms } : {}),
  }

  const stats = await prisma.transaction.aggregate({
    where,
    _avg: { pricePerSqft: true },
    _count: { _all: true },
  })

  const count = stats._count._all
  const avgPsf = stats._avg.pricePerSqft

  // Zero comparables is reported as "no figure", not as AED 0/sqft — a mortgage sized on
  // a synthetic zero would look like a valid calculator result.
  if (count === 0 || avgPsf === null) {
    return c.json({
      community: community.slug,
      communityName: community.nameEn,
      bedrooms,
      sizeSqft,
      avgPsfAed: null,
      estimatedPriceAed: null,
      basedOnTx: 0,
      period: '90 days',
      source: dldConfigured() ? 'DLD register (no matching sales)' : 'DLD register not connected',
      note: dldConfigured()
        ? 'No registered sales match this community and bedroom count in the last 90 days.'
        : 'The DLD transaction feed is not connected on this deployment, so there is no market price to pre-fill.',
    })
  }

  const estimated = sizeSqft && sizeSqft > 0 ? avgPsf * sizeSqft : null

  return c.json({
    community: community.slug,
    communityName: community.nameEn,
    bedrooms,
    sizeSqft,
    avgPsfAed: Math.round(avgPsf),
    estimatedPriceAed: estimated === null ? null : Math.round(estimated),
    basedOnTx: count,
    period: '90 days',
    source: dldConfigured() ? 'DLD register' : 'DLD register not connected',
    note: null,
  })
})

// ─── Day 15 Task A — product-tour progress ───────────────────────────────────
//
// The brief's route shapes are kept (`/sqftlab/onboarding/step`,
// `/sqftlab/onboarding/complete`) because the Day 15 checklist tests them, but the
// storage is the tour's own `tourStep` / `tourCompleted` — NOT `onboardingCompleted`,
// which the sign-up wizard already owns (see the schema comment). Writing the wizard's
// flag here would mark a user as having finished sign-up the moment they dismissed a
// tooltip.
//
// Corrected from the brief:
//  · `{ onboardingStep: { set: n } }` is a MongoDB update operator. Prisma takes a
//    plain value, so that payload is a validation error rather than the no-op it looks
//    like — the route would have 500'd on every call.
//  · `step` is validated as an integer inside the step range. The brief forwarded
//    `Math.max(body.step, 0)` untouched, so a missing/string field became NaN and a
//    caller could park the marker at 999.
//  · Progress is MONOTONIC. Storing the reported value verbatim let a late or replayed
//    request move the user backwards and re-tick finished steps.
//  · Reaching the last step completes the tour server-side, so the guarantee does not
//    depend on the client remembering to send a second request.
//
// `getUserId` only — no `seededUserId()` fallback. Identity comes from the same bearer
// token `/me` issued, so an unauthenticated caller genuinely has no tour to record.

// 0 = signed in, 1 = browse a community, 2 = run a CMA, 3 = save an alert,
// 4 = add a portfolio property. Kept in one place because the client renders a badge
// and a link per step and must not disagree with the server about how many exist.
const TOUR_LAST_STEP = 4
/** Every step ticked — used to complete the tour without a second client request. */
const TOUR_ALL_STEPS = (1 << (TOUR_LAST_STEP + 1)) - 1

/** Bitmask → the step numbers that are done, ascending. */
function stepsFromMask(mask: number): number[] {
  const out: number[] = []
  for (let i = 0; i <= TOUR_LAST_STEP; i++) if (mask & (1 << i)) out.push(i)
  return out
}

app.get('/sqftlab/onboarding', async (c) => {
  const userId = getUserId(c)
  if (!userId) return upgradeRequired(c)

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { tourSteps: true, tourCompleted: true },
  })
  if (!user) return upgradeRequired(c)

  return c.json({
    steps: stepsFromMask(user.tourSteps),
    completed: user.tourCompleted,
    lastStep: TOUR_LAST_STEP,
  })
})

app.post('/sqftlab/onboarding/step', async (c) => {
  const userId = getUserId(c)
  if (!userId) return upgradeRequired(c)

  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Request body must be JSON.' }, 400)
  }

  const raw = body.step
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > TOUR_LAST_STEP) {
    return c.json({ error: `step must be an integer between 0 and ${TOUR_LAST_STEP}` }, 400)
  }

  const current = await prisma.user.findUnique({
    where: { id: userId },
    select: { tourSteps: true, tourCompleted: true },
  })
  if (!current) return upgradeRequired(c)

  // OR the bit in, never assign: steps are independent, so a replayed or out-of-order
  // call cannot un-tick one, and marking a later step does not claim the earlier ones.
  const mask = current.tourSteps | (1 << raw)
  const completed = current.tourCompleted || mask === TOUR_ALL_STEPS

  const user = await prisma.user.update({
    where: { id: userId },
    data: { tourSteps: mask, ...(completed ? { tourCompleted: true } : {}) },
    select: { tourSteps: true, tourCompleted: true },
  })

  await trackEvent(c, 'onboarding_step', { step: raw, completed: user.tourCompleted })
  return c.json({
    steps: stepsFromMask(user.tourSteps),
    completed: user.tourCompleted,
    lastStep: TOUR_LAST_STEP,
  })
})

app.post('/sqftlab/onboarding/complete', async (c) => {
  const userId = getUserId(c)
  if (!userId) return upgradeRequired(c)

  // Doubles as "dismiss": the only exit from the banner, so one flag governs both.
  const user = await prisma.user.update({
    where: { id: userId },
    data: { tourCompleted: true },
    select: { tourSteps: true, tourCompleted: true },
  })

  await trackEvent(c, 'onboarding_complete', { steps: stepsFromMask(user.tourSteps) })
  return c.json({
    steps: stepsFromMask(user.tourSteps),
    completed: user.tourCompleted,
    complete: true,
    lastStep: TOUR_LAST_STEP,
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Day 16 — Deal Origination Network
//
// A private, enterprise-only layer where members post investment opportunities
// ("deal briefs") and other members express interest.
//
// NAMING. The brief specifies `/sqftlab/deals`. That path is taken: `GET
// /sqftlab/deals` is the Day 8 market scan (listings 8%+ below their area's DLD
// median) and has four consumers — the SPA's Deals page, verify-day1,
// verify-fixes and the offline snapshot. Two different resources answering on
// one path (a listing feed on `GET /deals`, a deal brief on `GET /deals/:id`)
// is a footgun, so the network is namespaced under `/sqftlab/deal-briefs` —
// also the model's own name. The SPA still serves it at `/deals`, as asked.
//
// PRIVACY. server.tsx mounts the auto-generated CRUD at /api *before* this
// file, which would expose every brief with no gate at all. In this deployment
// that layer is dead: `createAllRoutes()` throws on a stale generated import
// (`getVerificationTokenList` is missing from server-functions.ts) and
// server.tsx's bare `catch {}` swallows it, so /api/deal-briefs answers 404
// like every other generated route. Verified by request, not assumed. If that
// layer is ever repaired these two models must be gated there as well.
// ═══════════════════════════════════════════════════════════════════════════

const DEAL_TYPES = ['acquisition', 'off-plan', 'portfolio-sale', 'distressed'] as const
const DEAL_STATUSES = ['active', 'under-offer', 'closed'] as const
const DEAL_NETWORK_TIER = 'enterprise' as const
const DEAL_TITLE_MAX = 200
const DEAL_DESC_MAX = 5_000
const DEAL_MESSAGE_MAX = 2_000
const DEAL_TXN_WINDOW_DAYS = 90
const DEAL_COMP_WINDOW_DAYS = 180
const DEAL_PAGE_SIZE = 50

/** Enterprise gate shared by every route in the network. Answers 403. */
function dealNetworkBlocked(c: Context) {
  return requireTier(c, DEAL_NETWORK_TIER, 'Deal Origination Network')
}

async function readDealJson(c: Context): Promise<{ body?: unknown; error?: string }> {
  try {
    return { body: await c.req.json() }
  } catch {
    return { error: 'Body must be valid JSON' }
  }
}

/** Optional numeric field: absent/empty becomes null, anything else must be in range. */
function optNumber(
  v: unknown,
  min: number,
  max: number,
  label: string,
): { value?: number | null; error?: string } {
  if (v === undefined || v === null || v === '') return { value: null }
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return { error: `${label} must be a number` }
  if (n < min || n > max) return { error: `${label} must be between ${min} and ${max}` }
  return { value: n }
}

interface DealInput {
  title: string
  community: string
  description: string
  dealType: string
  bedrooms: number | null
  sizeSqftMin: number | null
  sizeSqftMax: number | null
  askingPriceAed: number | null
  targetYieldPct: number | null
  isConfidential: boolean
}

/**
 * Validate and whitelist a create payload.
 *
 * The brief spreads the raw body into `prisma.dealBrief.create`, which lets a
 * caller set `userId` (post as somebody else), `status` (a deal born "closed")
 * and every `dld*` field (fabricating the market context the network's whole
 * premise rests on). Same mass-assignment shape as the Day 17 white-label
 * route, so the fields are enumerated rather than forwarded.
 */
function parseDealInput(raw: unknown): { data?: DealInput; error?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'Body must be a JSON object' }
  }
  const b = raw as Record<string, unknown>

  const title = typeof b.title === 'string' ? b.title.trim() : ''
  if (title.length < 3 || title.length > DEAL_TITLE_MAX) {
    return { error: `title must be 3-${DEAL_TITLE_MAX} characters` }
  }

  const community = typeof b.community === 'string' ? b.community.trim() : ''
  if (community.length < 2 || community.length > 120) {
    return { error: 'community must be 2-120 characters' }
  }

  const description = typeof b.description === 'string' ? b.description.trim() : ''
  if (description.length < 10 || description.length > DEAL_DESC_MAX) {
    return { error: `description must be 10-${DEAL_DESC_MAX} characters` }
  }

  const dealType = typeof b.dealType === 'string' ? b.dealType.trim() : ''
  if (!(DEAL_TYPES as readonly string[]).includes(dealType)) {
    return { error: `dealType must be one of: ${DEAL_TYPES.join(', ')}` }
  }

  const bedrooms = optNumber(b.bedrooms, 0, 50, 'bedrooms')
  if (bedrooms.error) return { error: bedrooms.error }
  if (bedrooms.value != null && !Number.isInteger(bedrooms.value)) {
    return { error: 'bedrooms must be a whole number' }
  }

  const sizeMin = optNumber(b.sizeSqftMin, 1, 1_000_000, 'sizeSqftMin')
  if (sizeMin.error) return { error: sizeMin.error }
  const sizeMax = optNumber(b.sizeSqftMax, 1, 1_000_000, 'sizeSqftMax')
  if (sizeMax.error) return { error: sizeMax.error }
  if (sizeMin.value != null && sizeMax.value != null && sizeMin.value > sizeMax.value) {
    return { error: 'sizeSqftMin cannot exceed sizeSqftMax' }
  }

  const price = optNumber(b.askingPriceAed, 1, 1e12, 'askingPriceAed')
  if (price.error) return { error: price.error }
  const yieldPct = optNumber(b.targetYieldPct, 0, 100, 'targetYieldPct')
  if (yieldPct.error) return { error: yieldPct.error }

  if (b.isConfidential !== undefined && typeof b.isConfidential !== 'boolean') {
    return { error: 'isConfidential must be a boolean' }
  }

  return {
    data: {
      title,
      community,
      description,
      dealType,
      bedrooms: bedrooms.value ?? null,
      sizeSqftMin: sizeMin.value ?? null,
      sizeSqftMax: sizeMax.value ?? null,
      askingPriceAed: price.value ?? null,
      targetYieldPct: yieldPct.value ?? null,
      isConfidential: (b.isConfidential as boolean | undefined) ?? true,
    },
  }
}

/**
 * DLD market context for a community name.
 *
 * The brief queries `area: { contains, mode: 'insensitive' }` and
 * `transactionType: 'Sales'`. None of that exists here: Transaction has no
 * `area` column (it keys on `communityId`), the stored sale types are `sale`
 * and `off_plan_sale`, and SQLite rejects `mode` outright. Both traps are
 * already documented in src/lib/deals.ts and src/lib/community-match.ts.
 *
 * Returns nulls rather than a fallback number. This deployment has zero
 * transaction rows, so a market level can only come from somewhere else, and a
 * fabricated one is worse than an absent one — the UI states the absence.
 */
async function dealDldContext(communityName: string) {
  const community = await findCommunityByName(communityName)
  if (!community) {
    return { communityId: null, communityName: null, avgPsf: null, transCount: 0, windowDays: DEAL_TXN_WINDOW_DAYS, matched: false }
  }

  const since = new Date()
  since.setDate(since.getDate() - DEAL_TXN_WINDOW_DAYS)

  const agg = await prisma.transaction.aggregate({
    where: {
      communityId: community.id,
      transactionType: { in: [...SALE_TXN_TYPES] },
      pricePerSqft: { gt: 100 },
      transactionDate: { gte: since },
    },
    _avg: { pricePerSqft: true },
    _count: { _all: true },
  })

  const avg = agg._avg.pricePerSqft
  return {
    communityId: community.id,
    communityName: community.nameEn,
    avgPsf: avg != null ? Math.round(avg) : null,
    transCount: agg._count._all,
    windowDays: DEAL_TXN_WINDOW_DAYS,
    matched: true,
  }
}

/**
 * The area's asking-price level, with its provenance, for the deal cards.
 *
 * Kept separate from the DLD figure above on purpose. `medianAedSqft` carries a
 * `psfSource` of "dld" or "listing", and while the DLD register is empty that
 * listing-derived median is the only real market level available — presenting
 * it as a DLD number would be a lie, but hiding it leaves the cards blank.
 */
async function dealMarketContext(communityName: string) {
  const community = await findCommunityByName(communityName)
  if (!community) return { communityName: null, medianAedSqft: null, source: null, matched: false }
  return {
    communityName: community.nameEn,
    medianAedSqft: community.medianAedSqft > 0 ? community.medianAedSqft : null,
    source: community.psfSource,
    matched: true,
  }
}

/** Escape interpolated values before they go into email HTML. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Tell the poster somebody is interested.
 *
 * The brief imports `resend`, which is not a dependency of this project — the
 * dynamic import would fail at runtime and the `await` would reject inside the
 * request. The app already has a mail path (see sendMagicLinkEmail above), so
 * this mirrors it and reports 'unconfigured' when no transport exists rather
 * than pretending the message went out.
 */
async function sendDealInterestEmail(opts: {
  to: string
  posterName: string | null
  dealTitle: string
  dealId: string
  community: string
  interestedName: string | null
  interestedCompany: string | null
  message: string | null
  contactOk: boolean
}): Promise<'sent' | 'unconfigured'> {
  const { createEmailOptional } = await import('@shogo-ai/sdk/email/server')
  const email = createEmailOptional()
  if (!email) return 'unconfigured'

  const who = escapeHtml(opts.interestedName ?? 'A member')
  const company = opts.interestedCompany ? ` (${escapeHtml(opts.interestedCompany)})` : ''
  const title = escapeHtml(opts.dealTitle)
  const community = escapeHtml(opts.community)
  const posterName = escapeHtml(opts.posterName ?? 'there')
  const link = `${process.env.APP_URL ?? 'https://sqftlab.com'}/deals/${encodeURIComponent(opts.dealId)}`

  await email.send({
    to: opts.to,
    subject: `sqftLab: New expression of interest in "${opts.dealTitle}"`,
    html:
      `<p>Hi ${posterName},</p>` +
      `<p><strong>${who}</strong>${company} has expressed interest in your deal:</p>` +
      `<p><strong>${title}</strong> — ${community}</p>` +
      (opts.message
        ? `<blockquote style="border-left:3px solid #2563EB;padding-left:12px;color:#475569">${escapeHtml(opts.message)}</blockquote>`
        : '') +
      (opts.contactOk ? '<p>They consent to being contacted directly.</p>' : '') +
      `<p><a href="${link}" style="background:#2563EB;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">View Deal</a></p>`,
  })
  return 'sent'
}

// ─── List ────────────────────────────────────────────────────────────────────

app.get('/sqftlab/deal-briefs', async (c) => {
  const blocked = dealNetworkBlocked(c)
  if (blocked) return blocked

  const status = c.req.query('status') ?? 'active'
  const dealType = c.req.query('dealType')
  const community = c.req.query('community')?.trim()

  if (!(DEAL_STATUSES as readonly string[]).includes(status)) {
    return c.json({ error: `status must be one of: ${DEAL_STATUSES.join(', ')}` }, 400)
  }
  if (dealType && !(DEAL_TYPES as readonly string[]).includes(dealType)) {
    return c.json({ error: `dealType must be one of: ${DEAL_TYPES.join(', ')}` }, 400)
  }

  // `contains` compiles to LIKE on SQLite, which is ASCII case-insensitive by
  // default — so "marina" matches "Dubai Marina" without `mode: 'insensitive'`,
  // which SQLite rejects.
  const deals = await prisma.dealBrief.findMany({
    where: {
      status,
      ...(dealType ? { dealType } : {}),
      ...(community ? { community: { contains: community } } : {}),
    },
    include: {
      // Never select email: the poster's address is not part of the network's
      // public face, and a `select` that omits it cannot leak it later.
      user: { select: { name: true, company: true } },
      _count: { select: { expressions: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: DEAL_PAGE_SIZE,
  })

  const enriched = await Promise.all(
    deals.map(async (d) => ({ ...d, marketContext: await dealMarketContext(d.community) })),
  )

  return c.json({
    deals: enriched,
    filters: { status, dealType: dealType ?? null, community: community ?? null },
    dealTypes: [...DEAL_TYPES],
    ...(enriched.length === 0
      ? {
          message:
            'No deal briefs match. The network is private, so an empty result is normal until members post.',
        }
      : {}),
  })
})

// ─── Own deals ──────────────────────────────────────────────────────────────
//
// Registered before `/:id` deliberately: Hono matches in registration order, so
// a `/:id` route declared first would swallow `/mine` and look up a deal whose
// id is the literal string "mine".

app.get('/sqftlab/deal-briefs/mine', async (c) => {
  const blocked = dealNetworkBlocked(c)
  if (blocked) return blocked

  const userId = getUserId(c)
  if (!userId) return upgradeRequired(c)

  const deals = await prisma.dealBrief.findMany({
    where: { userId },
    include: { _count: { select: { expressions: true } } },
    orderBy: { createdAt: 'desc' },
  })

  return c.json({ deals })
})

// ─── Create ─────────────────────────────────────────────────────────────────

app.post('/sqftlab/deal-briefs', async (c) => {
  const blocked = dealNetworkBlocked(c)
  if (blocked) return blocked

  const userId = getUserId(c)
  if (!userId) return upgradeRequired(c)

  const { body, error: bodyError } = await readDealJson(c)
  if (bodyError) return c.json({ error: bodyError }, 400)

  const parsed = parseDealInput(body)
  if (!parsed.data) return c.json({ error: parsed.error }, 400)

  const dld = await dealDldContext(parsed.data.community)

  const deal = await prisma.dealBrief.create({
    data: {
      userId,
      ...parsed.data,
      dldAvgPsfAed: dld.avgPsf,
      dldTransCount: dld.transCount,
      dldLastUpdated: new Date(),
    },
    include: { _count: { select: { expressions: true } } },
  })

  await trackEvent(c, 'deal_posted', { community: parsed.data.community, dealType: parsed.data.dealType })

  return c.json(
    {
      ...deal,
      marketContext: await dealMarketContext(parsed.data.community),
      // Whether the poster's area resolved, so an unmatched community reads as
      // "we could not find this area" rather than "there is no market data".
      communityMatched: dld.matched,
    },
    201,
  )
})

// ─── Detail ─────────────────────────────────────────────────────────────────

app.get('/sqftlab/deal-briefs/:id', async (c) => {
  const blocked = dealNetworkBlocked(c)
  if (blocked) return blocked

  const userId = getUserId(c)

  const deal = await prisma.dealBrief.findUnique({
    where: { id: c.req.param('id') },
    include: { user: { select: { name: true, company: true } } },
  })
  if (!deal) return c.json({ error: 'Deal not found' }, 404)

  const isOwner = userId != null && deal.userId === userId

  // Messages and consent flags are for the poster only. The brief's route
  // returns `expressions` filtered to the caller, which never exposes the
  // poster's inbox — that stays true here, and the owner's view is the one
  // place the list appears.
  const [expressions, myExpression, marketContext] = await Promise.all([
    isOwner
      ? prisma.dealExpression.findMany({
          where: { dealId: deal.id },
          include: { user: { select: { name: true, company: true } } },
          orderBy: { createdAt: 'desc' },
        })
      : Promise.resolve([]),
    !isOwner && userId
      ? prisma.dealExpression.findUnique({
          where: { dealId_userId: { dealId: deal.id, userId } },
          select: { id: true, createdAt: true },
        })
      : Promise.resolve(null),
    dealMarketContext(deal.community),
  ])

  // Recent sale comparables for the deal's area, from the register.
  const community = await findCommunityByName(deal.community)
  let comps: unknown[] = []
  if (community) {
    const since = new Date()
    since.setDate(since.getDate() - DEAL_COMP_WINDOW_DAYS)
    comps = await prisma.transaction.findMany({
      where: {
        communityId: community.id,
        transactionType: { in: [...SALE_TXN_TYPES] },
        pricePerSqft: { gt: 100 },
        transactionDate: { gte: since },
        ...(deal.bedrooms != null ? { beds: deal.bedrooms } : {}),
      },
      select: {
        transactionDate: true,
        pricePerSqft: true,
        priceAed: true,
        areaSqft: true,
        beds: true,
        buildingName: true,
      },
      orderBy: { transactionDate: 'desc' },
      take: 10,
    })
  }

  const { userId: _ownerId, ...safeDeal } = deal

  return c.json({
    deal: { ...safeDeal, isOwner },
    comps,
    compWindowDays: DEAL_COMP_WINDOW_DAYS,
    marketContext,
    expressions: isOwner ? expressions : undefined,
    expressionCount: isOwner ? expressions.length : undefined,
    myExpression,
    // Explains an empty comparables table instead of leaving it looking broken.
    compsNote: !community
      ? `No area in the database matches "${deal.community}", so no comparables could be looked up.`
      : comps.length === 0
        ? `No registered sale transactions in ${community.nameEn} in the last ${DEAL_COMP_WINDOW_DAYS} days.`
        : null,
  })
})

// ─── Update (owner only) ────────────────────────────────────────────────────

app.patch('/sqftlab/deal-briefs/:id', async (c) => {
  const userId = getUserId(c)
  if (!userId) return upgradeRequired(c)

  const existing = await prisma.dealBrief.findFirst({
    where: { id: c.req.param('id'), userId },
    select: { id: true, status: true },
  })
  if (!existing) return c.json({ error: 'Deal not found or not yours' }, 404)

  const { body, error: bodyError } = await readDealJson(c)
  if (bodyError) return c.json({ error: bodyError }, 400)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: 'Body must be a JSON object' }, 400)
  }
  const b = body as Record<string, unknown>

  // Only these three are updatable. The brief forwards the whole body, which
  // would also let the owner rewrite `userId`, `dldAvgPsfAed` and `createdAt`.
  const data: { status?: string; title?: string; description?: string } = {}

  if (b.status !== undefined) {
    if (typeof b.status !== 'string' || !(DEAL_STATUSES as readonly string[]).includes(b.status)) {
      return c.json({ error: `status must be one of: ${DEAL_STATUSES.join(', ')}` }, 400)
    }
    data.status = b.status
  }
  if (b.title !== undefined) {
    const title = typeof b.title === 'string' ? b.title.trim() : ''
    if (title.length < 3 || title.length > DEAL_TITLE_MAX) {
      return c.json({ error: `title must be 3-${DEAL_TITLE_MAX} characters` }, 400)
    }
    data.title = title
  }
  if (b.description !== undefined) {
    const description = typeof b.description === 'string' ? b.description.trim() : ''
    if (description.length < 10 || description.length > DEAL_DESC_MAX) {
      return c.json({ error: `description must be 10-${DEAL_DESC_MAX} characters` }, 400)
    }
    data.description = description
  }

  if (Object.keys(data).length === 0) {
    return c.json(
      { error: `Nothing to update. Updatable fields: status, title, description.` },
      400,
    )
  }

  const updated = await prisma.dealBrief.update({
    where: { id: existing.id },
    data,
    include: { _count: { select: { expressions: true } } },
  })

  if (data.status && data.status !== existing.status) {
    await trackEvent(c, 'deal_status_changed', { dealId: existing.id, from: existing.status, to: data.status })
  }

  return c.json(updated)
})

// ─── Express interest ───────────────────────────────────────────────────────

app.post('/sqftlab/deal-briefs/:id/express', async (c) => {
  const blocked = dealNetworkBlocked(c)
  if (blocked) return blocked

  const userId = getUserId(c)
  if (!userId) return upgradeRequired(c)

  const deal = await prisma.dealBrief.findUnique({
    where: { id: c.req.param('id') },
    select: { id: true, userId: true, title: true, community: true, status: true },
  })
  if (!deal) return c.json({ error: 'Deal not found' }, 404)
  if (deal.userId === userId) {
    return c.json({ error: 'Cannot express interest in your own deal' }, 400)
  }
  // A closed deal cannot be introduced to anybody, so accepting interest would
  // create a record nobody acts on.
  if (deal.status === 'closed') {
    return c.json({ error: 'This deal is closed and is no longer accepting interest' }, 409)
  }

  const { body, error: bodyError } = await readDealJson(c)
  if (bodyError) return c.json({ error: bodyError }, 400)
  if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body))) {
    return c.json({ error: 'Body must be a JSON object' }, 400)
  }
  const b = (body ?? {}) as Record<string, unknown>

  let message: string | null = null
  if (b.message !== undefined && b.message !== null && b.message !== '') {
    if (typeof b.message !== 'string') return c.json({ error: 'message must be a string' }, 400)
    message = b.message.trim()
    if (message.length > DEAL_MESSAGE_MAX) {
      return c.json({ error: `message must be at most ${DEAL_MESSAGE_MAX} characters` }, 400)
    }
    if (message === '') message = null
  }
  if (b.contactOk !== undefined && typeof b.contactOk !== 'boolean') {
    return c.json({ error: 'contactOk must be a boolean' }, 400)
  }
  const contactOk = (b.contactOk as boolean | undefined) ?? false

  // Upsert on the (dealId, userId) unique key, so expressing twice edits the
  // first expression instead of stacking duplicates.
  const expression = await prisma.dealExpression.upsert({
    where: { dealId_userId: { dealId: deal.id, userId } },
    update: { message, contactOk },
    create: { dealId: deal.id, userId, message, contactOk },
  })

  const [poster, interested] = await Promise.all([
    prisma.user.findUnique({ where: { id: deal.userId }, select: { email: true, name: true } }),
    prisma.user.findUnique({ where: { id: userId }, select: { name: true, company: true } }),
  ])

  let emailStatus: 'sent' | 'unconfigured' | 'failed' = 'unconfigured'
  if (poster?.email) {
    try {
      emailStatus = await sendDealInterestEmail({
        to: poster.email,
        posterName: poster.name,
        dealTitle: deal.title,
        dealId: deal.id,
        community: deal.community,
        interestedName: interested?.name ?? null,
        interestedCompany: interested?.company ?? null,
        message,
        contactOk,
      })
    } catch {
      // A mail failure must not lose the expression of interest, which is the
      // thing the poster can actually act on.
      emailStatus = 'failed'
    }
  }

  await trackEvent(c, 'deal_expression', { dealId: deal.id })
  return c.json({ ...expression, emailStatus }, 201)
})

// Catch-all — must be registered LAST so every real route wins.
//
// The pattern is '*' and not '/api/*': server.tsx mounts this app with
// `app.route('/api', customRoutes)`, so routes here are relative to that mount
// point (see the '/sqftlab/...' declarations above). An '/api/*' pattern would
// therefore never match anything.
//
// This exists because server.tsx also owns a SPA catch-all that resolves any
// unmatched path to index.html. Without this handler an API client asking for a
// mistyped or removed endpoint receives an HTML document with a 200 status,
// parses it as a successful response, and fails somewhere far away from the
// actual mistake. Answering in JSON keeps the failure at the boundary.
app.all('*', (c) =>
  c.json({ error: `No API route matches ${c.req.method} ${c.req.path}` }, 404),
)

export default app

