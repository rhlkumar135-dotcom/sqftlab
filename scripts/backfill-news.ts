/**
 * One-off corpus backfill: ingest the 30-day window, then run the AI pass until the
 * backlog is clear.
 *
 * `runNewsIngest` already does ingest + one processing batch, but on a cold corpus the
 * first tick saves far more items than a single batch can analyse (batch default 30), so
 * a single call leaves most of the feed unanalysed — and unanalysed items are invisible
 * in the tabs and excluded from every sentiment figure. This loops the processing pass
 * until it drains, with a hard cap so a stuck credential cannot spin forever.
 *
 * Safe to re-run: ingestion is idempotent on `contentHash`, and the processing pass only
 * selects rows where `aiProcessed = false`.
 */
import { prisma } from '../src/lib/db'
import { ingestAllNewsSources, processUnprocessedItems, aiConfigured } from '../src/lib/news'

const MAX_PROCESS_ROUNDS = Number(process.env.MAX_PROCESS_ROUNDS ?? 12)

async function main() {
  console.log('aiConfigured:', aiConfigured())

  const ingest = await ingestAllNewsSources()
  console.log(
    `\ningest: fetched=${ingest.fetched} saved=${ingest.saved} skipped=${ingest.skipped} ` +
      `filtered=${ingest.filtered} repaired=${ingest.repaired} errors=${ingest.errors} feedsOk=${ingest.feedsOk}/${ingest.feeds.length}`
  )
  for (const f of ingest.feeds) {
    console.log(
      `  ${f.feedId.padEnd(26)} fetched=${String(f.fetched).padEnd(4)} saved=${String(f.saved).padEnd(4)} ` +
        `filtered=${String(f.filtered).padEnd(4)} repaired=${String(f.repaired).padEnd(3)} ${f.error ?? ''}`
    )
  }

  if (!aiConfigured()) {
    console.log('\nno AI credential — items are stored but will stay unanalysed')
  } else {
    let totalProcessed = 0
    for (let round = 1; round <= MAX_PROCESS_ROUNDS; round++) {
      const r = await processUnprocessedItems(30)
      totalProcessed += r.processed
      const left = await prisma.newsItem.count({ where: { aiProcessed: false } })
      console.log(`  process round ${round}: attempted=${r.attempted} processed=${r.processed} failed=${r.failed} left=${left}`)
      if (r.attempted === 0 || r.processed === 0 || r.skippedNoCredential) break
    }
    console.log(`\nanalysed this run: ${totalProcessed}`)
  }

  const rows = await prisma.newsItem.groupBy({
    by: ['emirate'],
    _count: { _all: true },
    orderBy: { emirate: 'asc' },
  })
  const total = await prisma.newsItem.count()
  const analysed = await prisma.newsItem.count({ where: { aiProcessed: true } })
  const oldest = await prisma.newsItem.findFirst({ orderBy: { publishedAt: 'asc' }, select: { publishedAt: true } })
  const newest = await prisma.newsItem.findFirst({ orderBy: { publishedAt: 'desc' }, select: { publishedAt: true } })

  console.log(`\ncorpus: total=${total} analysed=${analysed}`)
  console.log(`range:  ${oldest?.publishedAt.toISOString().slice(0, 10) ?? '-'} -> ${newest?.publishedAt.toISOString().slice(0, 10) ?? '-'}`)
  console.log('by emirate:')
  for (const g of rows) console.log(`  ${g.emirate.padEnd(12)} ${g._count._all}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
