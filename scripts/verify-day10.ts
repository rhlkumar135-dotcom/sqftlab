// Day 10 verification — developer positioning + building scorecard.
//
// Run:
//   cp prisma/dev.db /tmp/day10-e2e.db
//   DATABASE_URL=file:/tmp/day10-e2e.db bun run scripts/verify-day10.ts
//
// Runs the REAL Hono app in-process against a throwaway COPY of the database into
// which it inserts synthetic DLD rows. Nothing is mocked and the project database is
// never touched; every row created here is removed in `finally`.
//
// The copy matters: this deployment's `transactions` and `building_profiles` tables
// hold ZERO rows, so against the real database the "has comparables" branch is
// unreachable and the suite could only ever prove the empty path. With synthetic
// rows the computed path — verdict, percentile, floor bands — is exercised for real.
import { prisma } from '../src/lib/db'

const dbUrl = process.env.DATABASE_URL ?? ''
if (!dbUrl.includes('day10-e2e')) {
  throw new Error(
    `Refusing to run: DATABASE_URL must point at the disposable copy (…day10-e2e.db), got "${dbUrl || '<unset>'}".\n` +
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
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 240)}`}`)
  }
}

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
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    body = {}
  }
  return { status: res.status, body }
}

const ID = 'zz-verify-day10'
const BUILDING = 'Zz Verify Tower'
const SLUG = 'zz-verify-tower'
const created: string[] = []

try {
  const community = await prisma.community.findFirst({ select: { id: true, nameEn: true, slug: true } })
  if (!community) throw new Error('No community row to attach test transactions to')

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
  const ent = await user('enterprise')

  // ── Synthetic comparables: PSFs 1000/1100/1200/1300/1400, beds=2 ──────────────
  const psfs = [1000, 1100, 1200, 1300, 1400]
  const floors = [3, 8, 12, 20, 25] // → Low, Mid, Mid, High, High
  for (let i = 0; i < psfs.length; i++) {
    await prisma.transaction.create({
      data: {
        dldId: `${ID}-tx-${i}`,
        communityId: community.id,
        transactionType: i === 1 ? 'off_plan_sale' : 'sale',
        propertyType: 'apartment',
        beds: 2,
        areaSqft: 1000,
        priceAed: psfs[i] * 1000,
        pricePerSqft: psfs[i],
        transactionDate: new Date(),
        buildingName: BUILDING,
        floorNumber: floors[i],
      },
    })
  }
  // One non-sale that must be excluded from every aggregate below.
  await prisma.transaction.create({
    data: {
      dldId: `${ID}-tx-mortgage`,
      communityId: community.id,
      transactionType: 'mortgage',
      propertyType: 'apartment',
      beds: 2,
      areaSqft: 1000,
      priceAed: 9_000_000,
      pricePerSqft: 9000,
      transactionDate: new Date(),
      buildingName: BUILDING,
      floorNumber: 10,
    },
  })
  // A sale below the AED 100/sqft floor that the methodology excludes.
  await prisma.transaction.create({
    data: {
      dldId: `${ID}-tx-cheap`,
      communityId: community.id,
      transactionType: 'sale',
      propertyType: 'apartment',
      beds: 2,
      areaSqft: 1000,
      priceAed: 50_000,
      pricePerSqft: 50,
      transactionDate: new Date(),
      buildingName: BUILDING,
      floorNumber: 4,
    },
  })

  console.log('\n── Day 10A developer positioning: gates ──')
  const anon = await req('/sqftlab/developer/position', {
    method: 'POST',
    body: { projectName: 'X', area: community.nameEn, beds: 2, launchPsfAed: 1800 },
  })
  check('anon → 403', anon.status === 403, anon.body)
  check('anon names the required tier', anon.body.requiredTier === 'enterprise', anon.body)

  const proPost = await req('/sqftlab/developer/position', {
    method: 'POST',
    token: pro,
    body: { projectName: 'X', area: community.nameEn, beds: 2, launchPsfAed: 1800 },
  })
  check('pro → 403 (enterprise feature)', proPost.status === 403, proPost.body)

  console.log('\n── Day 10A: validation ──')
  const empty = await req('/sqftlab/developer/position', { method: 'POST', token: ent, body: {} })
  check('empty body → 400, not 500 (brief throws)', empty.status === 400, empty.status)
  check('empty body names every missing field', Array.isArray(empty.body.fields) && (empty.body.fields as string[]).length === 4, empty.body)

  const badBeds = await req('/sqftlab/developer/position', {
    method: 'POST',
    token: ent,
    body: { projectName: 'X', area: community.nameEn, beds: 1.5, launchPsfAed: 1800 },
  })
  check('fractional beds → 400', badBeds.status === 400, badBeds.body)

  const badPsf = await req('/sqftlab/developer/position', {
    method: 'POST',
    token: ent,
    body: { projectName: 'X', area: community.nameEn, beds: 2, launchPsfAed: -1 },
  })
  check('negative launch price → 400', badPsf.status === 400, badPsf.body)

  const unknownArea = await req('/sqftlab/developer/position', {
    method: 'POST',
    token: ent,
    body: { projectName: 'X', area: 'zz-nowhere-area', beds: 2, launchPsfAed: 1800 },
  })
  check('unknown area → 200 with insufficientData', unknownArea.status === 200 && unknownArea.body.insufficientData === true, unknownArea.body)

  console.log('\n── Day 10A: computed positioning (5 real comparables) ──')
  const atMarket = await req('/sqftlab/developer/position', {
    method: 'POST',
    token: ent,
    body: { projectName: 'Zz Launch', area: community.nameEn, beds: 2, launchPsfAed: 1200 },
  })
  check('200', atMarket.status === 200, atMarket.body)
  check('comparables excludes the mortgage and the sub-100 sale', atMarket.body.dldComparables === 5, atMarket.body.dldComparables)
  const m = atMarket.body.market as { avgPsfAed: number; minPsfAed: number; maxPsfAed: number } | null
  check('avg PSF = 1200 from the 5 sales', m?.avgPsfAed === 1200, m)
  check('min/max are the real range, not 0', m?.minPsfAed === 1000 && m?.maxPsfAed === 1400, m)
  const p = atMarket.body.positioning as { pctVsMarket: number | null; percentile: number | null; verdict: string }
  check('at-market launch → 0% vs market', p.pctVsMarket === 0, p)
  check('percentile 60 (3 of 5 at or below 1200)', p.percentile === 60, p)
  check('verdict is the at-market sentence', p.verdict.startsWith('At-market'), p.verdict)

  const under = await req('/sqftlab/developer/position', {
    method: 'POST',
    token: ent,
    body: { projectName: 'Zz Launch', area: community.nameEn, beds: 2, launchPsfAed: 900 },
  })
  const up = under.body.positioning as { pctVsMarket: number | null; percentile: number | null; verdict: string }
  check('under-market → -25%', up.pctVsMarket === -25, up)
  check('under-market percentile 0', up.percentile === 0, up)
  check('under-market verdict', up.verdict.startsWith('Under-market'), up.verdict)

  const over = await req('/sqftlab/developer/position', {
    method: 'POST',
    token: ent,
    body: { projectName: 'Zz Launch', area: community.nameEn, beds: 2, launchPsfAed: 1800 },
  })
  const op = over.body.positioning as { pctVsMarket: number | null; percentile: number | null; verdict: string }
  check('+50% → aggressive verdict', op.verdict.startsWith('Aggressive'), op.verdict)
  check('percentile 100 above every comparable', op.percentile === 100, op)

  console.log('\n── Day 10A: the brief-fabrication regressions ──')
  // beds=7 has no transactions: the brief would answer percentile 50 and "At-market".
  const none = await req('/sqftlab/developer/position', {
    method: 'POST',
    token: ent,
    body: { projectName: 'Zz Launch', area: community.nameEn, beds: 7, launchPsfAed: 1800 },
  })
  const np = none.body.positioning as { pctVsMarket: number | null; percentile: number | null; verdict: string }
  check('zero comparables → insufficientData', none.body.insufficientData === true, none.body)
  check('zero comparables → percentile is null, NOT 50', np.percentile === null, np)
  check('zero comparables → pctVsMarket is null, NOT 0', np.pctVsMarket === null, np)
  check('zero comparables → verdict does NOT claim at-market', !np.verdict.startsWith('At-market'), np.verdict)
  check('market block is null rather than a zeroed object', none.body.market === null, none.body.market)

  console.log('\n── Day 10B buildings: search ──')
  const shortQ = await req('/sqftlab/buildings?q=z')
  check('1-char query → empty, no query issued', shortQ.status === 200 && (shortQ.body.buildings as unknown[]).length === 0, shortQ.body)
  const found = await req(`/sqftlab/buildings?q=${encodeURIComponent('zz verify')}`)
  const hits = found.body.buildings as Array<{ name: string; slug: string }>
  check('search finds the synthetic building', hits.some((h) => h.name === BUILDING), hits)
  check('search returns a slug', hits.every((h) => typeof h.slug === 'string' && h.slug.length > 0), hits)

  console.log('\n── Day 10B: scorecard + tier gating ──')
  const freeCard = await req(`/sqftlab/buildings/${SLUG}`, { token: free })
  check('free scorecard 200', freeCard.status === 200, freeCard.body)
  check('free resolves the stored name from the slug', freeCard.body.buildingName === BUILDING, freeCard.body.buildingName)
  check('free: floorBreakdown is null', freeCard.body.floorBreakdown === null, freeCard.body.floorBreakdown)
  check('free: floorBreakdownLocked true', freeCard.body.floorBreakdownLocked === true)
  const fs = freeCard.body.stats as { transactions: number; medianPsfAed: number | null }
  check('free still gets the median PSF (1200)', fs.medianPsfAed === 1200, fs)
  check('transactions counted from sales only', fs.transactions === 5, fs)

  const proCard = await req(`/sqftlab/buildings/${SLUG}`, { token: pro })
  check('pro: floorBreakdown still null', proCard.body.floorBreakdown === null, proCard.body.floorBreakdown)
  check('pro: still locked', proCard.body.floorBreakdownLocked === true)

  const entCard = await req(`/sqftlab/buildings/${SLUG}`, { token: ent })
  check('enterprise: floorBreakdownLocked false', entCard.body.floorBreakdownLocked === false, entCard.body.floorBreakdownLocked)
  const bands = entCard.body.floorBreakdown as Array<{ range: string; avgPsfAed: number | null; count: number }>
  check('enterprise: three floor bands', Array.isArray(bands) && bands.length === 3, bands)
  check('Low (1–5) has floor 3 only', bands?.[0]?.count === 1 && bands?.[0]?.avgPsfAed === 1000, bands?.[0])
  check('Mid (6–15) has floors 8,12', bands?.[1]?.count === 2 && bands?.[1]?.avgPsfAed === 1150, bands?.[1])
  check('High (16+) has floors 20,25', bands?.[2]?.count === 2 && bands?.[2]?.avgPsfAed === 1350, bands?.[2])
  check('no band is NaN (brief divides by an unchecked length)', bands.every((b) => b.avgPsfAed === null || Number.isFinite(b.avgPsfAed)), bands)

  // A band with no sales must report null, never NaN — assert on a building that has
  // sales only in one band.
  const recent = entCard.body.recentTransactions as Array<{ date: string; pricePerSqft: number | null }>
  check('recent transactions carry a date and PSF', recent.length === 5 && typeof recent[0].date === 'string', recent[0])

  console.log('\n── Day 10B: empty floor bands must be null, not NaN ──')
  // Sales in ONE band only. The brief divides by an unchecked `psfs.length`, so the
  // two empty bands become NaN, which survives JSON.stringify as null mid-object —
  // a band that looks priced at 0 rather than unpriced.
  const loneBuilding = 'Zz Lone Band Tower'
  await prisma.transaction.create({
    data: {
      dldId: `${ID}-lone-0`,
      communityId: community.id,
      transactionType: 'sale',
      propertyType: 'apartment',
      beds: 1,
      areaSqft: 500,
      priceAed: 600_000,
      pricePerSqft: 1200,
      transactionDate: new Date(),
      buildingName: loneBuilding,
      floorNumber: 2,
    },
  })
  const lone = await req('/sqftlab/buildings/zz-lone-band-tower', { token: ent })
  const lb = lone.body.floorBreakdown as Array<{ range: string; avgPsfAed: number | null; count: number }>
  check('lone-band: the populated band is priced', lb?.[0]?.count === 1 && lb?.[0]?.avgPsfAed === 1200, lb?.[0])
  check('lone-band: empty Mid band is null, not NaN/0', lb?.[1]?.avgPsfAed === null && lb?.[1]?.count === 0, lb?.[1])
  check('lone-band: empty High band is null, not NaN/0', lb?.[2]?.avgPsfAed === null && lb?.[2]?.count === 0, lb?.[2])

  console.log('\n── Day 10B: cache is keyed by tier ──')
  const entAgain = await req(`/sqftlab/buildings/${SLUG}`, { token: ent })
  check('second enterprise call is served from cache', entAgain.body.cached === true, entAgain.body.cached)
  const freeAgain = await req(`/sqftlab/buildings/${SLUG}`, { token: free })
  check('free is NOT served the enterprise payload', freeAgain.body.floorBreakdown === null, freeAgain.body.floorBreakdown)
  check('free response is its own cache entry', freeAgain.body.floorBreakdownLocked === true)

  console.log('\n── Day 10B: unknown building ──')
  const missing = await req('/sqftlab/buildings/zz-definitely-not-a-building')
  check('unknown slug → 200 with insufficientData', missing.status === 200 && missing.body.insufficientData === true, missing.status)
  check('unknown slug → reason names the building', typeof missing.body.reason === 'string' && (missing.body.reason as string).length > 20)
  check('unknown slug → no fabricated median', (missing.body.stats as { medianPsfAed: number | null }).medianPsfAed === null)
} catch (err) {
  failed++
  failures.push('suite threw')
  console.log(`\n  ✗ suite threw: ${(err as Error).message}`)
} finally {
  const tx = await prisma.transaction.deleteMany({ where: { dldId: { startsWith: ID } } })
  const us = await prisma.user.deleteMany({ where: { id: { in: created } } })
  console.log(`\n  cleanup: ${tx.count} transaction(s), ${us.count} user(s) removed`)
  console.log(`\n  ${passed} passed, ${failed} failed`)
  if (failures.length) console.log(`  failures:\n${failures.map((f) => `    - ${f}`).join('\n')}`)
  process.exit(failed === 0 ? 0 : 1)
}
