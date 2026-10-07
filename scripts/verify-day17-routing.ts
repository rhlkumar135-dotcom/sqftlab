/**
 * Day 17 Task E4 — routing audit.
 *
 * Two halves:
 *
 *  1. SERVER. Every route in the brief's manifest must be REGISTERED. A handler's own 404
 *     (unknown portfolio id, unknown community) is indistinguishable from "route does not
 *     exist" if you only look at the status code, so the check is on the response BODY:
 *     Hono's router answers an unmounted path with a plain-text `404 Not Found`, whereas
 *     every handler here answers with JSON. A JSON 404 means the route ran and said no.
 *
 *  2. CLIENT. The pages the brief lists must be reachable. "In the navigation sidebar" is
 *     the brief's wording; what matters is that a user can get there without typing a URL,
 *     so membership of NAV or of a known entry point is what is asserted — and this is a
 *     real check, not a formality: the mortgage calculator shipped with no entry point at
 *     all and this audit is what caught it.
 *
 * Routes the brief lists for Day 16 (the deals feature) are reported as a known gap rather
 * than as failures, because Day 16 was never implemented — see the summary at the end.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { prisma } from '../src/lib/db'

const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3101'

/**
 * See scripts/verify-day17.ts for why the project database is required and why the check
 * compares RESOLVED paths: the sandbox shell's `DATABASE_URL` points at the workspace-root
 * stub, which also ends in `/prisma/dev.db` and would sail through a substring test. This
 * suite talks to the live server, so it must write where the server reads.
 */
const EXPECTED_DB = resolve('prisma/dev.db')
function isProjectDb(url: string): boolean {
  if (!url) return false
  const path = url.replace(/^file:\/\//, '').replace(/^file:/, '')
  return resolve(path) === EXPECTED_DB
}

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

function section(t: string) { console.log(`\n── ${t}`) }

interface Probe {
  method: string
  path: string
  body?: unknown
  expectStatus?: number
}

const MANIFEST: Probe[] = [
  // Day 5
  { method: 'POST', path: '/api/sqftlab/subscribe' },
  { method: 'POST', path: '/api/stripe/webhook' },
  { method: 'GET', path: '/api/sqftlab/users/me' },
  // Day 6 / 7
  { method: 'POST', path: '/api/sqftlab/cma' },
  { method: 'POST', path: '/api/sqftlab/report/property' },
  // Day 8
  { method: 'GET', path: '/api/sqftlab/portfolio' },
  { method: 'POST', path: '/api/sqftlab/portfolio' },
  { method: 'DELETE', path: '/api/sqftlab/portfolio/verify17-nonexistent' },
  // Day 9
  { method: 'GET', path: '/api/sqftlab/capital-flow/overview' },
  { method: 'GET', path: '/api/sqftlab/capital-flow/downtown-dubai' },
  { method: 'GET', path: '/api/sqftlab/communities/downtown-dubai/yield' },
  // Day 10
  { method: 'POST', path: '/api/sqftlab/developer/position' },
  { method: 'GET', path: '/api/sqftlab/buildings' },
  { method: 'GET', path: '/api/sqftlab/buildings/verify17-nonexistent' },
  // Day 11
  { method: 'GET', path: '/api/sqftlab/api-keys' },
  { method: 'POST', path: '/api/sqftlab/api-keys' },
  { method: 'DELETE', path: '/api/sqftlab/api-keys/verify17-nonexistent' },
  { method: 'POST', path: '/api/sqftlab/export' },
  { method: 'GET', path: '/api/v1/transactions' },
  { method: 'GET', path: '/api/v1/communities' },
  { method: 'GET', path: '/api/v1/communities/downtown-dubai/stats' },
  // Day 12
  { method: 'GET', path: '/api/sqftlab/alerts' },
  { method: 'POST', path: '/api/sqftlab/alerts' },
  { method: 'DELETE', path: '/api/sqftlab/alerts/verify17-nonexistent' },
  { method: 'GET', path: '/api/sqftlab/alerts/verify17-nonexistent/matches' },
  // Day 13
  { method: 'POST', path: '/api/sqftlab/ai/chat' },
  { method: 'GET', path: '/api/sqftlab/ai/chat/history' },
  { method: 'GET', path: '/api/sqftlab/public/market-pulse' },
  // Day 14
  { method: 'POST', path: '/api/sqftlab/whatsapp/subscribe' },
  { method: 'GET', path: '/api/sqftlab/whatsapp/subscribe' },
  { method: 'DELETE', path: '/api/sqftlab/whatsapp/subscribe' },
  { method: 'POST', path: '/api/sqftlab/whatsapp/webhook' },
  { method: 'GET', path: '/api/sqftlab/mortgage/estimate' },
  // Day 15
  { method: 'POST', path: '/api/sqftlab/onboarding/step' },
  { method: 'POST', path: '/api/sqftlab/onboarding/complete' },
  // Day 8 — the below-market listing scan. Still mounted, and it owns `/sqftlab/deals`
  // for that reason; the Day 16 network was namespaced away from it (`/deal-briefs`).
  { method: 'GET', path: '/api/sqftlab/deals' },
  // Day 16 — Deal Origination Network. These were "known missing" until Day 16 was built;
  // they are now normal probes that must pass, so a regression fails the audit.
  { method: 'GET', path: '/api/sqftlab/deal-briefs' },
  { method: 'POST', path: '/api/sqftlab/deal-briefs' },
  { method: 'GET', path: '/api/sqftlab/deal-briefs/mine' },
  { method: 'GET', path: '/api/sqftlab/deal-briefs/verify17-nonexistent' },
  { method: 'PATCH', path: '/api/sqftlab/deal-briefs/verify17-nonexistent' },
  { method: 'POST', path: '/api/sqftlab/deal-briefs/verify17-nonexistent/express' },
  // Day 17
  { method: 'POST', path: '/api/sqftlab/white-label/config' },
  { method: 'GET', path: '/api/sqftlab/white-label/config' },
  { method: 'POST', path: '/api/sqftlab/white-label/verify-domain' },
  { method: 'GET', path: '/api/health' },
]

/**
 * A JSON body means a handler ran — except that this app also mounts a JSON catch-all at
 * the bottom of custom-routes.ts (`{ error: 'No API route matches …' }`, 404). Checking
 * only the content type therefore reports EVERY path as registered, including the Day 16
 * routes that were never built, which is exactly the false pass this audit must not give.
 * So the catch-all's own body is recognised and treated as a miss.
 */
async function probe(p: Probe): Promise<{ registered: boolean; status: number; detail: string }> {
  const headers: Record<string, string> = {}
  let body: string | undefined
  if (p.method === 'POST' || p.method === 'PATCH') {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(p.body ?? {})
  }
  const res = await fetch(`${BASE}${p.path}`, { method: p.method, headers, body, redirect: 'manual' })
  const text = await res.text()
  const ct = res.headers.get('content-type') ?? ''
  const isJson = ct.includes('application/json')
  // Hono answers an unmounted path with exactly "404 Not Found" as text/plain.
  const honoMiss = res.status === 404 && !isJson && text.trim() === '404 Not Found'
  // The app's own catch-all.
  const catchAllMiss = res.status === 404 && /No API route matches/.test(text)
  const miss = honoMiss || catchAllMiss
  return {
    registered: !miss,
    status: res.status,
    detail: honoMiss
      ? 'Hono router 404 (route not mounted)'
      : catchAllMiss
        ? `catch-all 404 (route not mounted): ${text.slice(0, 90)}`
        : `${res.status} ${isJson ? 'json' : ct}`,
  }
}

async function main() {
  if (!isProjectDb(process.env.DATABASE_URL ?? '')) {
    console.error(
      `Refusing to run: DATABASE_URL must resolve to this project's ${EXPECTED_DB}.\n` +
        `Got "${process.env.DATABASE_URL ?? '<unset>'}".\n` +
        `Run: DATABASE_URL=file:${EXPECTED_DB} bun run scripts/verify-day17-routing.ts`,
    )
    process.exit(2)
  }

  // ── 1. Server routes ───────────────────────────────────────────────────────
  section('E4a — every manifest route is registered')
  const missing: Probe[] = []

  for (const p of MANIFEST) {
    const r = await probe(p)
    const label = `${p.method} ${p.path}`
    if (r.registered) {
      check(label, true)
    } else {
      missing.push(p)
      check(label, false, r.detail)
    }
  }

  // Day 17 kept a `day16` escape hatch here because that day had not been built and the
  // brief's summary claimed otherwise. Day 16 now ships, so the hatch is gone: a missing
  // deal-brief route fails the audit like any other.
  if (missing.length > 0) {
    console.log(`\n  ⚠ ${missing.length} manifest route(s) not mounted:`)
    for (const p of missing) console.log(`      ${p.method} ${p.path}`)
  }

  // ── 2. Tier gating ─────────────────────────────────────────────────────────
  section('E4b — tier gates refuse lower tiers and name the upgrade')
  {
    const free = await prisma.user.create({
      data: { email: 'verify-day17-free@example.invalid', name: 'Verify 17 Free', subscriptionTier: 'free', subscriptionStatus: 'active' },
      select: { id: true },
    })
    try {
      const gates: Array<[string, string, string, string]> = [
        ['GET', '/api/sqftlab/portfolio', 'pro', 'Portfolio'],
        ['GET', '/api/sqftlab/api-keys', 'pro', 'API keys'],
        ['POST', '/api/sqftlab/cma', 'enterprise', 'CMA Tool'],
        ['GET', '/api/sqftlab/capital-flow/overview', 'pro', 'Capital Flow Tracker'],
        ['GET', '/api/sqftlab/white-label/config', 'institutional', 'White-Label API'],
      ]
      for (const [method, path, requiredTier, feature] of gates) {
        const res = await fetch(`${BASE}${path}`, {
          method,
          headers: { Authorization: `Bearer ${free.id}`, 'Content-Type': 'application/json' },
          body: method === 'GET' ? undefined : '{}',
        })
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
        check(`${path} refuses a free user`, res.status === 403, `got ${res.status}`)
        check(`${path} names requiredTier=${requiredTier}`, body.requiredTier === requiredTier, String(body.requiredTier))
        check(`${path} names the feature`, body.feature === feature, String(body.feature))
        check(`${path} links to /pricing`, body.upgradeUrl === '/pricing', String(body.upgradeUrl))
      }
    } finally {
      await prisma.user.delete({ where: { id: free.id } }).catch(() => {})
    }
  }

  // ── 3. Per-alert matches is scoped to the caller ──────────────────────────
  section('E4b2 — /alerts/:id/matches cannot read another account’s watch')
  {
    const [owner, stranger] = await Promise.all([
      prisma.user.create({
        data: { email: 'verify-day17-owner@example.invalid', subscriptionTier: 'pro', subscriptionStatus: 'active' },
        select: { id: true },
      }),
      prisma.user.create({
        data: { email: 'verify-day17-stranger@example.invalid', subscriptionTier: 'pro', subscriptionStatus: 'active' },
        select: { id: true },
      }),
    ])
    try {
      const alert = await prisma.dealAlert.create({
        data: { userId: owner.id, district: 'downtown-dubai', name: 'verify17 watch' },
        select: { id: true },
      })

      const asOwner = await fetch(`${BASE}/api/sqftlab/alerts/${alert.id}/matches`, {
        headers: { Authorization: `Bearer ${owner.id}` },
      })
      check('owner reads their own alert → 200', asOwner.status === 200, `got ${asOwner.status}`)
      const body = (await asOwner.json()) as Record<string, unknown>
      check('response carries the alert and its matches', !!body.alert && Array.isArray(body.matches))

      const asStranger = await fetch(`${BASE}/api/sqftlab/alerts/${alert.id}/matches`, {
        headers: { Authorization: `Bearer ${stranger.id}` },
      })
      check("another account → 404 (not 200, not 403)", asStranger.status === 404, `got ${asStranger.status}`)
      const leak = (await asStranger.json().catch(() => ({}))) as Record<string, unknown>
      check('and leaks no alert data', leak.alert === undefined && leak.matches === undefined)

      // The pre-existing all-alerts route must remain an account-scoped list.
      const strangerAll = await fetch(`${BASE}/api/sqftlab/alerts/matches`, {
        headers: { Authorization: `Bearer ${stranger.id}` },
      })
      check('all-matches route still 200 for a signed-in user', strangerAll.status === 200, `got ${strangerAll.status}`)
    } finally {
      await prisma.alertMatch.deleteMany({ where: { alert: { userId: owner.id } } })
      await prisma.dealAlert.deleteMany({ where: { userId: { in: [owner.id, stranger.id] } } })
      await prisma.user.deleteMany({ where: { id: { in: [owner.id, stranger.id] } } })
    }
  }

  // ── 4. Public routes stay public ───────────────────────────────────────────
  section('E4c — public routes need no session')
  {
    // `community` is a required query parameter on the mortgage endpoint, so the no-session
    // probe has to supply one — asking without it is a 400 by design, not a missing route.
    for (const path of ['/api/health', '/api/health/db', '/api/sqftlab/public/market-pulse', '/api/sqftlab/mortgage/estimate?community=downtown-dubai', '/api/sqftlab/communities']) {
      const res = await fetch(`${BASE}${path}`)
      check(`${path} → 200 without a session`, res.status === 200, `got ${res.status}`)
    }
  }

  // ── 4. Client-side reachability ────────────────────────────────────────────
  section('E4d — every required page is reachable in the app')
  {
    const app = readFileSync('src/App.tsx', 'utf8')
    const navBlock = app.slice(app.indexOf('const NAV = ['), app.indexOf('// Day 15 Task A'))
    const navIds = [...navBlock.matchAll(/id:\s*'([a-z-]+)'/g)].map((m) => m[1])
    const pathsBlock = app.slice(app.indexOf('const PAGE_PATHS'), app.indexOf('const BUILDING_PATH'))
    const pathKeys = [...pathsBlock.matchAll(/^\s*'?([a-z-]+)'?:\s*'([^']+)'/gm)].map((m) => m[1])

    // Pages a user must be able to reach without typing a URL. `pricing` and `signin` are
    // header buttons rather than nav items, which is why they are checked against the
    // whole file rather than the NAV array alone.
    const mustBeInNav = ['dashboard', 'portfolio', 'alerts', 'export', 'capital-flow', 'buildings', 'deals', 'cma', 'mortgage', 'api-keys', 'docs', 'market-pulse']
    for (const id of mustBeInNav) {
      check(`NAV includes '${id}'`, navIds.includes(id), `nav = ${navIds.join(', ')}`)
    }
    check('header links to pricing', /setPage\(['"]pricing['"]\)|navigate\(['"]pricing['"]\)/.test(app))
    check('header links to signin', /setPage\(['"]signin['"]\)|navigate\(['"]signin['"]\)/.test(app))

    const published: Array<[string, string]> = [
      ['docs', '/docs'], ['api-keys', '/api-keys'], ['mortgage', '/mortgage'],
      ['cma', '/cma'], ['portfolio', '/portfolio'], ['export', '/export'],
      ['capital-flow', '/capital-flow'], ['buildings', '/buildings'],
      ['market-pulse', '/market-pulse'], ['pricing', '/pricing'],
    ]
    for (const [key, url] of published) {
      check(`PAGE_PATHS maps ${key} → ${url}`, pathKeys.includes(key), `paths = ${pathKeys.join(', ')}`)
    }

    // Each page in the type union must have a render branch, or navigating to it shows a blank shell.
    const typeLine = app.match(/^type Page = (.*)$/m)?.[1] ?? ''
    const pageIds = [...typeLine.matchAll(/'([a-z-]+)'/g)].map((m) => m[1])
    const unrendered = pageIds.filter((id) => !new RegExp(`page === '${id}'`).test(app) && id !== 'landing')
    check('every page id has a render branch', unrendered.length === 0, `missing: ${unrendered.join(', ')}`)
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failures.length) console.log(`failures:\n  - ${failures.join('\n  - ')}`)
}

let thrown: unknown = null
try {
  await main()
} catch (e) {
  thrown = e
} finally {
  await prisma.$disconnect()
}

if (thrown) {
  console.error(`\nSUITE ABORTED: ${thrown instanceof Error ? thrown.stack ?? thrown.message : String(thrown)}`)
  process.exit(1)
}
process.exit(failed > 0 ? 1 : 0)
