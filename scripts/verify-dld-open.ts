/**
 * Verifies the keyless DLD open-data ingest end to end: the gateway answers, the
 * rows land in the database, and communities get linked to their official area.
 *
 * Run: DATABASE_URL=file:$PWD/prisma/dev.db bun run scripts/verify-dld-open.ts
 */
import { syncDldReference, dldReferenceCounts } from '../src/lib/dld-open'
import { prisma } from '../src/lib/db'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('DLD open-data ingest\n')

const r = await syncDldReference()
console.log('sync result:', r, '\n')

check('areas from gateway > 400', r.areas > 400, `${r.areas}`)
check('projects from gateway > 4000', r.projects > 4000, `${r.projects}`)
check('property types > 50', r.propertyTypes > 50, `${r.propertyTypes}`)

const counts = await dldReferenceCounts()
console.log('\nstored counts:', counts, '\n')
check('area rows persisted', (counts.area ?? 0) > 400, `${counts.area}`)
check('project rows persisted', (counts.project ?? 0) > 4000, `${counts.project}`)
check('property_type rows persisted', (counts.property_type ?? 0) > 50, `${counts.property_type}`)

// Second run must be idempotent: a replace-in-place must not double the rows.
const r2 = await syncDldReference()
const counts2 = await dldReferenceCounts()
check(
  'idempotent (no row duplication on re-run)',
  counts2.area === counts.area && counts2.project === counts.project,
  `area ${counts.area}→${counts2.area}, project ${counts.project}→${counts2.project}`
)
check('second run still reports the same counts', r2.areas === r.areas)

const linked = await prisma.community.count({ where: { dldAreaId: { not: null } } })
const total = await prisma.community.count()
check('some communities linked to a DLD area', linked > 0, `${linked}/${total}`)

const sample = await prisma.community.findFirst({
  where: { dldAreaId: { not: null } },
  select: { nameEn: true, dldAreaId: true },
})
// DLD area ids are prefixed by sector (A-, C-, ...), so assert the shape, not a
// specific prefix.
check(
  'linked community has a real AREA_ID',
  /^[A-Z]+-\d+$/.test(sample?.dldAreaId ?? ''),
  JSON.stringify(sample)
)

// A price must never come from this source: it is a registry, not a register.
const priceish = await prisma.dldReference.count({
  where: { nameEn: { contains: 'AED' } },
})
check('reference rows carry no price text', priceish === 0, `${priceish} suspicious rows`)

console.log(`\nRESULT ${pass}/${pass + fail} passed`)
await prisma.$disconnect()
process.exit(fail === 0 ? 0 : 1)
