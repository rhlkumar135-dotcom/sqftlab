/**
 * In-process scheduling for the data pipelines.
 *
 * The cron routes (`/sqftlab/cron/hourly`, `/cron/news-ingest`, `/cron/daily-digest`) are
 * HTTP endpoints designed to be driven by an external scheduler. This deployment has none,
 * which made several documented behaviours false: "the feed refreshes every 30 minutes",
 * "scores recompute daily at 03:00", "the WhatsApp digest goes out at 08:00". Nothing has
 * ever called those routes, so those ran zero times — and a stale dataset looks exactly
 * like a current one until you check a timestamp.
 *
 * Running the timers inside the server removes the external dependency: while the process
 * is up, the data is current. It is the right trade for a single-instance deployment. If
 * this ever scales to more than one instance, revert to an external scheduler or add a
 * leader lock — every replica running these timers would multiply the work and the digest.
 *
 * Enabled by default only in production. A dev or preview process would otherwise hit the
 * news and FX upstreams on a timer for no benefit, and would re-run a refresh underneath
 * whoever is inspecting a dataset they expect to be stable.
 */
import { runHourlyRefresh, HOURLY_JOB } from './cron'
import { runNewsIngest, generateDailyDigest } from './news'

export const NEWS_JOB = 'news-ingest'
export const DIGEST_JOB = 'daily-digest'

const HOUR_MS = 60 * 60 * 1000
const NEWS_INTERVAL_MS = 30 * 60 * 1000
/** 02:00 UAE — the digest covers the previous day, so it runs after the day has closed. */
const DIGEST_HOUR_UAE = 2

/** Hour of day in the UAE (UTC+4, no daylight saving). */
function uaeHour(d: Date = new Date()): number {
  return (d.getUTCHours() + 4) % 24
}

export function schedulerEnabled(): boolean {
  if (process.env.DISABLE_INPROCESS_CRON === 'true') return false
  if (process.env.ENABLE_INPROCESS_CRON === 'true') return true
  return process.env.NODE_ENV === 'production'
}

interface JobState {
  lastStartedAt: string | null
  lastFinishedAt: string | null
  lastOk: boolean | null
  lastError: string | null
  runs: number
}

const state = new Map<string, JobState>()
const inFlight = new Set<string>()
let started = false
const timers: ReturnType<typeof setInterval>[] = []

function record(job: string): JobState {
  const existing = state.get(job)
  if (existing) return existing
  const fresh: JobState = { lastStartedAt: null, lastFinishedAt: null, lastOk: null, lastError: null, runs: 0 }
  state.set(job, fresh)
  return fresh
}

/**
 * Run a job, never letting it take the process down and never letting a slow run overlap
 * itself. Without the overlap guard a refresh that outlasts its interval (the full hourly
 * refresh can take over a minute) would stack, and two concurrent intelligence runs would
 * write duplicate append-only rows.
 */
async function run(job: string, fn: () => Promise<unknown>): Promise<void> {
  const s = record(job)
  if (inFlight.has(job)) {
    console.warn(`[scheduler] ${job} still running — skipping this tick`)
    return
  }
  inFlight.add(job)
  s.lastStartedAt = new Date().toISOString()
  s.runs += 1
  const t = Date.now()
  try {
    const result = await fn()
    s.lastOk = true
    s.lastError = null
    const detail = typeof result === 'object' && result !== null ? JSON.stringify(result).slice(0, 300) : String(result)
    console.log(`[scheduler] ${job} ok in ${Date.now() - t}ms — ${detail}`)
  } catch (e) {
    s.lastOk = false
    s.lastError = e instanceof Error ? e.message : String(e)
    // A failed job must not kill the process: the interval keeps its cadence and the next
    // run is the retry. The failure is also recorded in cron_runs by the job itself.
    console.error(`[scheduler] ${job} failed after ${Date.now() - t}ms — ${s.lastError}`)
  } finally {
    s.lastFinishedAt = new Date().toISOString()
    inFlight.delete(job)
  }
}

const jobs: Record<string, () => Promise<unknown>> = {
  [HOURLY_JOB]: runHourlyRefresh,
  [NEWS_JOB]: () => runNewsIngest(30),
  [DIGEST_JOB]: () => generateDailyDigest(),
}

export interface SchedulerInfo {
  enabled: boolean
  started: boolean
  /** Live timer handles. Exposed so a test can prove starting twice does not double-schedule. */
  timerCount: number
  jobs: Array<{ job: string; intervalMs: number | null; state: JobState | null; inFlight: boolean }>
}

export function schedulerInfo(): SchedulerInfo {
  const intervals: Record<string, number> = {
    [HOURLY_JOB]: HOUR_MS,
    [NEWS_JOB]: NEWS_INTERVAL_MS,
    [DIGEST_JOB]: HOUR_MS,
  }
  return {
    enabled: schedulerEnabled(),
    started,
    timerCount: timers.length,
    jobs: Object.keys(jobs).map((job) => ({
      job,
      intervalMs: intervals[job] ?? null,
      state: state.get(job) ?? null,
      inFlight: inFlight.has(job),
    })),
  }
}

/**
 * Start the timers. Idempotent — a second call is a no-op, so importing this module from
 * more than one place cannot double-schedule.
 */
export function startScheduler(): SchedulerInfo {
  if (started || !schedulerEnabled()) return schedulerInfo()
  started = true

  // A fresh deploy should be current on arrival rather than up to an interval stale.
  // Delayed so the kickoff does not compete with the first health checks, and staggered
  // so the two heavy jobs do not start in the same instant.
  timers.push(
    setTimeout(() => {
      void run(HOURLY_JOB, jobs[HOURLY_JOB])
      setTimeout(() => void run(NEWS_JOB, jobs[NEWS_JOB]), 20_000)
    }, 30_000),
  )

  timers.push(setInterval(() => void run(HOURLY_JOB, jobs[HOURLY_JOB]), HOUR_MS))
  timers.push(setInterval(() => void run(NEWS_JOB, jobs[NEWS_JOB]), NEWS_INTERVAL_MS))
  // The digest is daily but checked hourly, so a restart cannot skip its window entirely.
  // `generateDailyDigest` is idempotent per day, which is what makes the repeat calls safe.
  timers.push(
    setInterval(() => {
      if (uaeHour() === DIGEST_HOUR_UAE) void run(DIGEST_JOB, jobs[DIGEST_JOB])
    }, HOUR_MS),
  )

  console.log(
    `[scheduler] started — hourly refresh every 60m, news ingest every 30m, digest at ${DIGEST_HOUR_UAE}:00 UAE`,
  )
  return schedulerInfo()
}

/** Stop the timers. For tests and for a clean shutdown. */
export function stopScheduler(): void {
  for (const t of timers) clearInterval(t)
  timers.length = 0
  started = false
}
