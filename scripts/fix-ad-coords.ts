// Repairs Abu Dhabi communities that were plotted inside Dubai.
//
// `ensureCommunity` used a single hardcoded Dubai centroid (25.2, 55.27) for
// every community it created, regardless of emirate, so any Abu Dhabi area
// discovered by the scraper landed in Dubai and rendered as a marker on the
// wrong city. The fallback is now emirate-keyed; this fixes rows already stored.
//
// Dry-run by default. Pass --apply to write.
import { prisma } from '../src/lib/db'

// Real centroids for the affected areas.
const CORRECT: Record<string, [number, number, string]> = {
  mbz: [24.3390, 54.5450, 'Mohammed Bin Zayed City, Abu Dhabi'],
  'al-maryah-island': [24.5015, 54.3870, 'Al Maryah Island, Abu Dhabi'],
}

// Abu Dhabi emirate's mainland extent. 25.06/55.15 sits north-east of this —
// inside Dubai — which is where the two mislocated rows are.
const AD_BOUNDS = { minLat: 22.6, maxLat: 24.95, minLng: 51.5, maxLng: 55.05 }

const apply = process.argv.includes('--apply')

const communities = await prisma.community.findMany({
  select: { id: true, slug: true, nameEn: true, emirate: true, latitude: true, longitude: true },
})

const misplaced = communities.filter(
  (c) =>
    c.emirate === 'abu_dhabi' &&
    (c.latitude < AD_BOUNDS.minLat ||
      c.latitude > AD_BOUNDS.maxLat ||
      c.longitude < AD_BOUNDS.minLng ||
      c.longitude > AD_BOUNDS.maxLng),
)

console.log(`abu_dhabi communities: ${communities.filter((c) => c.emirate === 'abu_dhabi').length}`)
console.log(`outside Abu Dhabi bounds: ${misplaced.length}`)

for (const c of misplaced) {
  const fix = CORRECT[c.slug]
  const label = `  ${c.slug} (${c.latitude.toFixed(4)}, ${c.longitude.toFixed(4)})${fix ? ` -> (${fix[0]}, ${fix[1]}) ${fix[2]}` : ' -> NO KNOWN CENTROID'}`
  if (!fix) {
    console.log(`SKIP${label}`)
    continue
  }
  console.log(`${apply ? 'FIX ' : 'DRY '}${label}`)
  if (apply) {
    await prisma.community.update({
      where: { id: c.id },
      data: { latitude: fix[0], longitude: fix[1] },
    })
  }
}

if (!apply) console.log('\nDry run — re-run with --apply to write.')
await prisma.$disconnect()
