/**
 * Verifies the hourly refresh cron (the job that makes "live data" true).
 *
 *   auth → run → per-step outcomes → fresh PSF materialised → run persisted
 *
 * Uses Hono's in-process app.request() so it exercises the real handler, the
 * real pipeline and the real writes without binding a port.
 *
 * Run: DATABASE_URL="file:./prisma/dev.db" bun run scripts/verify-cron.ts
 */

import app from '../custom-routes'
import { prisma } from '../src/lib/db'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail: string) => {
  if (ok) { pass++; console.log(`  ✓ ${name} — ${detail}`) }
  else { fail++; console.log(`  ✗ ${name} — ${detail}`) }
}

const SECRET = process.env.CRON_SECRET || 'sqftlab-cron-2026'

interface Step { step: string; status: string; ms: number; detail?: string; error?: string }
interface RunResult {
  ok: boolean; okCount: number; failCount: number; durationMs: number; steps: Step[]
}
interface StatusResult {
  healthy: boolean; lastStatus: string | null; lastRunAt: string | null
  ageMs: number | null; expectedIntervalMs: number; runs?: unknown[]
}

async function main() {
  console.log('\n═══ Hourly refresh cron ═══')

  // ── Auth ────────────────────────────────────────────────────────────────────
  const noSecret = await app.request('/sqftlab/cron/hourly')
  check('no secret → 401', noSecret.status === 401, `got ${noSecret.status}`)

  const wrongSecret = await app.request('/sqftlab/cron/hourly?secret=not-the-secret')
  check('wrong secret → 401', wrongSecret.status === 401, `got ${wrongSecret.status}`)

  // ── Run ─────────────────────────────────────────────────────────────────────
  const res = await app.request(`/sqftlab/cron/hourly?secret=${encodeURIComponent(SECRET)}`)
  check('authorised → 200', res.status === 200, `got ${res.status}`)
  const body = await res.json() as RunResult

  check('every step succeeded', body.failCount === 0, `ok=${body.okCount} failed=${body.failCount}`)
  check('okCount >= 6', body.okCount >= 6, `${body.okCount}`)

  const names = body.steps.map((s) => s.step)
  for (const expected of ['exchangeRates', 'macro', 'communityStats', 'deals', 'alerts', 'intelligence']) {
    check(`step "${expected}" present`, names.includes(expected), names.join(','))
  }

  const reported = body.steps.filter((s) => s.status === 'failed')
  if (reported.length) console.log(`     failures: ${reported.map((s) => `${s.step}: ${s.error}`).join(' | ')}`)

  // ── The run must have actually moved data ───────────────────────────────────
  const stats = body.steps.find((s) => s.step === 'communityStats')
  const dldMatch = /dld=(\d+)/.exec(stats?.detail ?? '')
  check('communityStats reports DLD-sourced PSF', !!dldMatch && Number(dldMatch[1]) > 0, stats?.detail ?? 'no detail')

  const dealsStep = body.steps.find((s) => s.step === 'deals')
  check('deal detection ran', /listings below market/.test(dealsStep?.detail ?? ''), dealsStep?.detail ?? 'no detail')

  // ── Persisted state matches what the step claimed ───────────────────────────
  const dldRows = await prisma.community.count({ where: { psfSource: 'dld' } })
  const withTxns = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(DISTINCT community_id) AS n FROM transactions
  `.catch(() => [{ n: 0n }])
  const expectedDld = Number(withTxns[0]?.n ?? 0)
  check('psfSource=dld persisted for communities with transactions',
    dldRows === expectedDld && dldRows > 0, `dld=${dldRows} expected=${expectedDld}`)

  const notDld = await prisma.community.count({ where: { psfSource: { not: 'dld' } } })
  check('no community left on listing-derived PSF while it has transactions',
    notDld === 0, `still-listing=${notDld}`)

  // ── Run recorded for observability ──────────────────────────────────────────
  const run = await prisma.cronRun.findFirst({ where: { job: 'hourly-refresh' }, orderBy: { startedAt: 'desc' } })
  check('CronRun row persisted', !!run, run ? `id=${run.id} status=${run.status}` : 'none')
  check('CronRun status success', run?.status === 'success', run?.status ?? 'none')
  check('CronRun has per-step JSON', (run?.steps ?? '').includes('communityStats'), `${(run?.steps ?? '').length} chars`)

  // ── Freshness endpoint ──────────────────────────────────────────────────────
  const st = await app.request('/sqftlab/cron/status')
  check('status → 200', st.status === 200, `got ${st.status}`)
  const sj = await st.json() as StatusResult
  check('status healthy', sj.healthy === true, `healthy=${sj.healthy} ageMs=${sj.ageMs}`)
  check('lastStatus success', sj.lastStatus === 'success', sj.lastStatus ?? 'none')
  check('expected interval is 1 hour', sj.expectedIntervalMs === 3_600_000, `${sj.expectedIntervalMs}`)
  check('status is public but hides step detail', sj.runs === undefined, `runs=${sj.runs === undefined ? 'hidden' : 'LEAKED'}`)

  const stAuthed = await app.request(`/sqftlab/cron/status?secret=${encodeURIComponent(SECRET)}`)
  const sjAuthed = await stAuthed.json() as StatusResult
  check('authorised status includes run history', Array.isArray(sjAuthed.runs) && sjAuthed.runs.length > 0,
    `${sjAuthed.runs?.length ?? 0} runs`)

  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══\n`)
  if (fail) process.exitCode = 1
}

main()
  .catch((e) => { console.error('FATAL', e); process.exitCode = 1 })
  .finally(async () => {
    await prisma.$disconnect()
    process.exit(process.exitCode ?? 0)
  })
