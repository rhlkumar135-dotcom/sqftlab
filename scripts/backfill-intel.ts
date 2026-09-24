/**
 * Backfill the DLD dimension columns that the seeded dataset never populated:
 * building_name, floor_number, buyer_type, buyer_nationality, project_name.
 *
 * WHY THIS EXISTS
 * ---------------
 * Three of the seven intelligence products (Building Intelligence, Migration
 * Signal, Institutional Flow) read dimensions that real DLD feeds carry but the
 * seed data does not. Without them those products can only report "insufficient
 * data", so this script synthesises the dimensions.
 *
 * THIS IS SYNTHETIC DEMO DATA. The building names are generated from the
 * community name — they are not real towers, and no output derived from them
 * should be presented as a real DLD finding. The values are deterministic
 * (seeded from each transaction id) so re-running is idempotent.
 *
 * Run:  bun run scripts/backfill-intel.ts
 */

import { prisma } from '../src/lib/db'

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** mulberry32 — small, fast, deterministic PRNG. */
function rng(seed: number) {
  let a = seed
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T,>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length) % xs.length]

// Realistic Dubai buyer-nationality mix (share weights approximate the emirate).
const NATIONALITIES: [string, number][] = [
  ['India', 26], ['United Arab Emirates', 17], ['Russia', 9], ['United Kingdom', 8],
  ['China', 6], ['Pakistan', 6], ['Egypt', 4], ['Saudi Arabia', 4],
  ['France', 3], ['Germany', 3], ['Turkey', 3], ['Iran', 3],
  ['Nigeria', 2], ['United States', 2], ['Ukraine', 2], ['Kazakhstan', 2],
]

const CORPORATES = [
  'Emaar Properties PJSC', 'Nakheel Development', 'Meraas Holding',
  'Aldar Properties PJSC', 'Sobha Realty', 'DAMAC Properties',
  'Al Habtoor Group', 'Dubai Investments PJSC', 'Wasl Asset Management',
  'Dubai South', 'Tanmiyat Properties', 'MAG Property Development',
]

const SUFFIXES = ['Tower', 'Residences', 'Heights', 'Plaza', 'Gardens', 'Terraces']

function weightedNationality(r: () => number): string {
  const total = NATIONALITIES.reduce((s, [, w]) => s + w, 0)
  let x = r() * total
  for (const [name, w] of NATIONALITIES) {
    x -= w
    if (x <= 0) return name
  }
  return NATIONALITIES[0][0]
}

async function main() {
  const communities = await prisma.community.findMany({ select: { id: true, nameEn: true, slug: true } })
  const byId = new Map(communities.map((c) => [c.id, c]))

  const txns = await prisma.transaction.findMany({
    select: { id: true, communityId: true, propertyType: true, beds: true, transactionType: true, transactionDate: true },
    orderBy: { transactionDate: 'asc' },
  })
  console.log(`Backfilling ${txns.length} transactions across ${communities.length} communities…`)

  // Pre-plan buildings per community so each gets 5+ sales (the spec's
  // confidence floor for a building profile).
  const buildingsByCommunity = new Map<string, string[]>()
  for (const c of communities) {
    const count = txns.filter((t) => t.communityId === c.id).length
    if (!count) continue
    const n = Math.max(1, Math.min(4, Math.floor(count / 5)))
    const r = rng(hash(c.slug))
    const names = new Set<string>()
    while (names.size < n) {
      names.add(`${c.nameEn} ${pick(r, SUFFIXES)} ${names.size + 1}`)
    }
    buildingsByCommunity.set(c.id, [...names])
  }

  // Concentrated corporate buyers: a handful of entity+building+month cells
  // with 3+ units, so the Institutional Flow clusterer has real clusters to find.
  const clusterSeeds = new Map<string, string>() // communityId||building -> entity
  for (const [communityId, buildings] of buildingsByCommunity) {
    const r = rng(hash(`${communityId}:corp`))
    if (buildings.length && r() < 0.75) {
      clusterSeeds.set(`${communityId}||${buildings[0]}`, pick(r, CORPORATES))
    }
  }

  let updated = 0
  for (const t of txns) {
    const c = byId.get(t.communityId)
    if (!c) continue
    const r = rng(hash(t.id))
    const buildings = buildingsByCommunity.get(t.communityId) ?? [`${c.nameEn} Tower 1`]

    const isApartment = t.propertyType === 'apartment'
    const building = buildings[Math.floor(r() * buildings.length) % buildings.length]

    // Floors only exist for stacked buildings; villas/townhouses stay null.
    const floorNumber = isApartment ? 1 + Math.floor(r() * 45) : null

    // Corporate share ~22%, concentrated inside the seeded cluster cells.
    const clusterKey = `${t.communityId}||${building}`
    const entity = clusterSeeds.get(clusterKey)
    const isCorporate = entity ? r() < 0.55 : r() < 0.08

    const payload = {
      buildingName: building,
      projectName: t.transactionType === 'off_plan_sale' ? building : null,
      masterProject: c.nameEn,
      floorNumber,
      buyerType: isCorporate ? 'corporate' : 'individual',
      buyerNationality: isCorporate ? (entity ?? pick(r, CORPORATES)) : weightedNationality(r),
    }

    await prisma.transaction.update({ where: { id: t.id }, data: payload })
    updated++
    if (updated % 100 === 0) console.log(`  ${updated}/${txns.length}`)
  }

  console.log(`✓ Backfilled ${updated} transactions`)
  console.log('  NOTE: building names and buyer dimensions are synthetic demo data.')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
