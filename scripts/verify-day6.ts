// Day 6 verification — CMA tool (Part 1: the maths, and the running server).
//
// Run: bun run scripts/verify-day6.ts
//
// Part A exercises the pure valuation module directly. Part B exercises the RUNNING
// server, which is the deployment's real state: no DLD feed connected, so the CMA
// route's authenticated, well-formed answer is a refusal that says so.
//
// The happy path (a real valuation returned with comps) cannot be reached against
// this deployment's database, because it contains no recorded sales — that is the
// actual condition of the product, not a test gap. It is covered instead in
// scripts/verify-day6-e2e.ts, which seeds a DISPOSABLE COPY of the database with
// comparable sales, so the 200 branch is proven without inventing rows in the real
// one. See that file's header.
import './_env-guard'
import type { CmaComp } from '../src/lib/cma'

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
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 200)}`}`)
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

const CMA_BODY = {
  buildingName: 'Marina Gate',
  community: 'Dubai Marina',
  bedrooms: 2,
  sizeSqft: 1200,
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── PART A: valuation maths ──')
{
  const {
    median, percentile, floorAdjustment, conditionAdjustment, verdictFor, matchesBuilding,
    computeCma, MIN_COMPS, SIZE_TOLERANCE,
  } = await import('../src/lib/cma')

  check('MIN_COMPS is 3 (fewer is not a market)', MIN_COMPS === 3, MIN_COMPS)
  check('size tolerance is ±20%', SIZE_TOLERANCE === 0.2, SIZE_TOLERANCE)

  // ── median ──
  check('median of an odd set is the middle value', median([100, 200, 300]) === 200)
  check('median of an even set averages the middle pair', median([100, 200, 300, 400]) === 250)
  check('median of a single value is that value', median([7]) === 7)

  // ── percentile (nearest rank) ──
  check('p25/p75 of 4 values', percentile([100, 200, 300, 400], 0.25) === 200 && percentile([100, 200, 300, 400], 0.75) === 400)
  check('p25/p75 of 3 values stay in range', percentile([100, 200, 300], 0.25) === 100 && percentile([100, 200, 300], 0.75) === 300)
  check('percentile never reads past the end', Number.isFinite(percentile([5, 6, 7], 0.99)))

  // ── floor adjustment: +0.5%/floor, capped at +10% ──
  check('no floor → no adjustment', floorAdjustment(null) === 0)
  check('ground floor → no adjustment', floorAdjustment(0) === 0)
  check('floor 4 → +2%', Math.abs(floorAdjustment(4) - 0.02) < 1e-9, floorAdjustment(4))
  check('floor 20 → +10% (cap)', floorAdjustment(20) === 0.1, floorAdjustment(20))
  check('floor 100 → still +10% (cap holds)', floorAdjustment(100) === 0.1, floorAdjustment(100))

  // ── condition ──
  check('excellent → +5%', conditionAdjustment('excellent') === 0.05)
  check('poor → -8%', conditionAdjustment('poor') === -0.08)
  check('good/average/null carry no premium', conditionAdjustment('good') === 0 && conditionAdjustment('average') === 0 && conditionAdjustment(null) === 0)

  // ── verdict thresholds, at and either side of every boundary ──
  check('verdict -8.1 → strong deal', verdictFor(-8.1).startsWith('Strong deal'), verdictFor(-8.1))
  check('verdict -8 → fair value', verdictFor(-8).startsWith('Fair value'), verdictFor(-8))
  check('verdict 0 → at market', verdictFor(0).startsWith('At market'), verdictFor(0))
  check('verdict 7.9 → at market', verdictFor(7.9).startsWith('At market'), verdictFor(7.9))
  check('verdict 8 → above market', verdictFor(8).startsWith('Above market'), verdictFor(8))
  check('verdict 19.9 → above market', verdictFor(19.9).startsWith('Above market'), verdictFor(19.9))
  check('verdict 20 → overpriced', verdictFor(20).startsWith('Overpriced'), verdictFor(20))

  // ── building matching ──
  check('building match is case-insensitive', matchesBuilding('MARINA GATE', 'marina gate'))
  check('building match accepts a longer comp name', matchesBuilding('Marina Gate Tower 1', 'Marina Gate'))
  check('building match accepts a shorter comp name', matchesBuilding('Marina', 'Marina Gate'))
  check('null / empty building never matches', !matchesBuilding(null, 'Marina Gate') && !matchesBuilding('Marina Gate', '  '))

  // ── computeCma ──
  const day = 86_400_000
  const comp = (psf: number, over: Partial<CmaComp> = {}): CmaComp => ({
    transactionDate: new Date(Date.now() - 10 * day),
    pricePerSqft: psf,
    priceAed: psf * 1000,
    areaSqft: 1000,
    floorNumber: 5,
    buildingName: 'Marina Gate',
    ...over,
  })

  check('computeCma refuses an empty comp set', computeCma(
    { buildingName: 'Marina Gate', community: 'Dubai Marina', bedrooms: 2, sizeSqft: 1000, floor: null, condition: null, listingPrice: null },
    [],
  ) === null)

  check('computeCma drops a zero-PSF row rather than skewing the median', computeCma(
    { buildingName: 'Marina Gate', community: 'Dubai Marina', bedrooms: 2, sizeSqft: 1000, floor: null, condition: null, listingPrice: null },
    [comp(0), comp(0)],
  ) === null)

  // Four same-building comps at 1000/1000/1000/1000 → median 1000, no adjustments.
  const flat = [comp(1000), comp(1000), comp(1000), comp(1000)]
  const base = computeCma(
    { buildingName: 'Marina Gate', community: 'Dubai Marina', bedrooms: 2, sizeSqft: 1000, floor: null, condition: null, listingPrice: null },
    flat,
  )!
  check('flat comps → estimate is psf × size', base.estimatedValueAed === 1_000_000, base.estimatedValueAed)
  check('flat comps → median/avg/p25/p75 all equal', base.medianPsf === 1000 && base.avgPsf === 1000 && base.p25Psf === 1000 && base.p75Psf === 1000)
  check('no floor + no condition → no adjustment applied', base.adjustedPsf === 1000 && base.floorAdjustmentPct === 0 && base.conditionAdjPct === 0)
  check('enough same-building comps → basis is "building"', base.compBasis === 'building', base.compBasis)

  // Adjustments are ADDITIVE, per the brief's `1 + floorAdj + condAdj`. Additive is
  // also the honest choice for this UI: each adjustment is displayed as its own
  // percentage, so +10% floor and +5% condition must add up to the +15% the estimate
  // reflects. Multiplicative composition would show two numbers that do not sum to
  // the change the user can see in the value.
  const adj = computeCma(
    { buildingName: 'Marina Gate', community: 'Dubai Marina', bedrooms: 2, sizeSqft: 1000, floor: 20, condition: 'excellent', listingPrice: null },
    flat,
  )!
  check('floor +10% and condition +5% add to +15%', adj.adjustedPsf === 1150, adj.adjustedPsf)
  check('adjusted PSF drives the estimate', adj.estimatedValueAed === 1_150_000, adj.estimatedValueAed)
  check('adjustments are reported separately', adj.floorAdjustmentPct === 10 && adj.conditionAdjPct === 5)

  // Below-minimum same-building comps fall back to the community, and say so.
  const twoInBuilding = [comp(1000), comp(1000), comp(2000, { buildingName: 'Other Tower' }), comp(2000, { buildingName: 'Other Tower' })]
  const fellBack = computeCma(
    { buildingName: 'Marina Gate', community: 'Dubai Marina', bedrooms: 2, sizeSqft: 1000, floor: null, condition: null, listingPrice: null },
    twoInBuilding,
  )!
  check('2 same-building comps is too few → falls back to the community', fellBack.compBasis === 'community', fellBack.compBasis)
  check('fallback reports how many were in the building', fellBack.sameBuildingCount === 2 && fellBack.compsUsed === 4)

  // Listing premium + verdict.
  const deal = computeCma(
    { buildingName: 'Marina Gate', community: 'Dubai Marina', bedrooms: 2, sizeSqft: 1000, floor: null, condition: null, listingPrice: 900_000 },
    flat,
  )!
  check('asking below the estimate → negative premium', deal.listingPremiumPct === -10, deal.listingPremiumPct)
  check('premium drives a "strong deal" verdict', deal.verdict !== null && deal.verdict.startsWith('Strong deal'), deal.verdict)

  const rich = computeCma(
    { buildingName: 'Marina Gate', community: 'Dubai Marina', bedrooms: 2, sizeSqft: 1000, floor: null, condition: null, listingPrice: 1_500_000 },
    flat,
  )!
  check('asking way above the estimate → overpriced verdict', rich.listingPremiumPct === 50 && rich.verdict !== null && rich.verdict.startsWith('Overpriced'), rich.verdict)

  const noAsk = computeCma(
    { buildingName: 'Marina Gate', community: 'Dubai Marina', bedrooms: 2, sizeSqft: 1000, floor: null, condition: null, listingPrice: null },
    flat,
  )!
  check('no asking price → no premium and no verdict (not a guess)', noAsk.listingPremiumPct === null && noAsk.verdict === null)

  // Recent comps: newest first, capped at 10, ISO dates.
  const many = Array.from({ length: 14 }, (_, i) => comp(1000 + i, { transactionDate: new Date(Date.now() - i * day) }))
  const capped = computeCma(
    { buildingName: 'Marina Gate', community: 'Dubai Marina', bedrooms: 2, sizeSqft: 1000, floor: null, condition: null, listingPrice: null },
    many,
  )!
  check('recentComps is capped at 10', capped.recentComps.length === 10, capped.recentComps.length)
  check('recentComps is newest-first', capped.recentComps[0].date >= capped.recentComps[9].date)
  check('recentComps dates are ISO days', /^\d{4}-\d{2}-\d{2}$/.test(capped.recentComps[0].date), capped.recentComps[0].date)

  // Every number that leaves this module must be finite: JSON.stringify turns NaN
  // and Infinity into null, which the UI would render as a blank cell instead of an
  // error, so a non-finite value here would be invisible in production.
  const numericLeaves = [
    base, adj, fellBack, deal, rich,
  ].flatMap((r) => [
    r.medianPsf, r.avgPsf, r.p25Psf, r.p75Psf, r.adjustedPsf, r.estimatedValueAed,
    r.floorAdjustmentPct, r.conditionAdjPct, r.compsUsed, r.compsInCommunity, r.sameBuildingCount,
  ])
  check('no non-finite number escapes computeCma', numericLeaves.every((n) => Number.isFinite(n)), numericLeaves.filter((n) => !Number.isFinite(n)))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── PART B: the running server ──')
const r1 = await req('/api/sqftlab/cma', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(CMA_BODY) })
check('POST /sqftlab/cma without auth → 401', r1.status === 401, { status: r1.status, body: r1.body })
check('401 body says Unauthorized', r1.body?.error === 'Unauthorized', r1.body)

const { prisma } = await import('../src/lib/db')
const demo = await prisma.user.findFirst({
  where: { email: process.env.DEMO_USER_EMAIL ?? 'demo@sqftlab.com' },
  select: { id: true, subscriptionTier: true, subscriptionStatus: true },
})
if (!demo) throw new Error('demo user not found — cannot exercise the authenticated paths')

const demoRes = await req('/api/sqftlab/cma', {
  method: 'POST',
  headers: { Authorization: `Bearer ${demo.id}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(CMA_BODY),
})
check(
  `elite (demo) tier → 403 upgrade required`,
  demoRes.status === 403,
  { status: demoRes.status, tier: demo.subscriptionTier, body: demoRes.body },
)
check('403 names the CMA Tool and the required tier', demoRes.body?.feature === 'CMA Tool' && demoRes.body?.requiredTier === 'enterprise', demoRes.body)
check('403 reports the caller tier honestly (elite, not free)', demoRes.body?.currentTier === demo.subscriptionTier, { reported: demoRes.body?.currentTier, actual: demo.subscriptionTier })
check('403 points at the upgrade path', demoRes.body?.upgradeUrl === '/pricing', demoRes.body?.upgradeUrl)

// The tiers ABOVE enterprise must pass the gate. Proven with a throwaway account so
// the real deployment's single user is never promoted, and deleted in `finally`.
const slug = `cma-verify-${Date.now()}`
let entId: string | null = null
try {
  const ent = await prisma.user.create({
    data: { email: `${slug}@example.invalid`, subscriptionTier: 'enterprise', subscriptionStatus: 'active' },
    select: { id: true },
  })
  entId = ent.id
  const auth = { Authorization: `Bearer ${entId}`, 'Content-Type': 'application/json' }

  const ok400 = await req('/api/sqftlab/cma', { method: 'POST', headers: auth, body: JSON.stringify({ bedrooms: 'x' }) })
  check('enterprise + missing fields → 400 (not 403)', ok400.status === 400, { status: ok400.status, body: ok400.body })
  check('400 lists the offending fields', Array.isArray(ok400.body?.fields) && (ok400.body!.fields as string[]).includes('buildingName'), ok400.body?.fields)
  check('400 lists the required fields and what each expects', ok400.body?.expected !== undefined && ok400.body!.expected !== null)

  const badBody = await req('/api/sqftlab/cma', { method: 'POST', headers: auth, body: 'not json' })
  check('enterprise + unparseable body → 400, not a 500', badBody.status === 400, { status: badBody.status, body: badBody.body })

  const negSize = await req('/api/sqftlab/cma', { method: 'POST', headers: auth, body: JSON.stringify({ ...CMA_BODY, sizeSqft: -5 }) })
  check('enterprise + negative size → 400', negSize.status === 400 && (negSize.body?.fields as string[])?.includes('sizeSqft'), { status: negSize.status, fields: negSize.body?.fields })

  const badCond = await req('/api/sqftlab/cma', { method: 'POST', headers: auth, body: JSON.stringify({ ...CMA_BODY, condition: 'pristine' }) })
  check('enterprise + unknown condition → 400', badCond.status === 400 && (badCond.body?.fields as string[])?.includes('condition'), { status: badCond.status, fields: badCond.body?.fields })

  const noArea = await req('/api/sqftlab/cma', { method: 'POST', headers: auth, body: JSON.stringify({ ...CMA_BODY, community: 'Atlantis The Palm Underwater' }) })
  check('enterprise + unknown community → 422 with communityFound:false', noArea.status === 422 && noArea.body?.communityFound === false, { status: noArea.status, body: noArea.body })

  // The live, user-facing answer. This deployment has no government feed, so the
  // honest response is a refusal that NAMES the missing source rather than "try a
  // broader area" (which would send the user hunting for data that is not there).
  const live = await req('/api/sqftlab/cma', { method: 'POST', headers: auth, body: JSON.stringify(CMA_BODY) })
  check('enterprise + valid body → 422 (no recorded sales on this deployment)', live.status === 422, { status: live.status, body: live.body })
  check('422 reports compsFound', typeof live.body?.compsFound === 'number', live.body?.compsFound)
  check('422 flags dldConnected:false', live.body?.dldConnected === false, live.body?.dldConnected)
  check(
    '422 explains the feed is not connected instead of blaming the search',
    typeof live.body?.message === 'string' && /not connected/i.test(live.body.message as string),
    live.body?.message,
  )
  check('422 error string matches the brief', live.body?.error === 'Insufficient comparable transactions', live.body?.error)

  // No valuation-shaped keys on a refusal: a partial payload would let a UI render
  // an empty estimate as if it were a real one.
  check('422 carries no estimatedValueAed', live.body?.estimatedValueAed === undefined)
} finally {
  if (entId) {
    // Events first: UserEvent.userId references User, so the row would block the
    // delete. The server's tier cache holds this id, but the account is gone and no
    // further request can carry it, so the stale entry is inert.
    await prisma.userEvent.deleteMany({ where: { userId: entId } })
    await prisma.user.delete({ where: { id: entId } })
  }
}
{
  const leftover = await prisma.user.findUnique({ where: { email: `${slug}@example.invalid` } })
  check('throwaway verification account was cleaned up', leftover === null)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── PART C: the page is wired, and says what it does ──')
{
  const pageSrc = await Bun.file('src/components/CmaPage.tsx').text()
  const appSrc = await Bun.file('src/App.tsx').text()

  // `authedFetch` rather than a plain fetch: the route resolves the caller from the
  // request, so a bare call arrives as a guest. See src/lib/session.ts.
  check('CMA page posts to the API route with its identity', pageSrc.includes("authedFetch('/api/sqftlab/cma'"))
  check('CMA page reads the caller tier with its identity', pageSrc.includes("authedFetch('/api/sqftlab/me')"))
  check('CMA page offers the Run CMA action', pageSrc.includes('Run CMA'))
  check('CMA page renders the estimated value in AED', pageSrc.includes('AED {aed.format(result.estimatedValueAed)}'))
  check('CMA page renders the market range (P25/Median/P75/Avg)', ['P25', 'Median', 'P75', 'Average'].every((k) => pageSrc.includes(k)))
  check('CMA page renders the comparable transactions table', pageSrc.includes('Comparable transactions'))
  // Day 7 Task C replaced this placeholder with a working export. This suite asserted
  // the placeholder, so left alone it would fail against the very change that was asked
  // for. It now asserts the wiring; the route itself is exercised end to end by
  // verify-day7-e2e.ts, which renders a real PDF.
  check('CMA page offers the PDF report download', pageSrc.includes('Download PDF report'))
  check('the PDF button no longer claims to be coming soon', !pageSrc.includes('Coming soon'))
  check('the PDF button posts to the report route with its identity',
    pageSrc.includes("authedFetch('/api/sqftlab/report/property'"))
  check('the PDF button is enabled only once a valuation exists', pageSrc.includes('disabled={pdfBusy || !result}'))
  check('a PDF failure shows the server message, never a browser alert',
    pageSrc.includes('body.message ?? body.error') && !pageSrc.includes('alert('))
  check('non-enterprise sees a blur gate', pageSrc.includes("filter: 'blur(6px)'"))
  check('gate CTA says Upgrade to Enterprise', pageSrc.includes('Upgrade to Enterprise'))
  check('gate is UX only — the server still enforces it', (await Bun.file('custom-routes.ts').text()).includes("requireTier(c, 'enterprise', 'CMA Tool')"))
  check('gate names the visitor\u2019s actual plan', pageSrc.includes('your plan:'))
  check('no invented valuation when the API refuses', pageSrc.includes('failure.message'))

  check('App registers the CMA page', appSrc.includes("page === 'cma' && <CmaPage"))
  // Day 13: resolution moved from a hardcoded `if (path === '/cma')` to a PAGE_PATHS
  // lookup, because the chain had silently dropped /export and /market-pulse. Assert the
  // path is published AND that resolution is data-driven.
  check(
    'App routes /cma to the CMA page',
    /cma:\s*'\/cma'/.test(appSrc) &&
      /const fromPath = \(Object\.keys\(PAGE_PATHS\) as Page\[\]\)\.find/.test(appSrc),
  )
  check('App exposes CMA in navigation', appSrc.includes("{ id: 'cma' as Page, label: 'CMA'"))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`)
console.log(`  ${passed} passed, ${failed} failed`)
if (failures.length) {
  console.log('\n  Failures:')
  for (const f of failures) console.log(`    ✗ ${f}`)
}
console.log(`${'─'.repeat(60)}\n`)
process.exit(failed === 0 ? 0 : 1)
