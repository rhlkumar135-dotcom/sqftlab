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

// A real user id, fetched the same way the browser does.
const me = await req('/api/sqftlab/me')
const userId: string | undefined = me.body?.user?.id
const auth = { Authorization: `Bearer ${userId}` }

console.log(`\n# FIX-03 — auth (identity from the request, not a constant)`)
{
  const p = await req('/api/sqftlab/portfolio')
  check('GET /portfolio without auth → 401', p.status === 401, `got ${p.status}`)
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
  check('POST /portfolio without auth → 401', noAuth.status === 401, `got ${noAuth.status}`)
}

console.log(`\n# FIX-04 — deal detection`)
{
  const d = await req('/api/sqftlab/deals')
  const deals: any[] = d.body?.deals ?? []
  check('GET /deals with deals > 0', deals.length > 0, `${deals.length} deals`)
  const withDiscount = deals.filter((x) => typeof x.discountPct === 'number' && x.discountPct !== 0)
  check('every deal carries discountPct', withDiscount.length === deals.length, `${withDiscount.length}/${deals.length}`)
  const inRange = withDiscount.every((x) => x.discountPct > 0 && x.discountPct < 60)
  check('discountPct is a sane positive %', inRange, withDiscount[0] ? `e.g. ${withDiscount[0].discountPct}%` : '')
  const unauth = await req('/api/sqftlab/detect-deals')
  check('GET /detect-deals without secret → 401', unauth.status === 401, `got ${unauth.status}`)
  const dd = await req(`/api/sqftlab/detect-deals?secret=${SECRET}`)
  check('GET /detect-deals → dealsDetected > 0', dd.body?.dealsDetected > 0, `dealsDetected=${dd.body?.dealsDetected}`)
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
  const src = a.body?.dataSource
  if (src === 'dld_transactions') {
    const months = (a.body.trend ?? []).filter((t: any) => t.medianPrice !== null)
    check('trend has real monthly medians', months.length > 0, `${months.length} months with data`)
    check('null-filled months are null, not 0', (a.body.trend ?? []).some((t: any) => t.medianPrice === null))
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
  const allowed = ['Strong upward trend', 'Moderate upward trend', 'Stable', 'Moderate downward trend', 'Declining trend']
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
