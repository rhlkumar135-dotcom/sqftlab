/**
 * Day 17 end-to-end verification — white-label API, docs/api-keys pages, health, security.
 *
 * Hits the RUNNING server over HTTP (localhost:3101), because that is the path a client
 * takes. Several of these assertions are about middleware ordering and the `Host` header,
 * neither of which a direct `app.request()` call reproduces faithfully.
 *
 * DATABASE_URL: the sandbox shell exports a DATABASE_URL pointing at the *workspace-root*
 * stub database, which shadows this project's .env. `src/lib/db` would therefore read an
 * empty database while the server reads the real one. The script refuses to run unless the
 * URL names this project's dev.db, so a passing run cannot be an artefact of that mix-up.
 *
 * Writes: two throwaway users (`verify-day17-*@example.invalid`), their API keys and
 * white-label configs. All of it is deleted in the `finally` block, including the
 * UserEvent rows the routes emit. Never touches the seeded demo account.
 */
import { prisma } from '../src/lib/db'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ENV_REQUIREMENTS, NOT_APPLICABLE, envReport } from '../src/lib/env-audit'

const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3101'

/**
 * Which database this script is allowed to write to.
 *
 * It must be the PROJECT's dev.db, and the check compares resolved absolute paths rather
 * than substring-matching `/prisma/dev.db` — because the sandbox shell exports
 * `DATABASE_URL=file:/app/workspace/prisma/dev.db`, the WORKSPACE-ROOT stub, which also
 * ends in `/prisma/dev.db`. A substring check passes against that stub, after which this
 * script would create its fixtures in an empty database while the running server read the
 * real one, and every assertion would fail for a reason that has nothing to do with Day 17.
 *
 * This suite hits the live server over HTTP, so it cannot use a throwaway copy the way the
 * other suites do; that is why it is scoped so carefully instead — three throwaway users
 * with `.invalid` addresses, every row deleted in the `finally` block. It never touches the
 * seeded demo account.
 */
const EXPECTED_DB = resolve('prisma/dev.db')
function isProjectDb(url: string): boolean {
  if (!url) return false
  const path = url.replace(/^file:\/\//, '').replace(/^file:/, '')
  return resolve(path) === EXPECTED_DB
}

const PROJECT_DB = EXPECTED_DB

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title: string) {
  console.log(`\n── ${title}`)
}

async function req(
  path: string,
  init: RequestInit & { userId?: string; host?: string } = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const headers = new Headers(init.headers)
  if (init.userId) headers.set('Authorization', `Bearer ${init.userId}`)
  if (init.host) headers.set('Host', init.host)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: 'manual' })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, body, headers: res.headers }
}

const TEST_EMAIL = 'verify-day17-inst@example.invalid'
const TEST_EMAIL_PRO = 'verify-day17-pro@example.invalid'
const OTHER_EMAIL = 'verify-day17-other@example.invalid'
const TEST_DOMAIN = 'data.verify-day17.invalid'

const created: string[] = []

async function main() {
  const url = process.env.DATABASE_URL ?? ''
  if (!isProjectDb(url)) {
    console.error(
      `Refusing to run: DATABASE_URL must resolve to this project's ${PROJECT_DB}.\n` +
        `Got "${url || '<unset>'}" — the sandbox shell's default points at the workspace-root\n` +
        `stub, and the server would disagree with whatever this script checked.\n` +
        `Run: DATABASE_URL=file:${PROJECT_DB} bun run scripts/verify-day17.ts`,
    )
    process.exit(2)
  }

  // ── E1: deep health check ──────────────────────────────────────────────────
  section('E1 — GET /api/health is a real, failing-capable check')
  {
    const { status, body } = await req('/api/health')
    const checks = (body.checks ?? {}) as Record<string, string>
    check('returns 200', status === 200, `got ${status}`)
    check("status is 'healthy'", body.status === 'healthy', String(body.status))
    check("checks.database is 'ok'", checks.database === 'ok', String(checks.database))
    check("checks.cache is 'ok' (real write/read round-trip)", checks.cache === 'ok', String(checks.cache))
    // Redis does not exist in this stack. Reported explicitly rather than omitted, so a
    // checklist looking for it can see the decision.
    check("checks.redis is 'not_configured'", checks.redis === 'not_configured', String(checks.redis))
    check('reports the failing set', Array.isArray(body.failing) && (body.failing as unknown[]).length === 0)
    check('carries a version', typeof body.version === 'string' && body.version.length > 0)

    // The endpoint must be able to say something other than 'healthy', or it proves
    // nothing. The degraded path cannot be triggered against the live server without
    // breaking its database, so this asserts the branch and its status code structurally —
    // the earlier version of this check was `await req(...).then(() => true)`, which
    // passed unconditionally and therefore tested nothing at all.
    const src = readFileSync('custom-routes.ts', 'utf8')
    const start = src.indexOf("app.get('/health'")
    const healthBlock = src.slice(start, src.indexOf("app.get('/health/db'"))
    check('health handler returns 503 when a check fails', /allOk \? 200 : 503/.test(healthBlock))
    check('health handler reports which checks failed', /\bfailing\b/.test(healthBlock))
    check('health handler marks the status degraded', /'degraded'/.test(healthBlock))
    check('health handler catches a DB error rather than throwing', /checks\.database = 'error'/.test(healthBlock))
  }

  // ── E2: security headers on every response class ───────────────────────────
  section('E2 — security headers')
  {
    const cases: Array<[string, RequestInit]> = [
      ['200', { method: 'GET' }],
      ['404', { method: 'GET' }],
    ]
    for (const [label, init] of cases) {
      const path = label === '200' ? '/api/sqftlab/stats' : '/api/no-such-route-verify17'
      const r = await req(path, init)
      check(
        `${label}: X-Content-Type-Options`,
        r.headers.get('x-content-type-options') === 'nosniff',
        String(r.headers.get('x-content-type-options')),
      )
      check(`${label}: X-Frame-Options`, r.headers.get('x-frame-options') === 'DENY')
      check(`${label}: Referrer-Policy`, r.headers.get('referrer-policy') === 'strict-origin-when-cross-origin')
      check(`${label}: Permissions-Policy`, (r.headers.get('permissions-policy') ?? '').includes('geolocation=()'))
    }
    const pre = await req('/api/sqftlab/stats', { method: 'OPTIONS', headers: { Origin: 'https://sqftlab.com' } })
    check('OPTIONS preflight also carries them', pre.headers.get('x-content-type-options') === 'nosniff')
    check(
      'OPTIONS preflight still answers CORS',
      pre.headers.get('access-control-allow-origin') === 'https://sqftlab.com',
      String(pre.headers.get('access-control-allow-origin')),
    )

    // The SPA shell is served by server.tsx, outside the /api mount where custom-routes
    // lives — so the API middleware never sees it. It is the response that most needs
    // X-Frame-Options, and setting the headers only on /api left every rendered page
    // without them.
    for (const path of ['/', '/docs', '/keys']) {
      const r = await req(path)
      check(`SPA shell ${path}: X-Frame-Options`, r.headers.get('x-frame-options') === 'DENY', String(r.headers.get('x-frame-options')))
      check(`SPA shell ${path}: X-Content-Type-Options`, r.headers.get('x-content-type-options') === 'nosniff')
    }
  }

  // ── E3: environment audit ──────────────────────────────────────────────────
  section('E3 — environment audit')
  {
    // Synthetic envs, so the result does not depend on what happens to be configured here.
    const empty = envReport({})
    check('an empty env flags DATABASE_URL as fatal', empty.fatalMissing.includes('DATABASE_URL'), JSON.stringify(empty.fatalMissing))
    check('and reports dormant features rather than throwing', empty.degraded.length > 0)

    const dbOnly = envReport({ DATABASE_URL: 'file:x' })
    check('DATABASE_URL alone clears the fatal list', dbOnly.fatalMissing.length === 0, JSON.stringify(dbOnly.fatalMissing))
    check('the DLD feed is still reported dormant', dbOnly.degraded.some((d) => d.missing.includes('DUBAI_PULSE_API_KEY')))

    const justDld = envReport({ DATABASE_URL: 'file:x', DUBAI_PULSE_API_KEY: 'k' })
    check('providing the DLD key clears that one group', !justDld.degraded.some((d) => d.capability === 'DLD transaction feed'))

    // Blank strings must count as missing — a var set to "" is not configured, and reading
    // it as present is how a "check passes, feature is dead" mismatch happens.
    const blank = envReport({ DATABASE_URL: '   ', DUBAI_PULSE_API_KEY: '' })
    check('whitespace-only values count as missing', blank.fatalMissing.includes('DATABASE_URL') && blank.degraded.some((d) => d.missing.includes('DUBAI_PULSE_API_KEY')))

    // The brief's list must not creep back in: these names belong to infrastructure this
    // deployment does not have, and demanding them trains the reader to ignore the warning.
    const allVars = ENV_REQUIREMENTS.flatMap((r) => r.vars)
    for (const wrong of ['REDIS_URL', 'NEXTAUTH_SECRET', 'NEXTAUTH_URL', 'RESEND_API_KEY']) {
      check(`${wrong} is not demanded by the audit`, !allVars.includes(wrong))
      check(`${wrong} is documented as not applicable`, NOT_APPLICABLE.some((n) => n.name === wrong))
    }
    for (const real of ['DATABASE_URL', 'DUBAI_PULSE_API_KEY', 'STRIPE_SECRET_KEY', 'TWILIO_ACCOUNT_SID', 'ANTHROPIC_API_KEY', 'PUPPETEER_EXECUTABLE_PATH']) {
      check(`${real} IS demanded by the audit`, allVars.includes(real))
    }
    check('every requirement explains the symptom', ENV_REQUIREMENTS.every((r) => r.symptom.length > 20))
  }

  // ── fixtures ───────────────────────────────────────────────────────────────
  const inst = await prisma.user.create({
    data: { email: TEST_EMAIL, name: 'Verify 17 Institutional', subscriptionTier: 'institutional', subscriptionStatus: 'active' },
    select: { id: true },
  })
  created.push(inst.id)
  const pro = await prisma.user.create({
    data: { email: TEST_EMAIL_PRO, name: 'Verify 17 Pro', subscriptionTier: 'pro', subscriptionStatus: 'active' },
    select: { id: true },
  })
  created.push(pro.id)
  const other = await prisma.user.create({
    data: { email: OTHER_EMAIL, name: 'Verify 17 Other', subscriptionTier: 'institutional', subscriptionStatus: 'active' },
    select: { id: true },
  })
  created.push(other.id)

  // ── Task B: tier gate ──────────────────────────────────────────────────────
  section('Task B — tier gate')
  {
    const anon = await req('/api/sqftlab/white-label/config')
    check('anonymous → 403 (not 200 with an empty config)', anon.status === 403, `got ${anon.status}`)

    const proUser = await req('/api/sqftlab/white-label/config', { userId: pro.id })
    check('pro tier → 403', proUser.status === 403, `got ${proUser.status}`)
    check('403 names the required tier', proUser.body.requiredTier === 'institutional', String(proUser.body.requiredTier))

    const instUser = await req('/api/sqftlab/white-label/config', { userId: inst.id })
    check('institutional → 200', instUser.status === 200, `got ${instUser.status}`)
    check('and starts with a null config', instUser.body.config === null)
  }

  // ── Task B: validation ─────────────────────────────────────────────────────
  section('Task B — input validation')
  {
    const noName = await req('/api/sqftlab/white-label/config', {
      method: 'POST', userId: inst.id, body: JSON.stringify({ brandColor: '#123456' }),
    })
    check('creating without clientName → 400', noName.status === 400, `got ${noName.status}`)

    const badColor = await req('/api/sqftlab/white-label/config', {
      method: 'POST', userId: inst.id, body: JSON.stringify({ clientName: 'X', brandColor: 'red' }),
    })
    check('non-hex brandColor → 400', badColor.status === 400, `got ${badColor.status}`)

    const badDomain = await req('/api/sqftlab/white-label/config', {
      method: 'POST', userId: inst.id, body: JSON.stringify({ clientName: 'X', customDomain: 'https://evil.com/path' }),
    })
    check('customDomain with scheme+path → 400', badDomain.status === 400, `got ${badDomain.status}`)

    const badLogo = await req('/api/sqftlab/white-label/config', {
      method: 'POST', userId: inst.id, body: JSON.stringify({ clientName: 'X', logoUrl: 'javascript:alert(1)' }),
    })
    check('javascript: logoUrl → 400', badLogo.status === 400, `got ${badLogo.status}`)
  }

  // ── Task B: mass assignment ────────────────────────────────────────────────
  section('Task B — mass assignment is closed (the brief spreads the raw body)')
  {
    const r = await req('/api/sqftlab/white-label/config', {
      method: 'POST',
      userId: inst.id,
      body: JSON.stringify({
        clientName: 'Emirates Verify Research',
        brandColor: '#2563EB',
        customDomain: TEST_DOMAIN,
        // Every one of these is an escalation attempt:
        customDomainVerified: true,
        dailyLimit: 999999999,
        monthlyLimit: 999999999,
        active: false,
        userId: other.id,
        id: 'hijacked-id',
        verifiedDomain: TEST_DOMAIN,
      }),
    })
    check('request succeeds (unknown keys ignored, not rejected)', r.status === 200, `got ${r.status}`)

    const row = await prisma.whiteLabelConfig.findUnique({ where: { userId: inst.id } })
    check('customDomainVerified NOT set by the client', row?.customDomainVerified === false, String(row?.customDomainVerified))
    check('dailyLimit NOT raised by the client', row?.dailyLimit === 100000, String(row?.dailyLimit))
    check('monthlyLimit NOT raised by the client', row?.monthlyLimit === 2000000, String(row?.monthlyLimit))
    check('active NOT flipped by the client', row?.active === true, String(row?.active))
    check('row belongs to the CALLER, not the userId in the body', row?.userId === inst.id)
    check('id is generated, not the client-supplied one', row?.id !== 'hijacked-id')
    check('domain normalised to a bare hostname', row?.customDomain === TEST_DOMAIN, String(row?.customDomain))
    check('brandColor normalised to upper case', row?.brandColor === '#2563EB', String(row?.brandColor))

    const otherRow = await prisma.whiteLabelConfig.findUnique({ where: { userId: other.id } })
    check('no config was created for the other user', otherRow === null)

    // The response must not leak the internal flags either.
    const view = (r.body.config ?? {}) as Record<string, unknown>
    check('response omits userId', view.userId === undefined)
    check('response omits the id', view.id === undefined)
    check('response omits verifiedDomain', view.verifiedDomain === undefined)
  }

  // ── Task B: domain conflict ────────────────────────────────────────────────
  section('Task B — domain conflict is a 409, not an unhandled 500')
  {
    const clash = await req('/api/sqftlab/white-label/config', {
      method: 'POST', userId: other.id, body: JSON.stringify({ clientName: 'Rival', customDomain: TEST_DOMAIN }),
    })
    check('second account claiming the same domain → 409', clash.status === 409, `got ${clash.status}`)

    // Re-claiming your OWN domain must not be treated as a conflict.
    const own = await req('/api/sqftlab/white-label/config', {
      method: 'POST', userId: inst.id, body: JSON.stringify({ clientName: 'Emirates Verify Research', customDomain: TEST_DOMAIN }),
    })
    check('re-setting your own domain → 200', own.status === 200, `got ${own.status}`)
  }

  // ── Task B: verify-domain actually verifies ────────────────────────────────
  section('Task B — verify-domain performs a real DNS check')
  {
    // No CNAME for a .invalid name; the important part is that it is answered, not thrown.
    const r = await req('/api/sqftlab/white-label/verify-domain', { method: 'POST', userId: inst.id })
    check('200 rather than 500', r.status === 200, `got ${r.status}`)
    check('verified is false', r.body.verified === false)
    check("outcome distinguishes 'mismatch' from 'unavailable'", r.body.outcome === 'mismatch' || r.body.outcome === 'unavailable', String(r.body.outcome))
    check('returns the CNAME instructions', (r.body.instructions as Record<string, unknown>)?.type === 'CNAME')
    check('expectedCname present', typeof r.body.expectedCname === 'string' && (r.body.expectedCname as string).length > 0)

    const after = await prisma.whiteLabelConfig.findUnique({ where: { userId: inst.id } })
    check('still unverified in the database', after?.customDomainVerified === false)
    check('records why it failed', typeof after?.lastVerifyError === 'string' && (after?.lastVerifyError.length ?? 0) > 0)

    const noDomain = await req('/api/sqftlab/white-label/verify-domain', { method: 'POST', userId: other.id })
    check('no domain configured → 400', noDomain.status === 400, `got ${noDomain.status}`)
  }

  // ── Task B: changing the domain revokes verification ───────────────────────
  section('Task B — repointing the domain revokes the verification')
  {
    await prisma.whiteLabelConfig.update({
      where: { userId: inst.id },
      data: { customDomainVerified: true, verifiedDomain: TEST_DOMAIN, verifiedAt: new Date() },
    })
    const moved = await req('/api/sqftlab/white-label/config', {
      method: 'POST', userId: inst.id, body: JSON.stringify({ customDomain: 'data.moved-verify.invalid' }),
    })
    check('domain change accepted', moved.status === 200, `got ${moved.status}`)
    const row = await prisma.whiteLabelConfig.findUnique({ where: { userId: inst.id } })
    check('customDomainVerified reset to false', row?.customDomainVerified === false, String(row?.customDomainVerified))
    check('verifiedDomain cleared', row?.verifiedDomain === null, String(row?.verifiedDomain))

    // Put it back for the host-middleware test.
    await prisma.whiteLabelConfig.update({
      where: { userId: inst.id },
      data: { customDomain: TEST_DOMAIN, customDomainVerified: true, verifiedDomain: TEST_DOMAIN, verifiedAt: new Date() },
    })
  }

  // ── Task B: host middleware + branding injection ───────────────────────────
  section('Task B — host middleware brands /api/v1 responses')
  {
    const keyRes = await req('/api/sqftlab/api-keys', { method: 'POST', userId: inst.id, body: JSON.stringify({ name: 'Verify 17 key' }) })
    check('API key created', keyRes.status === 201, `got ${keyRes.status}`)
    const rawKey = String(keyRes.body.key ?? '')
    check('raw key returned once', rawKey.startsWith('sqft_'))

    const asBrand = await req('/api/v1/communities', { headers: { Authorization: `Bearer ${rawKey}` }, host: TEST_DOMAIN })
    check('branded host → 200', asBrand.status === 200, `got ${asBrand.status}`)
    const meta = (asBrand.body.meta ?? {}) as Record<string, unknown>
    const wl = (meta.whiteLabel ?? {}) as Record<string, unknown>
    check('meta.whiteLabel present', !!meta.whiteLabel)
    check('clientName injected', wl.clientName === 'Emirates Verify Research', String(wl.clientName))
    check('brandColor injected', wl.brandColor === '#2563EB', String(wl.brandColor))
    check('attribution injected', typeof wl.attribution === 'string' && (wl.attribution as string).length > 0)
    check('X-White-Label response header set', asBrand.headers.get('x-white-label') === 'Emirates Verify Research', String(asBrand.headers.get('x-white-label')))

    // The allowlisted own-host must NOT be branded, even though a config exists.
    const own = await req('/api/v1/communities', { headers: { Authorization: `Bearer ${rawKey}` }, host: 'sqftlab.com' })
    check('own host → no branding', ((own.body.meta ?? {}) as Record<string, unknown>).whiteLabel === undefined)

    // Unverified domain must NOT be branded.
    await prisma.whiteLabelConfig.update({ where: { userId: inst.id }, data: { customDomainVerified: false } })
    const unverified = await req('/api/v1/communities', { headers: { Authorization: `Bearer ${rawKey}` }, host: TEST_DOMAIN })
    check('unverified domain → no branding', ((unverified.body.meta ?? {}) as Record<string, unknown>).whiteLabel === undefined)

    // Inactive config must NOT be branded.
    await prisma.whiteLabelConfig.update({ where: { userId: inst.id }, data: { customDomainVerified: true, active: false } })
    const inactive = await req('/api/v1/communities', { headers: { Authorization: `Bearer ${rawKey}` }, host: TEST_DOMAIN })
    check('inactive config → no branding', ((inactive.body.meta ?? {}) as Record<string, unknown>).whiteLabel === undefined)

    // Host with a port must still resolve to the same config.
    await prisma.whiteLabelConfig.update({ where: { userId: inst.id }, data: { active: true } })
    const withPort = await req('/api/v1/communities', { headers: { Authorization: `Bearer ${rawKey}` }, host: `${TEST_DOMAIN}:443` })
    check('Host with :port still matches', ((withPort.body.meta ?? {}) as Record<string, unknown>).whiteLabel !== undefined)

    // Attribution override + brand hiding.
    const attribRes = await req('/api/sqftlab/white-label/config', {
      method: 'POST', userId: inst.id,
      body: JSON.stringify({ attributionText: 'Powered by Verify Research, data from sqftLab', hideSqftLabBrand: true }),
    })
    check('partial update (no clientName) → 200', attribRes.status === 200, `got ${attribRes.status}`)
    const custom = await req('/api/v1/communities', { headers: { Authorization: `Bearer ${rawKey}` }, host: TEST_DOMAIN })
    const customWl = (((custom.body.meta ?? {}) as Record<string, unknown>).whiteLabel ?? {}) as Record<string, unknown>
    check('attributionText honoured', customWl.attribution === 'Powered by Verify Research, data from sqftLab', String(customWl.attribution))
    check('hideSqftLabBrand reported', customWl.hideSqftLabBrand === true)

    // The other two v1 routes must be branded too, and an error response must not crash.
    const stats = await req('/api/v1/communities/downtown-dubai/stats', { headers: { Authorization: `Bearer ${rawKey}` }, host: TEST_DOMAIN })
    check('/v1/communities/:slug/stats branded', ((stats.body.meta ?? {}) as Record<string, unknown>).whiteLabel !== undefined)
    const notFound = await req('/api/v1/transactions?area=NoSuchAreaVerify17', { headers: { Authorization: `Bearer ${rawKey}` }, host: TEST_DOMAIN })
    check('v1 404 body still branded', ((notFound.body.meta ?? {}) as Record<string, unknown>).whiteLabel !== undefined)
    check('v1 404 keeps its own fields', notFound.body.code === 'area_not_found')
  }

  // ── Task D: api-keys usage payload ─────────────────────────────────────────
  section('Task D — GET /api/sqftlab/api-keys returns usage')
  {
    const r = await req('/api/sqftlab/api-keys', { userId: pro.id })
    check('200 for a pro account', r.status === 200, `got ${r.status}`)
    const usage = (r.body.usage ?? {}) as Record<string, unknown>
    check('usage present', !!r.body.usage)
    check('dailyLimitPerKey = 500 on pro', usage.dailyLimitPerKey === 500, String(usage.dailyLimitPerKey))
    check('maxKeys = 3 on pro', usage.maxKeys === 3, String(usage.maxKeys))
    check('keyCount present', typeof usage.keyCount === 'number')
    check('resetsAtUtc is a UTC midnight', typeof usage.resetsAtUtc === 'string' && (usage.resetsAtUtc as string).endsWith('T00:00:00.000Z'), String(usage.resetsAtUtc))
    check('busiest-key fields present', usage.busiestKeyCallsToday === 0)
    check('keys array present', Array.isArray(r.body.keys))

    // The per-key cap the GET advertises must be the one the POST enforces.
    const created1 = await req('/api/sqftlab/api-keys', { method: 'POST', userId: pro.id, body: JSON.stringify({ name: 'k1' }) })
    check('first key created', created1.status === 201)
    const instKeys = await req('/api/sqftlab/api-keys', { userId: inst.id })
    check('institutional sees 100000/day and 20 keys', (instKeys.body.usage as Record<string, unknown>).dailyLimitPerKey === 100000 && (instKeys.body.usage as Record<string, unknown>).maxKeys === 20)

    // Stale-counter rollover: a key whose daily reset predates today must report 0 used.
    const stale = await prisma.apiKey.create({
      data: {
        userId: pro.id, keyHash: `verify17-stale-${Date.now()}`, prefix: 'sqft_stale01', name: 'stale',
        tier: 'pro', callsToday: 499, callsMonth: 1234,
        callsResetAt: new Date(Date.now() - 3 * 86_400_000),
        monthResetAt: new Date(Date.now() - 40 * 86_400_000),
      },
      select: { id: true },
    })
    const rolled = await req('/api/sqftlab/api-keys', { userId: pro.id })
    const staleRow = ((rolled.body.keys ?? []) as Array<Record<string, unknown>>).find((k) => k.name === 'stale')
    check('stale callsToday rolled over to 0, not reported as 499/500', staleRow?.callsToday === 0, String(staleRow?.callsToday))
    check('stale callsMonth rolled over to 0', staleRow?.callsMonth === 0, String(staleRow?.callsMonth))
    check('remainingToday back to the full allowance', staleRow?.remainingToday === 500, String(staleRow?.remainingToday))
    await prisma.apiKey.delete({ where: { id: stale.id } })
  }

  // ── E4: routing ────────────────────────────────────────────────────────────
  section('E4 — routes reachable')
  {
    for (const [path, expect] of [
      ['/api/health', 200],
      ['/api/health/db', 200],
      ['/api/v1/communities', 401], // no key
    ] as const) {
      const r = await req(path)
      check(`${path} → ${expect}`, r.status === expect, `got ${r.status}`)
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failures.length) console.log(`failures:\n  - ${failures.join('\n  - ')}`)
}

/** Wait for the API to accept connections; a restart after an edit can take a few seconds. */
async function waitForServer(): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`)
      if (r.status === 200 || r.status === 503) return true
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1_000))
  }
  return false
}

// The error must reach the console. An earlier version called process.exit() from the
// `finally` block, which swallowed any exception thrown by main() — the suite appeared to
// "pass" while having run only its first section.
let thrown: unknown = null
try {
  if (!(await waitForServer())) {
    console.error(`Refusing to run: ${BASE}/api/health never answered. Is the server up?`)
    process.exit(2)
  }
  await main()
} catch (e) {
  thrown = e
} finally {
  // Delete exactly what this script made, including the analytics rows the routes
  // emitted, so a run leaves the database as it found it.
  await prisma.userEvent.deleteMany({ where: { userId: { in: created } } })
  await prisma.apiKey.deleteMany({ where: { userId: { in: created } } })
  await prisma.whiteLabelConfig.deleteMany({ where: { userId: { in: created } } })
  await prisma.user.deleteMany({ where: { id: { in: created } } })
  const leftovers = await prisma.user.count({ where: { email: { in: [TEST_EMAIL, TEST_EMAIL_PRO, OTHER_EMAIL] } } })
  console.log(`cleanup: removed ${created.length} test users (leftover rows: ${leftovers})`)
  await prisma.$disconnect()
}

if (thrown) {
  console.error(`\nSUITE ABORTED: ${thrown instanceof Error ? thrown.stack ?? thrown.message : String(thrown)}`)
  process.exit(1)
}
process.exit(failed > 0 ? 1 : 0)
