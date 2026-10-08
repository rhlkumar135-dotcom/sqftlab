import { useCallback, useEffect, useState } from 'react'
import { CalendarClock, History } from 'lucide-react'

/**
 * Market history, next to the newest refresh.
 *
 * The point of this panel is to make a distinction visible that the rest of the site
 * cannot express: every other figure on the page is a single point in time, overwritten
 * on the next refresh. This one shows what has actually been *recorded*, and says plainly
 * where the record begins.
 *
 * The two series are labelled differently on purpose, because they are not the same kind
 * of thing and a reader who confuses them will draw a wrong conclusion:
 *
 *  · Supply (monthly) — real history, reaching back further, taken from the portals' own
 *    "first listed" timestamps. The bar is how many listings came to market that month.
 *    Every listing carries the asking price it has TODAY, so the price per cohort is a
 *    current snapshot of an old cohort, not a historical market price. It is therefore
 *    NOT plotted as a price line — only the counts are shown as history.
 *
 *  · Asking PSF (daily) — the market series proper, one point per day the snapshot job has
 *    run. It only appears once there is more than one day to compare, because a "trend"
 *    drawn through a single point is a lie told with a straight line.
 */

interface HistoryResponse {
  asOf?: string
  latest?: {
    refreshedAt?: string | null
    period?: string
    districts?: number
    listings?: number
    snapshotPending?: boolean
  }
  coverage?: {
    historyStartsOn?: string | null
    latestRecordedOn?: string | null
    daysRecorded?: number
  }
  daily?: Array<{
    period: string
    medianPsf: number | null
    saleListings: number
    rentListings: number
    districts: number
    psfSource: string
    registerBacked: number
  }>
  supply?: Array<{
    month: string
    listings: number
    sale: number
    rent: number
    medianAskingPsf: number | null
  }>
}

const num = (n: number | undefined | null): string =>
  typeof n === 'number' && Number.isFinite(n)
    ? new Intl.NumberFormat('en-AE', { maximumFractionDigits: 0 }).format(n)
    : '—'

/** "2 hours ago" reads faster than a timestamp when the question is "is this current?". */
function ago(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return 'just now'
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

const monthLabel = (m: string): string => {
  const [y, mm] = m.split('-')
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${names[Number(mm) - 1] ?? mm} ${y.slice(2)}`
}

export default function MarketHistoryPanel() {
  const [data, setData] = useState<HistoryResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/sqftlab/market/history?days=90')
      const body = (await res.json().catch(() => ({}))) as HistoryResponse & { error?: string }
      if (!res.ok) {
        // Surface the server's own message — a generic string here strands the reader
        // and hides which failure actually happened.
        setError(body.error ?? `History could not be loaded (HTTP ${res.status}).`)
        return
      }
      setData(body)
    } catch {
      setError('History could not be reached. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const card = 'g2 p-4 sm:p-5'
  const muted = { color: 'var(--ink-5)' }
  const supply = data?.supply ?? []
  const daily = data?.daily ?? []
  const days = data?.coverage?.daysRecorded ?? 0
  const peak = supply.reduce((m, s) => Math.max(m, s.listings), 0)
  // A trailing window, so the bars stay legible on a phone rather than compressing
  // 21 months into an unreadable strip.
  const shown = supply.slice(-12)

  return (
    <div className={card}>
      <div className="flex items-start gap-2.5 mb-3">
        <div className="rounded-[10px] p-2 shrink-0" style={{ background: 'rgba(37,99,235,0.09)' }}>
          <History size={16} style={{ color: 'var(--b600)' }} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>
            Recorded history
          </h2>
          <p className="text-[12px] mt-0.5 flex items-center gap-1.5 flex-wrap" style={{ color: 'var(--ink-4)' }}>
            <CalendarClock size={12} />
            <span>
              Latest refresh {ago(data?.latest?.refreshedAt)} · {num(data?.latest?.listings)} listings across{' '}
              {num(data?.latest?.districts)} districts
            </span>
          </p>
        </div>
      </div>

      {loading && (
        <div className="text-[13px]" style={muted}>
          Loading history…
        </div>
      )}

      {!loading && error && (
        <div>
          <div className="text-[13px]" style={{ color: 'var(--ink-3)' }}>
            {error}
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-3 px-3 py-2 rounded-[10px] text-[12px] font-semibold"
            style={{ background: 'var(--b600)', color: '#fff' }}
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && data && (
        <>
          {days <= 1 ? (
            <p className="text-[12px] leading-relaxed mb-3" style={{ color: 'var(--ink-4)' }}>
              Daily history begins {data.coverage?.historyStartsOn ?? 'today'} — {days} day
              {days === 1 ? '' : 's'} recorded so far. A market trend needs more than one
              observation, so no price line is drawn yet; it will fill in from here.
            </p>
          ) : (
            <div className="mb-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide mb-1.5" style={muted}>
                Asking price / sqft · {days} days recorded
              </div>
              <DailySpark daily={daily} />
            </div>
          )}

          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide mb-1.5" style={muted}>
              Listings first offered each month
            </div>
            <div className="flex items-end gap-1.5 overflow-x-auto pb-1">
              {shown.length === 0 && (
                <span className="text-[12px]" style={{ color: 'var(--ink-4)' }}>
                  No supply history yet.
                </span>
              )}
              {shown.map((s) => {
                const h = peak > 0 ? Math.max(2, Math.round((s.listings / peak) * 44)) : 2
                return (
                  <div key={s.month} className="flex flex-col items-center gap-1 shrink-0" style={{ width: 38 }}>
                    <span className="text-[10px] mono" style={{ color: 'var(--ink-4)' }}>
                      {s.listings}
                    </span>
                    <div
                      style={{
                        height: h,
                        width: 22,
                        background: 'var(--b600)',
                        opacity: 0.75,
                        borderRadius: 3,
                      }}
                    />
                    <span className="text-[9px] whitespace-nowrap" style={{ color: 'var(--ink-5)' }}>
                      {monthLabel(s.month)}
                    </span>
                  </div>
                )
              })}
            </div>
            <p className="text-[11px] leading-relaxed mt-2" style={{ color: 'var(--ink-5)' }}>
              Real history from the portals&rsquo; own listing dates, reaching back further than the daily
              record. Counts are supply. These listings carry the asking price they have today, so this is
              not a historical price series and no price is drawn from it.
            </p>
          </div>
        </>
      )}
    </div>
  )
}

/** Compact SVG line so a second day immediately shows movement rather than a bare number. */
function DailySpark({ daily }: { daily: NonNullable<HistoryResponse['daily']> }) {
  const pts = daily.filter((d) => d.medianPsf !== null)
  if (pts.length < 2) return null

  const values = pts.map((p) => p.medianPsf as number)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const w = 100
  const h = 30
  const coords = pts.map((p, i) => {
    const x = pts.length === 1 ? 0 : (i / (pts.length - 1)) * w
    const y = h - (((p.medianPsf as number) - min) / span) * h
    return `${x.toFixed(2)},${y.toFixed(2)}`
  })

  const first = values[0]
  const last = values[values.length - 1]
  const change = first > 0 ? ((last - first) / first) * 100 : 0

  return (
    <div className="flex items-center gap-3">
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height="34" preserveAspectRatio="none" role="img"
        aria-label={`Asking price per square foot over ${pts.length} days`}>
        <polyline
          points={coords.join(' ')}
          fill="none"
          stroke="var(--b600)"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="text-right shrink-0">
        <div className="text-[13px] font-semibold mono" style={{ color: 'var(--ink)' }}>
          {num(last)}
        </div>
        <div className="text-[10px]" style={{ color: 'var(--ink-5)' }}>
          {change >= 0 ? '+' : ''}
          {change.toFixed(1)}% since {daily[0]?.period}
        </div>
      </div>
    </div>
  )
}
