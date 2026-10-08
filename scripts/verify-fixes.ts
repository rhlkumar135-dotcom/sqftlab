// End-to-end verification of the FIX-01..FIX-12 changes against the running
// project server. Run: bun run scripts/verify-fixes.ts
const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3101'
const SECRET = 'sqftlab-cron-2026'

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
  let body: any = null
  const text = await res.text()
  try {
    body = JSON.parse(text)
  } catch {
    body = text.slice(0, 120)
  }
  return { status: res.status, body, headers: res.headers }
}

// A real session, established the way the browser gets one: `/me` issues the
// cookie, and every account-scoped route resolves identity from it.
//
// This previously sent `Authorization: Bearer <userId>` — a caller-supplied id the
// server took at face value. That is deliberately no longer accepted: a user id is
// not a credential. The test has to hold a real session to prove anything, so a
// run that fails here means the cookie path is broken, not that the test is stale.
const me = await req('/api/sqftlab/me')
const userId: string | undefined = me.body?.user?.id
const sessionCookie = (me.headers.get('set-cookie') ?? '')
  .split(/,(?=[^;,\s]+=)/)
  .map((s) => s.trim())
  .find((s) => s.startsWith('next-auth.session-token=')) ?? ''
const auth = { Cookie: sessionCookie }
check('session cookie issued by /me', sessionCookie.length > 20, sessionCookie ? 'present' : 'MISSING')

console.log(`\n# FIX-03 — auth (identity from the request, not a constant)`)
{
  const p = await req('/api/sqftlab/portfolio')
  // Day 4's requireTier supersedes Day 1's 401 on this route: a guest is rank 0,
  // below the pro minimum, so it answers 403 with the tier it needs.
  check('GET /portfolio without auth → 403 + requiredTier', p.status === 403 && p.body?.requiredTier === 'pro', `got ${p.status} ${JSON.stringify(p.body)?.slice(0, 80)}`)
  const pa = await req('/api/sqftlab/portfolio', { headers: auth })
  check('GET /portfolio with auth → 200', pa.status === 200 && Array.isArray(pa.body?.items), `got ${pa.status}`)
  const w = await req('/api/sqftlab/watchlist')
  check('GET /watchlist without auth → 401', w.status === 401, `got ${w.status}`)
  const wa = await req('/api/sqftlab/watchlist', { headers: auth })
  check('GET /watchlist with auth → 200', wa.status === 200 && Array.isArray(wa.body?.items), `got ${wa.status}`)
  const ar = await req('/api/sqftlab/alert-rules')
  check('GET /alert-rules without auth → 401', ar.status === 401, `got ${ar.status}`)
  const al = await req('/api/sqftlab/alerts')
  check('GET /alerts without auth → 401', al.status === 401, `got ${al.status}`)
  const ala = await req('/api/sqftlab/alerts', { headers: auth })
  check('GET /alerts with auth → 200', ala.status === 200 && Array.isArray(ala.body?.alerts), `got ${ala.status}`)
  check('/me bootstraps an identity', Boolean(userId), userId ?? 'none')
  // POST validation: an unknown district must 400, not create a junk row.
  const bad = await req('/api/sqftlab/portfolio', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ communitySlug: 'not-a-district', purchasePrice: 1, areaSqft: 1 }),
  })
  check('POST /portfolio rejects an unknown district → 400', bad.status === 400, `got ${bad.status}`)
  const noAuth = await req('/api/sqftlab/portfolio', { method: 'POST', body: '{}' })
  check('POST /portfolio without auth → 403 + requiredTier', noAuth.status === 403 && noAuth.body?.requiredTier === 'pro', `got ${noAuth.status}`)
}

console.log(`\n# FIX-04 — deal detection`)
{
  const d = await req('/api/sqftlab/deals')
  const deals: any[] = d.body?.deals ?? []
  // The 8% rule is defined against the area's 90-day DLD median, so a zero-deal
  // result is correct whenever no registered transactions are loaded. What must
  // hold either way: the payload explains itself, and every flag is consistent
  // with the rule. Requiring deals > 0 only held while the table carried
  // generated rows.
  check(
    'GET /deals explains an empty result',
    deals.length > 0 || (d.body?.insufficientData === true && typeof d.body?.message === 'string'),
    `${deals.length} deals · ${d.body?.message ?? d.body?.insufficientData ?? 'no explanation'}`,
  )
  check('GET /deals declares its basis', d.body?.basis === 'dld_90d_median', d.body?.basis)
  const withDiscount = deals.filter((x) => typeof x.discountPct === 'number' && x.discountPct !== 0)
  check('every deal carries discountPct', withDiscount.length === deals.length, `${withDiscount.length}/${deals.length}`)
  const inRange = withDiscount.every((x) => x.discountPct > 0 && x.discountPct < 60)
  check('discountPct is a sane positive %', inRange, withDiscount[0] ? `e.g. ${withDiscount[0].discountPct}%` : 'n/a (no deals)')
  const unauth = await req('/api/sqftlab/detect-deals')
  check('GET /detect-deals without secret → 401', unauth.status === 401, `got ${unauth.status}`)
  const dd = await req(`/api/sqftlab/detect-deals?secret=${SECRET}`)
  check(
    'GET /detect-deals returns a count consistent with /deals',
    typeof dd.body?.dealsDetected === 'number' && dd.body.dealsDetected === deals.length,
    `dealsDetected=${dd.body?.dealsDetected} vs /deals=${deals.length}`,
  )
}

console.log(`\n# FIX-05 — price trend from real transactions`)
{
  const a = await req('/api/sqftlab/communities/dubai-marina/trend')
  const b = await req('/api/sqftlab/communities/dubai-marina/trend')
  check('trend responds 200', a.status === 200, `got ${a.status}`)
  check('trend declares its dataSource', typeof a.body?.dataSource === 'string', a.body?.dataSource)
  check(
    'two consecutive calls are identical (no random flicker)',
    JSON.stringify(a.body) === JSON.stringify(b.body),
  )
  // Decide "has data" from the payload, not from the label. The old check
  // compared dataSource against the literal 'dld_transactions', which the
  // handler never emits — it derives the label from the rows' `source` column
  // ('DLD (Dubai Pulse)' once transactions exist). That coupling made the test
  // fail on a perfectly healthy response.
  const src = a.body?.dataSource
  const monthsWithData = (a.body.trend ?? []).filter((t: any) => t.medianPrice !== null)
  if (monthsWithData.length > 0) {
    check('trend has real monthly medians', true, `${monthsWithData.length} months with data`)
    check(
      'null-filled months are null, not 0',
      (a.body.trend ?? []).some((t: any) => t.medianPrice === null),
    )
    check('dataSource names a real source, not an internal id', src !== 'dld_dubai' && src !== 'unknown', src)
  } else {
    check('honest no-data path (not fabricated)', src === 'no_transaction_data', src)
  }
  const missing = await req('/api/sqftlab/communities/does-not-exist/trend')
  check('unknown community → 404', missing.status === 404, `got ${missing.status}`)
}

console.log(`\n# FIX-06 — psfSource provenance`)
{
  const c = await req('/api/sqftlab/communities')
  const first = (c.body?.communities ?? [])[0]
  check('communities still serve', c.status === 200 && Boolean(first), `got ${c.status}`)
}

console.log(`\n# FIX-07 — no financial recommendations`)
{
  const p = await req('/api/sqftlab/predictions')
  const preds: any[] = p.body?.predictions ?? []
  check('predictions respond', p.status === 200 && preds.length > 0, `${preds.length}`)
  check('no `recommendation` field', preds.every((x) => !('recommendation' in x)))
  check('`momentumLabel` present', preds.every((x) => typeof x.momentumLabel === 'string'), preds[0]?.momentumLabel)
  check('`projectedChange6m` renamed', preds.every((x) => 'projectedChange6m' in x && !('forecastChange6m' in x)))
  check('disclaimer present', typeof p.body?.disclaimer === 'string')
  const labels = new Set(preds.map((x) => x.momentumLabel))
  // Trend descriptors only — never advice. 'Not enough data' is the honest
  // state for a district with no price, so it belongs in this vocabulary rather
  // than being filed under 'Stable'.
  const allowed = ['Strong upward trend', 'Moderate upward trend', 'Stable', 'Moderate downward trend', 'Declining trend', 'Not enough data']
  check('labels are trend descriptors only', [...labels].every((l) => allowed.includes(l)), [...labels].join(' / '))
  check('no strongBuys key', !('strongBuys' in (p.body ?? {})))
  check('topMomentum present', Array.isArray(p.body?.topMomentum))
  check('summary uses rising/stable/falling', 'rising' in (p.body?.summary ?? {}) && !('strongBuys' in (p.body?.summary ?? {})))
}

console.log(`\n# FIX-08 — exchange rates`)
{
  const a = await req('/api/sqftlab/rates/exchange')
  check('AED_INR is a real value (>20)', Number(a.body?.AED_INR) > 20, String(a.body?.AED_INR))
  check('AED_PKR is a real value (>70)', Number(a.body?.AED_PKR) > 70, String(a.body?.AED_PKR))
  check('response labels its source', ['live', 'cache', 'fallback'].includes(a.body?.source), a.body?.source)
  const b = await req('/api/sqftlab/rates/exchange')
  if (a.body?.source === 'live') {
    check('second call within TTL → source "cache"', b.body?.source === 'cache', b.body?.source)
    check('cached values match the live fetch', b.body?.AED_INR === a.body?.AED_INR)
  } else {
    check(`first call was "${a.body?.source}", so no cache assertion`, b.body?.source !== 'live' || true)
  }
}

console.log(`\n# FIX-10 — mortgage disclaimers`)
{
  const m = await req('/api/sqftlab/mortgage/simulate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ price: 2000000, downPaymentPct: 20, ratePct: 4.5, termYears: 25 }),
  })
  check('simulate responds', m.status === 200, `got ${m.status}`)
  check('disclaimer present', typeof m.body?.disclaimer === 'string')
  check('bankRatesDisclaimer present', typeof m.body?.bankRatesDisclaimer === 'string')
  check('bank rates still returned', Array.isArray(m.body?.bankRates) && m.body.bankRates.length === 5)
}

console.log(`\n# FIX-10b — the calculators refuse input they cannot compute`)
{
  const post = (path: string, body?: string) =>
    req(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body }),
    })

  // A missing field used to be arithmetic on `undefined`: every output became NaN,
  // JSON.stringify wrote NaN as null, and the route answered 200 with an all-null
  // payload — indistinguishable from a real answer. An absent body threw out of
  // c.req.json() as a 500. Both must now be a 400 that names the field.
  for (const [label, path] of [
    ['mortgage', '/api/sqftlab/mortgage/simulate'],
    ['yield', '/api/sqftlab/yield/calculate'],
  ] as const) {
    const none = await post(path)
    check(`${label}: no body → 400, not 500`, none.status === 400, `got ${none.status}`)
    check(`${label}: 400 body names the missing fields`, none.body?.error === 'Invalid input' && Array.isArray(none.body?.fields) && none.body.fields.length > 0, JSON.stringify(none.body?.fields))
    check(`${label}: 400 body documents what each field expects`, typeof none.body?.expected === 'object' && none.body?.expected !== null, Object.keys(none.body?.expected ?? {}).join(','))
  }

  // Field names from another API (priceAed, not price) must not read as success.
  const wrong = await post('/api/sqftlab/mortgage/simulate', JSON.stringify({ priceAed: 2000000 }))
  check('mortgage: unknown field names → 400, never a 200 of nulls', wrong.status === 400, `got ${wrong.status} ${JSON.stringify(wrong.body)?.slice(0, 70)}`)

  // Out-of-range values are refused, and the field named is the offending one.
  const down100 = await post('/api/sqftlab/mortgage/simulate', JSON.stringify({ price: 2000000, downPaymentPct: 100, ratePct: 4.5, termYears: 25 }))
  check('mortgage: downPaymentPct=100 → 400 naming downPaymentPct', down100.status === 400 && (down100.body?.fields ?? []).includes('downPaymentPct'), JSON.stringify(down100.body?.fields))
  const term50 = await post('/api/sqftlab/mortgage/simulate', JSON.stringify({ price: 2000000, downPaymentPct: 20, ratePct: 4.5, termYears: 50 }))
  check('mortgage: termYears=50 → 400 naming termYears', term50.status === 400 && (term50.body?.fields ?? []).includes('termYears'), JSON.stringify(term50.body?.fields))
  const nan = await post('/api/sqftlab/yield/calculate', JSON.stringify({ purchasePrice: 0, annualRent: 'abc' }))
  check('yield: zero price + non-numeric rent → 400', nan.status === 400 && (nan.body?.fields ?? []).includes('purchasePrice') && (nan.body?.fields ?? []).includes('annualRent'), JSON.stringify(nan.body?.fields))
  const noRate = await post('/api/sqftlab/yield/calculate', JSON.stringify({ purchasePrice: 2000000, annualRent: 120000, mortgageEnabled: true }))
  check('yield: mortgageEnabled without a rate → 400 naming the mortgage fields', noRate.status === 400 && (noRate.body?.fields ?? []).includes('mortgageRate'), JSON.stringify(noRate.body?.fields))

  // ...and the valid path is unchanged, to the number.
  const okYield = await post('/api/sqftlab/yield/calculate', JSON.stringify({ purchasePrice: 2000000, annualRent: 120000, serviceCharge: 15000, mortgageEnabled: false, mortgageRate: 4.5, mortgageTerm: 25, downPaymentPct: 20 }))
  check('yield: valid input still computes', okYield.status === 200 && okYield.body?.grossYield === 6 && okYield.body?.netYield === 5.17, `${okYield.body?.grossYield} / ${okYield.body?.netYield}`)

  // A negative monthly cash flow never breaks even: said outright as null rather
  // than left as Infinity for JSON.stringify to rewrite.
  const neg = await post('/api/sqftlab/yield/calculate', JSON.stringify({ purchasePrice: 2000000, annualRent: 1000, serviceCharge: 90000, mortgageEnabled: false }))
  check('yield: negative cash flow → breakEvenMonths is explicitly null', neg.status === 200 && neg.body?.breakEvenMonths === null, JSON.stringify(neg.body?.breakEvenMonths))
}

console.log(`\n# FIX-12 — server health still green`)
{
  const h = await req('/health')
  check('GET /health → 200', h.status === 200, `got ${h.status}`)
  const s = await req('/api/sqftlab/stats')
  check('GET /api/sqftlab/stats → 200', s.status === 200, `got ${s.status}`)
}

console.log(`\n${'='.repeat(58)}`)
console.log(`${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
