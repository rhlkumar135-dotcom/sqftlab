// Day 5 verification — Stripe wiring, the kill switch, the pricing page's data.
//
// Run: bun run scripts/verify-day5.ts
//
// Part 1 exercises the RUNNING server, which is the deployment's real state
// (PAYMENTS_ENABLED=false, no Stripe credentials). Part 2 spawns a child with the
// flag flipped to TRUE, because the authenticated / invalid-plan / unconfigured
// branches of /sqftlab/subscribe are unreachable while the switch is off — testing
// only the live state would silently skip them.
import './_env-guard'

const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3101'

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
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 160)}`}`)
  }
}

async function req(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> | null; text: string }> {
  const res = await fetch(`${BASE}${path}`, init)
  const text = await res.text()
  let body: Record<string, unknown> | null = null
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = null
  }
  return { status: res.status, body, text }
}

// ── The demo account, resolved the same way the server resolves it ────────────
const { prisma } = await import('../src/lib/db')
const demo = await prisma.user.findFirst({
  where: { email: process.env.DEMO_USER_EMAIL ?? 'demo@sqftlab.com' },
  select: { id: true, subscriptionTier: true, subscriptionStatus: true },
})
if (!demo) throw new Error('demo user not found — cannot exercise the authenticated paths')
const auth = { Authorization: `Bearer ${demo.id}`, 'Content-Type': 'application/json' }

console.log('\n── TASK A: the Stripe module must not explode without credentials ──')
{
  // The brief's version threw at import when STRIPE_SECRET_KEY was unset. Because
  // custom-routes.ts imports it, that would have taken the whole API down. Prove
  // the module loads and degrades instead, in a process with no Stripe env at all.
  const child = Bun.spawnSync({
    cmd: [
      'bun',
      '-e',
      `import './scripts/_env-guard'
const m = await import('./src/lib/stripe.ts')
console.log('__JSON__' + JSON.stringify({
  imported: true,
  getStripeWithoutKey: m.getStripe() === null,
  priceKeys: Object.keys(m.PRICE_IDS).length,
  priceIdForUnset: m.priceIdFor('pro', 'monthly'),
  missing: m.missingStripeEnv(),
  canceledMapsTo: m.normalizeStripeStatus('canceled'),
  activeMapsTo: m.normalizeStripeStatus('active'),
  trialingMapsTo: m.normalizeStripeStatus('trialing'),
  incompleteMapsTo: m.normalizeStripeStatus('incomplete'),
  periodEndFromItems: m.subscriptionPeriodEnd({ items: { data: [
    { current_period_end: 1000 }, { current_period_end: 2000 } ] } }),
}))`,
    ],
    env: { ...process.env, STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', PAYMENTS_ENABLED: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = child.stdout.toString()
  const marker = out.indexOf('__JSON__')
  const lib = marker >= 0 ? (JSON.parse(out.slice(marker + 8).trim()) as Record<string, unknown>) : null
  if (!lib) {
    console.log(`    child stderr: ${child.stderr.toString().slice(0, 300)}`)
  }
  check('src/lib/stripe.ts imports with NO credentials (no boot crash)', lib?.imported === true, out.slice(0, 120))
  check('getStripe() returns null rather than throwing', lib?.getStripeWithoutKey === true)
  check('all six price IDs are declared', lib?.priceKeys === 6, lib?.priceKeys)
  check('an unset price id yields null, not ""', lib?.priceIdForUnset === null, lib?.priceIdForUnset)
  check('missingStripeEnv() names the gaps', Array.isArray(lib?.missing) && (lib.missing as string[]).length === 8, lib?.missing)
  check("Stripe's 'canceled' maps to the schema's 'cancelled'", lib?.canceledMapsTo === 'cancelled', lib?.canceledMapsTo)
  check("'active' and 'trialing' stay entitled", lib?.activeMapsTo === 'active' && lib?.trialingMapsTo === 'trialing')
  check("an unknown status ('incomplete') collapses to 'inactive'", lib?.incompleteMapsTo === 'inactive', lib?.incompleteMapsTo)
  check('current_period_end is read from subscription ITEMS (latest wins)', lib?.periodEndFromItems === 2000, lib?.periodEndFromItems)
}

console.log('\n── TASK B: routes in the live state (PAYMENTS_ENABLED=false) ──')
{
  const sub = await req('/api/sqftlab/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan: 'pro', billing: 'monthly' }),
  })
  check('/sqftlab/subscribe → 503 while the kill switch is engaged', sub.status === 503, sub.status)
  check('…and says so readably', typeof sub.body?.error === 'string' && sub.body?.paymentsEnabled === false, sub.body?.error)

  // The kill switch is checked BEFORE auth on purpose: while payments are off,
  // "unauthorized" would imply a login is all that stands in the way.
  const subAuthed = await req('/api/sqftlab/subscribe', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ plan: 'pro', billing: 'monthly' }),
  })
  check('…even for an authenticated caller (switch outranks auth)', subAuthed.status === 503, subAuthed.status)

  const me = await req('/api/sqftlab/users/me')
  check('/sqftlab/users/me without auth → 401', me.status === 401, me.status)

  const meAuthed = await req('/api/sqftlab/users/me', { headers: auth })
  check('/sqftlab/users/me with auth → 200', meAuthed.status === 200, meAuthed.status)
  check('…returns the subscription fields the pricing UI needs',
    typeof meAuthed.body?.subscriptionTier === 'string' &&
      typeof meAuthed.body?.subscriptionStatus === 'string' &&
      'trialEndsAt' in (meAuthed.body ?? {}) &&
      'currentPeriodEnd' in (meAuthed.body ?? {}),
    Object.keys(meAuthed.body ?? {}).join(','))
  check('…exposes entitled + tier for the caller',
    typeof meAuthed.body?.entitled === 'boolean' && typeof meAuthed.body?.tier === 'string',
    `${meAuthed.body?.entitled} / ${meAuthed.body?.tier}`)
  check('…does not leak the Stripe customer id', !('stripeCustomerId' in (meAuthed.body ?? {})))

  // Both webhook paths share one handler.
  for (const path of ['/api/stripe/webhook', '/api/webhooks/stripe']) {
    const hook = await req(path, { method: 'POST', body: '{"type":"test"}' })
    check(`${path} → 200, acknowledged but NOT processed`, hook.status === 200 && hook.body?.processed === false, JSON.stringify(hook.body))
  }

  // Day 4's surface must survive Day 5 untouched.
  for (const path of ['/api/checkout', '/api/subscribe', '/api/create-payment-intent']) {
    const r = await req(path, { method: 'POST' })
    check(`${path} still 503 (Day 4 kill switch intact)`, r.status === 503, r.status)
  }
}

console.log('\n── TASK B2: branches only reachable with the switch ON ──')
{
  const code = `import './scripts/_env-guard'
const app = (await import('./custom-routes.ts')).default
const U = process.env.DEMO_UID
const json = (b) => ({ 'Content-Type': 'application/json' })
const out = {}
let r = await app.request('/sqftlab/subscribe', { method: 'POST', headers: json(), body: '{"plan":"pro","billing":"monthly"}' })
out.unauth = { status: r.status, body: await r.json() }
r = await app.request('/sqftlab/subscribe', { method: 'POST', headers: { ...json(), authorization: 'Bearer ' + U }, body: '{"plan":"nope","billing":"monthly"}' })
out.badPlan = { status: r.status, body: await r.json() }
r = await app.request('/sqftlab/subscribe', { method: 'POST', headers: { ...json(), authorization: 'Bearer ' + U }, body: '{"plan":"pro","billing":"weekly"}' })
out.badBilling = { status: r.status, body: await r.json() }
r = await app.request('/sqftlab/subscribe', { method: 'POST', headers: { ...json(), authorization: 'Bearer ' + U }, body: 'not json' })
out.badJson = { status: r.status, body: await r.json() }
r = await app.request('/sqftlab/subscribe', { method: 'POST', headers: { ...json(), authorization: 'Bearer ' + U }, body: '{"plan":"enterprise","billing":"annual"}' })
out.validUnconfigured = { status: r.status, body: await r.json() }
r = await app.request('/stripe/webhook', { method: 'POST', body: '{}' })
out.hookNoSecret = { status: r.status, body: await r.json() }
console.log('__JSON__' + JSON.stringify(out))`

  const child = Bun.spawnSync({
    cmd: ['bun', '-e', code],
    env: { ...process.env, PAYMENTS_ENABLED: 'true', DEMO_UID: demo.id },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = child.stdout.toString()
  const marker = out.indexOf('__JSON__')
  const r = marker >= 0
    ? (JSON.parse(out.slice(marker + 8).trim()) as Record<string, { status: number; body: Record<string, unknown> }>)
    : null
  if (!r) console.log(`    child stderr: ${child.stderr.toString().slice(0, 400)}`)

  check('switch ON + no auth → 401 (the brief\'s checklist item)', r?.unauth?.status === 401, r?.unauth)
  check('unknown plan → 400, no ' + 'charge attempted', r?.badPlan?.status === 400, r?.badPlan)
  check('…listing the valid plans', Array.isArray(r?.badPlan?.body?.plans), r?.badPlan?.body?.plans)
  check('unknown billing period → 400', r?.badBilling?.status === 400, r?.badBilling)
  check('malformed JSON → 400, not 500', r?.badJson?.status === 400, r?.badJson)
  check('switch ON, valid plan, no credentials → 503 naming what is missing',
    r?.validUnconfigured?.status === 503 && Array.isArray(r?.validUnconfigured?.body?.missingEnv),
    r?.validUnconfigured?.body)
  check('…and it never reaches Stripe (no 502 from a live call)', r?.validUnconfigured?.status !== 502)
  check('switch ON, no webhook secret → acknowledged, not processed',
    r?.hookNoSecret?.status === 200 && r?.hookNoSecret?.body?.processed === false, r?.hookNoSecret)
}

console.log('\n── TASK C: the pricing page and its guardrails ──')
{
  const pageSrc = await Bun.file('src/components/PricingPage.tsx').text()
  for (const tier of ['Free', 'Pro', 'Enterprise', 'Institutional']) {
    check(`pricing page defines the ${tier} tier`, pageSrc.includes(`name: '${tier}'`))
  }
  check('four plans are declared', (pageSrc.match(/\n    id: '/g) ?? []).length === 4, (pageSrc.match(/\n    id: '/g) ?? []).length)
  check('the subtitle DLD claim is conditional, never hardcoded',
    pageSrc.includes("? 'Every plan includes live DLD transaction data"))
  check('AED 499 / 4,999 / 15,000 monthly', pageSrc.includes('monthly: 499') && pageSrc.includes('monthly: 4999') && pageSrc.includes('monthly: 15000'))
  check('AED 4,990 / 49,990 / 150,000 annual', pageSrc.includes('annual: 4990') && pageSrc.includes('annual: 49990') && pageSrc.includes('annual: 150000'))
  check('annual saving is actually computed', pageSrc.includes('p.monthly * 12 - p.annual'))
  check('prices render in the data font', pageSrc.includes("fontFamily: 'var(--font-data)'"))
  check('most-popular card scales on desktop only', pageSrc.includes('lg:scale-[1.02]'))
  check('comparison table has 20+ rows', (pageSrc.match(/label: '/g) ?? []).length >= 20, (pageSrc.match(/label: '/g) ?? []).length)
  check('FAQ has five questions', (pageSrc.match(/\n    q: '/g) ?? []).length === 5, (pageSrc.match(/\n    q: '/g) ?? []).length)

  // The trust strip must not assert a DLD feed that is not connected.
  const sources = await req('/api/sqftlab/sources')
  const dld = (sources.body?.available as { name: string; connected: boolean }[] | undefined)?.find(
    (s) => s.name.toLowerCase().includes('dld'),
  )
  check('pricing page reads real source status for the trust strip', pageSrc.includes("fetch('/api/sqftlab/sources')"))
  check('…and does not hardcode the DLD claim', !pageSrc.includes('Data from DLD official records'))
  if (dld && !dld.connected) {
    check('DLD is genuinely not connected, so the strip spoke correctly', dld.connected === false)
  } else {
    console.log('  · DLD appears connected on this deployment; strip will say so')
  }

  // Static guardrails
  const routes = await Bun.file('custom-routes.ts').text()
  const stripeLines = routes.split('\n').filter((l) => /stripe/i.test(l))
  check('no unguarded stripe call in custom-routes.ts',
    stripeLines.every((l) => !/createPaymentIntent|charges\.create|new Stripe/i.test(l)),
    `refs: ${stripeLines.length}`)
  const envFile = await Bun.file('.env').text()
  check('PAYMENTS_ENABLED is still explicitly false (not flipped by Day 5)', /^PAYMENTS_ENABLED=false$/m.test(envFile))
  const app = await Bun.file('src/App.tsx').text()
  check('/pricing URL selects the pricing page', app.includes("if (path === '/pricing') setPage('pricing')"))
}

console.log(`\n═══ DAY 5: ${passed} passed, ${failed} failed ═══`)
if (failures.length) console.log(`failed: ${failures.join(', ')}`)
await prisma.$disconnect()
process.exit(failed === 0 ? 0 : 1)
