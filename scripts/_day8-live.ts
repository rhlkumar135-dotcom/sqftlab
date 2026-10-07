// Live probe: the portfolio routes as the running server actually serves them.
// Temporary — removes the one holding it creates before exiting.
import './_env-guard'
import { prisma } from '../src/lib/db'

const BASE = 'http://localhost:3101/api'

const seeded = await prisma.user.findFirst({
  where: { email: { in: ['demo@sqftlab.com', 'demo@sqftlab.ae'] } },
  select: { id: true, subscriptionTier: true },
})
// Resolved by email, never a hardcoded cuid — the id is per-database.
const auth = seeded ? { Authorization: `Bearer ${seeded.id}` } : {}

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, { headers })
  const text = await res.text()
  let body: Record<string, unknown> | null = null
  try { body = JSON.parse(text) as Record<string, unknown> } catch { body = null }
  return { status: res.status, body }
}

console.log('── access ──')
const anon = await get('/sqftlab/portfolio')
console.log(`  no auth                → ${anon.status}  requiredTier=${String(anon.body?.requiredTier)}`)

if (seeded) {
  console.log(`\n── as the seeded ${seeded.subscriptionTier} user ──`)
  const r = await get('/sqftlab/portfolio', auth)
  const s = (r.body?.summary ?? {}) as Record<string, unknown>
  console.log(`  GET /portfolio         → ${r.status}`)
  console.log(`  totalCurrentAed        → ${JSON.stringify(s.totalCurrentAed)}`)
  console.log(`  totalGainAed           → ${JSON.stringify(s.totalGainAed)}`)
  console.log(`  totalGainPct           → ${JSON.stringify(s.totalGainPct)}`)
  console.log(`  valued / unvalued      → ${String(s.valuedCount)} / ${String(s.unvaluedCount)}`)
  console.log(`  the AED 10,941,214?    → ${s.totalCurrentAed === 10_941_214 ? 'STILL SHOWN (BAD)' : 'no longer reported'}`)
  for (const it of ((r.body?.items ?? []) as Record<string, unknown>[]).slice(0, 4)) {
    console.log(
      `    ${String(it.title).padEnd(22)} currentValue=${JSON.stringify(it.currentValue)}  isValued=${String(it.isValued)}  gainAed=${JSON.stringify(it.gainAed)}`,
    )
  }
}

console.log('\n── the write paths ──')
const missing = await fetch(`${BASE}/sqftlab/portfolio/nope`, { method: 'DELETE', headers: auth })
console.log(`  DELETE an unknown id   → ${missing.status}`)

const created = await fetch(`${BASE}/sqftlab/portfolio`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...auth },
  body: JSON.stringify({ communitySlug: 'dubai-marina', beds: 2, areaSqft: 1000, purchasePrice: 1_000_000, buildingName: 'Live probe' }),
})
const pb = (await created.json()) as Record<string, unknown>
const item = (pb.item ?? {}) as Record<string, unknown>
console.log(`  POST a holding         → ${created.status}  valued=${String(pb.valued)}  currentValue=${JSON.stringify(item.currentValue)}`)
console.log(`    says: ${String(pb.message ?? '(valued, no caveat)').slice(0, 150)}`)
if (item.id) {
  const del = await fetch(`${BASE}/sqftlab/portfolio/${String(item.id)}`, { method: 'DELETE', headers: auth })
  console.log(`  DELETE it again        → ${del.status}  (probe row cleaned up)`)
  console.log(`  rows left from probe   → ${await prisma.portfolio.count({ where: { buildingName: 'Live probe' } })}`)
}
process.exit(0)
