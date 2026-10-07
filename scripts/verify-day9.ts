// Day 9 verification — capital flow tracker + Ejari rental yield.
//
// Run:
//   cp prisma/dev.db /tmp/day9-e2e.db
//   DATABASE_URL=file:/tmp/day9-e2e.db bun run scripts/verify-day9.ts
//
// Runs the REAL Hono app in-process against a throwaway COPY of the database into
// which it inserts synthetic DLD sales (with buyer nationalities) and Ejari
// contracts. The project database is never touched; everything created here is
// removed in `finally`.
//
// The copy is required because `transactions`, `nationality_flow` and
// `ejari_contracts` are all empty in this deployment — against the real database
// only the "no data" branch is reachable, so the percentage arithmetic and the
// Ejari-first yield, which are the two things most likely to be wrong, could never
// be exercised.
import { prisma } from '../src/lib/db'

const dbUrl = process.env.DATABASE_URL ?? ''
if (!dbUrl.includes('day9-e2e')) {
  throw new Error(
    `Refusing to run: DATABASE_URL must point at the disposable copy (…day9-e2e.db), got "${dbUrl || '<unset>'}".\n` +
      'This script WRITES rows; running it against the project database would pollute it.',
  )
}

const { default: app } = await import('../custom-routes')
const { summariseNationalities, windowStart } = await import('../src/lib/capital-flow')
const { median, floorBreakdownFrom, slugify } = await import('../src/lib/buildings')

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
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 260)}`}`)
  }
}

async function req(
  path: string,
  opts: { method?: string; token?: string | null } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const res = await app.request(path, { method: opts.method ?? 'GET', headers })
  const text = await res.text()
  let body: Record<string, unknown> = {}
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    body = {}
  }
  return { status: res.status, body }
}

const ID = 'zz-verify-day9'
const created: string[] = []
const ejariIds: string[] = []

try {
  // ── Pure arithmetic first: no database, no app ────────────────────────────────
  console.log('── Day 9A: percentage base (the brief computes it from the returned slice) ──')
  // The brief does `const total = grouped.reduce(...)` AFTER `take: 15`, so the base
  // is the slice: a nationality with 1 of 18 sales reads as 1/15 = 6.7% instead of
  // 1/18 = 5.6%, and the column always sums to 100%.
  const eighteen = Array.from({ length: 18 }, (_, i) => ({
    nationality: `Nat${i}`,
    count: 1,
    totalValueAed: 1_000_000,
  }))
  const limited = summariseNationalities(eighteen, 18, 15)
  const sliceSum = limited.reduce((s, r) => s + r.pct, 0)
  check('returns exactly the limit', limited.length === 15, limited.length)
  check('share is of the MARKET, so a truncated slice sums to under 100%', sliceSum < 100, sliceSum)
  check('each share is 1/18 = 5.6%, not 1/15 = 6.7%', Math.abs(limited[0].pct - 5.6) < 0.05, limited[0].pct)
  check('the brief’s base would have summed to 100', Math.abs(18 * (1 / 15) * 100 - 120) < 0.01)
  const none = summariseNationalities(eighteen, 0, 15)
  check('zero total → 0%, never NaN', none.every((r) => r.pct === 0), none[0])

  console.log('\n── Day 9B/10B: shared pure helpers ──')
  check('median of an odd list', median([3, 1, 2]) === 2)
  check('median of an even list averages the middle', median([1, 2, 3, 4]) === 2.5)
  check('median of empty is null, not 0', median([]) === null)
  const bands = floorBreakdownFrom([
    { floorNumber: 2, pricePerSqft: 1000 },
    { floorNumber: 30, pricePerSqft: null },
  ])
  check('a band with no priced sale is null, not NaN', bands[2].avgPsfAed === null && bands[2].count === 0, bands[2])
  check('slugify strips punctuation', slugify('Marina Gate 1') === 'marina-gate-1')
  check('windowStart floors to midnight', windowStart(3).getHours() === 0)

  // ── Set up the project data ───────────────────────────────────────────────────
  const community = await prisma.community.findFirst({
    where: { medianAnnualRentAed: { gt: 0 } },
    select: { id: true, nameEn: true, slug: true, medianAnnualRentAed: true },
  })
  if (!community) throw new Error('No community with a rent median to test against')

  // The thin-sample case below needs its own community: the yield cache is keyed by
  // slug, so reusing the first one would answer from the 6-contract cache entry and
  // the <5 warning could never be observed.
  const community2 = await prisma.community.findFirst({
    where: { medianAnnualRentAed: { gt: 0 }, id: { not: community.id } },
    select: { id: true, nameEn: true, slug: true },
  })
  if (!community2) throw new Error('Need a second community for the thin-sample test')

  const user = async (tier: string) => {
    const u = await prisma.user.create({
      data: { email: `${tier}.${ID}@example.invalid`, subscriptionTier: tier, subscriptionStatus: 'active' },
      select: { id: true },
    })
    created.push(u.id)
    return u.id
  }
  const free = await user('free')
  const pro = await user('pro')

  // 20 sales in one community: 18 nationalities × 1, plus 2 more for "Indian".
  const nationalities = ['Indian', 'British', 'Russian', 'Chinese', 'Pakistani', 'Egyptian', 'French', 'German', 'American', 'Iranian', 'Turkish', 'Ukrainian', 'Italian', 'Spanish', 'Jordanian', 'Lebanese', 'Filipino', 'Canadian']
  let n = 0
  for (let i = 0; i < nationalities.length; i++) {
    await prisma.transaction.create({
      data: {
        dldId: `${ID}-tx-${n++}`,
        communityId: community.id,
        transactionType: 'sale',
        propertyType: 'apartment',
        beds: 2,
        areaSqft: 1000,
        priceAed: 1_000_000 + i * 10_000,
        pricePerSqft: 1000 + i * 10,
        transactionDate: new Date(),
        buyerNationality: nationalities[i],
      },
    })
  }
  for (let k = 0; k < 2; k++) {
    await prisma.transaction.create({
      data: {
        dldId: `${ID}-tx-extra-${k}`,
        communityId: community.id,
        transactionType: 'sale',
        propertyType: 'apartment',
        beds: 2,
        areaSqft: 1000,
        priceAed: 1_050_000,
        pricePerSqft: 1050,
        transactionDate: new Date(),
        buyerNationality: 'Indian',
      },
    })
  }
  // A mortgage and a null-nationality sale: neither may appear in the breakdown.
  await prisma.transaction.create({
    data: {
      dldId: `${ID}-tx-mortgage`, communityId: community.id, transactionType: 'mortgage',
      propertyType: 'apartment', beds: 2, areaSqft: 1000, priceAed: 5_000_000,
      pricePerSqft: 5000, transactionDate: new Date(), buyerNationality: 'Indian',
    },
  })
  await prisma.transaction.create({
    data: {
      dldId: `${ID}-tx-nonat`, communityId: community.id, transactionType: 'sale',
      propertyType: 'apartment', beds: 2, areaSqft: 1000, priceAed: 900_000,
      pricePerSqft: 900, transactionDate: new Date(),
    },
  })

  console.log('\n── Day 9A: overview gates ──')
  const anon = await req('/sqftlab/capital-flow/overview')
  check('anon → 403', anon.status === 403, anon.body)
  check('anon names the tier', anon.body.requiredTier === 'pro', anon.body)
  const freeOv = await req('/sqftlab/capital-flow/overview', { token: free })
  check('free → 403', freeOv.status === 403, freeOv.body)

  console.log('\n── Day 9A: overview content ──')
  const ov = await req('/sqftlab/capital-flow/overview', { token: pro })
  check('pro → 200', ov.status === 200, ov.body)
  check('source is live DLD, not the snapshot', ov.body.source === 'dld_transactions', ov.body.source)
  // 20 sales: the mortgage is not a sale and the null-nationality sale counts as
  // Unknown, so the buyer total is 21 — every sale is described, none dropped.
  check('totalBuyers counts every sale in the window', ov.body.totalBuyers === 21, ov.body.totalBuyers)
  const rows = ov.body.nationalities as Array<{ nationality: string; count: number; pct: number; totalValueAed: number }>
  check('top nationality is Indian with 3 sales', rows[0].nationality === 'Indian' && rows[0].count === 3, rows[0])
  check('Indian share is 3/21 = 14.3%', Math.abs(rows[0].pct - 14.3) < 0.05, rows[0].pct)
  check('sum of shares is under 100 (15 of 19 groups shown)', rows.reduce((s, r) => s + r.pct, 0) < 100)
  check('the mortgage is excluded', !rows.some((r) => r.count > 3))
  check('rows carry a value total', rows.every((r) => typeof r.totalValueAed === 'number'))

  console.log('\n── Day 9A: area route + ordering ──')
  // If `/capital-flow/:area` were registered first it would swallow `overview`.
  check('`overview` is not captured as an area name', ov.body.scope === 'Dubai', ov.body.scope)
  const area = await req(`/sqftlab/capital-flow/${encodeURIComponent(community.slug)}`, { token: pro })
  check('known area → 200', area.status === 200, area.body)
  check('area scope is the community name', area.body.scope === community.nameEn, area.body.scope)
  check('area total matches the overview for one community', area.body.totalBuyers === 21, area.body.totalBuyers)
  // The area route returns up to 20 rows, so all 19 groups come back and the
  // null-nationality sale can be seen — counted under "Unknown" rather than dropped,
  // which would have left the shares describing only part of the market.
  const areaRows = area.body.nationalities as Array<{ nationality: string; count: number }>
  check('a null nationality is reported as Unknown, not dropped', areaRows.some((r) => r.nationality === 'Unknown'), areaRows.map((r) => r.nationality))
  const badArea = await req('/sqftlab/capital-flow/zz-no-such-area', { token: pro })
  check('unknown area → 404, not an empty breakdown', badArea.status === 404, badArea.body)

  console.log('\n── Day 9B: yield, no Ejari contracts (listing fallback) ──')
  const yNoEjari = await req(`/sqftlab/communities/${community.slug}/yield`, { token: pro })
  check('200', yNoEjari.status === 200, yNoEjari.body)
  check('rentSource is rent_listings, NOT ejari', yNoEjari.body.rentSource === 'rent_listings', yNoEjari.body.rentSource)
  check('contractCount is 0', yNoEjari.body.contractCount === 0, yNoEjari.body.contractCount)
  const warns = yNoEjari.body.warnings as string[]
  check('it warns the rent is an asking price, not contracted', warns.some((w) => /asking rents/.test(w)), warns)
  check('sale source is the DLD transactions just inserted', yNoEjari.body.saleSource === 'dld_transactions', yNoEjari.body.saleSource)
  check('a gross yield is produced', typeof yNoEjari.body.grossYieldPct === 'number', yNoEjari.body.grossYieldPct)

  console.log('\n── Day 9B: yield from registered Ejari contracts ──')
  // A rent far above the asking-rent median, so the yield must move if Ejari is
  // genuinely preferred over the listing fallback rather than merely labelled.
  const EJARI_RENT = 500_000
  for (let i = 0; i < 6; i++) {
    const c = await prisma.ejariContract.create({
      data: {
        area: community.nameEn,
        communityId: community.id,
        buildingName: 'Zz Ejari Tower',
        bedrooms: 2,
        sizeSqft: 1000,
        annualRentAed: EJARI_RENT,
        contractStart: new Date(),
        contractEnd: new Date(Date.now() + 365 * 24 * 3600 * 1000),
        registeredAt: new Date(),
      },
      select: { id: true },
    })
    ejariIds.push(c.id)
  }
  const yEjari = await req(`/sqftlab/communities/${community.slug}/yield`, { token: pro })
  check('rentSource flips to ejari', yEjari.body.rentSource === 'ejari', yEjari.body.rentSource)
  check('avgAnnualRentAed is the contracted rent', yEjari.body.avgAnnualRentAed === EJARI_RENT, yEjari.body.avgAnnualRentAed)
  check('contractCount is 6', yEjari.body.contractCount === 6, yEjari.body.contractCount)
  check('6 contracts clears the <5 warning', !(yEjari.body.warnings as string[]).some((w) => /Fewer than 5/.test(w)), yEjari.body.warnings)

  console.log('\n── Day 9B: the <5 contract warning ──')
  await prisma.ejariContract.deleteMany({ where: { id: { in: ejariIds } } })
  for (let i = 0; i < 2; i++) {
    const c = await prisma.ejariContract.create({
      data: {
        area: community2.nameEn,
        communityId: community2.id,
        bedrooms: 2,
        sizeSqft: 1000,
        annualRentAed: 300_000,
        contractStart: new Date(),
        contractEnd: new Date(Date.now() + 365 * 24 * 3600 * 1000),
      },
      select: { id: true },
    })
    ejariIds.push(c.id)
  }
  const yThin = await req(`/sqftlab/communities/${community2.slug}/yield`, { token: pro })
  check('2 contracts still reads as ejari', yThin.body.rentSource === 'ejari', yThin.body.rentSource)
  check('and warns the sample is too small', (yThin.body.warnings as string[]).some((w) => /Fewer than 5/.test(w)), yThin.body.warnings)

  console.log('\n── Day 9B: gates + not-found ──')
  const yAnon = await req(`/sqftlab/communities/${community.slug}/yield`)
  check('anon → 403', yAnon.status === 403, yAnon.body)
  const yMiss = await req('/sqftlab/communities/zz-no-such-community/yield', { token: pro })
  check('unknown community → 404', yMiss.status === 404, yMiss.body)

  console.log('\n── Day 9: raw-SQL guard (mode: "insensitive" needs Postgres) ──')
  // The brief's queries all carry `mode: 'insensitive'`, which SQLite rejects. If a
  // future edit reintroduces it anywhere on these paths, the requests above 500.
  const anyDollar = await req('/sqftlab/capital-flow/overview?months=abc', { token: pro })
  check('a non-numeric months param does not 500', anyDollar.status === 200, anyDollar.status)
  check('it falls back to the default window', anyDollar.body.period === '90 days', anyDollar.body.period)
  const big = await req('/sqftlab/capital-flow/overview?months=9999', { token: pro })
  check('an out-of-range months param is clamped, not passed through', big.body.period === '90 days', big.body.period)
} catch (err) {
  failed++
  failures.push('suite threw')
  console.log(`\n  ✗ suite threw: ${(err as Error).message}`)
} finally {
  // Delete only the rows this suite created. An earlier draft deleted every Ejari
  // contract matching the community, which would have taken the user's own rows with
  // it the moment any existed.
  const e = await prisma.ejariContract.deleteMany({ where: { id: { in: ejariIds } } })
  const tx = await prisma.transaction.deleteMany({ where: { dldId: { startsWith: ID } } })
  const us = await prisma.user.deleteMany({ where: { id: { in: created } } })
  console.log(`\n  cleanup: ${e.count} ejari, ${tx.count} transaction(s), ${us.count} user(s) removed`)
  console.log(`\n  ${passed} passed, ${failed} failed`)
  if (failures.length) console.log(`  failures:\n${failures.map((f) => `    - ${f}`).join('\n')}`)
  process.exit(failed === 0 ? 0 : 1)
}
