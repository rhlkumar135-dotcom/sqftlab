import { prisma } from './db'
import { fetchAllMacro, fetchExchangeRates } from './macro'
import { runIntelligencePipeline } from './intelligence'
import { scanDealAlerts, notifyPendingMatches } from './alerts'
import { publish } from './events'
import { detectDeals, SALE_TXN_TYPES } from './deals'
import { computeAllInvestmentScores } from './score-engine'
import { cacheInvalidate } from './cache'
import { dldConfigured, syncDLDTransactions } from './dld'
import { syncDldReference } from './dld-open'
import { adrecConfigured, syncADRECTransactions } from './adrec'
import { revalueAllHoldings } from './portfolio-jobs'
import { sendWhatsappDigests } from './whatsapp-jobs'
import { captureMarketSnapshot } from './market-history'

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
 * Median value per community.
 *
 * Used instead of a mean because individual bad rows are exactly what a mean is worst at:
 * one rent listing carrying a sale-scale price moves a whole district's advertised rent,
 * and a single mis-parsed 11 sqft "duplex" yields a price-per-sqft in the thousands. Both
 * are present in the live data. A median is unmoved by either, which is why it is the right
 * statistic for "what does a typical unit here cost" — and what these columns have always
 * claimed to hold.
 */
function medianByCommunity(pairs: Array<[string | null, number | null]>): Map<string, number> {
  const buckets = new Map<string, number[]>()
  for (const [communityId, value] of pairs) {
    if (communityId === null || value === null || !Number.isFinite(value) || value <= 0) continue
    const bucket = buckets.get(communityId)
    if (bucket === undefined) buckets.set(communityId, [value])
    else bucket.push(value)
  }

  const medians = new Map<string, number>()
  for (const [communityId, values] of buckets) {
    values.sort((a, b) => a - b)
    const middle = Math.floor(values.length / 2)
    const median =
      values.length % 2 === 0 ? (values[middle - 1]! + values[middle]!) / 2 : values[middle]!
    medians.set(communityId, median)
  }
  return medians
}

/**
 * Recompute every community's PSF from government transaction data, falling
 * back to listing asking prices only where no transactions exist.
 *
 * This is the difference between the platform's core claim being true and false:
 * `community.medianAedSqft` was previously always derived from PropertyFinder
 * asking prices. `psfSource` records which one a given row actually used.
 *
 * Four grouped queries, two row fetches reduced to medians, and one batched write replace the
 * per-community loop (~160 queries). Yields are only overwritten when both inputs are real,
 * so a community with no rent data keeps its previous value rather than dropping to 0.
 */
export async function refreshCommunityStats(): Promise<{
  communities: number
  dld: number
  listing: number
  none: number
}> {
  const since30d = new Date()
  since30d.setDate(since30d.getDate() - 30)

  const [txPsf, txCount, txCount30d, listPsf, listRent] = await Promise.all([
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
    // Counted, not assumed. `transactionCount30d` was written once by the seed script
    // and never recomputed, so it advertised activity the register could not support.
    prisma.transaction.groupBy({
      by: ['communityId'],
      where: { transactionDate: { gte: since30d } },
      _count: { _all: true },
    }),
    // Fetched row-wise and reduced to a MEDIAN in JS. Prisma's groupBy offers only
    // mean/min/max, and these two columns are named `medianAedSqft` and
    // `medianAnnualRentAed` — so a mean was being stored under a median's name, which is a
    // lie the UI then repeated. The consequence was not cosmetic: measured on this dataset
    // the mean overstated Palm Jumeirah's annual rent by 69% (AED 790,812 against AED
    // 468,785 before the five sale-scale rent listings) and that figure divides straight
    // into gross yield, which is why the district advertised a yield no market supports.
    // A median is robust to those rows by construction, so no plausibility band has to be
    // invented to defend the number.
    prisma.listing.findMany({
      where: { purpose: 'sale', pricePerSqft: { gt: 0 } },
      select: { communityId: true, pricePerSqft: true },
    }),
    prisma.listing.findMany({
      where: { purpose: 'rent', priceAed: { gt: 0 } },
      select: { communityId: true, priceAed: true },
    }),
  ])

  const txPsfMap = new Map(txPsf.map((r) => [r.communityId, r._avg.pricePerSqft ?? 0]))
  const txCountMap = new Map(txCount.map((r) => [r.communityId, r._count._all]))
  const txCount30dMap = new Map(txCount30d.map((r) => [r.communityId, r._count._all]))
  const listPsfMap = medianByCommunity(listPsf.map((r) => [r.communityId, r.pricePerSqft]))
  const rentMap = medianByCommunity(listRent.map((r) => [r.communityId, r.priceAed]))

  const communities = await prisma.community.findMany({
    select: {
      id: true,
      medianAedSqft: true,
      medianAnnualRentAed: true,
      grossYieldPct: true,
      // Read so the value can be preserved where a register backs it, and cleared where
      // one does not. Without these in the select the update wrote `undefined`.
      priceChange30d: true,
      priceChange1y: true,
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

      // Momentum can only come from a transaction register. Preserved where register
      // rows exist, cleared to 0 where they do not — otherwise a value written once by
      // the seed script survives every refresh and is served as a market movement.
      const hasRegister = (txCountMap.get(cm.id) ?? 0) > 0

      return prisma.community.update({
        where: { id: cm.id },
        data: {
          // Written as computed, including 0. The previous `|| cm.medianAedSqft`
          // fallback kept whatever was already in the row whenever live data was
          // absent, so a seeded median survived every refresh and was served as a
          // market PSF — five communities advertised a price their own psfSource
          // labelled 'none'. A district with no data now reads 0, which the UI
          // renders as DASH rather than as a number.
          medianAedSqft: mp,
          medianAnnualRentAed: mr,
          grossYieldPct: yld,
          totalTransactions: txCountMap.get(cm.id) ?? 0,
          transactionCount30d: txCount30dMap.get(cm.id) ?? 0,
          priceChange30d: hasRegister ? cm.priceChange30d : 0,
          priceChange1y: hasRegister ? cm.priceChange1y : 0,
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

  // The keyless half of DLD. Unlike dldSync this needs no credential, so it is a
  // live government source rather than a skipped one — the area, project and
  // Ejari property-type registries refresh every hour. It carries no prices.
  await step('dldReference', async () => {
    const r = await syncDldReference()
    return (
      `${r.areas} areas, ${r.projects} projects, ${r.propertyTypes} property types ` +
      `(${r.linkedCommunities} communities linked to their official DLD area` +
      (r.newlyLinked ? `, ${r.newlyLinked} new` : '') +
      ')'
    )
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

  // Runs immediately after communityStats, and depends on it: the snapshot copies the
  // columns that step just wrote, so capturing first would record stale values.
  await step('marketSnapshot', async () => {
    const r = await captureMarketSnapshot()
    return `${r.communities} districts captured for ${r.period}`
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

  await step('investmentScores', investmentScoresStep)
  await step('portfolioRevalue', portfolioRevalueStep)
  await step('whatsappDigest', whatsappDigestStep)

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

// ─── Investment scores (FEATURE-01) ─────────────────────────────────────────

export const DAILY_JOB = 'daily-scores'

/** Hour of day in the UAE (UTC+4, no daylight saving). */
function uaeHour(d: Date = new Date()): number {
  return (d.getUTCHours() + 4) % 24
}

/**
 * Recompute every community's investment score once a day, in the 03:00 UAE window.
 *
 * Guarded on the hour AND the age of the newest row. A guard on age alone would
 * drift — each run takes time, so ">24h since last" fires a little earlier every
 * day until it lands at midnight. Requiring the 03:00 window pins it, and the age
 * check keeps a retried or duplicated run inside that hour from recomputing twice.
 *
 * The batch scores every community with one fixed set of queries, so this is six
 * round trips rather than six per community.
 */
async function investmentScoresStep(): Promise<string | { skipped: string }> {
  if (uaeHour() !== 3) return { skipped: `outside the 03:00 UAE window (now ${uaeHour()}:00 UAE)` }

  const newest = await prisma.investmentScore.findFirst({
    orderBy: { calculatedAt: 'desc' },
    select: { calculatedAt: true },
  })
  const ageHours = newest ? (Date.now() - newest.calculatedAt.getTime()) / 3_600_000 : Infinity
  if (ageHours < 20) return { skipped: `already scored ${Math.round(ageHours)}h ago` }

  const r = await computeAllInvestmentScores()
  // Day 15 D2 — the score route caches the newest row for 6h. This batch has just written
  // newer ones, so drop them: otherwise a paid customer keeps seeing the previous score
  // for the rest of the window even though the recompute they are paying for already ran.
  cacheInvalidate('sqftlab:score:')
  return `${r.written} scores (avg ${r.avgScore ?? 'n/a'}, coverage ${r.avgCoverage ?? 'n/a'})`
}

/**
 * Revalue every portfolio holding once a day, in the 04:00 UAE window.
 *
 * Carried by the hourly refresh and guarded on the hour, the same way the score
 * recompute is: the guard is what makes an hourly job safe to run daily work from, and
 * it keeps a retried run inside the same hour from valuing twice.
 *
 * A holding with too few comparables keeps its previous valuation rather than being
 * zeroed — `revalueAllHoldings` counts those as skipped and leaves the row alone.
 */
/**
 * Send the WhatsApp digest once a day, in the 08:00 UAE window.
 *
 * Hour-guarded like the other daily work carried by the hourly refresh, so a retried run
 * inside the same hour cannot message a subscriber twice — and `lastSentAt` gating inside
 * the job is the second line of defence if the process is restarted mid-hour.
 */
async function whatsappDigestStep(): Promise<string | { skipped: string }> {
  if (uaeHour() !== 8) return { skipped: `outside the 08:00 UAE window (now ${uaeHour()}:00 UAE)` }

  const r = await sendWhatsappDigests()
  if (r.considered === 0) return { skipped: 'no WhatsApp subscribers' }
  if (r.skipped.unconfigured > 0 && r.sent === 0 && r.failed === 0) {
    return { skipped: `${r.considered} subscriber(s), but WhatsApp delivery is not configured` }
  }
  return (
    `${r.sent} sent, ${r.failed} failed of ${r.considered} subscriber(s)` +
    (r.errorMsg ? ` — first error: ${r.errorMsg}` : '')
  )
}

async function portfolioRevalueStep(): Promise<string | { skipped: string }> {
  if (uaeHour() !== 4) return { skipped: `outside the 04:00 UAE window (now ${uaeHour()}:00 UAE)` }

  const r = await revalueAllHoldings()
  if (r.considered === 0) return { skipped: 'no holdings to revalue' }
  return (
    `${r.valued} of ${r.considered} holdings valued in ${r.queries} queries` +
    (r.skipped > 0 ? ` (${r.skipped} without enough comparable sales, left unchanged)` : '')
  )
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
