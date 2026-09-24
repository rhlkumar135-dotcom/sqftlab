/**
 * End-to-end verification of the Part 6 intelligence products.
 *
 * Exercises the real Hono router and the real handlers against the real SQLite
 * database using Hono's in-process `app.request()` — no port binding, no
 * long-lived server. Prints status + a shape summary for each route so a
 * regression shows up as a wrong status or a missing field.
 *
 * Run: DATABASE_URL="file:./prisma/dev.db" bun run scripts/verify-intel.ts
 */

import app from '../custom-routes'
import { runIntelligencePipeline } from '../src/lib/intelligence'
import { prisma } from '../src/lib/db'

let pass = 0
let fail = 0

function check(name: string, cond: boolean, detail: string) {
  if (cond) { pass++; console.log(`  ✓ ${name} — ${detail}`) }
  else { fail++; console.log(`  ✗ ${name} — ${detail}`) }
}

async function hit(path: string, init?: RequestInit) {
  const res = await app.request(path, init)
  let body: unknown = null
  try { body = await res.json() } catch { body = null }
  return { status: res.status, body: body as Record<string, unknown> | null }
}

/**
 * Registered-transaction outputs (price index, building profiles, migration,
 * supply, district metrics) are only populated when transactions exist. With no
 * source connected the only correct behaviour is to return empty AND state why —
 * never to emit a number. This accepts either, and fails if an empty result is
 * presented without explanation.
 */
function explainedWhenEmpty(value: number, body: any): boolean {
  if (value > 0) return true
  const b = body ?? {}
  return (
    b.insufficientData === true ||
    b.insufficientHistory === true ||
    typeof b.reason === 'string' ||
    typeof b.message === 'string'
  )
}

function why(body: any): string {
  const b = body ?? {}
  return String(b.reason ?? b.message ?? (b.insufficientData ? 'insufficientData' : 'no explanation'))
}

async function main() {
  console.log('\n═══ 1. Run the intelligence pipeline ═══')
  const pipeline = await runIntelligencePipeline()
  console.log(`  duration ${pipeline.durationMs}ms`)
  console.log(`  rpi        : ${JSON.stringify(pipeline.rpi)}`)
  console.log(`  buildings  : ${JSON.stringify(pipeline.buildings)}`)
  console.log(`  migration  : ${JSON.stringify(pipeline.migration)}`)
  console.log(`  flow       : ${JSON.stringify(pipeline.flow)}`)
  console.log(`  supply     : ${JSON.stringify(pipeline.supply)}`)
  console.log(`  metrics    : ${JSON.stringify(pipeline.metrics)}`)
  console.log(`  macro      : ${JSON.stringify(pipeline.macro)}`)

  console.log('\n═══ 2. 6.1 Real Price Index ═══')
  {
    const r = await hit('/sqftlab/rpi')
    check('status 200', r.status === 200, `got ${r.status}`)
    check('index value present or explained',
      typeof r.body?.indexValue === 'number' || explainedWhenEmpty(0, r.body),
      typeof r.body?.indexValue === 'number' ? `indexValue=${r.body?.indexValue}` : why(r.body))
    check('has methodology', typeof r.body?.methodology === 'string', 'methodology present')
    check('segments populated or explained',
      explainedWhenEmpty(Number(r.body?.segments ?? 0), r.body),
      `segments=${r.body?.segments} ${Number(r.body?.segments ?? 0) > 0 ? '' : why(r.body)}`)
    console.log(`     → AED ${r.body?.indexValue}/sqft · ${r.body?.transactionCount} txns · monthly ${r.body?.monthlyChange?.toFixed?.(2) ?? r.body?.monthlyChange}%`)
  }

  console.log('\n═══ 3. 6.2 Building Intelligence ═══')
  {
    const list = await hit('/sqftlab/building')
    check('status 200', list.status === 200, `got ${list.status}`)
    check('buildings populated or explained',
      explainedWhenEmpty(Number(list.body?.count ?? 0), list.body),
      `count=${list.body?.count} ${Number(list.body?.count ?? 0) > 0 ? '' : why(list.body)}`)
    const b0 = (list.body?.buildings as Record<string, unknown>[])?.[0]
    if (b0) check('profile has score', typeof b0?.intelligenceScore === 'number', `score=${b0?.intelligenceScore}`)
    if (b0) check('profile has liquidity', b0?.liquidityScore != null, `liquidity=${b0?.liquidityScore}`)
    console.log(`     → "${b0?.buildingNameEn}" (${b0?.communityEn}) score ${b0?.intelligenceScore}, floorPremium ${b0?.floorPremiumPct?.toFixed?.(3) ?? b0?.floorPremiumPct}%/floor`)

    if (b0) {
      const slug = encodeURIComponent(`${b0.buildingNameEn}--${b0.communityEn}`)
      const one = await hit(`/sqftlab/building/${slug}`)
      check('detail status 200', one.status === 200, `got ${one.status}`)
      check('detail has interpretation', typeof one.body?.interpretation === 'object', 'interpretation present')
    }
    const missing = await hit('/sqftlab/building/__nope__')
    check('unknown slug → 404', missing.status === 404, `got ${missing.status}`)
  }

  console.log('\n═══ 4. 6.3 Yield Curve (honest insufficiency) ═══')
  {
    const dist = await prisma.community.findFirst({ select: { slug: true } })
    const r = await hit(`/sqftlab/yield-curve?district=${dist?.slug}`)
    check('status 200', r.status === 200, `got ${r.status}`)
    const honest = r.body?.insufficientHistory === true || typeof r.body?.yieldLagMonths === 'number'
    check('reports a lag OR insufficiency', honest, `insufficientHistory=${r.body?.insufficientHistory}`)
    console.log(`     → ${r.body?.insufficientHistory ? 'insufficientHistory (honest)' : `lag ${r.body?.yieldLagMonths}m`}`)
    const bad = await hit('/sqftlab/yield-curve?district=does-not-exist')
    check('unknown district → 404', bad.status === 404, `got ${bad.status}`)
    const noParam = await hit('/sqftlab/yield-curve')
    check('missing param → 400', noParam.status === 400, `got ${noParam.status}`)
  }

  console.log('\n═══ 5. 6.4 Migration Signal ═══')
  {
    const r = await hit('/sqftlab/migration')
    check('status 200', r.status === 200, `got ${r.status}`)
    check('flows populated or explained',
      explainedWhenEmpty(((r.body?.flows as unknown[])?.length ?? 0), r.body),
      `flows=${(r.body?.flows as unknown[])?.length} ${((r.body?.flows as unknown[])?.length ?? 0) > 0 ? '' : why(r.body)}`)
    console.log(`     → ${(r.body?.flows as unknown[])?.length} nationality flows, ${(r.body?.surges as unknown[])?.length} surges >25% MoM`)
  }

  console.log('\n═══ 6. 6.5 Institutional Flow ═══')
  {
    const r = await hit('/sqftlab/flow')
    check('status 200', r.status === 200, `got ${r.status}`)
    check('clusters populated or explained',
      explainedWhenEmpty(((r.body?.clusters as unknown[])?.length ?? 0), r.body),
      `clusters=${(r.body?.clusters as unknown[])?.length} ${((r.body?.clusters as unknown[])?.length ?? 0) > 0 ? '' : why(r.body)}`)
    const c0 = (r.body?.clusters as Record<string, unknown>[])?.[0]
    console.log(`     → ${(r.body?.clusters as unknown[])?.length} clusters, top: ${c0?.entityName} (${c0?.unitCount} units, AED ${Number(c0?.totalValue).toLocaleString()})`)
  }

  console.log('\n═══ 7. 6.6 Construction Pipeline ═══')
  {
    const r = await hit('/sqftlab/supply')
    check('status 200', r.status === 200, `got ${r.status}`)
    check('districts populated or explained',
      explainedWhenEmpty(((r.body?.districts as unknown[])?.length ?? 0), r.body),
      `districts=${(r.body?.districts as unknown[])?.length} ${((r.body?.districts as unknown[])?.length ?? 0) > 0 ? '' : why(r.body)}`)
    const hi = r.body?.highestPressure as Record<string, unknown> | undefined
    console.log(`     → highest pressure: ${hi?.district} (score ${hi?.pressureScore}, ${hi?.supplyMonths} months supply)`)
  }

  console.log('\n═══ 8. 6.7 Macro Sensitivity ═══')
  {
    const r = await hit('/sqftlab/macro')
    check('status 200', r.status === 200, `got ${r.status}`)
    const honest = r.body?.insufficientHistory === true || ((r.body?.sensitivities as unknown[])?.length ?? 0) > 0
    check('reports betas OR insufficiency', honest, `insufficientHistory=${r.body?.insufficientHistory}`)
    console.log(`     → ${r.body?.insufficientHistory ? `insufficient (missing: ${JSON.stringify(r.body?.missingIndicators)})` : `${(r.body?.sensitivities as unknown[])?.length} fitted`}`)

    const sc = await hit('/sqftlab/macro/scenario', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ district: 'downtown-dubai', oilPct: -20 }),
    })
    check('scenario honest 412 or 200', sc.status === 412 || sc.status === 200, `got ${sc.status}`)
  }

  console.log('\n═══ 9. Supporting endpoints ═══')
  {
    const d = await hit('/sqftlab/districts')
    check('/districts 200', d.status === 200, `got ${d.status}, count=${d.body?.count}`)
    const ms = await hit('/sqftlab/market-summary')
    check('/market-summary 200', ms.status === 200, `got ${ms.status}`)
    const st = await hit('/sqftlab/intelligence/status')
    check('/intelligence/status 200', st.status === 200, `got ${st.status}`)
    const fx = await hit('/sqftlab/fx')
    check('/fx 200', fx.status === 200, `USD=${(fx.body as Record<string, unknown>)?.usd}`)
    const co = await hit('/checkout', { method: 'POST' })
    check('/checkout → 503 kill switch', co.status === 503, `got ${co.status}`)
    const img = await hit('/sqftlab/img?url=' + encodeURIComponent('http://169.254.169.254/latest/meta-data/'))
    check('/img blocks SSRF (non-https)', img.status === 400 || img.status === 403, `got ${img.status}`)
    const img2 = await hit('/sqftlab/img?url=' + encodeURIComponent('https://evil.example.com/x.jpg'))
    check('/img blocks off-allowlist host', img2.status === 403, `got ${img2.status}`)
  }

  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══\n`)
  if (fail > 0) process.exitCode = 1
}

main()
  .catch((e) => { console.error('FATAL', e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
