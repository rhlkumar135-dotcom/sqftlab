#!/usr/bin/env bun
/**
 * Prove the database holds live data and no mock data.
 *
 * The brief's data is meant to come from real portals (PropertyFinder) and real feeds
 * (Google News RSS), with the reference tables seeded from published sources. "No mock
 * data" is therefore a claim that has to be checked against the rows, not asserted — and
 * the failure it guards against is quiet: a placeholder row or a seeded fixture looks
 * exactly like a real one in the UI.
 *
 * The sweep is generic on purpose. Rather than testing the columns I happened to think
 * of, it walks every text column of every table, so a table added later is covered
 * without this script being remembered.
 *
 * Usage:
 *   bun run scripts/verify-live-data.ts
 *   DATABASE_URL=file:/tmp/copy.db bun run scripts/verify-live-data.ts
 */
import { Database } from 'bun:sqlite'
import { isAbsolute, resolve } from 'node:path'

const raw = process.env.DATABASE_URL ?? ''
const stripped = raw.replace(/^file:/, '')
const dbPath =
  stripped === ''
    ? resolve(import.meta.dir, '../prisma/dev.db')
    : isAbsolute(stripped)
      ? stripped
      : resolve(import.meta.dir, '..', stripped)

const db = new Database(dbPath, { readonly: true })

let passed = 0
const failures: string[] = []

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failures.push(label)
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

/**
 * Strings that only appear in fabricated data.
 *
 * Each marker carries a `verify` regex, and LIKE is only a prefilter. Substring matching
 * alone is too blunt in both directions: it flags the real district "Hammock Park" for
 * "mock" and a base64 image path ending "...TBD0RRZDP55M" for "tbd", and a check that
 * cries wolf on real data is a check that gets switched off.
 *
 * Bare "test" is deliberately absent: it matches "latest", "greatest" and "testament".
 */
const MARKERS: Array<{ label: string; like: string; verify: RegExp }> = [
  { label: 'mock', like: '%mock%', verify: /\bmock/i },
  { label: 'dummy', like: '%dummy%', verify: /\bdummy/i },
  { label: 'lorem ipsum', like: '%lorem%', verify: /\blorem\b/i },
  { label: 'fixture', like: '%fixture%', verify: /\bfixture/i },
  { label: 'placeholder', like: '%placeholder%', verify: /\bplaceholder/i },
  { label: 'synthetic', like: '%synthetic%', verify: /\bsynthetic/i },
  { label: 'seed', like: '%seed%', verify: /\bseeded\b|\bseed data\b/i },
  { label: 'example.com', like: '%example.com%', verify: /@example\.com|\.example\.com/i },
  { label: 'test user', like: '%test user%', verify: /\btest user\b/i },
  { label: 'test@ address', like: '%test@%', verify: /test@/i },
  { label: 'asdf', like: '%asdf%', verify: /\basdf/i },
  { label: 'foobar', like: '%foobar%', verify: /foobar/i },
  { label: 'john doe', like: '%john doe%', verify: /\bjohn doe\b/i },
  { label: 'jane doe', like: '%jane doe%', verify: /\bjane doe\b/i },
  { label: 'tbd', like: '%tbd%', verify: /\btbd\b/i },
  { label: 'sample data', like: '%sample data%', verify: /\bsample data\b/i },
]

function hasColumn(table: string, column: string): boolean {
  const cols = db.query(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>
  return cols.some((c) => c.name === column)
}

const tables = db
  .query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%' ORDER BY name",
  )
  .all()
  .map((r: { name: string }) => r.name)

console.log(`Database: ${dbPath}\n`)

console.log('── table inventory ──')
const counts = new Map<string, number>()
for (const table of tables) {
  const n = db.query(`SELECT COUNT(*) n FROM "${table}"`).get() as { n: number }
  counts.set(table, n.n)
  if (n.n > 0) console.log(`  ${table.padEnd(28)} ${String(n.n).padStart(7)} rows`)
}
const empty = tables.filter((t) => counts.get(t) === 0)
console.log(`  (${empty.length} empty: ${empty.join(', ')})`)

console.log('\n── no fabricated strings anywhere in the data ──')
{
  const hits: Array<{ where: string; sample: string }> = []
  for (const table of tables) {
    const cols = db.query(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; type: string }>
    const textCols = cols.filter((c) => /text|char|clob|varchar/i.test(c.type) || c.type === '')
    for (const col of textCols) {
      for (const marker of MARKERS) {
        const rows = db
          .query(`SELECT "${col.name}" v FROM "${table}" WHERE "${col.name}" LIKE ? LIMIT 5`)
          .all(marker.like) as Array<{ v: string }>
        for (const row of rows) {
          const value = String(row.v)
          // LIKE is the coarse prefilter; the regex decides. Without it "Hammock Park"
          // counts as a match for "mock".
          if (!marker.verify.test(value)) continue
          hits.push({ where: `${table}.${col.name} ~ ${marker.label}`, sample: value.slice(0, 90) })
        }
      }
    }
  }
  check('no fabricated strings in any text column', hits.length === 0, hits.slice(0, 8))
}

console.log('\n── listings came from a real portal ──')
{
  const sources = db.query('SELECT source, COUNT(*) n FROM listings GROUP BY 1 ORDER BY n DESC').all() as Array<{
    source: string | null
    n: number
  }>
  console.log(`  sources: ${sources.map((s) => `${s.source ?? 'NULL'}=${s.n}`).join(', ')}`)

  const total = counts.get('listings') ?? 0
  check('listings exist', total > 0, total)
  check(
    'every listing names a real source',
    sources.every((s) => s.source !== null && !/mock|demo|sample|seed/i.test(s.source)),
    sources.map((s) => s.source),
  )

  // A scraped row must point at the portal, and the URL must not be a placeholder host.
  const urls = db.query('SELECT source_url FROM listings WHERE source_url IS NOT NULL LIMIT 200').all() as Array<{
    source_url: string
  }>
  check(
    'sampled listing URLs are real portal links',
    urls.length > 0 && urls.every((u) => /^https:\/\/[a-z0-9.-]+\//i.test(u.source_url)),
    urls.find((u) => !/^https:\/\//.test(u.source_url))?.source_url,
  )
  check(
    'no listing URL points at a placeholder host',
    urls.every((u) => !/example\.|localhost|127\.0\.0\.1|test\./i.test(u.source_url)),
  )

  // A fabricated price is usually a round number or an absurd one.
  const price = db
    .query('SELECT MIN(price_aed) min, MAX(price_aed) max, SUM(price_aed <= 100) tiny FROM listings')
    .get() as { min: number | null; max: number | null; tiny: number }
  console.log(`  price range: AED ${price.min} – ${price.max}`)
  check('no placeholder prices (<= AED 100)', price.tiny === 0, price.tiny)

  // Freshness: scraped data must be recent, not a fixture frozen at build time.
  const fresh = db
    .query(
      "SELECT SUM(scraped_at >= datetime('now','-2 days')) recent, COUNT(*) n FROM listings",
    )
    .get() as { recent: number; n: number }
  console.log(`  scraped in the last 2 days: ${fresh.recent}/${fresh.n}`)
  check('the inventory was collected recently', fresh.recent > 0, fresh)
}

console.log('\n── news came from real publishers ──')
{
  const items = counts.get('news_items') ?? 0
  if (items === 0) {
    console.log('  (no news rows to check)')
  } else {
    const feeds = db.query('SELECT source_name, COUNT(*) n FROM news_items GROUP BY 1 ORDER BY n DESC').all() as Array<{
      source_name: string | null
      n: number
    }>
    console.log(`  publishers: ${feeds.map((f) => `${f.source_name ?? 'NULL'}=${f.n}`).join(', ')}`)
    check(
      'every news item names a publisher',
      feeds.every((f) => f.source_name !== null && f.source_name.trim() !== ''),
      feeds.map((f) => f.source_name),
    )

    const linkCol = hasColumn('news_items', 'source_url') ? 'source_url' : 'url'
    const links = db.query(`SELECT "${linkCol}" u FROM news_items LIMIT 200`).all() as Array<{ u: string }>
    check(
      'news links are real URLs',
      links.length > 0 && links.every((l) => /^https?:\/\/[a-z0-9.-]+\.[a-z]{2,}\//i.test(l.u)),
      links.find((l) => !/^https?:\/\//.test(l.u))?.u,
    )

    // The row a previous browser-QA pass caught in the published feed: a hand-made test
    // record, indistinguishable from a real story once it is rendered.
    const titleCol = hasColumn('news_items', 'headline') ? 'headline' : 'title'
    const strays = db
      .query(`SELECT id, "${titleCol}" t FROM news_items WHERE LOWER("${titleCol}") IN ('diag','test','debug') OR LOWER("${titleCol}") LIKE '%diag%'`)
      .all() as Array<{ id: string; t: string }>
    check('no diagnostic rows leaked into the feed', strays.length === 0, strays)
  }
}

console.log('\n── reference tables are published sources, not seeded fill ──')
{
  const communities = db
    .query('SELECT COUNT(*) n, COUNT(DISTINCT emirate) emirates FROM communities')
    .get() as { n: number; emirates: number }
  console.log(`  communities: ${communities.n} across ${communities.emirates} emirate value(s)`)
  check('the community registry is populated', communities.n > 0, communities.n)

  const named = db
    .query("SELECT name_en FROM communities WHERE name_en LIKE '%test%' OR name_en LIKE '%demo%' OR name_en LIKE '%sample%'")
    .all() as Array<{ name_en: string }>
  check('no community is named like a fixture', named.length === 0, named.map((n) => n.name_en))

  // Macro/exchange rows carry a publisher; a fixture would not.
  const macro = db
    .query("SELECT COUNT(*) n FROM macro_indicators WHERE source IS NULL OR TRIM(source) = ''")
    .get() as { n: number }
  if ((counts.get('macro_indicators') ?? 0) > 0) {
    check('every macro indicator names its source', macro.n === 0, macro.n)
  }
}

console.log('\n── market facts must be supported by a source ──')
{
  // No register rows exist, so no price movement can be computed from anything. The real
  // ingest paths (src/lib/dld.ts, src/lib/adrec.ts) write 0 for exactly this reason, so a
  // non-zero value can only have come from the seed script — and it is displayed as
  // "30-day change" and "1-year change" on the community screens and the map tooltip.
  const registerRows = counts.get('transactions') ?? 0
  const unsupported = db
    .query(
      'SELECT name_en, price_change_30d pc30, price_change_1y pc1y FROM communities WHERE price_change_30d <> 0 OR price_change_1y <> 0',
    )
    .all() as Array<{ name_en: string; pc30: number; pc1y: number }>
  console.log(
    `  register rows: ${registerRows}; communities claiming a non-zero price change: ${unsupported.length}`,
  )
  check(
    'no community claims a price change the register cannot support',
    registerRows > 0 || unsupported.length === 0,
    unsupported.slice(0, 5).map((c) => `${c.name_en} +${c.pc30}%/30d +${c.pc1y}%/1y`),
  )

  // refreshCommunityStats writes `medianAedSqft: mp || cm.medianAedSqft`, so when a
  // district has no live listings the seeded median is kept and shown as a market PSF.
  const seededMedian = db
    .query(
      "SELECT COUNT(*) n FROM communities WHERE median_aed_sqft > 0 AND (psf_source IS NULL OR psf_source <> 'listing')",
    )
    .get() as { n: number }
  const sources = db.query('SELECT DISTINCT psf_source FROM communities').all() as Array<{ psf_source: string | null }>
  console.log(
    `  PSF not sourced from live listings: ${seededMedian.n}/${counts.get('communities') ?? 0} (psf_source values: ${sources.map((s) => s.psf_source ?? 'NULL').join(', ')})`,
  )
  check('every displayed PSF is sourced from live listings', seededMedian.n === 0, seededMedian.n)

  // The demo persona is a deliberate feature (DEMO_ACCOUNT_AUTOLOGIN signs every anonymous
  // visitor into it), so this is reported rather than treated as stray data — but it is
  // seeded, and its portfolio is hand-authored, so a live-data audit must surface it.
  const demo = db
    .query("SELECT email, name, phone FROM users WHERE registered_via = 'demo' OR LOWER(name) LIKE '%demo%'")
    .all() as Array<{ email: string; name: string; phone: string | null }>
  console.log(
    `  seeded demo personas: ${demo.map((u) => `${u.name} <${u.email}> ${u.phone ?? 'no phone'}`).join('; ') || 'none'}`,
  )
  check('no seeded demo persona ships as a user', demo.length === 0, demo)
}

console.log('\n── derived tables must not outlive their inputs ──')
{
  // market_summary is computed FROM the transaction register. With an empty register a
  // populated summary is stale by construction — it reports a market nothing supports.
  const txns = counts.get('transactions') ?? 0
  const summaries = counts.get('market_summary') ?? 0
  if (summaries > 0) {
    const stamp = hasColumn('market_summary', 'updated_at') ? 'updated_at' : 'computed_at'
    const row = db
      .query(`SELECT total_transactions, ${stamp} updated_at FROM market_summary LIMIT 1`)
      .get() as { total_transactions: number | null; updated_at: string | null } | null
    console.log(`  market_summary: ${summaries} row(s), total_transactions=${row?.total_transactions}, updated=${row?.updated_at}`)
    check(
      'a populated market_summary has transactions behind it',
      txns > 0 || (row?.total_transactions ?? 0) === 0,
      { registerRows: txns, claimed: row?.total_transactions },
    )
  }
}

console.log('\n── operator-created rows are not shipped as data ──')
{
  const users = db.query('SELECT email, is_admin FROM users').all() as Array<{ email: string; is_admin: number }>
  console.log(`  users: ${users.map((u) => `${u.email}${u.is_admin ? ' (admin)' : ''}`).join(', ') || 'none'}`)
  check('no user has an @example.com address', users.every((u) => !/@example\.com$/i.test(u.email)), users.map((u) => u.email))

  const chats = counts.get('ai_chat_messages') ?? 0
  console.log(`  ai_chat_messages: ${chats} (runtime conversation history)`)
  const views = counts.get('resource_views') ?? 0
  console.log(`  resource_views: ${views} (runtime telemetry)`)
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(1)
}
console.log('All data is live: no mock, demo, fixture or placeholder rows found.')
