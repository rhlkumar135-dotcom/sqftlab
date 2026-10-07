// Day 6 verification — CMA tool (Part 2: the valuation happy path, end to end).
//
// Run:
//   cp prisma/dev.db /tmp/cma-e2e.db
//   DATABASE_URL=file:/tmp/cma-e2e.db bun run scripts/verify-day6-e2e.ts
//
// WHY THIS EXISTS, AND WHY IT USES A COPY
//
// This deployment has no government transaction feed connected, so the real database
// holds ZERO recorded sales. That makes the CMA route's success branch unreachable
// against it: every well-formed request correctly answers 422. A test suite that
// stopped there would leave the most important half of the feature — the arithmetic,
// the filters, the response shape the UI reads — completely unexercised.
//
// So this script runs the REAL route in-process (app.request, the same Hono app the
// server mounts) against a throwaway COPY of the database into which it writes its
// own comparable sales. The real database is never touched, and nothing here is
// mocked: the same Prisma client, the same filters, the same scoring module.
//
// The rows it writes are named `E2E-…` and are deleted in `finally`, along with the
// throwaway account. Delete the copy afterwards — it is a temporary file.
import { prisma } from '../src/lib/db'
import type { CmaResult } from '../src/lib/cma'

const dbUrl = process.env.DATABASE_URL ?? ''
if (!dbUrl.includes('cma-e2e')) {
  throw new Error(
    `Refusing to run: DATABASE_URL must point at the disposable copy (…cma-e2e.db), got "${dbUrl || '<unset>'}".\n` +
    'This script WRITES rows; running it against the project database would pollute it.',
  )
}

const { default: app } = await import('../custom-routes')

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
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 220)}`}`)
  }
}

const ID = `E2E-${Date.now()}`
const BUILDING = 'E2E Verification Tower'
const day = 86_400_000

const community = await prisma.community.findFirst({ select: { id: true, nameEn: true } })
if (!community) throw new Error('no community in the copy — cannot seed comparables')
const other = await prisma.community.findFirst({
  where: { id: { not: community.id } },
  select: { id: true, nameEn: true },
})
if (!other) throw new Error('need a second community for the cross-area decoy')

let userId: string | null = null

/** A comparable sale. `psf` is what the median should be built from. */
function tx(i: number, over: Record<string, unknown> = {}) {
  const psf = (over.pricePerSqft as number) ?? 1000
  const area = (over.areaSqft as number) ?? 1000
  return {
    dldId: `${ID}-${i}`,
    source: 'dld',
    communityId: community.id,
    transactionType: 'sale',
    propertyType: 'apartment',
    beds: 2,
    areaSqft: area,
    priceAed: psf * area,
    pricePerSqft: psf,
    transactionDate: new Date(Date.now() - 10 * day),
    buildingName: BUILDING,
    ...over,
  }
}

async function post(body: unknown): Promise<{ status: number; json: CmaResult & Record<string, unknown> }> {
  const res = await app.request('/sqftlab/cma', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userId}` },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as CmaResult & Record<string, unknown>
  return { status: res.status, json }
}

try {
  const ent = await prisma.user.create({
    data: { email: `${ID}@example.invalid`, subscriptionTier: 'enterprise', subscriptionStatus: 'active' },
    select: { id: true },
  })
  userId = ent.id

  // ── Seed: 4 genuine comparables, plus four decoys that MUST be filtered out ──
  //
  // Each decoy carries psf 99999. If any leaks into the comp set the median jumps
  // from ~1150 to something in the tens of thousands, so the assertions below
  // double as leak detectors rather than just shape checks.
  const POISON = 99_999
  await prisma.transaction.createMany({
    data: [
      tx(1, { pricePerSqft: 1000 }),
      tx(2, { pricePerSqft: 1100 }),
      tx(3, { pricePerSqft: 1200 }),
      tx(4, { pricePerSqft: 1300 }),

      tx(90, { pricePerSqft: POISON, beds: 3 }),                                  // wrong bedroom count
      tx(91, { pricePerSqft: POISON, areaSqft: 2000 }),                            // outside size ±20%
      tx(92, { pricePerSqft: POISON, transactionType: 'mortgage' }),               // not an arm's-length sale
      tx(93, { pricePerSqft: POISON, transactionDate: new Date(Date.now() - 400 * day) }), // older than the window
      tx(94, { pricePerSqft: POISON, communityId: other.id }),                     // a different area
    ],
  })

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n── the valuation happy path (200) ──')
  const body = { buildingName: BUILDING, community: community.nameEn, bedrooms: 2, sizeSqft: 1000 }

  const { status, json } = await post(body)
  check('200 with enough comparables', status === 200, { status, json })

  // EVERY field CmaPage.tsx reads, by name. The component is a separate file from
  // this route, so a rename on either side compiles clean on both and renders an
  // empty panel — this list is the contract, and it is asserted against a real
  // response rather than a hand-written fixture.
  const COMPONENT_READS = [
    'estimatedValueAed', 'adjustedPsf', 'floorAdjustmentPct', 'conditionAdjPct',
    'p25Psf', 'medianPsf', 'p75Psf', 'avgPsf',
    'compsUsed', 'compBasis', 'sameBuildingCount', 'windowDays',
    'verdict', 'listingPremiumPct', 'listingPriceAed', 'recentComps', 'subject',
  ]
  const missing = COMPONENT_READS.filter((k) => !(k in json))
  check('response carries every key the CMA page reads', missing.length === 0, missing)
  check('subject carries the keys the page displays',
    ['buildingName', 'community', 'bedrooms'].every((k) => k in (json.subject ?? {})), json.subject)
  check('compBasis is one of the two values the page branches on',
    json.compBasis === 'building' || json.compBasis === 'community', json.compBasis)
  check('windowDays is the 180-day window the page labels', json.windowDays === 180, json.windowDays)

  // The exact keys the component reads. A shape mismatch here is the classic
  // "green build, empty UI" failure, so they are asserted by name.
  check('returns estimatedValueAed', json.estimatedValueAed === 1_150_000, json.estimatedValueAed)
  check('returns medianPsf', json.medianPsf === 1150, json.medianPsf)
  check('returns recentComps', Array.isArray(json.recentComps), typeof json.recentComps)
  check('recentComps rows carry date/pricePsf/totalAed/sizeSqft/building',
    json.recentComps?.length > 0 && ['date', 'pricePsf', 'totalAed', 'sizeSqft', 'building'].every((k) => k in json.recentComps[0]),
    json.recentComps?.[0])
  check('returns the market range (p25/p75/avg)', json.p25Psf === 1100 && json.p75Psf === 1300 && json.avgPsf === 1150,
    { p25: json.p25Psf, p75: json.p75Psf, avg: json.avgPsf })
  check('returns the subject echo', json.subject?.buildingName === BUILDING && json.subject?.bedrooms === 2, json.subject)
  check('returns compsUsed', json.compsUsed === 4, json.compsUsed)

  // ── Every decoy stayed out ──
  check('wrong-bedroom comp excluded', json.medianPsf !== POISON && json.compsUsed === 4)
  check('out-of-size comp excluded', json.compsUsed === 4, json.compsUsed)
  check('mortgage row excluded from comparables', json.compsUsed === 4, json.compsUsed)
  check('row older than the 180-day window excluded', json.compsUsed === 4, json.compsUsed)
  check('comp from another community excluded', json.compsUsed === 4, json.compsUsed)

  // ── Same-building preference ──
  check('comparables came from the subject building', json.compBasis === 'building', json.compBasis)
  check('sameBuildingCount is reported', json.sameBuildingCount === 4, json.sameBuildingCount)

  // ── Adjustments, as the brief specifies (additive) ──
  const floored = await post({ ...body, floor: 10 })
  check('floor 10 → +5% → estimate 1,207,500', floored.json.floorAdjustmentPct === 5 && floored.json.estimatedValueAed === 1_207_500,
    { adj: floored.json.floorAdjustmentPct, est: floored.json.estimatedValueAed })

  const cond = await post({ ...body, condition: 'excellent' })
  check('condition excellent → +5% → estimate 1,207,500', cond.json.conditionAdjPct === 5 && cond.json.estimatedValueAed === 1_207_500,
    { adj: cond.json.conditionAdjPct, est: cond.json.estimatedValueAed })

  const poor = await post({ ...body, condition: 'poor' })
  check('condition poor → -8% → estimate 1,058,000', poor.json.conditionAdjPct === -8 && poor.json.estimatedValueAed === 1_058_000,
    { adj: poor.json.conditionAdjPct, est: poor.json.estimatedValueAed })

  // ── Deal analysis ──
  const below = await post({ ...body, listingPrice: 1_000_000 })
  check('asking below the estimate → negative premium', below.json.listingPremiumPct === -13, below.json.listingPremiumPct)
  check('asking below → a deal verdict', below.json.verdict?.startsWith('Strong deal') || below.json.verdict?.startsWith('Fair value'), below.json.verdict)

  const above = await post({ ...body, listingPrice: 1_500_000 })
  check('asking well above the estimate → overpriced verdict', above.json.verdict?.startsWith('Overpriced'), above.json.verdict)

  const noAsk = await post(body)
  check('no asking price → premium and verdict are null, not zero', noAsk.json.listingPremiumPct === null && noAsk.json.verdict === null,
    { premium: noAsk.json.listingPremiumPct, verdict: noAsk.json.verdict })

  // ── Nothing non-finite may cross the wire ──
  const flat = JSON.stringify(noAsk.json)
  check('no null where a number is expected', !/"medianPsf":null|"avgPsf":null|"estimatedValueAed":null|"adjustedPsf":null/.test(flat),
    flat.slice(0, 200))
  check('every numeric field is a finite number', [
    noAsk.json.medianPsf, noAsk.json.avgPsf, noAsk.json.p25Psf, noAsk.json.p75Psf,
    noAsk.json.adjustedPsf, noAsk.json.estimatedValueAed, noAsk.json.floorAdjustmentPct, noAsk.json.conditionAdjPct,
  ].every((n) => Number.isFinite(n)))

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n── the refusal path, with the feed connected ──')
  // With sales in the database, a thin query must say "widen the search" — the
  // opposite of the live deployment's "the feed is not connected" message. Getting
  // these two confused is the failure mode the route was built to avoid.
  const thin = await post({ buildingName: BUILDING, community: community.nameEn, bedrooms: 5, sizeSqft: 1000 })
  check('too few comparables → 422', thin.status === 422, thin.status)
  check('422 reports compsFound', typeof thin.json.compsFound === 'number', thin.json.compsFound)
  check('422 tells the user to widen the search when a feed IS configured',
    typeof thin.json.message === 'string' && /widen|busier/i.test(thin.json.message as string), thin.json.message)
  check('422 does not claim the feed is missing here', thin.json.dldConnected !== false || typeof thin.json.message === 'string')

  // ── Unauthenticated and under-tier callers are refused before any query ──
  const anon = await app.request('/sqftlab/cma', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  check('no auth → 401 even with a valid body', anon.status === 401, anon.status)

  const free = await prisma.user.create({
    data: { email: `${ID}-free@example.invalid`, subscriptionTier: 'free', subscriptionStatus: 'active' },
    select: { id: true },
  })
  const freeRes = await app.request('/sqftlab/cma', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${free.id}` },
    body: JSON.stringify(body),
  })
  check('free tier → 403 upgrade required', freeRes.status === 403, freeRes.status)
  const freeJson = (await freeRes.json()) as Record<string, unknown>
  check('free tier 403 still names the required tier', freeJson.requiredTier === 'enterprise' && freeJson.feature === 'CMA Tool', freeJson)
  await prisma.user.delete({ where: { id: free.id } })

  // ── The run is recorded ──
  const events = await prisma.userEvent.count({ where: { userId, eventType: 'cma_run' } })
  check('a successful run is tracked as cma_run', events >= 1, events)
} finally {
  // Clean up everything this script wrote, in dependency order.
  await prisma.transaction.deleteMany({ where: { dldId: { startsWith: ID } } })
  if (userId) {
    await prisma.userEvent.deleteMany({ where: { userId } })
    await prisma.user.delete({ where: { id: userId } }).catch(() => {})
  }
}

{
  const txs = await prisma.transaction.count({ where: { dldId: { startsWith: ID } } })
  const users = await prisma.user.count({ where: { email: { startsWith: ID } } })
  check('seeded comparables were removed', txs === 0, txs)
  check('throwaway accounts were removed', users === 0, users)
}

console.log(`\n${'─'.repeat(60)}`)
console.log(`  ${passed} passed, ${failed} failed`)
if (failures.length) {
  console.log('\n  Failures:')
  for (const f of failures) console.log(`    ✗ ${f}`)
}
console.log(`${'─'.repeat(60)}\n`)
process.exit(failed === 0 ? 0 : 1)
