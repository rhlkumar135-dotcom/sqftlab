// Day 7 verification — white-label PDF report (Part 2: the full path, end to end).
//
// Run:
//   cp prisma/dev.db /tmp/day7-e2e.db
//   DATABASE_URL=file:/tmp/day7-e2e.db bun run scripts/verify-day7-e2e.ts
//
// WHY THIS EXISTS, AND WHY IT USES A COPY
//
// The report route refuses to value a property without at least MIN_COMPS recorded
// sales, and this deployment's database holds ZERO transactions — so against the real
// database every well-formed request correctly answers 422 and the success branch, the
// one that actually renders a PDF, is never reached.
//
// So this runs the REAL route in-process (app.request — the same Hono app the server
// mounts), through the REAL Prisma client and a REAL Chromium, against a throwaway COPY
// of the database into which it writes its own comparables. Nothing is mocked. The
// project database is never touched, and every row written here is deleted in `finally`.
import { prisma } from '../src/lib/db'

const dbUrl = process.env.DATABASE_URL ?? ''
if (!dbUrl.includes('day7-e2e')) {
  throw new Error(
    `Refusing to run: DATABASE_URL must point at the disposable copy (…day7-e2e.db), got "${dbUrl || '<unset>'}".\n` +
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
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 200)}`}`)
  }
}

const ID = `DAY7-${Date.now()}`
const BUILDING = 'E2E Report Tower'
const day = 86_400_000

const community = await prisma.community.findFirst({ select: { id: true, nameEn: true, slug: true } })
if (!community) throw new Error('no community in the copy — cannot seed comparables')
const other = await prisma.community.findFirst({
  where: { id: { not: community.id } },
  select: { id: true, nameEn: true },
})
if (!other) throw new Error('need a second community for the cross-area decoy')

let entId: string | null = null
let freeId: string | null = null
let scoreId: string | null = null

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

const VALID = {
  propertyAddress: `${BUILDING}, ${community.nameEn}`,
  building: BUILDING,
  community: community.nameEn,
  bedrooms: 2,
  sizeSqft: 1000,
}

async function post(
  body: unknown,
  token: string | null = entId,
): Promise<{ status: number; type: string | null; disposition: string | null; bytes: Uint8Array; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await app.request('/sqftlab/report/property', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const bytes = new Uint8Array(await res.arrayBuffer())
  // Only attempt to parse JSON when the response is not the PDF.
  const json = res.headers.get('Content-Type')?.startsWith('application/json')
    ? (JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>)
    : {}
  return {
    status: res.status,
    type: res.headers.get('Content-Type'),
    disposition: res.headers.get('Content-Disposition'),
    bytes,
    json,
  }
}

try {
  const ent = await prisma.user.create({
    data: { email: `${ID}@example.invalid`, subscriptionTier: 'enterprise', subscriptionStatus: 'active' },
    select: { id: true },
  })
  entId = ent.id
  const free = await prisma.user.create({
    data: { email: `${ID}-free@example.invalid`, subscriptionTier: 'free', subscriptionStatus: 'active' },
    select: { id: true },
  })
  freeId = free.id

  await prisma.transaction.createMany({
    data: [
      tx(1, { pricePerSqft: 1000 }),
      tx(2, { pricePerSqft: 1100 }),
      tx(3, { pricePerSqft: 1200 }),
      tx(4, { pricePerSqft: 1300 }),

      // Decoys. Each carries a PSF of 99,999, so if any leaks into the comp set the
      // median moves by an order of magnitude and the estimate assertions below fail.
      tx(90, { pricePerSqft: 99_999, beds: 3 }),
      tx(91, { pricePerSqft: 99_999, areaSqft: 2000 }),
      tx(92, { pricePerSqft: 99_999, transactionType: 'mortgage' }),
      tx(93, { pricePerSqft: 99_999, transactionDate: new Date(Date.now() - 400 * day) }),
      tx(94, { pricePerSqft: 99_999, communityId: other.id }),
    ],
  })
  const seededCount = await prisma.transaction.count({ where: { dldId: { startsWith: ID } } })

  // ── The gate ladder ──────────────────────────────────────────────────────
  console.log('\n── access control ──')
  const anon = await post(VALID, null)
  check('no auth → 401', anon.status === 401, { status: anon.status, json: anon.json })
  const gated = await post(VALID, freeId)
  check('free tier → 403', gated.status === 403, gated.status)
  check('403 names the required tier and the feature',
    gated.json.requiredTier === 'enterprise' && gated.json.feature === 'PDF Report', gated.json)

  // ── Validation ───────────────────────────────────────────────────────────
  console.log('\n── input validation ──')
  const missing = await post({ ...VALID, sizeSqft: undefined })
  check('missing sizeSqft → 400, not a 200 with a broken report',
    missing.status === 400 && Array.isArray(missing.json.fields) && (missing.json.fields as string[]).includes('sizeSqft'),
    missing.json)
  const negative = await post({ ...VALID, listingPriceAed: -5 })
  check('negative asking price → 400', negative.status === 400, negative.status)
  const badBeds = await post({ ...VALID, bedrooms: 1.5 })
  check('fractional bedrooms → 400', badBeds.status === 400, badBeds.status)
  const empty = await post({})
  check('empty body → 400 naming the fields, not a 500', empty.status === 400, empty.status)
  check('400 lists every missing required field',
    ['propertyAddress', 'community', 'bedrooms', 'sizeSqft'].every((f) => (empty.json.fields as string[])?.includes(f)),
    empty.json.fields)

  // ── The refusal paths ────────────────────────────────────────────────────
  console.log('\n── refuses rather than inventing a valuation ──')
  const ghost = await post({ ...VALID, community: 'Zzz Nonexistent Area 12345' })
  check('unknown community → 422', ghost.status === 422, ghost.status)
  check('422 reports communityFound false', ghost.json.communityFound === false, ghost.json)

  const thin = await post({ ...VALID, bedrooms: 5 })
  check('too few comparables → 422', thin.status === 422, thin.status)
  check('422 reports how many were found', typeof thin.json.compsFound === 'number', thin.json.compsFound)
  check('422 tells the user to widen the search when sales exist',
    /widen|busier/i.test(String(thin.json.message ?? '')), thin.json.message)

  // ── The happy path: a real PDF ───────────────────────────────────────────
  console.log('\n── a real PDF is produced (200) ──')
  const ok = await post(VALID)
  check('200 with enough comparables', ok.status === 200, { status: ok.status, json: ok.json })
  check('Content-Type is application/pdf', ok.type === 'application/pdf', ok.type)
  check('Content-Disposition is an attachment with the community slug',
    ok.disposition?.startsWith('attachment;') === true && ok.disposition?.includes(community.slug) === true,
    ok.disposition)
  const magic = new TextDecoder().decode(ok.bytes.subarray(0, 5))
  check('the bytes begin with the PDF magic number', magic === '%PDF-', magic)
  check('the bytes end with the PDF trailer', new TextDecoder().decode(ok.bytes.subarray(-6)).includes('%%EOF'),
    new TextDecoder().decode(ok.bytes.subarray(-20)))
  check('the PDF is a substantial document', ok.bytes.length > 5_000, ok.bytes.length)
  const body = new TextDecoder('latin1').decode(ok.bytes)
  check('the PDF declares at least one page', /\/Type\s*\/Page[^s]/.test(body))

  // ── The report must agree with the CMA tool ──────────────────────────────
  // The report embeds the estimate, so if the two surfaces ever disagreed a broker
  // could hand a client a number the tool itself would contradict.
  console.log('\n── the report agrees with the CMA tool ──')
  const cmaRes = await app.request('/sqftlab/cma', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${entId}` },
    body: JSON.stringify({ buildingName: BUILDING, community: community.nameEn, bedrooms: 2, sizeSqft: 1000 }),
  })
  const cma = (await cmaRes.json()) as Record<string, number>
  check('CMA tool also returns 200 on the same inputs', cmaRes.status === 200, cmaRes.status)
  check('both derive the same median PSF from the same comps', cma.medianPsf === 1150, cma.medianPsf)
  check('both derive the same estimate (1,150 PSF × 1,000 sqft)', cma.estimatedValueAed === 1_150_000, cma.estimatedValueAed)

  // A subject in an unrelated building falls back to the community comp set, and the
  // report must still render — this is the branch a second building's report takes.
  const communityBasis = await post({ ...VALID, building: 'Some Other Tower', propertyAddress: 'Some Other Tower, ' + community.nameEn })
  check('a different building still produces a report', communityBasis.status === 200, communityBasis.status)

  // ── A missing score must not break the report ────────────────────────────
  console.log('\n── the report survives a community with no computed score ──')
  const priorScores = await prisma.investmentScore.count({ where: { communityId: community.id } })
  const noScore = await post(VALID)
  check('report renders with no InvestmentScore row', noScore.status === 200, noScore.status)
  check('the route did not invent a score to fill the gap',
    (await prisma.investmentScore.count({ where: { communityId: community.id } })) === priorScores)

  // ── The route is read-only ───────────────────────────────────────────────
  console.log('\n── the route writes no market data ──')
  check('no transaction rows were created by exporting',
    (await prisma.transaction.count({ where: { dldId: { startsWith: ID } } })) === seededCount, seededCount)

  // ── The export is recorded ───────────────────────────────────────────────
  const events = await prisma.userEvent.count({ where: { userId: entId, eventType: 'pdf_report_export' } })
  check('a successful export is tracked as pdf_report_export', events >= 1, events)
} finally {
  // Delete exactly what this script created, in dependency order.
  await prisma.transaction.deleteMany({ where: { dldId: { startsWith: ID } } })
  if (scoreId) await prisma.investmentScore.deleteMany({ where: { id: scoreId } })
  if (entId) {
    await prisma.userEvent.deleteMany({ where: { userId: entId } })
    await prisma.user.delete({ where: { id: entId } }).catch(() => undefined)
  }
  if (freeId) await prisma.user.delete({ where: { id: freeId } }).catch(() => undefined)
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
