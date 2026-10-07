// Deal-engine verification — Day 1 Task F (positive path).
//
// Run:
//   cp prisma/dev.db /tmp/deal-e2e.db
//   DATABASE_URL=file:/tmp/deal-e2e.db bun run scripts/verify-deal-engine.ts
//
// WHY THIS SUITE EXISTS
//
// verify-day1.ts asserts that every existing isDeal flag AGREES with the 8% rule
// ("0 violations"). On this deployment that assertion is VACUOUS: `transactions`
// is empty, `marketPsfByCommunity()` therefore returns no medians, the flagging
// loop never runs, and 0 violations is true by construction. A detectDeals() that
// threw internally, or that compared against the wrong side of the threshold,
// would still pass it.
//
// The brief's acceptance item — "a listing priced >8% below area PSF shows
// isDeal: true" — cannot be exercised against the real database either, because
// the condition it needs (a community with a 90-day DLD median) does not exist in
// the data. So this suite manufactures that condition on a throwaway COPY and
// asserts the flag appears, the boundary is respected, and the guard rails hold.
//
// Everything created here is deleted in `finally`.
import { prisma } from '../src/lib/db'

const dbUrl = process.env.DATABASE_URL ?? ''
if (!dbUrl.includes('deal-e2e')) {
  throw new Error(
    `Refusing to run: DATABASE_URL must point at the disposable copy (…deal-e2e.db), got "${dbUrl || '<unset>'}".\n` +
      'This script WRITES rows (and calls detectDeals(), which rewrites every isDeal flag), so running it ' +
      'against the project database would pollute it.',
  )
}

const { detectDeals, marketPsfByCommunity, DEAL_DISCOUNT_THRESHOLD } = await import('../src/lib/deals')

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

const TX_PREFIX = 'DLDCHECK-'
const LISTING_PREFIX = `dealcheck-${Date.now()}-`

/** AED/sqft levels the synthetic market is built from. */
const MEDIAN = 2000
const EVEN_MEDIAN = 2050 // 2x2000 + 2x2100 → (2000+2100)/2
const PLACEHOLDER = 50 // below the AED 100/sqft guard

type Spec = {
  tag: string
  communityId: string
  purpose: 'sale' | 'rent'
  pricePerSqft: number
  staleFlag?: boolean
  expect: boolean
  why: string
}

async function makeTx(communityId: string, pricePerSqft: number, n: number, offsetFrom = 0) {
  const recent = new Date()
  recent.setDate(recent.getDate() - 10)
  for (let i = 0; i < n; i++) {
    await prisma.transaction.create({
      data: {
        dldId: `${TX_PREFIX}${communityId}-${pricePerSqft}-${i + offsetFrom}`,
        communityId,
        transactionType: 'sale',
        propertyType: 'apartment',
        beds: 2,
        areaSqft: 1000,
        priceAed: pricePerSqft * 1000,
        pricePerSqft,
        transactionDate: recent,
      },
    })
  }
}

async function makeListing(s: Spec) {
  await prisma.listing.create({
    data: {
      externalId: `${LISTING_PREFIX}${s.tag}`,
      source: 'bayut',
      communityId: s.communityId,
      purpose: s.purpose,
      propertyType: 'apartment',
      beds: 2,
      baths: 2,
      areaSqft: 1000,
      priceAed: s.pricePerSqft * 1000,
      pricePerSqft: s.pricePerSqft,
      listedAt: new Date(),
      isDeal: s.staleFlag === true,
    },
  })
}

let specs: Spec[] = []

try {
  // Four communities, each isolated: the engine groups by communityId, so this
  // gives one median per scenario without them interfering.
  const communities = await prisma.community.findMany({
    select: { id: true, nameEn: true },
    orderBy: { id: 'asc' },
    take: 4,
  })
  if (communities.length < 4) throw new Error(`need 4 communities, found ${communities.length}`)
  const [withMedian, evenMedian, noMedian, placeholder] = communities

  console.log(`\n── seeded market (sale listings per community) ─────────────`)
  console.log(`  · median community:      ${withMedian.nameEn} @ AED ${MEDIAN}/sqft`)
  console.log(`  · even-count community:  ${evenMedian.nameEn} @ AED ${EVEN_MEDIAN}/sqft`)
  console.log(`  · no-data community:     ${noMedian.nameEn}`)
  console.log(`  · placeholder community: ${placeholder.nameEn} @ AED ${PLACEHOLDER}/sqft`)

  // 3 identical sales → exact odd-count median; 2+2 → exercises the even-count
  // averaging branch, which is where a median implementation usually goes wrong.
  await makeTx(withMedian.id, MEDIAN, 3)
  await makeTx(evenMedian.id, 2000, 2)
  await makeTx(evenMedian.id, 2100, 2, 2)
  await makeTx(placeholder.id, PLACEHOLDER, 3)

  const below = (m: number) => Math.floor(m * DEAL_DISCOUNT_THRESHOLD) - 100 // comfortably under the line
  const justAbove = (m: number) => Math.ceil(m * DEAL_DISCOUNT_THRESHOLD) + 60 // comfortably over

  specs = [
    {
      tag: 'deal',
      communityId: withMedian.id,
      purpose: 'sale',
      pricePerSqft: below(MEDIAN),
      expect: true,
      why: 'THE BRIEF ITEM — >8% below the area median',
    },
    {
      tag: 'boundary',
      communityId: withMedian.id,
      purpose: 'sale',
      pricePerSqft: MEDIAN * DEAL_DISCOUNT_THRESHOLD, // exactly 1840
      expect: false,
      why: 'exactly at the threshold — the rule is strictly below',
    },
    {
      tag: 'above',
      communityId: withMedian.id,
      purpose: 'sale',
      pricePerSqft: justAbove(MEDIAN),
      expect: false,
      why: 'above the threshold',
    },
    {
      tag: 'rent',
      communityId: withMedian.id,
      purpose: 'rent',
      pricePerSqft: below(MEDIAN),
      expect: false,
      why: 'rentals are never deals, however cheap per sqft',
    },
    {
      tag: 'even-count-deal',
      communityId: evenMedian.id,
      purpose: 'sale',
      pricePerSqft: below(EVEN_MEDIAN),
      expect: true,
      why: 'even-count median (2000+2100)/2 = 2050 must be averaged, not off-by-one',
    },
    {
      tag: 'even-count-above',
      communityId: evenMedian.id,
      purpose: 'sale',
      pricePerSqft: justAbove(EVEN_MEDIAN),
      expect: false,
      why: 'above the averaged median',
    },
    {
      tag: 'no-data',
      communityId: noMedian.id,
      purpose: 'sale',
      pricePerSqft: 100,
      expect: false,
      why: 'no DLD median → no flag (cannot claim a discount without a market level)',
    },
    {
      tag: 'stale-flag',
      communityId: noMedian.id,
      purpose: 'sale',
      pricePerSqft: 3000,
      staleFlag: true,
      expect: false,
      why: 'a stale true must be RESET when the community has no median',
    },
    {
      tag: 'placeholder',
      communityId: placeholder.id,
      purpose: 'sale',
      pricePerSqft: 10,
      expect: false,
      why: 'a sub-100/sqft median is a placeholder, not a market level',
    },
  ]

  for (const s of specs) await makeListing(s)

  // ── the engine runs for real ────────────────────────────────────────────────
  const flaggedCount = await detectDeals()

  console.log(`\n── medians the engine derived ─────────────────────────────`)
  const medians = await marketPsfByCommunity()
  check(
    `odd-count median is exact (${withMedian.nameEn} = ${MEDIAN})`,
    medians.get(withMedian.id) === MEDIAN,
    medians.get(withMedian.id),
  )
  check(
    `even-count median averages the middle pair (${evenMedian.nameEn} = ${EVEN_MEDIAN})`,
    medians.get(evenMedian.id) === EVEN_MEDIAN,
    medians.get(evenMedian.id),
  )
  check(
    `sub-100/sqft rows are excluded from the median (${placeholder.nameEn} has none)`,
    medians.get(placeholder.id) === undefined,
    medians.get(placeholder.id),
  )
  check(
    `a community with no sales has no median (${noMedian.nameEn})`,
    medians.get(noMedian.id) === undefined,
    medians.get(noMedian.id),
  )

  console.log(`\n── flags after detectDeals() ──────────────────────────────`)
  const rows = await prisma.listing.findMany({
    where: { externalId: { startsWith: LISTING_PREFIX } },
    select: { externalId: true, purpose: true, pricePerSqft: true, isDeal: true, communityId: true },
  })
  const byTag = new Map(rows.map((r) => [r.externalId.replace(LISTING_PREFIX, ''), r]))

  for (const s of specs) {
    const row = byTag.get(s.tag)
    if (!row) {
      check(`${s.tag} — listing was written`, false, 'missing after insert')
      continue
    }
    check(
      `${s.tag}: isDeal=${s.expect} (${s.why})`,
      row.isDeal === s.expect,
      { got: row.isDeal, pricePerSqft: row.pricePerSqft },
    )
  }

  // Positive control for the whole suite: if this is 0, every `expect: false`
  // above passed for the wrong reason and the run proves nothing.
  check(
    'the engine flagged at least one deal (the positive control)',
    flaggedCount >= 2,
    { flaggedCount },
  )
  check(
    'every negative case really was evaluated against a median',
    medians.size >= 2,
    { communitiesWithMedian: medians.size },
  )
} catch (e) {
  failed++
  failures.push('threw')
  console.log(`  ✗ suite threw — ${(e as Error).message}`)
} finally {
  const [delListings, delTx] = await Promise.all([
    prisma.listing.deleteMany({ where: { externalId: { startsWith: LISTING_PREFIX } } }),
    prisma.transaction.deleteMany({ where: { dldId: { startsWith: TX_PREFIX } } }),
  ])
  console.log(`\n  cleaned up: ${delListings.count} listings, ${delTx.count} transactions`)
  await prisma.$disconnect()

  console.log(`\n  ${passed} passed, ${failed} failed`)
  if (failed > 0) console.log(`  failing: ${failures.join(' | ')}`)
  process.exit(failed > 0 ? 1 : 0)
}
