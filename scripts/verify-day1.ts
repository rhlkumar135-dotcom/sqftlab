/**
 * Day 1 verification — Task A (schema), B (guest mode), C (sign-in), D/E/F (fixes).
 *
 * Run against the live API:  bun run scripts/verify-day1.ts
 * Override the target with API=http://localhost:3001
 *
 * Cleans up after itself: the test user, its sessions, and the guest rows and
 * events it creates are all deleted at the end.
 */
import { marketPsfByCommunity, DEAL_DISCOUNT_THRESHOLD } from '../src/lib/deals'

const API = process.env.API ?? 'http://localhost:3101'
const TEST_EMAIL = `day1-verify-${Date.now()}@example.com`

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    failures.push(name)
    console.log(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 200)}` : ''}`)
  }
}

async function json(path: string, init?: RequestInit) {
  const r = await fetch(`${API}${path}`, init)
  const body = await r.json().catch(() => ({}))
  return { status: r.status, body: body as Record<string, unknown>, headers: r.headers }
}

// A guest is identified only by the sqftlab_guest cookie.
async function newGuest(): Promise<{ cookie: string; guestId: string }> {
  const r = await fetch(`${API}/api/sqftlab/communities`)
  const raw = r.headers.get('set-cookie') ?? ''
  const m = raw.match(/sqftlab_guest=([^;]+)/)
  return { cookie: m ? `sqftlab_guest=${m[1]}` : '', guestId: m?.[1] ?? '' }
}

const { PrismaClient } = await import('../src/generated/prisma/client.js')
const { PrismaLibSql } = await import('@prisma/adapter-libsql')
const prisma = new PrismaClient({
  adapter: new PrismaLibSql({ url: process.env.DATABASE_URL! }),
})

const createdGuestIds: string[] = []
const demoUser = await prisma.user.findFirst({ where: { email: 'demo@sqftlab.com' } })

// Preflight. Without this, an unreachable API surfaces as a raw
// ConnectionRefused stack trace pointing at `newGuest()` — and because the throw
// escapes the try block below, the RESULT line never prints at all. That reads as
// "the suite produced no result" rather than "the suite could not run", which is
// exactly how a red run gets mistaken for a green one.
try {
  const probe = await fetch(`${API}/health`, { signal: AbortSignal.timeout(5000) })
  if (!probe.ok) throw new Error(`HTTP ${probe.status}`)
} catch (e) {
  console.error(`\n✗ Cannot reach the API at ${API} — ${(e as Error).message}`)
  console.error(`  Start the server, or target another: API=http://localhost:3101 bun run scripts/verify-day1.ts\n`)
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
}

try {
  console.log('\n── TASK A: schema completeness ─────────────────────────────')
  const tables = (await prisma.$queryRawUnsafe(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  )) as { name: string }[]
  const names = tables.map((t) => t.name)
  for (const t of ['user_events', 'guest_sessions', 'api_keys', 'accounts', 'sessions', 'verification_tokens', 'waitlist'])
    check(`table ${t} exists`, names.includes(t))

  const userCols = (await prisma.$queryRawUnsafe('PRAGMA table_info(users)')) as { name: string }[]
  const cols = userCols.map((c) => c.name)
  for (const c of ['subscription_status', 'whatsapp_phone', 'guest_id', 'registered_via', 'onboarding_completed', 'last_login_at', 'role', 'company', 'country'])
    check(`users.${c} exists`, cols.includes(c))
  check('users.subscriptionTier mapped to physical column "tier" (no data loss)', cols.includes('tier'))

  const demo = await prisma.user.findFirst({ where: { email: 'demo@sqftlab.com' } })
  check('demo user kept subscriptionTier=elite across the rename', demo?.subscriptionTier === 'elite', demo?.subscriptionTier)

  console.log('\n── TASK A4: append-only history ────────────────────────────')
  const intel = await Bun.file('src/lib/intelligence.ts').text()
  check('no nationalityFlow.deleteMany', !intel.includes('nationalityFlow.deleteMany'))
  check('no institutionalTransaction.deleteMany', !intel.includes('institutionalTransaction.deleteMany'))
  check('districtMetrics uses create() not upsert()', !/districtMetrics\.upsert/.test(intel))
  check('marketSummary does not update in place', !/marketSummary\.update/.test(intel))

  console.log('\n── TASK B: guest mode ──────────────────────────────────────')
  const guest = await newGuest()
  createdGuestIds.push(guest.guestId)
  check('sqftlab_guest cookie is set for a new visitor', guest.cookie.startsWith('sqftlab_guest='))
  check('guestId is 32 hex chars', /^[0-9a-f]{32}$/.test(guest.guestId), guest.guestId)

  // Trigger a tracked event so the GuestSession row is materialised.
  await fetch(`${API}/api/sqftlab/communities`, { headers: { Cookie: guest.cookie } })
  const gs = await prisma.guestSession.findUnique({ where: { id: guest.guestId } })
  check('GuestSession row created', Boolean(gs))

  const gComm = await json('/api/sqftlab/communities', { headers: { Cookie: guest.cookie } })
  const gList = (gComm.body.communities as unknown[]) ?? []
  check('guest sees exactly 6 communities', gList.length === 6, gList.length)
  check('guest response carries limited:true', gComm.body.limited === true)
  check('guest response carries signInUrl', gComm.body.signInUrl === '/auth/signin')

  const aComm = await json('/api/sqftlab/communities', {
    headers: { Authorization: `Bearer ${demoUser?.id}` },
  })
  const totalCommunities = await prisma.community.count()
  const aCommN = (aComm.body.communities as unknown[])?.length
  check(
    'signed-in caller sees every community',
    aCommN === totalCommunities,
    `${aCommN} of ${totalCommunities}`,
  )
  check('signed-in response carries no limited flag', aComm.body.limited === undefined)

  const gSlug = await json('/api/sqftlab/communities/dubai-marina', { headers: { Cookie: guest.cookie } })
  const gCommunity = (gSlug.body.community ?? {}) as Record<string, unknown>
  check('guest community hides scoreSchools', gCommunity.scoreSchools === undefined)
  check('guest community still exposes neighbourhoodScore', gCommunity.neighbourhoodScore !== undefined)

  const gTrend = await json('/api/sqftlab/communities/dubai-marina/trend', { headers: { Cookie: guest.cookie } })
  const gTrendLen = ((gTrend.body.trend as unknown[]) ?? []).length
  check('guest trend limited to 3 months', gTrendLen <= 3, gTrendLen)

  const gListings = await json('/api/sqftlab/listings', { headers: { Cookie: guest.cookie } })
  const gl = (gListings.body.listings as Record<string, unknown>[]) ?? []
  check('guest listings capped at 10', gl.length <= 10, gl.length)
  check('guest listings strip the isDeal badge', gl.every((l) => l.isDeal === undefined))

  console.log('\n── TASK B3: guest blocks ───────────────────────────────────')
  for (const [label, path, init] of [
    ['GET /portfolio', '/api/sqftlab/portfolio', undefined],
    ['POST /alerts', '/api/sqftlab/alerts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }],
    ['GET /api-keys', '/api/sqftlab/api-keys', undefined],
    ['GET /watchlist', '/api/sqftlab/watchlist', undefined],
    ['GET /alerts/matches', '/api/sqftlab/alerts/matches', undefined],
    ['GET /alert-rules', '/api/sqftlab/alert-rules', undefined],
    ['POST /auth/onboard', '/api/sqftlab/auth/onboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }],
  ] as const) {
    const r = await json(path, init ? { ...init, headers: { ...(init.headers ?? {}), Cookie: guest.cookie } } : { headers: { Cookie: guest.cookie } })
    check(`${label} → 401 for a guest`, r.status === 401, r.status)
    // B3 asks for a 401 *with an upgrade message* — a bare status is not enough,
    // the client needs something it can render and a route to send them to.
    check(`${label} → carries message + signInUrl`, r.body?.message && r.body?.signInUrl === '/auth/signin', r.body)
  }

  // The spec lists POST /sqftlab/cma, /sqftlab/report/property and
  // /sqftlab/capital-flow/* as guest-blocked. Those routes do not exist in this
  // app, so there is nothing to gate — asserting their absence keeps the gap
  // visible instead of implying coverage that isn't there.
  const absent = new Set<string>()
  for (const p of ['/api/sqftlab/cma', '/api/sqftlab/report/property', '/api/sqftlab/capital-flow']) {
    const r = await json(p, { headers: { Cookie: guest.cookie } })
    if (r.status === 404) absent.add(p)
  }
  check('B3 paths absent from this app are 404, not silently allowed', absent.size === 3, [...absent])

  // Payments are disabled, so the subscribe family is a 503 kill switch for
  // everyone — it short-circuits before any guest check can run.
  for (const p of ['/api/checkout', '/api/subscribe', '/api/create-payment-intent']) {
    const r = await json(p, { method: 'POST' })
    check(`${p} → 503 (payments disabled)`, r.status === 503, r.status)
  }

  console.log('\n── TASK C: sign-in ─────────────────────────────────────────')
  const ml = await json('/api/sqftlab/auth/magic-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: guest.cookie },
    body: JSON.stringify({ email: TEST_EMAIL }),
  })
  check('magic-link request accepted', ml.status === 200, ml.status)
  check('delivery is honestly reported (no mail transport configured)', ml.body.delivery === 'unconfigured', ml.body.delivery)
  const devLink = String(ml.body.devLink ?? '')
  check('dev link returned while unconfigured', devLink.includes('/api/sqftlab/auth/verify?token='))

  const badEmail = await json('/api/sqftlab/auth/magic-link', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'nope' }),
  })
  check('invalid email → 400', badEmail.status === 400, badEmail.status)

  const verifyRes = await fetch(devLink, { redirect: 'manual', headers: { Cookie: guest.cookie } })
  check('verify redirects into the app', [302, 303, 307].includes(verifyRes.status), verifyRes.status)
  const sessionCookieRaw = verifyRes.headers.get('set-cookie') ?? ''
  const sessionCookie = (sessionCookieRaw.match(/next-auth\.session-token=[^;]+/) ?? [''])[0]
  check('session cookie issued', sessionCookie.startsWith('next-auth.session-token='))

  const reuse = await fetch(devLink, { redirect: 'manual' })
  check('magic-link token is single-use', reuse.status === 400, reuse.status)

  const created = await prisma.user.findUnique({ where: { email: TEST_EMAIL } })
  check('user row created with registeredVia=magic_link', created?.registeredVia === 'magic_link', created?.registeredVia)
  check('guest session linked to the new user', created?.guestId === guest.guestId, created?.guestId)

  const converted = await prisma.guestSession.findUnique({ where: { id: guest.guestId } })
  check('GuestSession marked converted', converted?.convertedUserId === created?.id)

  const attributed = await prisma.userEvent.count({ where: { guestId: guest.guestId, userId: created?.id ?? 'x' } })
  check('guest events re-attributed to the user', attributed > 0, attributed)

  const sess = await json('/api/sqftlab/auth/session', { headers: { Cookie: sessionCookie } })
  check('auth/session reports authenticated', sess.body.authenticated === true, sess.body)

  const onb = await json('/api/sqftlab/auth/onboard', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
    body: JSON.stringify({ role: 'investor', areas: ['dubai-marina'], whatsappEnabled: false }),
  })
  check('onboarding accepted', onb.status === 200, onb.status)
  const onbUser = await prisma.user.findUnique({ where: { email: TEST_EMAIL } })
  check('onboardingCompleted persisted', onbUser?.onboardingCompleted === true)
  check('role persisted', onbUser?.role === 'investor', onbUser?.role)

  const google = await fetch(`${API}/api/sqftlab/auth/google`, { redirect: 'manual' })
  check('google reports unconfigured rather than 500', google.status === 501, google.status)

  const keysAuthed = await json('/api/sqftlab/api-keys', { headers: { Cookie: sessionCookie } })
  check('api-keys lists for a signed-in caller', keysAuthed.status === 200 && Array.isArray(keysAuthed.body.keys), keysAuthed.status)

  const newKey = await json('/api/sqftlab/api-keys', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: sessionCookie }, body: JSON.stringify({ name: 'day1-check' }),
  })
  check('api key issued with sqft_ prefix', String(newKey.body.key ?? '').startsWith('sqft_'))
  const keyRow = await prisma.apiKey.findFirst({ where: { userId: created!.id } })
  check('only the SHA-256 hash is stored (no plaintext)', keyRow !== null && keyRow.keyHash !== newKey.body.key && keyRow.keyHash.length === 64)

  console.log('\n── TASK D: real trend data ─────────────────────────────────')
  const t1 = await json('/api/sqftlab/communities/dubai-marina/trend')
  const t2 = await json('/api/sqftlab/communities/dubai-marina/trend')
  check('trend is stable across refreshes (no Math.random)', JSON.stringify(t1.body) === JSON.stringify(t2.body))
  const routes = await Bun.file('custom-routes.ts').text()
  check('custom-routes has no Math.random in a trend handler', !/trend[\s\S]{0,2000}Math\.random/.test(routes))

  console.log('\n── TASK E: no hardcoded demo user ──────────────────────────')
  check('DEMO_USER_ID gone from custom-routes.ts', !routes.includes('DEMO_USER_ID'))
  check('getUserId() resolves the caller per request', routes.includes('function getUserId'))

  console.log('\n── TASK F: isDeal computed ─────────────────────────────────')
  const deals = await json('/api/sqftlab/deals')
  check('deals endpoint responds', deals.status === 200, deals.status)
  const dealRows = (deals.body.deals ?? []) as unknown[]
  check('deals payload is an array', Array.isArray(dealRows))
  check(
    'no rentals carry a deal flag (deals are sale-only)',
    (await prisma.listing.count({ where: { isDeal: true, purpose: { not: 'sale' } } })) === 0,
  )

  // Validate the rule against the data rather than asserting a row count. The
  // 90-day median needs real DLD transactions, and DUBAI_PULSE_API_KEY is unset,
  // so this dataset currently has none — zero deals is the correct answer to
  // zero input, and a non-zero count would mean the flags were fabricated.
  const medians = await marketPsfByCommunity()
  const saleRows = await prisma.listing.findMany({
    where: { purpose: 'sale' },
    select: { communityId: true, pricePerSqft: true, isDeal: true },
  })
  const violations = saleRows.filter((l) => {
    const m = medians.get(l.communityId)
    if (!m || m <= 100) return false
    const expected = l.pricePerSqft > 0 && l.pricePerSqft < m * DEAL_DISCOUNT_THRESHOLD
    return expected !== l.isDeal
  }).length
  const flagged = await prisma.listing.count({ where: { isDeal: true } })
  console.log(
    `  · ${flagged} flagged · ${saleRows.length} sale listings · ${medians.size} communities with a 90-day DLD median`,
  )
  check('every flag agrees with the 8% rule (0 violations)', violations === 0, violations)

  const dealsSrc = await Bun.file('src/lib/deals.ts').text()
  check('deal threshold is 8% below market', dealsSrc.includes('DEAL_DISCOUNT_THRESHOLD = 0.92'))
  check(
    'deal detection uses the 90-day DLD median, not the listing median',
    dealsSrc.includes('marketPsfByCommunity') && !/threshold = cm\.medianAedSqft/.test(dealsSrc),
  )
  check('no hardcoded isDeal: false in a read path', !/app\.get\('\/sqftlab\/(deals|listings)'[\s\S]{0,2500}isDeal: false/.test(routes))
} catch (e) {
  // Record the throw so the finally block below reports it. Previously a throw
  // escaped the try body entirely: the finally still printed a RESULT line, but
  // with fail=0 it read as "nothing failed" when the run had actually aborted
  // partway through. Recording it here makes the summary tell the truth.
  const msg = (e as Error).message ?? String(e)
  failures.push(`threw before completing — ${msg}`)
  fail++
} finally {
  // ── Cleanup: remove exactly what this script created ───────────────────────
  const u = await prisma.user.findUnique({ where: { email: TEST_EMAIL } }).catch(() => null)
  if (u) {
    await prisma.apiKey.deleteMany({ where: { userId: u.id } })
    await prisma.session.deleteMany({ where: { userId: u.id } })
    await prisma.userEvent.deleteMany({ where: { userId: u.id } })
    await prisma.user.delete({ where: { id: u.id } })
  }
  await prisma.verificationToken.deleteMany({ where: { identifier: TEST_EMAIL } })
  for (const id of createdGuestIds) {
    if (!id) continue
    await prisma.userEvent.deleteMany({ where: { guestId: id } })
    await prisma.guestSession.deleteMany({ where: { id } })
  }
  await prisma.$disconnect()

  console.log(`\n${'═'.repeat(60)}`)
  console.log(`RESULT: ${pass} passed, ${fail} failed`)
  if (fail) console.log(`FAILED: ${failures.join(' | ')}`)
  console.log('═'.repeat(60))
  process.exitCode = fail ? 1 : 0
}
