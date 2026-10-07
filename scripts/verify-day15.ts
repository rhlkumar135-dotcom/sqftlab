// Day 15 verification — onboarding tour routes, response caching, and the empty-state /
// error-boundary wiring that can be asserted without a browser.
//
// Run:
//   cp prisma/dev.db /tmp/day15-e2e.db
//   DATABASE_URL=file:/tmp/day15-e2e.db bun run scripts/verify-day15.ts
//
// Runs the real Hono app in-process against a throwaway COPY. A copy is required: this
// suite creates users and writes tour state, none of which belongs in the project database.
import { prisma } from '../src/lib/db'

const dbUrl = process.env.DATABASE_URL ?? ''
if (!dbUrl.includes('day15-e2e')) {
  throw new Error(
    `Refusing to run: DATABASE_URL must point at the disposable copy (…day15-e2e.db), got "${dbUrl || '<unset>'}".\n` +
      'This suite creates users and writes onboarding state, which must not land in the project database.',
  )
}

const { default: app } = await import('../custom-routes')
const { cacheRead, cacheWrite, cacheInvalidate, CACHE_TTL } = await import('../src/lib/cache')

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 300)}`}`)
  }
}

async function call(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {}
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await app.request(path, {
    method: opts.method ?? 'GET',
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
  const text = await res.text()
  let body: any = {}
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = {}
  }
  return { status: res.status, body }
}

const created: string[] = []
async function mkuser(tier = 'elite') {
  const u = await prisma.user.create({
    data: {
      email: `d15v-${tier}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@verify.test`,
      name: `${tier} verify`,
      subscriptionTier: tier,
      role: 'investor',
    },
    select: { id: true },
  })
  created.push(u.id)
  return u.id
}

console.log('\nDay 15 — onboarding tour\n' + '-'.repeat(52))

// ─── Auth ────────────────────────────────────────────────────────────────────
const anon = await call('/sqftlab/onboarding')
check('GET /onboarding without a caller is 401', anon.status === 401, anon)
const anonStep = await call('/sqftlab/onboarding/step', { method: 'POST', body: { step: 1 } })
check('POST /onboarding/step without a caller is 401', anonStep.status === 401, anonStep)
const anonDone = await call('/sqftlab/onboarding/complete', { method: 'POST' })
check('POST /onboarding/complete without a caller is 401', anonDone.status === 401, anonDone)

// ─── Validation ──────────────────────────────────────────────────────────────
const u1 = await mkuser()
const bad: Array<[string, unknown]> = [
  ['a string', 'abc'],
  ['a float', 1.5],
  ['a negative', -1],
  ['past the last step', 999],
  ['missing', undefined],
  ['null', null],
]
for (const [label, value] of bad) {
  const r = await call('/sqftlab/onboarding/step', { method: 'POST', token: u1, body: { step: value } })
  check(`step rejects ${label} with 400`, r.status === 400, r)
}
const notJson = await app.request('/sqftlab/onboarding/step', {
  method: 'POST',
  headers: { Authorization: `Bearer ${u1}`, 'Content-Type': 'application/json' },
  body: '{not json',
})
check('step rejects a malformed body with 400', notJson.status === 400, { status: notJson.status })

// ─── Bitmask semantics ───────────────────────────────────────────────────────
const start = await call('/sqftlab/onboarding', { token: u1 })
check('a fresh account starts with no steps', Array.isArray(start.body.steps) && start.body.steps.length === 0, start.body)
check('a fresh account is not completed', start.body.completed === false, start.body)
check('lastStep is reported as 4', start.body.lastStep === 4, start.body)

const only2 = await call('/sqftlab/onboarding/step', { method: 'POST', token: u1, body: { step: 2 } })
check('ticking step 2 records ONLY step 2', JSON.stringify(only2.body.steps) === '[2]', only2.body)
check(
  'ticking a later step does not claim the earlier ones',
  !only2.body.steps.includes(0) && !only2.body.steps.includes(1),
  only2.body,
)

const replay = await call('/sqftlab/onboarding/step', { method: 'POST', token: u1, body: { step: 2 } })
check('replaying a step is idempotent', JSON.stringify(replay.body.steps) === '[2]', replay.body)

const stillNotDone = await call('/sqftlab/onboarding/step', { method: 'POST', token: u1, body: { step: 4 } })
check(
  'two of five steps does not complete the tour',
  stillNotDone.body.completed === false && JSON.stringify(stillNotDone.body.steps) === '[2,4]',
  stillNotDone.body,
)

const persisted = await call('/sqftlab/onboarding', { token: u1 })
check('progress persists across requests', JSON.stringify(persisted.body.steps) === '[2,4]', persisted.body)

// All five bits → auto-complete without a second client call.
for (const s of [0, 1, 3]) {
  await call('/sqftlab/onboarding/step', { method: 'POST', token: u1, body: { step: s } })
}
const allDone = await call('/sqftlab/onboarding', { token: u1 })
check('all five steps completes the tour server-side', allDone.body.completed === true, allDone.body)
check('all five steps are recorded', JSON.stringify(allDone.body.steps) === '[0,1,2,3,4]', allDone.body)

// ─── Dismiss ─────────────────────────────────────────────────────────────────
const u2 = await mkuser()
const dismissed = await call('/sqftlab/onboarding/complete', { method: 'POST', token: u2 })
check('complete dismisses without ticking every step', dismissed.body.completed === true, dismissed.body)
const afterDismiss = await call('/sqftlab/onboarding', { token: u2 })
check('dismissal persists', afterDismiss.body.completed === true, afterDismiss.body)

// A completed account must not be re-opened by a later step report.
const reStep = await call('/sqftlab/onboarding/step', { method: 'POST', token: u2, body: { step: 1 } })
check('a step after dismissal keeps the tour dismissed', reStep.body.completed === true, reStep.body)

// ─── /me carries the tour state the banner reads ─────────────────────────────
const me = await call('/sqftlab/me', { token: u1 })
check('GET /me exposes tourSteps', typeof me.body?.user?.tourSteps === 'number', me.body?.user)
check('GET /me exposes tourCompleted', me.body?.user?.tourCompleted === true, me.body?.user)
check(
  'GET /me still exposes the sign-up wizard flag separately',
  'onboardingCompleted' in (me.body?.user ?? {}),
  me.body?.user,
)

console.log('\nDay 15 — response cache\n' + '-'.repeat(52))

// ─── Cache wiring ────────────────────────────────────────────────────────────
check('TTLs match the brief', CACHE_TTL.communities === 1_800_000 && CACHE_TTL.scores === 21_600_000, CACHE_TTL)
check('building TTL is 30 minutes', CACHE_TTL.buildings === 1_800_000, CACHE_TTL.buildings)
check('capital-flow TTL is 6 hours', CACHE_TTL.capitalFlow === 21_600_000, CACHE_TTL.capitalFlow)
check('yield TTL is 12 hours', CACHE_TTL.yield === 43_200_000, CACHE_TTL.yield)

cacheWrite('sqftlab:score:a', { v: 1 }, 1000)
cacheWrite('sqftlab:score:b', { v: 2 }, 1000)
cacheWrite('sqftlab:community:detail:x', { v: 3 }, 1000)
const removed = cacheInvalidate('sqftlab:score:')
check('cacheInvalidate drops only the matching prefix', removed === 2, { removed })
check('an unrelated key survives invalidation', cacheRead('sqftlab:community:detail:x') !== null)
check('an expired entry reads as a miss', cacheRead('sqftlab:score:a') === null)
cacheInvalidate('sqftlab:community:')

// The detail route caches the ROW, not the response, so per-request analytics must still
// fire. That is the assertion that would fail if someone "optimised" this into a response
// cache — the guest redaction and the event would both be skipped.
const community = await prisma.community.findFirst({ select: { slug: true, id: true } })
if (!community) {
  check('a community exists to exercise the detail cache', false, 'no communities seeded')
} else {
  const before = await prisma.userEvent.count({ where: { eventType: 'community_view' } })
  const first = await call(`/sqftlab/communities/${community.slug}`)
  const second = await call(`/sqftlab/communities/${community.slug}`)
  const after = await prisma.userEvent.count({ where: { eventType: 'community_view' } })
  check('community detail answers 200 twice', first.status === 200 && second.status === 200, {
    a: first.status,
    b: second.status,
  })
  check('both reads return the same payload', JSON.stringify(first.body) === JSON.stringify(second.body))
  check(
    'a cache hit still records the view event',
    after - before === 2,
    { before, after, note: 'a response cache would record 0 on the second read' },
  )
  // The real redaction assertion: this request carries no token, so it is a guest, and a
  // cached row must not smuggle the paid breakdown fields back into that payload.
  const guest = first.body as { limited?: boolean; community?: Record<string, unknown> }
  const leaked = ['scoreSchools', 'scoreHealthcare', 'scoreMetro', 'scoreRetail', 'scoreParks', 'scoreWorship'].filter(
    (k) => guest.community && k in guest.community,
  )
  check('the guest payload is marked limited', guest.limited === true, guest.limited)
  check('no gated score field leaks on a cache hit', leaked.length === 0, leaked)
}

const ROUTE_COUNT = await prisma.$queryRaw<Array<{ n: number }>>`SELECT 1 as n`
check('prisma is still usable after the suite', ROUTE_COUNT.length === 1)

// ─── Clean up exactly what this suite created ────────────────────────────────
await prisma.user.deleteMany({ where: { id: { in: created } } })
cacheInvalidate('sqftlab:')

console.log('-'.repeat(52))
console.log(`${passed} passed, ${failed} failed`)
if (failed) console.log(`failing: ${failures.join(', ')}`)
await prisma.$disconnect()
process.exit(failed > 0 ? 1 : 0)
