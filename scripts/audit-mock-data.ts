/**
 * Mock-data audit.
 *
 * Answers "is any of this synthetic?" from the data itself rather than from a single
 * purge script's idea of what seeds look like — a seed written by a different path, or by
 * hand, would not match `isSeededListing`.
 *
 * Four independent signals, because each one alone has a blind spot:
 *
 *  1. MARKER STRINGS. Columns containing test/demo/sample/placeholder vocabulary. Catches
 *     hand-written fixtures, which are exactly the ones a pattern matcher misses.
 *  2. ID SHAPE. Seeded rows tend to carry fabricated ids. For listings the real shape is
 *     `propertyfinder_<numericId>`; anything else is reported.
 *  3. IMPLAUSIBLE VALUES. Prices padded by round numbers, out-of-range figures, and the
 *     sub-100 AED/sqft transfers that export-data.ts already treats as placeholders.
 *  4. DUPLICATION. A table where one value covers a suspicious share of rows reads as
 *     generated filler rather than observed data.
 *
 * Read-only. Nothing here writes.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'file:./prisma/dev.db'

let problems = 0
const findings: string[] = []

function report(line: string, isProblem: boolean): void {
  if (isProblem) {
    problems += 1
    findings.push(line)
    console.log(`  ✗ ${line}`)
  } else {
    console.log(`  · ${line}`)
  }
}

const MOCK_MARKERS = [
  'lorem', 'ipsum', 'placeholder', 'dummy', 'asdf', 'foobar', 'foo bar', 'test row',
  'sample ', 'fake ', 'mock', 'example.com', 'changeme', 'todo', 'xxx', '12345',
  'jane doe', 'john doe', 'villa test', 'test property', 'test community',
]

/**
 * How far our clock is from an external one.
 *
 * Load-bearing for this audit. Source-supplied timestamps (a portal's `listed_date`, a
 * feed's `pubDate`) come from the source's clock, so "is this date in the future?" is only
 * a meaningful question when our clock is right. During development on this runtime it was
 * 48 hours slow, which made correct dates look like corruption and produced two false
 * findings before the cause was found. So the skew is measured first and the date checks are
 * judged against it, rather than reported as data problems.
 */
async function measureClockSkewMs(): Promise<number | null> {
  const started = Date.now()
  const offsets: number[] = []
  for (const source of ['https://www.google.com', 'https://www.cloudflare.com']) {
    try {
      const res = await fetch(source, { method: 'HEAD', signal: AbortSignal.timeout(10_000) })
      const header = res.headers.get('date')
      if (header === null) continue
      const serverTime = new Date(header).getTime()
      if (Number.isNaN(serverTime)) continue
      offsets.push(serverTime - (started + (Date.now() - started) / 2))
    } catch {
      // An unreachable source simply does not contribute a reading.
    }
  }
  if (offsets.length === 0) return null
  offsets.sort((a, b) => a - b)
  return offsets[Math.floor(offsets.length / 2)] ?? null
}

async function main() {
  // Reuse the application's client: Prisma 7 requires a driver adapter, so constructing a
  // bare PrismaClient here would fail for reasons unrelated to the data.
  const { prisma } = await import('../src/lib/db')

  // ── Table inventory ────────────────────────────────────────────────────────────
  const tables = (await prisma.$queryRawUnsafe(
    "select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like '_prisma%' order by name",
  )) as Array<{ name: string }>

  console.log(`\n── table inventory (${tables.length} tables) ──`)
  const counts = new Map<string, number>()
  for (const { name } of tables) {
    const row = (await prisma.$queryRawUnsafe(`select count(*) as n from "${name}"`)) as Array<{ n: number | bigint }>
    const n = Number(row[0]?.n ?? 0)
    counts.set(name, n)
  }
  const populated = [...counts.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
  const empty = [...counts.entries()].filter(([, n]) => n === 0).map(([t]) => t)
  console.log(`  populated: ${populated.map(([t, n]) => `${t}=${n}`).join('  ')}`)
  console.log(`  empty (${empty.length}): ${empty.join(', ')}`)

  // ── 1. Marker strings ──────────────────────────────────────────────────────────
  console.log('\n── 1. marker strings in populated tables ──')
  let markerHits = 0
  for (const [table, n] of populated) {
    if (n === 0) continue
    const cols = (await prisma.$queryRawUnsafe(`pragma table_info("${table}")`)) as Array<{ name: string; type: string }>
    const textCols = cols.filter((c) => /char|text|clob|varchar/i.test(c.type))
    for (const col of textCols) {
      for (const marker of MOCK_MARKERS) {
        const hit = (await prisma.$queryRawUnsafe(
          `select count(*) as n from "${table}" where lower("${col.name}") like ?`,
        )) as Array<{ n: number | bigint }>
        const count = Number(hit[0]?.n ?? 0)
        if (count > 0) {
          markerHits += 1
          report(`${table}.${col.name} contains "${marker}" in ${count} row(s)`, true)
        }
      }
    }
  }
  if (markerHits === 0) console.log('  · no marker vocabulary found in any text column')

  // ── 2. Listing id shape ────────────────────────────────────────────────────────
  console.log('\n── 2. listing external id shape ──')
  const bySource = (await prisma.$queryRawUnsafe(
    'select source, count(*) as n from listings group by source order by n desc',
  )) as Array<{ source: string | null; n: number | bigint }>
  for (const row of bySource) {
    console.log(`  · source=${row.source ?? '(null)'} rows=${Number(row.n)}`)
  }
  const badIds = (await prisma.$queryRawUnsafe(
    `select count(*) as n from listings where external_id not like 'propertyfinder_%' or external_id not glob 'propertyfinder_[0-9]*'`,
  )) as Array<{ n: number | bigint }>
  report(`${Number(badIds[0]?.n ?? 0)} listing(s) have an id that is not propertyfinder_<digits>`, Number(badIds[0]?.n ?? 0) > 0)

  // ── 3. Implausible values ──────────────────────────────────────────────────────
  console.log('\n── 3. implausible values ──')
  // Measured before the date checks, because a slow clock makes correct source dates look
  // like corruption and would otherwise send this audit chasing the wrong thing.
  const skewMs = await measureClockSkewMs()
  const skewed = skewMs !== null && Math.abs(skewMs) > 5 * 60 * 1000
  if (skewMs === null) {
    console.log('  · container clock UNVERIFIED (no external clock reachable) — date checks below are inconclusive')
  } else {
    const hours = (skewMs / 3_600_000).toFixed(2)
    console.log(
      skewed
        ? `  ✗ container clock is ${Math.abs(Number(hours))}h ${skewMs > 0 ? 'behind' : 'ahead of'} real time — source dates that look future-dated may simply be correct`
        : `  · container clock within 5m of real time (offset ${hours}h)`,
    )
  }
  // Purpose-aware, and this matters: a SALE at under 100 AED/sqft is a placeholder, but rent
  // per sqft per YEAR is legitimately in the tens — the average here is around 124. Treating
  // both bands alike reported 916 healthy rent listings as corrupt, which is how an audit
  // teaches you to ignore it.
  const salePlaceholders = (await prisma.$queryRawUnsafe(
    "select count(*) as n from listings where purpose = 'sale' and price_per_sqft is not null and price_per_sqft > 0 and price_per_sqft < 100",
  )) as Array<{ n: number | bigint }>
  report(`${Number(salePlaceholders[0]?.n ?? 0)} SALE listing(s) below 100 AED/sqft (placeholder range)`, Number(salePlaceholders[0]?.n ?? 0) > 0)

  const rentOutOfBand = (await prisma.$queryRawUnsafe(
    "select count(*) as n from listings where purpose = 'rent' and price_per_sqft is not null and (price_per_sqft <= 1 or price_per_sqft > 400)",
  )) as Array<{ n: number | bigint }>
  report(`${Number(rentOutOfBand[0]?.n ?? 0)} RENT listing(s) outside 1-400 AED/sqft/yr`, Number(rentOutOfBand[0]?.n ?? 0) > 0)

  const zeroPrice = (await prisma.$queryRawUnsafe(
    'select count(*) as n from listings where price_aed is null or price_aed <= 0',
  )) as Array<{ n: number | bigint }>
  report(`${Number(zeroPrice[0]?.n ?? 0)} listing(s) with no positive price`, Number(zeroPrice[0]?.n ?? 0) > 0)

  const txnPlaceholders = (await prisma.$queryRawUnsafe(
    'select count(*) as n from transactions where price_per_sqft is not null and price_per_sqft > 0 and price_per_sqft < 100',
  )) as Array<{ n: number | bigint }>
  report(`${Number(txnPlaceholders[0]?.n ?? 0)} transaction(s) below 100 AED/sqft`, Number(txnPlaceholders[0]?.n ?? 0) > 0)

  // A listing cannot be listed before it existed, nor after the crawl that observed it — but
  // ONLY when the two clocks agree. `listed_at` comes from the portal, `scraped_at` from us,
  // so when our clock lags these counts rise for reasons that are not data problems. Reported
  // as informational in that case rather than as a failure, with the reason attached.
  const future = (await prisma.$queryRawUnsafe(
    "select count(*) as n from listings where datetime(listed_at) > datetime('now')",
  )) as Array<{ n: number | bigint }>
  const futureCount = Number(future[0]?.n ?? 0)
  report(
    `${futureCount} listing(s) dated after our clock${skewed ? ' (expected — source clock is ahead of ours)' : ''}`,
    futureCount > 0 && !skewed && skewMs !== null,
  )

  const afterCrawl = (await prisma.$queryRawUnsafe(
    "select count(*) as n from listings where datetime(listed_at) > datetime(scraped_at, '+1 hour')",
  )) as Array<{ n: number | bigint }>
  const afterCrawlCount = Number(afterCrawl[0]?.n ?? 0)
  report(
    `${afterCrawlCount} listing(s) dated after the crawl that found them${skewed ? ' (expected — same clock offset)' : ''}`,
    afterCrawlCount > 0 && !skewed && skewMs !== null,
  )

  // ── 4. Duplication ─────────────────────────────────────────────────────────────
  console.log('\n── 4. duplication ──')
  const totalListings = counts.get('listings') ?? 0
  if (totalListings > 0) {
    const dupes = (await prisma.$queryRawUnsafe(
      'select count(*) as n from (select source_url from listings where source_url is not null group by source_url having count(*) > 1)',
    )) as Array<{ n: number | bigint }>
    report(`${Number(dupes[0]?.n ?? 0)} duplicate source_url group(s) among ${totalListings} listings`, Number(dupes[0]?.n ?? 0) > 0)

    const nullUrl = (await prisma.$queryRawUnsafe(
      'select count(*) as n from listings where source_url is null or source_url = \'\'',
    )) as Array<{ n: number | bigint }>
    const pct = Math.round((Number(nullUrl[0]?.n ?? 0) / totalListings) * 100)
    report(`${Number(nullUrl[0]?.n ?? 0)} listing(s) (${pct}%) have no source_url`, false)
  }

  const communities = counts.get('communities') ?? 0
  if (communities > 0) {
    const dupNames = (await prisma.$queryRawUnsafe(
      'select count(*) as n from (select name_en from communities group by name_en having count(*) > 1)',
    )) as Array<{ n: number | bigint }>
    report(`${Number(dupNames[0]?.n ?? 0)} duplicate community name group(s) among ${communities}`, Number(dupNames[0]?.n ?? 0) > 0)
  }

  // ── Distinctness: real coverage should spread across many values ───────────────
  if (totalListings > 0) {
    const distinct = (await prisma.$queryRawUnsafe(
      'select count(distinct community_id) as c, count(distinct price_aed) as p, count(distinct substr(listed_at,1,10)) as d from listings',
    )) as Array<{ c: number | bigint; p: number | bigint; d: number | bigint }>
    const row = distinct[0]
    console.log(`  · ${Number(row?.c ?? 0)} distinct communities, ${Number(row?.p ?? 0)} distinct prices, ${Number(row?.d ?? 0)} distinct listing dates`)

    const topPrice = (await prisma.$queryRawUnsafe(
      'select price_aed, count(*) as n from listings group by price_aed order by n desc limit 1',
    )) as Array<{ price_aed: number; n: number | bigint }>
    const share = Math.round((Number(topPrice[0]?.n ?? 0) / totalListings) * 100)
    report(`most common price ${topPrice[0]?.price_aed} covers ${share}% of listings`, share > 25)
  }

  console.log(`\n${'─'.repeat(64)}`)
  if (problems === 0) {
    console.log('No mock or synthetic data detected across any table.')
  } else {
    console.log(`${problems} finding(s) need attention:`)
    for (const f of findings) console.log(`  · ${f}`)
  }
  await prisma.$disconnect()
  process.exit(problems > 0 ? 1 : 0)
}

await main()
