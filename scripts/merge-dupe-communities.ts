/**
 * Merge communities the scraper duplicated because the matcher compared only
 * `nameEn`. Portals label areas by their short form ("JVC") while the seeded
 * row carries the spelled-out name ("Jumeirah Village Circle"), so the lookup
 * missed and a second row was created for the same place.
 *
 * `community-match.ts` now also matches on `slug`, which stops new duplicates.
 * This repairs the ones already written. Dry-run by default.
 */
import { prisma } from '../src/lib/db'

const MERGES: Array<{ from: string; into: string }> = [
  { from: 'jumeirah-village-circle', into: 'jvc' },
  { from: 'dubai-land', into: 'dubailand' },
]

const apply = process.argv.includes('--apply')

for (const { from, into } of MERGES) {
  const src = await prisma.community.findUnique({ where: { slug: from }, include: { _count: { select: { listings: true, transactions: true } } } })
  const dst = await prisma.community.findUnique({ where: { slug: into }, include: { _count: { select: { listings: true, transactions: true } } } })
  if (!src || !dst) {
    console.log(`skip  ${from} -> ${into}  (source or target missing)`)
    continue
  }
  console.log(
    `${from} (listings=${src._count.listings}, txns=${src._count.transactions})` +
      ` -> ${into} (listings=${dst._count.listings}, txns=${dst._count.transactions})`,
  )
  if (!apply) continue
  await prisma.listing.updateMany({ where: { communityId: src.id }, data: { communityId: dst.id } })
  await prisma.transaction.updateMany({ where: { communityId: src.id }, data: { communityId: dst.id } })
  await prisma.portfolio.updateMany({ where: { communityId: src.id }, data: { communityId: dst.id } })
  // The unique (userId, communityId) pair means a watchlist row may already exist
  // on the target; delete the source rows rather than colliding.
  await prisma.watchlist.deleteMany({ where: { communityId: src.id } })
  await prisma.alert.updateMany({ where: { communityId: src.id }, data: { communityId: dst.id } })
  await prisma.community.delete({ where: { id: src.id } })
  console.log(`  ✓ merged and deleted ${from}`)
}

console.log(apply ? '\nApplied.' : '\nDRY RUN — re-run with --apply')
await prisma.$disconnect()
