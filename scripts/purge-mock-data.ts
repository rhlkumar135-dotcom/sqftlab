/**
 * Removes the synthetic dataset that `scripts/seed-pg.ts` generated.
 *
 * Every row it produced is identifiable: listings use
 *   `<portal>-<slug>-<index>-<13-digit-ms>`  (e.g. bayut-al-barsha-1-1789270942325)
 * whereas real PropertyFinder rows use `propertyfinder_<numericId>`.
 * Transactions carry `DLD-<EMIRATE>-<13-digit-ms>-<n>` ids.
 *
 * Derived tables are purged too: price index, district metrics, building
 * profiles, nationality flows and supply pipeline were all computed *from* the
 * fabricated inputs, so leaving them would present synthetic intelligence with a
 * real-looking provenance.
 *
 * Dry-run by default. Pass --apply to actually delete.
 *
 *   DATABASE_URL=file:./prisma/dev.db bun run scripts/purge-mock-data.ts
 *   DATABASE_URL=file:./prisma/dev.db bun run scripts/purge-mock-data.ts --apply
 */

import { prisma } from '../src/lib/db'
const APPLY = process.argv.includes('--apply')

const isSeededListing = (id: string | null) => !!id && /-\d{13}$/.test(id) && id.split('-').length >= 4
// Seed id shape: DLD-<EMIRATE>-<13-digit-ms>-<counter>. The emirate segment can
// be empty (slugs like "al-furjan" split to "AL-" + ""), so it must not be
// required — being strict here would leave 105 fabricated rows behind.
const isSeededTransaction = (id: string | null) => !!id && /^DLD-.*-\d{13}-\d+$/.test(id)

/** Derived tables recomputed by the hourly cron from whatever is real. */
const DERIVED = [
  'real_price_index',
  'district_metrics',
  'building_profiles',
  'nationality_flow',
  'supply_pipeline',
  'market_summaries',
  'institutional_transactions',
]

async function tableExists(name: string) {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?`, name
  )
  return Number(rows[0]?.n ?? 0) > 0
}

async function main() {
  console.log(`\n═══ Purge synthetic data ${APPLY ? '(APPLY)' : '(DRY RUN — pass --apply)'} ═══\n`)

  const listings = await prisma.listing.findMany({ select: { externalId: true } })
  const seededListings = listings.filter((l) => isSeededListing(l.externalId))
  const realListings = listings.length - seededListings.length
  console.log(`listings      total=${listings.length}  seeded=${seededListings.length}  real(kept)=${realListings}`)

  const txns = await prisma.transaction.findMany({ select: { dldId: true } })
  const seededTxns = txns.filter((t) => isSeededTransaction(t.dldId))
  console.log(`transactions  total=${txns.length}  seeded=${seededTxns.length}  real(kept)=${txns.length - seededTxns.length}`)

  const counts: Record<string, number> = {}
  for (const t of DERIVED) {
    if (!(await tableExists(t))) continue
    const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT COUNT(*) AS n FROM "${t}"`)
    counts[t] = Number(rows[0]?.n ?? 0)
  }
  console.log(`derived       ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  ')}`)

  if (!APPLY) {
    console.log('\nNothing deleted. Re-run with --apply to execute.\n')
    return
  }

  if (seededListings.length) {
    const ids = seededListings.map((l) => l.externalId)
    const r = await prisma.listing.deleteMany({ where: { externalId: { in: ids } } })
    console.log(`\n✓ deleted ${r.count} seeded listings`)
  }
  if (seededTxns.length) {
    const ids = seededTxns.map((t) => t.dldId)
    const r = await prisma.transaction.deleteMany({ where: { dldId: { in: ids } } })
    console.log(`✓ deleted ${r.count} seeded transactions`)
  }

  for (const [t, n] of Object.entries(counts)) {
    if (!n) continue
    await prisma.$executeRawUnsafe(`DELETE FROM "${t}"`)
    console.log(`✓ cleared derived table ${t} (${n} rows)`)
  }

  console.log('\nRemaining after purge:')
  console.log(`  listings=${await prisma.listing.count()}  transactions=${await prisma.transaction.count()}  communities=${await prisma.community.count()}`)
  console.log('  (communities kept — real UAE names/coords; their stats are recomputed)\n')
}

main()
  .catch((e) => { console.error('FATAL', e); process.exitCode = 1 })
  .finally(async () => { await prisma.$disconnect(); process.exit(process.exitCode ?? 0) })
