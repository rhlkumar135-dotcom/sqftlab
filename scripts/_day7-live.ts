// Live probe: the report route as the running server actually serves it, over HTTP.
// Temporary — deletes the throwaway account it creates before exiting.
import './_env-guard'
import { prisma } from '../src/lib/db'

const BASE = 'http://localhost:3101/api'
const ID = `DAY7LIVE-${Date.now()}`
let entId: string | null = null

async function post(body: unknown, token: string | null) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}/sqftlab/report/property`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, type: res.headers.get('Content-Type'), text: text.slice(0, 150) }
}

try {
  const ent = await prisma.user.create({
    data: { email: `${ID}@example.invalid`, subscriptionTier: 'enterprise', subscriptionStatus: 'active' },
    select: { id: true },
  })
  entId = ent.id

  const me = await fetch(`${BASE}/sqftlab/me`)
  console.log(`  /sqftlab/me                  → ${me.status} ${me.headers.get('Content-Type')}`)

  const valid = { propertyAddress: 'Marina Gate, Dubai Marina', community: 'Dubai Marina', bedrooms: 2, sizeSqft: 1100 }

  // Resolved by email rather than by baking a cuid into the source: the seeded
  // account's id is per-database, and this project deliberately never hardcodes one
  // (see `seededUserId()` in custom-routes.ts for the same reasoning).
  const seeded = await prisma.user.findFirst({
    where: { email: { in: ['demo@sqftlab.com', 'demo@sqftlab.ae'] } },
    select: { id: true, subscriptionTier: true },
  })

  const anon = await post(valid, null)
  console.log(`  no auth                      → ${anon.status}  ${anon.text}`)

  if (seeded) {
    const below = await post(valid, seeded.id)
    console.log(`  seeded user (${seeded.subscriptionTier})        → ${below.status}  ${below.text}`)
  } else {
    console.log('  seeded demo user            → not present in this database (skipped)')
  }

  const bad = await post({ propertyAddress: 'x' }, entId)
  console.log(`  enterprise, missing fields   → ${bad.status}  ${bad.text}`)

  const ghost = await post({ ...valid, community: 'Zzz Nonexistent Area 12345' }, entId)
  console.log(`  enterprise, unknown area     → ${ghost.status}  ${ghost.text}`)

  const real = await post(valid, entId)
  console.log(`  enterprise, valid body       → ${real.status}  ${real.text}`)

  const bogus = await fetch(`${BASE}/sqftlab/report/nonexistent`, { method: 'POST' })
  console.log(`  control: bogus route         → ${bogus.status} ${bogus.headers.get('Content-Type')}  (proves the 4 above are not a catch-all)`)
} finally {
  if (entId) {
    await prisma.userEvent.deleteMany({ where: { userId: entId } })
    await prisma.user.delete({ where: { id: entId } }).catch(() => undefined)
  }
}

const left = await prisma.user.count({ where: { email: { startsWith: 'DAY7LIVE-' } } })
console.log(`\n  throwaway live accounts remaining: ${left}`)
process.exit(0)
