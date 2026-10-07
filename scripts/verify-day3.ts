// Day 3 verification — investment score API contract, tier gating, and the
// scraper audit-row lifecycle.
//
// Creates its own subscription user and deletes it in a finally block: this
// touches the live database, so nothing may be left behind.
import './_env-guard'
import { prisma } from '../src/lib/db'

const BASE = process.env.API_BASE ?? 'http://localhost:3101'
const J = (r: Response) => r.json() as Promise<any>

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

async function main() {
  // ── Guest: number only ────────────────────────────────────────────────────
  const guestRes = await fetch(`${BASE}/api/sqftlab/communities/dubai-marina/score`)
  const guest = await J(guestRes)
  check('guest score is HTTP 200', guestRes.status === 200, `got ${guestRes.status}`)
  check('guest receives a numeric score', typeof guest.score === 'number', `score=${guest.score}`)
  check('guest breakdown is withheld', guest.breakdown === null)
  check('guest payload advertises the upgrade', guest.limited === true)
  check('score carries data coverage', typeof guest.dataCoverage === 'number', `coverage=${guest.dataCoverage}`)

  // ── Unknown slug ──────────────────────────────────────────────────────────
  const missing = await fetch(`${BASE}/api/sqftlab/communities/not-a-real-district/score`)
  check('unknown slug is 404', missing.status === 404, `got ${missing.status}`)

  // ── Pro: breakdown ────────────────────────────────────────────────────────
  const user = await prisma.user.create({
    data: {
      email: `day3-verify-${Date.now()}@example.invalid`,
      name: 'Day3 Verify',
      subscriptionTier: 'pro',
      subscriptionStatus: 'active',
    },
  })

  try {
    const proRes = await fetch(`${BASE}/api/sqftlab/communities/dubai-marina/score`, {
      headers: { Authorization: `Bearer ${user.id}` },
    })
    const pro = await J(proRes)
    check('pro score is HTTP 200', proRes.status === 200, `got ${proRes.status}`)
    check('pro receives the breakdown', pro.breakdown != null && typeof pro.breakdown === 'object')
    const keys = pro.breakdown ? Object.keys(pro.breakdown).sort().join(',') : ''
    check(
      'breakdown exposes all five weighted inputs',
      keys === 'capitalFlow,psfMomentum,rentalYield,supplyAbsorption,volumeTrend',
      keys
    )
    check('pro is not limited', !pro.limited)

    // ── The weighting must match the spec (30/25/20/15/10) ──────────────────
    const b = pro.breakdown
    if (b) {
      const w = b.psfMomentum * 0.3 + b.rentalYield * 0.25 + b.supplyAbsorption * 0.2 + b.volumeTrend * 0.15 + b.capitalFlow * 0.1
      check('composite equals the weighted sum', Math.abs(w - pro.score) < 0.15, `weighted=${w.toFixed(2)} score=${pro.score}`)
      check('no input exceeds 0..100', [b.psfMomentum, b.rentalYield, b.supplyAbsorption, b.volumeTrend, b.capitalFlow].every((v: number) => v >= 0 && v <= 100))
    }
  } finally {
    await prisma.user.delete({ where: { id: user.id } })
    const still = await prisma.user.findUnique({ where: { id: user.id } })
    check('test user cleaned up', still === null)
  }

  // ── Batch endpoint ────────────────────────────────────────────────────────
  const batchRes = await fetch(`${BASE}/api/sqftlab/scores`)
  const batch = await J(batchRes)
  check('batch scores is HTTP 200', batchRes.status === 200, `got ${batchRes.status}`)
  check('batch returns rows', Array.isArray(batch.scores) && batch.scores.length > 0, `${batch.scores?.length} rows`)
  check('batch is sorted by score desc', batch.scores.every((r: any, i: number) => i === 0 || batch.scores[i - 1].score >= r.score))

  // ── Recompute is not public ───────────────────────────────────────────────
  const noAuth = await fetch(`${BASE}/api/sqftlab/scores/recompute`, { method: 'POST' })
  check('recompute without the cron secret is 401', noAuth.status === 401, `got ${noAuth.status}`)

  // ── Append-only: a recompute adds rows, never replaces them ───────────────
  const before = await prisma.investmentScore.count()
  await fetch(`${BASE}/api/sqftlab/scores/recompute?secret=${process.env.CRON_SECRET ?? 'sqftlab-cron-2026'}`, { method: 'POST' })
  const after = await prisma.investmentScore.count()
  check('recompute is append-only', after > before, `${before} -> ${after}`)

  console.log(`\n${pass} passed, ${fail} failed`)
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error('verification crashed:', String(e).slice(0, 500))
  await prisma.$disconnect()
  process.exit(1)
})
