// Removes the building-level junk communities a scraper run created.
//
// The scraper used to key a listing's community on the BUILDING slug from the
// PropertyFinder card, so one run added ~484 communities named after individual
// towers (`...-jlt-cluster-e-global-lake-view`), each with zero listings and the
// wrong emirate. `custom-routes.ts` now attributes listings to the area being
// scraped, so no new ones appear — this cleans up the ones already written.
//
// Safety: a community is only a candidate when it owns NO listings and NO
// transactions AND its slug is in none of:
//   - the 44 districts recorded in the shipped snapshot
//   - the 30 areas the scraper is configured to crawl
// Runs dry unless APPLY=1. Writes a JSON backup before deleting.
import { writeFileSync } from 'node:fs'
import { prisma } from '../src/lib/db'
import snapshot from '../src/data/snapshot.json'

const AREA_SLUGS = [
  'dubai-marina', 'downtown-dubai', 'palm-jumeirah', 'jumeirah-village-circle', 'business-bay',
  'dubai-hills-estate', 'jumeirah-lake-towers', 'difc', 'dubai-creek-harbour', 'mbr-city',
  'al-barsha', 'deira', 'bur-dubai', 'dubai-silicon-oasis', 'dubai-sports-city', 'motor-city',
  'discovery-gardens', 'town-square', 'al-nahda', 'dubailand',
  'al-reem-island', 'saadiyat-island', 'yas-island', 'al-raha-beach', 'corniche',
  'khalifa-city', 'mbz-city', 'al-maryah-island',
]

function snapshotSlugs(): string[] {
  const out = new Set<string>()
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) {
      for (const x of o) {
        if (x && typeof x === 'object' && 'slug' in (x as Record<string, unknown>)) {
          const s = (x as { slug?: unknown }).slug
          if (typeof s === 'string') out.add(s)
        }
        walk(x)
      }
    } else if (o && typeof o === 'object') {
      for (const v of Object.values(o as Record<string, unknown>)) walk(v)
    }
  }
  walk(snapshot)
  return [...out]
}

async function main() {
  const keep = new Set([...snapshotSlugs(), ...AREA_SLUGS])
  console.log(`keep set: ${keep.size} slugs (${snapshotSlugs().length} from snapshot, ${AREA_SLUGS.length} areas)`)

  const total = await prisma.community.count()
  const owned = new Set(
    (await prisma.listing.groupBy({ by: ['communityId'], _count: { _all: true } })).map((r) => r.communityId)
  )
  const txOwned = new Set(
    (await prisma.transaction.groupBy({ by: ['communityId'], _count: { _all: true } })).map((r) => r.communityId)
  )

  const all = await prisma.community.findMany({ select: { id: true, slug: true, nameEn: true, emirate: true } })
  const junk = all.filter((c) => !owned.has(c.id) && !txOwned.has(c.id) && !keep.has(c.slug))

  console.log(`communities: ${total}`)
  console.log(`  keep (in snapshot/areas):     ${all.length - junk.length - [...all].filter((c) => !keep.has(c.slug) && (owned.has(c.id) || txOwned.has(c.id))).length}`)
  console.log(`  keep (owns real data):        ${[...all].filter((c) => !keep.has(c.slug) && (owned.has(c.id) || txOwned.has(c.id))).length}`)
  console.log(`  JUNK (no data, unknown slug): ${junk.length}`)
  console.log('\n  sample:')
  for (const c of junk.slice(0, 10)) console.log(`    ${c.slug}`)

  if (process.env.APPLY !== '1') {
    console.log('\nDRY RUN — set APPLY=1 to delete.')
    await prisma.$disconnect()
    return
  }

  const backupPath = `scripts/.backup-junk-communities-${Date.now()}.json`
  writeFileSync(backupPath, JSON.stringify(junk, null, 1))
  console.log(`\nbackup written: ${backupPath}`)

  const ids = junk.map((c) => c.id)
  // Scores reference communities, so clear them first or the delete hits the FK.
  const scores = await prisma.investmentScore.deleteMany({ where: { communityId: { in: ids } } })
  const deleted = await prisma.community.deleteMany({ where: { id: { in: ids } } })
  console.log(`deleted ${scores.count} investment score row(s) and ${deleted.count} community row(s)`)
  console.log(`communities remaining: ${await prisma.community.count()}`)
  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(String(e).slice(0, 400))
  process.exit(1)
})
