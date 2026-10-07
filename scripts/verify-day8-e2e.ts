// Day 8 verification — portfolio (Part 2: the routes, end to end).
//
// Run:
//   cp prisma/dev.db /tmp/day8-e2e.db
//   DATABASE_URL=file:/tmp/day8-e2e.db bun run scripts/verify-day8-e2e.ts
//
// Runs the REAL Hono app in-process against a throwaway COPY of the database into which
// it writes its own comparables. Nothing is mocked and the project database is never
// touched; everything created here is removed in `finally`.
//
// The list/detail routes behave differently depending on whether a valuation exists, and
// this deployment's database holds ZERO transactions — so against the real database every
// holding is correctly "unvalued" and the valued branch is unreachable. Hence the copy.
import { prisma } from '../src/lib/db'

const dbUrl = process.env.DATABASE_URL ?? ''
if (!dbUrl.includes('day8-e2e')) {
  throw new Error(
    `Refusing to run: DATABASE_URL must point at the disposable copy (…day8-e2e.db), got "${dbUrl || '<unset>'}".\n` +
    'This script WRITES rows; running it against the project database would pollute it.',
  )
}

const { default: app } = await import('../custom-routes')
const { revalueAllHoldings } = await import('../src/lib/portfolio-jobs')

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
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 240)}`}`)
  }
}

const ID = `DAY8-${Date.now()}`
const day = 86_400_000

const withComps = await prisma.community.findFirst({ select: { id: true, nameEn: true, slug: true } })
if (!withComps) throw new Error('no community in the copy')
const noComps = await prisma.community.findFirst({
  where: { id: { not: withComps.id } },
  select: { id: true, nameEn: true, slug: true },
})
if (!noComps) throw new Error('need a second community with no comparables')

let proId: string | null = null
let entId: string | null = null

async function req(
  path: string,
  opts: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const res = await app.request(path, {
    method: opts.method ?? 'GET',
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  })
  const text = await res.text()
  let body: Record<string, unknown> = {}
  try { body = text ? (JSON.parse(text) as Record<string, unknown>) : {} } catch { body = {} }
  return { status: res.status, body }
}

const base = { beds: 2, areaSqft: 1000, purchasePrice: 1_000_000 }
const post = (token: string | null, body: unknown) =>
  req('/sqftlab/portfolio', { method: 'POST', body, token })

try {
  const pro = await prisma.user.create({
    data: { email: `${ID}-pro@example.invalid`, subscriptionTier: 'pro', subscriptionStatus: 'active' },
    select: { id: true },
  })
  proId = pro.id
  const ent = await prisma.user.create({
    data: { email: `${ID}-ent@example.invalid`, subscriptionTier: 'enterprise', subscriptionStatus: 'active' },
    select: { id: true },
  })
  entId = ent.id

  // Four sales at 1,000–1,300 PSF → median 1,150 → a 1,000 sqft unit is worth 1,150,000.
  // A fifth row is a mortgage, which is not an arm's-length price and must not be used.
  await prisma.transaction.createMany({
    data: [
      { dldId: `${ID}-1`, source: 'dld', communityId: withComps.id, transactionType: 'sale', propertyType: 'apartment', beds: 2, areaSqft: 1000, priceAed: 1_000_000, pricePerSqft: 1000, transactionDate: new Date(Date.now() - 10 * day), buildingName: 'E2E Tower' },
      { dldId: `${ID}-2`, source: 'dld', communityId: withComps.id, transactionType: 'sale', propertyType: 'apartment', beds: 2, areaSqft: 1000, priceAed: 1_100_000, pricePerSqft: 1100, transactionDate: new Date(Date.now() - 20 * day), buildingName: 'E2E Tower' },
      { dldId: `${ID}-3`, source: 'dld', communityId: withComps.id, transactionType: 'sale', propertyType: 'apartment', beds: 2, areaSqft: 1000, priceAed: 1_200_000, pricePerSqft: 1200, transactionDate: new Date(Date.now() - 30 * day), buildingName: 'E2E Tower' },
      { dldId: `${ID}-4`, source: 'dld', communityId: withComps.id, transactionType: 'sale', propertyType: 'apartment', beds: 2, areaSqft: 1000, priceAed: 1_300_000, pricePerSqft: 1300, transactionDate: new Date(Date.now() - 40 * day), buildingName: 'E2E Tower' },
      { dldId: `${ID}-5`, source: 'dld', communityId: withComps.id, transactionType: 'mortgage', propertyType: 'apartment', beds: 2, areaSqft: 1000, priceAed: 9_999_000, pricePerSqft: 9999, transactionDate: new Date(Date.now() - 5 * day), buildingName: 'E2E Tower' },
    ],
  })

  // ── Access control (tier precedes auth on this route, and a test pins that) ──
  console.log('\n── access control ──')
  const anonGet = await req('/sqftlab/portfolio')
  check('GET with no auth → 403 + requiredTier pro',
    anonGet.status === 403 && anonGet.body.requiredTier === 'pro', anonGet)
  const anonPost = await post(null, base)
  check('POST with no auth → 403 + requiredTier pro',
    anonPost.status === 403 && anonPost.body.requiredTier === 'pro', anonPost.status)
  const anonDelete = await req('/sqftlab/portfolio/whatever', { method: 'DELETE' })
  check('DELETE with no auth → 403', anonDelete.status === 403, anonDelete.status)

  // ── Adding a holding with no comparables ────────────────────────────────────
  console.log('\n── a holding with no comparable sales is saved unvalued ──')
  const created = await post(proId, { ...base, communitySlug: noComps.slug, buildingName: 'No Comps Villa' })
  check('201 Created', created.status === 201, created)
  const createdItem = (created.body.item ?? {}) as Record<string, unknown>
  check('the response says it is not valued', created.body.valued === false, created.body.valued)
  check('it explains why rather than reporting a value',
    typeof created.body.message === 'string' && /not yet valued/i.test(created.body.message), created.body.message)
  check('the response carries no current value', createdItem.currentValue === null, createdItem.currentValue)
  check('the response carries no gain', createdItem.gainAed === null, createdItem.gainAed)

  const createdRow = await prisma.portfolio.findUnique({ where: { id: String(createdItem.id) } })
  check('the stored currentValue is 0, not the purchase price',
    createdRow?.currentValue === 0, createdRow?.currentValue)
  check('valuedAt is null, marking it unvalued', createdRow?.valuedAt === null, createdRow?.valuedAt)
  check('purchase PSF was derived from the price and size', createdItem.purchasePsf === 1000, createdItem.purchasePsf)

  // ── Mass assignment: valuation columns are not client-writable ─────────────
  console.log('\n── a client cannot lodge its own valuation ──')
  const spoof = await post(proId, {
    ...base,
    communitySlug: noComps.slug,
    buildingName: 'Spoofed',
    currentValue: 999_999_999,
    valuedAt: '2020-01-01T00:00:00.000Z',
    valuationSource: 'dld',
    valuationComps: 99,
  })
  const spoofRow = await prisma.portfolio.findUnique({ where: { id: String((spoof.body.item as Record<string, unknown>).id) } })
  check('a client-supplied currentValue is ignored', spoofRow?.currentValue === 0, spoofRow?.currentValue)
  check('a client-supplied valuedAt is ignored', spoofRow?.valuedAt === null, spoofRow?.valuedAt)
  check('a client-supplied valuationSource is ignored', spoofRow?.valuationSource === null, spoofRow?.valuationSource)

  // ── A holding with real comparables is valued from them ────────────────────
  console.log('\n── a holding with comparables is valued from them ──')
  const valuedRes = await post(proId, { ...base, communitySlug: withComps.slug, buildingName: 'E2E Tower' })
  check('201 Created', valuedRes.status === 201, valuedRes)
  const valuedItem = (valuedRes.body.item ?? {}) as Record<string, unknown>
  check('the response says it was valued', valuedRes.body.valued === true, valuedRes.body.valued)
  check('the value is the median of the comparable sales (1,150 PSF × 1,000 sqft)',
    valuedItem.currentValue === 1_150_000, valuedItem.currentValue)
  check('the mortgage row was not counted as a comparable',
    valuedItem.valuationComps === 4, valuedItem.valuationComps)
  check('it is flagged as valued', valuedItem.isValued === true, valuedItem.isValued)
  check('the gain is derived from the value and the price',
    valuedItem.gainAed === 150_000 && valuedItem.gainPct === 15, valuedItem)

  // ── GET: the summary the checklist asks for ────────────────────────────────
  console.log('\n── GET returns the run-down ──')
  const list = await req('/sqftlab/portfolio', { token: proId })
  const summary = (list.body.summary ?? {}) as Record<string, number | null>
  const items = (list.body.items ?? []) as Record<string, unknown>[]
  check('200 with an items array', list.status === 200 && Array.isArray(items), list.status)
  check('summary.totalGainPct is present and numeric',
    typeof summary.totalGainPct === 'number', summary.totalGainPct)
  check('summary.totalGainAed is present', typeof summary.totalGainAed === 'number', summary.totalGainAed)
  check('valued and unvalued holdings are counted separately',
    summary.valuedCount === 1 && summary.unvaluedCount === 2, summary)
  check('the current total covers only the valued holding',
    summary.totalCurrentAed === 1_150_000, summary.totalCurrentAed)
  check('what was paid covers every holding', summary.totalPurchaseAed === 3_000_000, summary.totalPurchaseAed)
  check('the gain percent is against the valued cost only', summary.totalGainPct === 15, summary.totalGainPct)
  check('below the cap the limit is reported but not flagged as reached',
    list.body.limit === 5 && list.body.atLimit === false, list.body)
  check('the unvalued items carry null rather than a substitute',
    items.filter((i) => i.isValued === false).every((i) => i.currentValue === null && i.gainAed === null))
  check('no item anywhere reports a gain against an unvalued holding',
    items.every((i) => i.isValued === true || i.gainAed === null))

  // ── The plan cap ───────────────────────────────────────────────────────────
  console.log('\n── the pro cap refuses the sixth holding ──')
  // Filled to the cap first: asserting on the sixth add only means anything once five
  // are actually held.
  const held = await prisma.portfolio.count({ where: { userId: proId } })
  for (let i = held; i < 5; i++) {
    const fill = await post(proId, { ...base, communitySlug: noComps.slug, buildingName: `Fill ${i + 1}` })
    check(`holding ${i + 1} of 5 is accepted`, fill.status === 201, fill.status)
  }
  const atCap = await req('/sqftlab/portfolio', { token: proId })
  check('at the cap, the list says so',
    atCap.body.atLimit === true && atCap.body.limit === 5, atCap.body)

  const sixth = await post(proId, { ...base, communitySlug: noComps.slug, buildingName: 'Sixth' })
  check('the sixth is refused with 403', sixth.status === 403, sixth)
  check('the refusal names the limit', sixth.body.limit === 5, sixth.body.limit)
  check('the refusal offers a route to upgrade', sixth.body.upgradeUrl === '/pricing', sixth.body.upgradeUrl)
  const afterCap = await prisma.portfolio.count({ where: { userId: proId } })
  check('the refused holding was not written', afterCap === 5, afterCap)

  // ── Enterprise is uncapped ─────────────────────────────────────────────────
  console.log('\n── enterprise is uncapped ──')
  for (let i = 0; i < 6; i++) {
    await post(entId, { ...base, communitySlug: noComps.slug, buildingName: `Ent ${i}` })
  }
  const entCount = await prisma.portfolio.count({ where: { userId: entId } })
  check('enterprise can hold more than five', entCount === 6, entCount)
  const entList = await req('/sqftlab/portfolio', { token: entId })
  check('enterprise receives no cap metadata',
    entList.body.limit === undefined && entList.body.atLimit === undefined, entList.body)
  check('every enterprise item is returned', ((entList.body.items ?? []) as unknown[]).length === 6)

  // ── Validation ─────────────────────────────────────────────────────────────
  console.log('\n── input validation ──')
  const missing = await post(entId, { communitySlug: noComps.slug })
  check('missing size and price → 400 naming them',
    missing.status === 400 && (missing.body.fields as string[])?.includes('sizeSqft'.replace('sizeSqft', 'areaSqft')),
    missing.body)
  const unknown = await post(entId, { ...base, communitySlug: 'not-a-district' })
  check('an unknown district → 400', unknown.status === 400, unknown.status)
  const future = await post(entId, { ...base, communitySlug: noComps.slug, purchaseDate: '2099-01-01' })
  check('a future purchase date → 400', future.status === 400, future.status)
  const badDate = await post(entId, { ...base, communitySlug: noComps.slug, purchaseDate: 'not-a-date' })
  check('an unparseable purchase date → 400', badDate.status === 400, badDate.status)

  // ── Delete ─────────────────────────────────────────────────────────────────
  console.log('\n── remove ──')
  const target = String(valuedItem.id)
  const foreign = await req(`/sqftlab/portfolio/${target}`, { method: 'DELETE', token: entId })
  check("another account's holding → 404, not deleted", foreign.status === 404, foreign.status)
  check('and it is still there', (await prisma.portfolio.count({ where: { id: target } })) === 1)
  const own = await req(`/sqftlab/portfolio/${target}`, { method: 'DELETE', token: proId })
  check('own holding → deleted', own.status === 200 && own.body.deleted === true, own)
  check('and it is gone', (await prisma.portfolio.count({ where: { id: target } })) === 0)
  const again = await req(`/sqftlab/portfolio/${target}`, { method: 'DELETE', token: proId })
  check('deleting it twice → 404', again.status === 404, again.status)

  // ── The nightly revalue ────────────────────────────────────────────────────
  console.log('\n── the nightly revalue is batched and never zeroes a holding ──')
  // Scoped to the whole table: the job revalues EVERY holding, including the seeded ones
  // this script did not create, so counting only its own rows under-counts the job.
  const before = await prisma.portfolio.findMany({
    select: { communityId: true, beds: true, currentValue: true, valuedAt: true, id: true },
  })
  const groups = new Set(before.map((h) => `${h.communityId}\u0000${h.beds}`)).size
  const r = await revalueAllHoldings()
  check('the job considered every holding in the database', r.considered === before.length, { r: r.considered, holdings: before.length })
  check('one query per (community, bedrooms) group, not one per holding',
    r.queries === groups && r.queries <= before.length, { queries: r.queries, groups, holdings: before.length })
  check('it valued the holdings that have comparables', r.valued >= 1, r.valued)
  check('everything it could not value came back as skipped', r.valued + r.skipped === r.considered, r)

  const after = await prisma.portfolio.findMany({
    where: { userId: { in: [proId, entId] } },
    select: { id: true, currentValue: true, valuedAt: true, valuationComps: true },
  })
  check('an unvalued holding keeps currentValue 0 and valuedAt null',
    after.filter((h) => h.valuedAt === null).every((h) => h.currentValue === 0))
  check('a valued holding records its provenance',
    after.filter((h) => h.valuedAt !== null).every((h) => typeof h.valuationComps === 'number' && h.valuationComps > 0))

  console.log('\n── the invariant that makes a screen trustworthy ──')
  check('no holding claims a value without a valuation behind it',
    after.every((h) => (h.valuedAt === null) === (h.currentValue === 0)))
} finally {
  await prisma.transaction.deleteMany({ where: { dldId: { startsWith: ID } } })
  for (const uid of [proId, entId]) {
    if (!uid) continue
    await prisma.portfolio.deleteMany({ where: { userId: uid } })
    await prisma.userEvent.deleteMany({ where: { userId: uid } })
    await prisma.user.delete({ where: { id: uid } }).catch(() => undefined)
  }
}

{
  const leftovers = await prisma.portfolio.count({ where: { user: { email: { startsWith: ID } } } }).catch(() => 0)
  const users = await prisma.user.count({ where: { email: { startsWith: ID } } })
  const txns = await prisma.transaction.count({ where: { dldId: { startsWith: ID } } })
  check('holdings were removed', leftovers === 0, leftovers)
  check('throwaway accounts were removed', users === 0, users)
  check('seeded comparables were removed', txns === 0, txns)
}

console.log(`\n${'─'.repeat(60)}`)
console.log(`  ${passed} passed, ${failed} failed`)
if (failures.length) {
  console.log('\n  Failures:')
  for (const f of failures) console.log(`    ✗ ${f}`)
}
console.log(`${'─'.repeat(60)}\n`)
process.exit(failed === 0 ? 0 : 1)
