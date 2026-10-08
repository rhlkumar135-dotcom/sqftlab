/**
 * Verifies the market-history contract:
 *
 *  1. Re-capturing the same day is idempotent — it updates today's row in place rather
 *     than adding a second one, so "latest" always means the newest refresh.
 *  2. A capture for a different day creates a *new* row — history accumulates instead of
 *     being overwritten. This is the whole point of the table: `communities.median_aed_sqft`
 *     is mutated on every refresh, so without a separate row per day no trend is possible.
 *
 * Test 2 writes a real row for a past day and then removes it, so the database is left
 * exactly as it was found. It never touches today's row, which holds genuine data.
 */
import { prisma } from '../src/lib/db'
import { captureMarketSnapshot, loadMarketHistory, uaeDay } from '../src/lib/market-history'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const today = uaeDay()
const yesterday = uaeDay(new Date(Date.now() - 24 * 60 * 60 * 1000))

async function main() {
  console.log(`\nmarket-history — today=${today} yesterday=${yesterday}\n`)

  const districts = await prisma.community.count()
  if (districts === 0) {
    console.log('  ! no communities in this database — nothing to capture')
    process.exit(0)
  }

  console.log('today (latest wins, history untouched)')
  const first = await captureMarketSnapshot()
  const afterFirst = await prisma.marketSnapshot.count({ where: { period: today } })
  check('captures one row per district', afterFirst === districts, `${afterFirst}/${districts}`)

  const stampBefore = await prisma.marketSnapshot.findFirst({
    where: { period: today },
    orderBy: { capturedAt: 'desc' },
    select: { capturedAt: true },
  })

  await new Promise((r) => setTimeout(r, 1100))
  const second = await captureMarketSnapshot()
  const afterSecond = await prisma.marketSnapshot.count({ where: { period: today } })
  const stampAfter = await prisma.marketSnapshot.findFirst({
    where: { period: today },
    orderBy: { capturedAt: 'desc' },
    select: { capturedAt: true },
  })

  check('re-capture adds no rows', afterSecond === afterFirst, `${afterFirst} -> ${afterSecond}`)
  check(
    're-capture advances the refreshed timestamp',
    !!stampBefore && !!stampAfter && stampAfter.capturedAt > stampBefore.capturedAt,
    `${stampBefore?.capturedAt.toISOString() ?? '?'} -> ${stampAfter?.capturedAt.toISOString() ?? '?'}`
  )
  check('same period reported', first.period === second.period, second.period)

  console.log('\nhistory (a new day appends)')
  let pastRows = 0
  try {
    await captureMarketSnapshot(new Date(Date.now() - 24 * 60 * 60 * 1000))
    pastRows = await prisma.marketSnapshot.count({ where: { period: yesterday } })
    check('a past day writes its own rows', pastRows === districts, `${pastRows}/${districts}`)

    const history = await loadMarketHistory({ days: 90 })
    const periods = history.daily.map((d) => d.period)
    check('both days appear in the series', periods.includes(today) && periods.includes(yesterday), periods.join(', '))
    check('daysRecorded counts both', history.daysRecorded === 2, String(history.daysRecorded))
    check('firstPeriod is the older day', history.firstPeriod === yesterday, String(history.firstPeriod))
    check(
      'daily points resolve a market PSF',
      history.daily.every((d) => d.medianPsf === null || d.medianPsf > 0),
      history.daily.map((d) => `${d.period}=${d.medianPsf}`).join(' ')
    )
    check(
      'supply history reaches beyond the snapshots',
      history.supply.length > history.daysRecorded,
      `${history.supply.length} months vs ${history.daysRecorded} days`
    )
  } finally {
    // Remove only what this test wrote. Today's row is genuine data and is left alone.
    const removed = await prisma.marketSnapshot.deleteMany({ where: { period: yesterday } })
    check('cleanup removed the test day', removed.count === pastRows, `${removed.count} rows`)
  }

  const finalToday = await prisma.marketSnapshot.count({ where: { period: today } })
  check('today is still intact after cleanup', finalToday === districts, `${finalToday}/${districts}`)
  const leftovers = await prisma.marketSnapshot.count({ where: { period: yesterday } })
  check('no test residue remains', leftovers === 0, `${leftovers} rows`)

  console.log(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) FAILED\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
