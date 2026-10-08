/**
 * Re-apply the news classifier and relevance filter to the stored corpus.
 *
 * Thin wrapper over `reclassifyNewsCorpus()` so the same logic runs here and behind the
 * `/sqftlab/news/reclassify` route. Both operations are needed because both rules are
 * applied at ingest, and ingest never revisits a row it has already stored.
 */
import { prisma } from '../src/lib/db'
import { reclassifyNewsCorpus } from '../src/lib/news'

async function main() {
  const r = await reclassifyNewsCorpus(1000)

  console.log(`scanned ${r.scanned}: retagged ${r.retagged}, purged ${r.purged}\n`)
  console.log('before:', JSON.stringify(r.before))
  console.log('after: ', JSON.stringify(r.after))

  if (r.purgeSamples.length > 0) {
    console.log('\npurged (off-topic for the feed that stored them):')
    for (const h of r.purgeSamples) console.log(`  - ${h}`)
  }

  for (const e of ['dubai', 'abu_dhabi', 'uae']) {
    const rows = await prisma.newsItem.findMany({
      where: { emirate: e },
      select: { headline: true },
      orderBy: { publishedAt: 'desc' },
      take: 6,
    })
    console.log(`\n${e} — newest 6:`)
    for (const x of rows) console.log(`  ${x.headline.slice(0, 88)}`)
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
