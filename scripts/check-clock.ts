/**
 * Clock-skew check.
 *
 * WHY THIS EXISTS. During a data audit on this runtime, roughly 5% of listings appeared to
 * be "listed in the future" and every recent news headline rendered as "just now". Both
 * looked like data-corruption bugs. Neither was: the sandbox clock was running **48 hours
 * behind real time**. Three independent servers agreed on 10 Oct while the container said
 * 8 Oct.
 *
 * That matters far beyond one misleading audit, because the product is almost entirely
 * time-relative: "listings listed in the last N days", the 30-day news window, monthly
 * market-history buckets, "updated 2h ago" labels, digest scheduling, and every
 * `publishedAt >= since` filter. A skewed clock silently shifts all of them, and the
 * symptoms look like data problems rather than infrastructure ones — which is exactly the
 * wrong direction to send an investigation. So rather than infer the clock from the data, we
 * ask an external server what time it is.
 *
 * Three sources are queried and the median offset is reported, so one bad responder cannot
 * mislead it. Read-only; makes no writes.
 *
 *   bun run scripts/check-clock.ts
 *
 * Exit code is 1 when the skew exceeds the tolerance, so CI can gate on it.
 */
const TOLERANCE_MS = 5 * 60 * 1000

/** Servers that return a reliable `Date` header. Chosen for independence, not for content. */
const SOURCES = ['https://www.google.com', 'https://www.propertyfinder.ae', 'https://www.cloudflare.com']

interface Reading {
  source: string
  serverTime: number
  offsetMs: number
}

async function readClock(source: string, startedAt: number): Promise<Reading | null> {
  try {
    const res = await fetch(source, { method: 'HEAD', signal: AbortSignal.timeout(15_000) })
    const header = res.headers.get('date')
    if (header === null) return null
    const serverTime = new Date(header).getTime()
    if (Number.isNaN(serverTime)) return null
    // Compare against the midpoint of the request, so network latency does not read as skew.
    const midway = startedAt + (Date.now() - startedAt) / 2
    return { source, serverTime, offsetMs: serverTime - midway }
  } catch {
    return null
  }
}

async function main() {
  const startedAt = Date.now()
  const localDate = new Date(startedAt)
  console.log(`container clock : ${localDate.toISOString()}  (epoch ${startedAt})`)
  console.log(`local timezone  : ${Intl.DateTimeFormat().resolvedOptions().timeZone}\n`)

  const readings = (await Promise.all(SOURCES.map((s) => readClock(s, startedAt)))).filter(
    (r): r is Reading => r !== null,
  )

  if (readings.length === 0) {
    console.log('Could not reach any external clock source, so the container clock is UNVERIFIED.')
    console.log('This is not a pass — treat every time-relative figure with suspicion until it is checked.')
    process.exit(2)
  }

  console.log('external clocks:')
  for (const r of readings) {
    const sign = r.offsetMs >= 0 ? '+' : '−'
    const abs = Math.abs(r.offsetMs)
    const human = abs > 3_600_000 ? `${(abs / 3_600_000).toFixed(2)}h` : `${(abs / 60_000).toFixed(1)}m`
    console.log(`  ${r.source.padEnd(34)} ${new Date(r.serverTime).toISOString()}   local is ${sign}${human}`)
  }

  const sorted = readings.map((r) => r.offsetMs).sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
  const absMedian = Math.abs(median)
  const human = absMedian > 3_600_000 ? `${(absMedian / 3_600_000).toFixed(2)} hours` : `${(absMedian / 60_000).toFixed(1)} minutes`
  const direction = median >= 0 ? 'behind' : 'ahead of'

  console.log(`\nmedian offset: the container clock is ${human} ${direction} real time`)

  if (absMedian <= TOLERANCE_MS) {
    console.log('within tolerance — time-relative features are trustworthy.')
    process.exit(0)
  }

  console.log(
    `\n✗ EXCEEDS the ${TOLERANCE_MS / 60_000}-minute tolerance.\n` +
      '  Consequences to expect while this holds:\n' +
      '    · "listed in the last N days" windows and the 30-day news window are shifted\n' +
      '    · source timestamps that are correct will appear to be in the future\n' +
      '    · relative labels ("just now", "2h ago") will be wrong\n' +
      '    · digest scheduling and monthly buckets will be offset\n' +
      '  Do NOT "fix" this by rewriting source data to match the container clock — the source\n' +
      '  clock is the external one. Correct the clock.',
  )
  process.exit(1)
}

await main()
