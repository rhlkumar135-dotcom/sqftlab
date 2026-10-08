/**
 * Day 19 verification — exercises the news pipeline directly, outside the server,
 * so a failure surfaces as a stack trace instead of a dropped connection.
 *
 * Run: bun run scripts/verify-news.ts
 */
import { ingestAllNewsSources, processUnprocessedItems, generateDailyDigest, aiConfigured } from '../src/lib/news'
import { NEWS_FEEDS } from '../src/lib/news-sources'
import { prisma } from '../src/lib/db'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failures++
}

console.log('=== Day 19 — news pipeline ===\n')
console.log(`aiConfigured: ${aiConfigured()}`)
console.log(`feeds configured: ${NEWS_FEEDS.length}\n`)

console.log('── ingest ──')
const ingest = await ingestAllNewsSources()
for (const f of ingest.feeds) {
  console.log(
    `  ${f.feedId.padEnd(26)} fetched=${String(f.fetched).padStart(3)} saved=${String(f.saved).padStart(3)} filtered=${String(f.filtered).padStart(3)} skipped=${String(f.skipped).padStart(3)}${f.error ? `  ERROR=${f.error}` : ''}`,
  )
}
console.log(`\n  totals: fetched=${ingest.fetched} saved=${ingest.saved} filtered=${ingest.filtered} skipped=${ingest.skipped} errors=${ingest.errors} feedsOk=${ingest.feedsOk}/${NEWS_FEEDS.length}`)

check('at least 5 feeds responded', ingest.feedsOk >= 5, `${ingest.feedsOk} ok`)
check('no per-item ingest errors', ingest.errors === 0, `errors=${ingest.errors}`)

// The feed is long-lived: a re-run legitimately stores nothing because every recent
// item is already present. What must hold is that the table has articles and that
// they are recent — not that this particular run inserted any.
const storedTotal = await prisma.newsItem.count()
const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
const storedRecent = await prisma.newsItem.count({ where: { publishedAt: { gte: since7d } } })
check('articles are stored', storedTotal > 0, `total=${storedTotal}`)
check('stored articles are within the 7-day window', storedRecent > 0, `recent=${storedRecent}`)

console.log('\n── idempotency (second ingest must save 0 new) ──')
const second = await ingestAllNewsSources()
check('re-ingest stores no duplicates', second.saved === 0, `second run saved=${second.saved}`)

console.log('\n── AI processing ──')
const proc = await processUnprocessedItems(5)
console.log(`  attempted=${proc.attempted} processed=${proc.processed} failed=${proc.failed} noCredential=${proc.skippedNoCredential}${proc.error ? ` err=${proc.error}` : ''}`)
if (proc.attempted > 0) check('at least one item processed by the model', proc.processed > 0, `processed=${proc.processed}`)

console.log('\n── stored data sanity ──')
const total = await prisma.newsItem.count()
const processed = await prisma.newsItem.count({ where: { aiProcessed: true } })
const sample = await prisma.newsItem.findFirst({ where: { aiProcessed: true }, orderBy: { publishedAt: 'desc' } })
console.log(`  items total=${total} processed=${processed}`)
if (sample) {
  console.log(`  sample headline : ${sample.headline.slice(0, 80)}`)
  console.log(`  sample publisher: ${sample.sourceName}`)
  console.log(`  sample signal   : ${sample.aiSignalType} / ${sample.aiSentiment}`)
  console.log(`  sample area     : ${sample.aiImpactArea ?? '(none)'}`)
  console.log(`  sample figures  : ${sample.aiKeyFigures ?? '(none)'}`)
  check('sample has an AI summary', !!sample.aiSummary)
  check('sample signal is a known type', ['price-movement', 'project-launch', 'regulatory', 'investment', 'market-stats', 'macro', 'other'].includes(sample.aiSignalType ?? ''), sample.aiSignalType ?? '')
}

console.log('\n── digest ──')
const digest = await generateDailyDigest(true)
console.log(`  generated=${digest.generated} reason=${digest.reason ?? '-'} date=${digest.date} articles=${digest.articlesScanned}`)
if (digest.generated) {
  const row = await prisma.intelligenceSummary.findFirst({ orderBy: { date: 'desc' } })
  console.log(`  headline: ${row?.headline?.slice(0, 90)}`)
  console.log(`  sentiment: ${row?.sentimentScore}`)
  console.log(`  areas: ${row?.areasInFocus}`)
  check('digest has a headline', !!row?.headline)
  check('digest has signals json', (row?.topSignals ?? '').startsWith('['), row?.topSignals?.slice(0, 40) ?? '')
  check('digest is idempotent (second call reports already generated)', (await generateDailyDigest()).generated === false)
}

console.log(`\n=== ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} ===`)
await prisma.$disconnect()
process.exit(failures === 0 ? 0 : 1)
