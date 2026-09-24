import { prisma } from './db'
import { fetchAllMacro, fetchExchangeRates } from './macro'
import { runIntelligencePipeline } from './intelligence'
import { scanDealAlerts, notifyPendingMatches } from './alerts'
import { publish } from './events'
import { detectDeals, SALE_TXN_TYPES } from './deals'
import { dldConfigured, syncDLDTransactions } from './dld'
import { adrecConfigured, syncADRECTransactions } from './adrec'

export const HOURLY_JOB = 'hourly-refresh'

export type StepStatus = 'ok' | 'failed' | 'skipped'
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
  skipCount: number
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
  none: number
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
  let none = 0

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
      else none++

      return prisma.community.update({
        where: { id: cm.id },
        data: {
          medianAedSqft: mp || cm.medianAedSqft,
          medianAnnualRentAed: mr || cm.medianAnnualRentAed,
          grossYieldPct: yld || cm.grossYieldPct,
          totalTransactions: txCountMap.get(cm.id) ?? 0,
          // Provenance must describe what actually backs the number. Labelling a
          // community 'listing' when it has neither transactions nor sale
          // listings asserts a source that does not exist. 'none' says so.
          psfSource: tx > 0 ? 'dld' : lp > 0 ? 'listing' : 'none',
        },
      })
    })
  )

  return { communities: communities.length, dld, listing, none }
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

  const step = async (
    name: string,
    fn: () => Promise<string | void | { skipped: string }>
  ) => {
    const t = Date.now()
    try {
      const detail = await fn()
      // A step may declare itself inapplicable (an unconfigured data source)
      // rather than failing. Recorded distinctly so a healthy run with missing
      // credentials does not read as a broken pipeline.
      if (detail && typeof detail === 'object' && 'skipped' in detail) {
        steps.push({ step: name, status: 'skipped', ms: Date.now() - t, detail: detail.skipped })
        return
      }
      steps.push({ step: name, status: 'ok', ms: Date.now() - t, detail: (detail as string) || undefined })
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

  // Government transaction sources. Reported as "skipped" rather than "failed"
  // when credentials are absent — an unconfigured source is a known state, not a
  // broken pipeline, and conflating the two would make a healthy run look red.
  await step('dldSync', async () => {
    if (!dldConfigured()) {
      return { skipped: 'not configured — set DUBAI_PULSE_API_KEY' }
    }
    const r = await syncDLDTransactions()
    return `${r.imported} transactions imported since ${r.since} (${r.pages} pages)`
  })

  await step('adrecSync', async () => {
    if (!adrecConfigured()) {
      return { skipped: 'not configured — set ADREC_API_URL and ADREC_API_KEY' }
    }
    const r = await syncADRECTransactions()
    return `${r.imported} imported, ${r.skipped} unmappable (${r.pages} pages)`
  })

  await step('macro', async () => {
    const r = await fetchAllMacro()
    const ok = r.results.filter((x) => x.ok).length
    return `${ok}/${r.results.length} indicators`
  })

  await step('communityStats', async () => {
    const r = await refreshCommunityStats()
    return `${r.communities} communities (dld=${r.dld}, listing=${r.listing}, none=${r.none})`
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
    // These are objects, not counts — interpolating them directly printed
    // "[object Object]" in the run status.
    const len = (v: unknown) => (Array.isArray(v) ? v.length : 0)
    const gaps: string[] = []
    if (len(r.rpi?.segments) === 0) gaps.push('rpi needs transactions')
    if (len(r.buildings?.buildings) === 0) gaps.push('buildings need transactions')
    if (len(r.supply?.districts) === 0) gaps.push('supply needs transactions')
    const detail =
      `rpi=${len(r.rpi?.segments)} buildings=${len(r.buildings?.buildings)} ` +
      `supply=${len(r.supply?.districts)} metrics=${len(r.metrics?.districts)} ` +
      `migration=${len(r.migration?.flows)} in ${r.durationMs}ms`
    return gaps.length ? `${detail} — ${gaps.join('; ')}` : detail
  })

  const okCount = steps.filter((s) => s.status === 'ok').length
  const skipCount = steps.filter((s) => s.status === 'skipped').length
  // Only genuine failures count against the run; "skipped" means a source is
  // simply not configured, which is not a broken pipeline.
  const failCount = steps.filter((s) => s.status === 'failed').length
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
    publish('cron:update', { job: HOURLY_JOB, status, okCount, failCount, skipCount, durationMs, steps })
  } catch {
    // A broadcast failure must not fail an otherwise successful refresh.
  }

  return { ok: failCount === 0, job: HOURLY_JOB, runId: run.id, okCount, failCount, skipCount, durationMs, steps }
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
