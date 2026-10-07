// Regression guard for the PropertyFinder listing parser.
//
// Run: bun run scripts/verify-scraper.ts
//
// Why this exists: `pfParse()` in custom-routes.ts read `property.size` directly
// into the `areaSqft` column. PropertyFinder returns that field as
// `{ value, unit }`, so every `prisma.listing.upsert()` threw
// "Expected Float, provided Object" — and because the call sat inside a bare
// `catch {}`, the crawl still reported success while persisting nothing. The
// offline copy in scripts/scraper-pf.ts had handled both shapes for a while; the
// in-server copy had not. These checks fail if the two ever drift apart again.
import './_env-guard'
import { prisma } from '../src/lib/db'
import { pfParse } from '../custom-routes'

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

// The exact payload shape copied out of the live failure log.
const pfListing = {
  id: '139232605',
  price: { value: 1149888 },
  size: { value: 898, unit: 'sqft' },
  property_type: 'Apartment',
  bedrooms_value: 1,
  bathrooms_value: 2,
  furnished: 'unfurnished',
  completion_status: 'ready',
  agent: { name: 'Mishel Wehbe' },
  broker: { name: 'fam Properties - Branch 6' },
  title: 'Vacant | Park And Golf View | Most Spacious Layout',
  images: [{ medium: 'https://example.invalid/a.jpg' }],
  listed_date: '2026-09-02T12:57:43.000Z',
  location: {
    name: 'Dubai Hills Estate',
    slug: 'dubai-hills-estate',
    coordinates: { lat: 25.023927688598633, lon: 55.18357467651367 },
  },
}

console.log('\n── pfParse: PropertyFinder size shapes ─────────────────────')

const parsed = pfParse(pfListing, 'propertyfinder', 'sale')
check('areaSqft is a number, not the size object', typeof parsed.areaSqft === 'number', `typeof=${typeof parsed.areaSqft}`)
check('areaSqft reads through to the value', parsed.areaSqft === 898, String(parsed.areaSqft))
check('priceAed reads through to the price value', parsed.priceAed === 1149888, String(parsed.priceAed))
check('pricePerSqft is computed, not forced to 0', parsed.pricePerSqft === Math.round(1149888 / 898), String(parsed.pricePerSqft))
check('externalId is namespaced by source', parsed.externalId === 'propertyfinder_139232605', parsed.externalId)

// A bare number is the older shape and must keep working.
const bare = pfParse({ ...pfListing, size: 898 }, 'propertyfinder', 'sale')
check('a bare numeric size still parses', bare.areaSqft === 898 && bare.pricePerSqft === 1280, String(bare.areaSqft))

// A numeric string is what a sloppy upstream would send next.
const strSize = pfParse({ ...pfListing, size: { value: '898', unit: 'sqft' } }, 'propertyfinder', 'sale')
check('a numeric string size parses', strSize.areaSqft === 898, String(strSize.areaSqft))

// Missing or unusable size must degrade to 0 rather than NaN (NaN also fails the
// Prisma Float check and would resurrect the original outage).
const noSize = pfParse({ ...pfListing, size: undefined }, 'propertyfinder', 'sale')
check('an absent size degrades to 0, never NaN', noSize.areaSqft === 0 && noSize.pricePerSqft === 0, String(noSize.areaSqft))
const junkSize = pfParse({ ...pfListing, size: { unit: 'sqft' } }, 'propertyfinder', 'sale')
check('a size without a value degrades to 0', junkSize.areaSqft === 0, String(junkSize.areaSqft))

console.log('\n── the write that used to throw ────────────────────────────')

const community = await prisma.community.findFirst({ select: { id: true, slug: true } })
if (!community) {
  console.log('  skip: no community row to attach a listing to')
} else {
  const externalId = `selftest_pfparse_${Date.now()}`
  try {
    // Mirrors the create payload in the scrape handler.
    await prisma.listing.upsert({
      where: { externalId },
      create: {
        externalId,
        source: 'propertyfinder',
        communityId: community.id,
        purpose: 'sale',
        propertyType: parsed.propertyType,
        beds: parsed.beds,
        baths: parsed.baths,
        areaSqft: parsed.areaSqft,
        priceAed: parsed.priceAed,
        pricePerSqft: parsed.pricePerSqft,
        furnished: parsed.furnished,
        completion: parsed.completion,
        agentName: parsed.agentName,
        agencyName: parsed.agencyName,
        title: parsed.title,
        imageUrl: parsed.imageUrl,
        sourceUrl: parsed.sourceUrl,
        latitude: parsed.latitude,
        longitude: parsed.longitude,
        listedAt: parsed.listedAt,
        isDeal: false,
      },
      update: { priceAed: parsed.priceAed },
    })
    const row = await prisma.listing.findUnique({ where: { externalId }, select: { areaSqft: true, pricePerSqft: true } })
    check('the upsert persists with a real area', row?.areaSqft === 898, String(row?.areaSqft))
    check('the upsert persists with a real pricePerSqft', (row?.pricePerSqft ?? 0) > 0, String(row?.pricePerSqft))
  } catch (err) {
    check('the upsert does not throw', false, err instanceof Error ? err.message.slice(0, 90) : String(err))
  } finally {
    // This row is ours alone, and the live table must be left as it was found.
    await prisma.listing.deleteMany({ where: { externalId } })
    const gone = await prisma.listing.count({ where: { externalId } })
    check('the test row was removed again', gone === 0, `remaining=${gone}`)
  }
}

console.log('\n── the crawl can no longer fail silently ───────────────────')

const src = await Bun.file('custom-routes.ts').text()
const looseCatch = /catch \{\}\s*\n\s*\}\s*\n\s*\/\/ Jittered/.test(src)
check('the listing loop no longer swallows write errors', !looseCatch)
check('failures are counted and surfaced', src.includes('saveFailures++') && src.includes('saveFailures,'))
check('a failed run is not logged as success', src.includes("circuitBroken || saveFailures > 0 ? 'partial' : 'success'"))

console.log(`\n${pass} passed, ${fail} failed`)
await prisma.$disconnect()
process.exit(fail === 0 ? 0 : 1)
