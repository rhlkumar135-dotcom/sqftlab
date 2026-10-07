// Closes ScraperLog rows left on 'running' by a handler that was killed before it
// could reach a terminal state. Safe to run repeatedly; it only touches rows that
// no live process can own.
import { prisma } from '../src/lib/db'

const main = async () => {
  const stale = await prisma.scraperLog.findMany({ where: { status: 'running' } })
  console.log(`stale 'running' rows: ${stale.length}`)
  for (const r of stale) console.log(`  ${r.startedAt.toISOString()} source=${r.source} dur=${r.durationMs}`)

  if (stale.length) {
    const { count } = await prisma.scraperLog.updateMany({
      where: { status: 'running' },
      data: { status: 'error', errorMsg: 'Interrupted — process died before completion', finishedAt: new Date() },
    })
    console.log(`closed ${count} row(s)`)
  }
  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(String(e).slice(0, 300))
  process.exit(1)
})
