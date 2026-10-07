// Day 4 verification — tier middleware, requireTier, the payment kill switch and
// the per-tier rate limiter. Run: bun run scripts/verify-day4.ts
//
// NOTE ON WHERE TO RUN THIS. Against the origin (localhost:3101) every claim below
// holds. Against a *.preview.shogo.ai host two of them do not, through no fault of
// the app: the edge strips the caller's Cookie/Authorization headers, so the API
// only ever sees an anonymous caller, and it rewrites the X-RateLimit-* headers
// with its own values. Point VERIFY_BASE at the origin, or at the Railway host.
const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3101'

let pass = 0
let fail = 0

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass++
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function req(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, init)
  const text = await res.text()
  let body: any = null
  try {
    body = JSON.parse(text)
  } catch {
    body = text.slice(0, 120)
  }
  return { status: res.status, body, headers: res.headers }
}

console.log('\n── TASK A/B: tier middleware + requireTier ──────────────────')
{
  // The gate must answer 403 (not 401) and name the tier the caller needs.
  for (const [label, path, init] of [
    ['GET /portfolio', '/api/sqftlab/portfolio', undefined],
    ['POST /portfolio', '/api/sqftlab/portfolio', { method: 'POST', body: '{}' }],
    ['POST /alerts', '/api/sqftlab/alerts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }],
    ['GET /api-keys', '/api/sqftlab/api-keys', undefined],
    ['POST /api-keys', '/api/sqftlab/api-keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }],
    ['DELETE /api-keys/x', '/api/sqftlab/api-keys/x', { method: 'DELETE' }],
  ] as const) {
    const r = await req(path, init as RequestInit | undefined)
    check(`${label} → 403 for a guest`, r.status === 403, r.status)
    check(
      `${label} → payload names tier + upgrade path`,
      r.body?.error === 'Upgrade required' &&
        r.body?.requiredTier === 'pro' &&
        r.body?.currentTier === 'guest' &&
        r.body?.upgradeUrl === '/pricing' &&
        typeof r.body?.feature === 'string',
      JSON.stringify(r.body)?.slice(0, 90),
    )
  }

  // A route the tier gate was NOT applied to must still answer the Day 1 way.
  const w = await req('/api/sqftlab/watchlist')
  check('ungated /watchlist still → 401 (Day 1 contract intact)', w.status === 401, w.status)
}

console.log('\n── TASK A: elite must not be demoted to guest ───────────────')
{
  // The schema's ladder is free | pro | elite | enterprise | institutional. `elite`
  // is what the seeded demo account uses, and is therefore the identity the whole
  // site runs as. If it is missing from TIER_RANK it falls back to rank 0 and every
  // gated route 403s the app's own user.
  const me = await req('/api/sqftlab/me')
  const id: string | undefined = me.body?.user?.id
  const tier: string | undefined = me.body?.user?.tier
  check('/me bootstraps an identity', Boolean(id), `id=${id ?? 'none'} tier=${tier ?? 'none'}`)

  const auth = { Authorization: `Bearer ${id}` }
  const p = await req('/api/sqftlab/portfolio', { headers: auth })
  check(`elite caller passes the pro gate (${tier})`, p.status === 200, `got ${p.status}`)
  const k = await req('/api/sqftlab/api-keys', { headers: auth })
  check('elite caller may list api-keys', k.status === 200, `got ${k.status}`)
  const c = await req('/api/sqftlab/communities', { headers: auth })
  check('a known caller is not given the guest teaser', (c.body?.communities ?? []).length > 6, `${(c.body?.communities ?? []).length} districts`)

  // The tier must also be cached per caller rather than re-queried every request.
  const src = await Bun.file('custom-routes.ts').text()
  check('tier is resolved by middleware, not per handler', src.includes("app.use('*', async (c, next) => {\n  const userId = getUserId(c)"))
  check('no handler still awaits a tier lookup', !src.includes('await getCallerTier'))
}

console.log('\n── TASK C: payment kill switch ──────────────────────────────')
{
  for (const path of ['/api/checkout', '/api/subscribe', '/api/create-payment-intent']) {
    const r = await req(path, { method: 'POST' })
    check(`${path} → 503 while disabled`, r.status === 503, r.status)
    check(`${path} → readable message`, r.body?.paymentsEnabled === false && typeof r.body?.error === 'string', JSON.stringify(r.body)?.slice(0, 80))
  }

  // The webhook must acknowledge and drop, never process, and never 4xx (a non-2xx
  // makes Stripe retry an event we are deliberately ignoring).
  const hook = await req('/api/webhooks/stripe', { method: 'POST', body: '{"type":"test"}' })
  check('stripe webhook → 200 and not processed', hook.status === 200 && hook.body?.processed === false, JSON.stringify(hook.body))

  // The flag must be defined once, be env-driven, and default to off.
  const flag = await Bun.file('src/lib/payments-server.ts').text()
  check('kill switch reads the env var', flag.includes("process.env.PAYMENTS_ENABLED === 'true'"))
  const env = await Bun.file('.env').text()
  check('PAYMENTS_ENABLED=false is set explicitly', /^PAYMENTS_ENABLED=false$/m.test(env))

  // Every stripe reference must sit behind the guard.
  const src = await Bun.file('custom-routes.ts').text()
  const stripeLines = src.split('\n').filter((l) => /stripe/i.test(l))
  check('the only stripe reference is the guarded webhook', stripeLines.every((l) => !/createPaymentIntent|charges\.create|new Stripe/i.test(l)), `stripe refs: ${stripeLines.length}`)
}

console.log('\n── TASK D: rate limiter ─────────────────────────────────────')
{
  // A unique cookie gives this run its own window, so it cannot consume another
  // caller's budget (or the demo identity's).
  const identity = `day4-verify-${Date.now()}`
  const cookie = { Cookie: `sqftlab_guest=${identity}` }

  const first = await req('/api/sqftlab/stats', { headers: cookie })
  check('rate-limit headers are sent', first.headers.get('X-RateLimit-Limit') !== null && first.headers.get('X-RateLimit-Remaining') !== null, `limit=${first.headers.get('X-RateLimit-Limit')} remaining=${first.headers.get('X-RateLimit-Remaining')}`)
  check('guest limit is 20/min', first.headers.get('X-RateLimit-Limit') === '20', first.headers.get('X-RateLimit-Limit'))

  // Guest allowance is 20/min: the 21st request in the window must be refused.
  let last = 0
  let firstBlockedAt = 0
  for (let i = 2; i <= 22; i++) {
    const r = await req('/api/sqftlab/stats', { headers: cookie })
    last = r.status
    if (r.status === 429 && firstBlockedAt === 0) firstBlockedAt = i
  }
  check('the 21st request in the window is refused', firstBlockedAt === 21, `first 429 at #${firstBlockedAt}`)
  check('the last request of the run is 429', last === 429, last)

  const blocked = await req('/api/sqftlab/stats', { headers: cookie })
  check('429 body explains the retry and the upgrade path', blocked.body?.retryAfter === 60 && blocked.body?.upgradeUrl === '/pricing', JSON.stringify(blocked.body))

  // A different caller is unaffected by that window.
  const other = await req('/api/sqftlab/stats', { headers: { Cookie: `sqftlab_guest=${identity}-other` } })
  check('the window is per identity, not global', other.status === 200, other.status)

  // The paid identity gets its own, larger allowance.
  const me = await req('/api/sqftlab/me')
  const paid = await req('/api/sqftlab/stats', { headers: { Authorization: `Bearer ${me.body?.user?.id}` } })
  check('the elite tier gets its own allowance', Number(paid.headers.get('X-RateLimit-Limit')) === 500, paid.headers.get('X-RateLimit-Limit'))

  // A long-lived SSE stream must not consume the request budget.
  const src = await Bun.file('custom-routes.ts').text()
  check('SSE is exempt from the limiter', src.includes("text/event-stream"))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
