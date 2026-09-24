import { prisma } from './db'
import { fetchAllMacro, fetchExchangeRates } from './macro'
import { runIntelligencePipeline } from './intelligence'
import { scanDealAlerts, notifyPendingMatches } from './alerts'
import { publish } from './events'
import { detectDeals, SALE_TXN_TYPES } from './deals'

export const HOURLY_JOB = 'hourly-refresh'

export type StepStatus = 'ok' | 'failed'
export interface StepResult {
  step: string
  status: StepStatus
  ms: number
  detail?: string
  error?: string
}

export interface RefreshResult {
  ok: boolean
  job: string
  runId: string
  okCount: number
  failCount: number
  durationMs: number
  steps: StepResult[]
}

/**
 * Recompute every community's PSF from government transaction data, falling
 * back to listing asking prices only where no transactions exist.
 *
 * This is the difference between the platform's core claim being true and false:
 * `community.medianAedSqft` was previously always derived from PropertyFinder
 * asking prices. `psfSource` records which one a given row actually used.
 *
 * Five grouped queries plus one batched write replace the per-community loop
 * (~160 queries). Yields are only overwritten when both inputs are real, so a
 * community with no rent data keeps its previous value rather than dropping to 0.
 */
export async function refreshCommunityStats(): Promise<{
  communities: number
  dld: number
  listing: number
}> {
  const [txPsf, txCount, listPsf, listRent] = await Promise.all([
    prisma.transaction.groupBy({
      by: ['communityId'],
      where: {
        transactionType: { in: [...SALE_TXN_TYPES] },
        pricePerSqft: { gt: 100 },
      },
      _avg: { pricePerSqft: true },
    }),
    prisma.transaction.groupBy({
      by: ['communityId'],
      _count: { _all: true },
    }),
    prisma.listing.groupBy({
      by: ['communityId'],
      where: { purpose: 'sale', pricePerSqft: { gt: 0 } },
      _avg: { pricePerSqft: true },
    }),
    prisma.listing.groupBy({
      by: ['communityId'],
      where: { purpose: 'rent', priceAed: { gt: 0 } },
      _avg: { priceAed: true },
    }),
  ])

  const txPsfMap = new Map(txPsf.map((r) => [r.communityId, r._avg.pricePerSqft ?? 0]))
  const txCountMap = new Map(txCount.map((r) => [r.communityId, r._count._all]))
  const listPsfMap = new Map(listPsf.map((r) => [r.communityId, r._avg.pricePerSqft ?? 0]))
  const rentMap = new Map(listRent.map((r) => [r.communityId, r._avg.priceAed ?? 0]))

  const communities = await prisma.community.findMany({
    select: {
      id: true,
      medianAedSqft: true,
      medianAnnualRentAed: true,
      grossYieldPct: true,
    },
  })

  let dld = 0
  let listing = 0

  await prisma.$transaction(
    communities.map((cm) => {
      const tx = txPsfMap.get(cm.id) ?? 0
      const lp = listPsfMap.get(cm.id) ?? 0
      const mp = Math.round(tx || lp || 0)
      const mr = Math.round(rentMap.get(cm.id) ?? 0)
      // Average unit ≈ 1,000 sqft, so a PSF and an annual rent are only
      // comparable at that scale. Both inputs must be real or yield is left alone.
      const yld = mp > 0 && mr > 0 ? Math.round((mr / (mp * 1000)) * 10000) / 100 : 0

      if (tx > 0) dld++
      else if (lp > 0) listing++

      return prisma.community.update({
        where: { id: cm.id },
        data: {
          medianAedSqft: mp || cm.medianAedSqft,
          medianAnnualRentAed: mr || cm.medianAnnualRentAed,
          grossYieldPct: yld || cm.grossYieldPct,
          totalTransactions: txCountMap.get(cm.id) ?? 0,
          psfSource: tx > 0 ? 'dld' : 'listing',
        },
      })
    })
  )

  return { communities: communities.length, dld, listing }
}

/**
 * The hourly refresh.
 *
 * Every step is isolated: one failing source (a dead FX endpoint, a DLD outage)
 * must not abort the rest, or a single bad upstream would silently freeze the
 * whole dataset. Each step's outcome is recorded, and the run itself is written
 * to `CronRun` so "is the data actually refreshing?" has an answer.
 */
export async function runHourlyRefresh(): Promise<RefreshResult> {
  const startedAt = Date.now()
  const steps: StepResult[] = []

  const run = await prisma.cronRun.create({
    data: { job: HOURLY_JOB, status: 'running' },
  })

  const step = async (name: string, fn: () => Promise<string | void>) => {
    const t = Date.now()
    try {
      const detail = await fn()
      steps.push({ step: name, status: 'ok', ms: Date.now() - t, detail: detail || undefined })
    } catch (e) {
      steps.push({
        step: name,
        status: 'failed',
        ms: Date.now() - t,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  await step('exchangeRates', async () => {
    const r = await fetchExchangeRates()
    return `ok=${r.ok}${r.error ? ` error=${r.error}` : ''}`
  })

  await step('macro', async () => {
    const r = await fetchAllMacro()
    const ok = r.results.filter((x) => x.ok).length
    return `${ok}/${r.results.length} indicators`
  })

  await step('communityStats', async () => {
    const r = await refreshCommunityStats()
    return `${r.communities} communities (dld=${r.dld}, listing=${r.listing})`
  })

  await step('deals', async () => {
    const n = await detectDeals()
    return `${n} listings below market`
  })

  await step('alerts', async () => {
    const scan = await scanDealAlerts()
    const notify = await notifyPendingMatches()
    return `scanned=${JSON.stringify(scan).slice(0, 120)} notified=${
      typeof notify === 'object' ? JSON.stringify(notify).slice(0, 80) : String(notify)
    }`
  })

  await step('intelligence', async () => {
    const r = await runIntelligencePipeline()
    return `rpi=${r.rpi} buildings=${r.buildings} supply=${r.supply} in ${r.durationMs}ms`
  })

  const okCount = steps.filter((s) => s.status === 'ok').length
  const failCount = steps.length - okCount
  const durationMs = Date.now() - startedAt
  const status = failCount === 0 ? 'success' : okCount > 0 ? 'partial' : 'error'

  await prisma.cronRun.update({
    where: { id: run.id },
    data: {
      status,
      steps: JSON.stringify(steps),
      okCount,
      failCount,
      durationMs,
      finishedAt: new Date(),
      errorMsg: steps.find((s) => s.status === 'failed')?.error ?? null,
    },
  })

  // Broadcast the recomputed state so connected clients refresh without polling.
  try {
    const summary = await prisma.marketSummary.findFirst({ orderBy: { computedAt: 'desc' } })
    if (summary) publish('market:update', summary)
    publish('cron:update', { job: HOURLY_JOB, status, okCount, failCount, durationMs, steps })
  } catch {
    // A broadcast failure must not fail an otherwise successful refresh.
  }

  return { ok: failCount === 0, job: HOURLY_JOB, runId: run.id, okCount, failCount, durationMs, steps }
}

/** Most recent runs, newest first — powers /sqftlab/cron/status. */
export async function recentCronRuns(limit = 10) {
  const rows = await prisma.cronRun.findMany({
    where: { job: HOURLY_JOB },
    orderBy: { startedAt: 'desc' },
    take: limit,
  })
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    okCount: r.okCount,
    failCount: r.failCount,
    durationMs: r.durationMs,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    steps: r.steps ? JSON.parse(r.steps) : [],
  }))
}
