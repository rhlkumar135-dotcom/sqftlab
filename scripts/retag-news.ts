/**
 * Recompute `emirate` for every stored news item under the current classifier.
 *
 * Needed because the tag is written at ingest: re-running the ingest only touches items
 * the feeds still return, so a classifier fix would never reach the older rows. This walks
 * the whole table.
 *
 * Prints the before/after distribution and the specific items that moved, so the change can
 * be judged rather than trusted.
 */
import { prisma } from '../src/lib/db'
import { classifyEmirate, NEWS_FEEDS } from '../src/lib/news-sources'
import { cacheInvalidate } from '../src/lib/cache'

const regionOfFeed = (id: string) => NEWS_FEEDS.find((f) => f.id === id)?.region ?? 'uae'

async function main() {
  const items = await prisma.newsItem.findMany({
    select: { id: true, headline: true, rawExcerpt: true, source: true, emirate: true },
  })

  const before: Record<string, number> = {}
  const after: Record<string, number> = {}
  const changes: Array<{ from: string; to: string; headline: string }> = []
  let updated = 0

  for (const it of items) {
    before[it.emirate] = (before[it.emirate] ?? 0) + 1
    const next = classifyEmirate(it.headline, it.rawExcerpt, regionOfFeed(it.source))
    after[next] = (after[next] ?? 0) + 1
    if (next !== it.emirate) {
      await prisma.newsItem.update({ where: { id: it.id }, data: { emirate: next } })
      updated++
      if (changes.length < 25) changes.push({ from: it.emirate, to: next, headline: it.headline })
    }
  }

  console.log(`scanned ${items.length}, retagged ${updated}\n`)
  console.log('before:', JSON.stringify(before))
  console.log('after: ', JSON.stringify(after))
  console.log('\nmoves (first 25):')
  for (const c of changes) console.log(`  ${c.from} -> ${c.to}  ${c.headline.slice(0, 80)}`)

  // Distribution inside the two emirate tabs, which is what the tabs actually show.
  for (const e of ['dubai', 'abu_dhabi']) {
    const rows = await prisma.newsItem.findMany({
      where: { emirate: e },
      select: { headline: true },
      orderBy: { publishedAt: 'desc' },
      take: 8,
    })
    console.log(`\n${e} — newest 8 headlines:`)
    for (const r of rows) console.log(`  ${r.headline.slice(0, 92)}`)
  }

  // The caches hold the counts and the analytics breakdowns derived from this column.
  cacheInvalidate('news:')
  console.log('\ncache invalidated')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
