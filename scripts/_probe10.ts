import './_env-guard'
import { prisma } from '../src/lib/db'

/**
 * Day 9 + Day 10 live endpoint probe.
 *
 * Creates its own throwaway accounts at the tiers under test and deletes them in
 * a `finally`, rather than temporarily re-tiering the seeded demo user — a probe
 * must not leave the user's own account mutated, nor rows behind in the DB.
 */
const B = 'http://localhost:3101/api/sqftlab'
const TMP = 'zz-probe-day10@sqftlab.test'
const created: string[] = []

async function mkUser(tier: string): Promise<string> {
  const u = await prisma.user.create({
    data: {
      email: `${tier}.${TMP}`,
      name: `Probe ${tier}`,
      subscriptionTier: tier,
      subscriptionStatus: 'active',
    },
    select: { id: true },
  })
  created.push(u.id)
  return u.id
}

interface Res {
  status: number
  body: Record<string, unknown>
}
async function call(method: string, path: string, userId?: string, body?: unknown): Promise<Res> {
  const r = await fetch(`${B}${path}`, {
    method,
    headers: {
      ...(userId ? { Authorization: `Bearer ${userId}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await r.text()
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    parsed = { _raw: text.slice(0, 120) }
  }
  return { status: r.status, body: parsed }
}

const show = (label: string, r: Res, keys: string[]) => {
  const picked: Record<string, unknown> = {}
  for (const k of keys) {
    const parts = k.split('.')
    let cur: unknown = r.body
    for (const p of parts) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[p] : undefined
    picked[k] = cur
  }
  console.log(`  ${label.padEnd(40)} ${r.status}  ${JSON.stringify(picked)}`)
}

try {
  const pro = await mkUser('pro')
  const ent = await mkUser('enterprise')

  console.log('── Day 10A developer positioning ──')
  show(
    'anon',
    await call('POST', '/developer/position', undefined, { projectName: 'X', area: 'JLT', beds: 2, launchPsfAed: 1800 }),
    ['error', 'requiredTier'],
  )
  show(
    'pro (needs enterprise)',
    await call('POST', '/developer/position', pro, { projectName: 'X', area: 'JLT', beds: 2, launchPsfAed: 1800 }),
    ['error', 'requiredTier'],
  )
  show(
    'enterprise, valid body',
    await call('POST', '/developer/position', ent, { projectName: 'Marina Heights', area: 'JLT', beds: 2, launchPsfAed: 1800 }),
    ['dldComparables', 'positioning.verdict', 'positioning.percentile', 'positioning.pctVsMarket', 'insufficientData'],
  )
  show(
    'enterprise, EMPTY body (brief=500)',
    await call('POST', '/developer/position', ent, {}),
    ['error', 'fields'],
  )
  show(
    'enterprise, bad beds',
    await call('POST', '/developer/position', ent, { projectName: 'X', area: 'JLT', beds: 1.5, launchPsfAed: 1800 }),
    ['error', 'fields'],
  )
  show(
    'enterprise, negative psf',
    await call('POST', '/developer/position', ent, { projectName: 'X', area: 'JLT', beds: 2, launchPsfAed: -5 }),
    ['error', 'fields'],
  )
  show(
    'enterprise, unknown area',
    await call('POST', '/developer/position', ent, { projectName: 'X', area: 'Nowhere-9', beds: 2, launchPsfAed: 1800 }),
    ['error', 'insufficientData', 'reason'],
  )

  console.log('\n── Day 10B buildings ──')
  show('search q=ma (anon)', await call('GET', '/buildings?q=ma'), ['buildings'])
  show('search q=m (too short)', await call('GET', '/buildings?q=m'), ['buildings'])
  show(
    'scorecard marina-gate-1 (free)',
    await call('GET', '/buildings/marina-gate-1', await mkUser('free')),
    ['buildingName', 'matched', 'floorBreakdown', 'floorBreakdownLocked', 'insufficientData'],
  )
  show(
    'scorecard marina-gate-1 (pro)',
    await call('GET', '/buildings/marina-gate-1', pro),
    ['floorBreakdown', 'floorBreakdownLocked'],
  )
  show(
    'scorecard marina-gate-1 (enterprise)',
    await call('GET', '/buildings/marina-gate-1', ent),
    ['floorBreakdown', 'floorBreakdownLocked'],
  )

  console.log('\n── Day 9 (regression) ──')
  show('capital-flow/overview (elite)', await call('GET', '/capital-flow/overview', ent), ['insufficientData', 'source'])
  show('communities/downtown-dubai/yield', await call('GET', '/communities/downtown-dubai/yield', ent), [
    'grossYieldPct',
    'rentSource',
    'saleSource',
  ])
} finally {
  const del = await prisma.user.deleteMany({ where: { id: { in: created } } })
  console.log(`\n  cleanup: removed ${del.count} probe account(s)`)
  process.exit(0)
}
