import { useCallback, useEffect, useState } from 'react'
import { Activity, ArrowLeft, Building2, TrendingUp, Trophy } from 'lucide-react'

/**
 * Public Market Pulse (Day 13 Task D).
 *
 * Why this page exists: it is the SEO surface. The brief is right that it must be
 * reachable without a login, because a crawler will not authenticate — so this page
 * reads only `/api/sqftlab/public/market-pulse`, which is deliberately ungated.
 *
 * Two deviations from the brief:
 *
 * 1. The brief's page reads `data.transactions`, `data.avgPrice`, `data.areas[]` with
 *    `name`/`count`/`avgPsf`, and `data.topDeals[]`. Those names do not match the route
 *    it also specifies, so every field would have been `undefined` while the page
 *    rendered zeroes. The real shape is typed below.
 * 2. The brief renders figures unconditionally. With an empty register that means a page
 *    publicly asserting "0 transactions, AED 0 average PSF" — which reads as a dead
 *    market rather than as "no data loaded". `dataAvailable`/`note` come from the server
 *    and are shown prominently, because this is the page most likely to be indexed and
 *    therefore the most damaging place to state a falsehood confidently.
 */

interface Pulse {
  generatedAt?: string
  period?: string
  periodDays?: number
  source?: string
  dataAvailable?: boolean
  note?: string | null
  market?: {
    totalTransactions?: number
    avgPsfAed?: number
    totalVolumeAed?: number
  }
  topAreas?: Array<{ area: string; count: number; avgPsfAed: number; volumeAed: number }>
  premiumDeals?: Array<{
    area: string
    building: string
    psfAed: number
    totalAed: number
    date: string
  }>
}

const aed = (n: number | undefined): string =>
  typeof n === 'number' && Number.isFinite(n)
    ? new Intl.NumberFormat('en-AE', { maximumFractionDigits: 0 }).format(n)
    : '—'

const compactAed = (n: number | undefined): string => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(Math.round(n))
}

export default function MarketPulsePage({ onBack }: { onBack?: () => void }) {
  const [data, setData] = useState<Pulse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // bare-fetch-ok: this endpoint is deliberately public and ungated — it is the SEO
      // surface, so it must work without an identity to present. Sending a bearer would
      // change nothing (the route never reads one) and would imply it is account-scoped.
      const res = await fetch('/api/sqftlab/public/market-pulse')
      const body = (await res.json().catch(() => ({}))) as Pulse & { error?: string }
      if (!res.ok) {
        setError(body.error ?? `The market pulse could not be loaded (HTTP ${res.status}).`)
        return
      }
      setData(body)
    } catch {
      setError('The market pulse could not be reached. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Page-level SEO, applied imperatively because this is a single-page app: without it a
  // deep link to this page would carry whatever title the last view set.
  useEffect(() => {
    const prevTitle = document.title
    const prevDesc = document.querySelector('meta[name="description"]')?.getAttribute('content') ?? ''
    document.title = 'Dubai Property Market Pulse — sqftLab'
    let meta = document.querySelector('meta[name="description"]')
    if (!meta) {
      meta = document.createElement('meta')
      meta.setAttribute('name', 'description')
      document.head.appendChild(meta)
    }
    meta.setAttribute(
      'content',
      'Dubai transaction register summary: volumes, average price per square foot, the most active communities and the highest-value sales in the last 30 days.',
    )
    return () => {
      document.title = prevTitle
      const m = document.querySelector('meta[name="description"]')
      if (m) m.setAttribute('content', prevDesc)
    }
  }, [])

  const market = data?.market
  const areas = data?.topAreas ?? []
  const deals = data?.premiumDeals ?? []
  const hasData = data?.dataAvailable === true

  const card = 'g2 p-4 sm:p-5'
  const muted = { color: 'var(--ink-5)' }

  return (
    <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <div className="flex items-start gap-3 mb-5">
        <div className="rounded-[14px] p-2.5 shrink-0" style={{ background: 'rgba(37,99,235,0.09)' }}>
          <Activity size={20} style={{ color: 'var(--b600)' }} />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight" style={{ color: 'var(--ink)' }}>
            Dubai Market Pulse
          </h1>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--ink-4)' }}>
            Transaction register summary
            {data?.period ? ` · last ${data.period}` : ''}
            {data?.source ? ` · ${data.source}` : ''}
          </p>
        </div>
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="hidden sm:flex items-center gap-1.5 rounded-[10px] px-3 py-2 text-[12px] font-medium shrink-0"
            style={{ background: 'var(--g3)', border: '1px solid var(--gb)', color: 'var(--ink-4)' }}
          >
            <ArrowLeft size={14} /> Back
          </button>
        )}
      </div>

      {loading && (
        <div className={card} style={muted}>
          <div className="text-[13px]">Loading market pulse…</div>
        </div>
      )}

      {!loading && error && (
        <div className={card}>
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
          {!hasData && (
            <div className="g2 p-4 sm:p-5 mb-4" style={{ borderLeft: '3px solid var(--b600)' }}>
              <div className="text-[13px] font-semibold mb-1" style={{ color: 'var(--ink)' }}>
                No transactions loaded yet
              </div>
              <p className="text-[12px] leading-relaxed" style={{ color: 'var(--ink-4)' }}>
                {data.note ??
                  'The transaction register is empty on this deployment, so the figures below are zero because nothing is loaded — not because the market was inactive.'}
              </p>
            </div>
          )}

          {/* Headline figures — one column on a phone, three across on desktop. */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
            <div className={card}>
              <div className="flex items-center gap-2 mb-2">
                <TrendingUp size={14} style={{ color: 'var(--b600)' }} />
                <span className="text-[11px] font-semibold uppercase tracking-wide" style={muted}>
                  Transactions
                </span>
              </div>
              <div className="text-xl font-semibold mono" style={{ color: 'var(--ink)' }}>
                {hasData ? aed(market?.totalTransactions) : '—'}
              </div>
            </div>
            <div className={card}>
              <div className="flex items-center gap-2 mb-2">
                <Building2 size={14} style={{ color: 'var(--b600)' }} />
                <span className="text-[11px] font-semibold uppercase tracking-wide" style={muted}>
                  Avg price / sqft
                </span>
              </div>
              <div className="text-xl font-semibold mono" style={{ color: 'var(--ink)' }}>
                {hasData ? `AED ${aed(market?.avgPsfAed)}` : '—'}
              </div>
            </div>
            <div className={card}>
              <div className="flex items-center gap-2 mb-2">
                <Trophy size={14} style={{ color: 'var(--b600)' }} />
                <span className="text-[11px] font-semibold uppercase tracking-wide" style={muted}>
                  Total value
                </span>
              </div>
              <div className="text-xl font-semibold mono" style={{ color: 'var(--ink)' }}>
                {hasData ? `AED ${compactAed(market?.totalVolumeAed)}` : '—'}
              </div>
            </div>
          </div>

          {/* Most active communities */}
          <div className={`${card} mb-4`}>
            <h2 className="text-[14px] font-semibold mb-3" style={{ color: 'var(--ink)' }}>
              Most active communities
            </h2>
            {areas.length === 0 ? (
              <p className="text-[12px]" style={muted}>
                No community activity to rank — the register is empty.
              </p>
            ) : (
              <>
                {/* Desktop: table. Mobile: stacked rows, so nothing is truncated. */}
                <div className="hidden sm:block overflow-x-auto">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr style={{ color: 'var(--ink-5)' }}>
                        <th className="text-left font-semibold text-[11px] uppercase tracking-wide pb-2">
                          Community
                        </th>
                        <th className="text-right font-semibold text-[11px] uppercase tracking-wide pb-2">
                          Sales
                        </th>
                        <th className="text-right font-semibold text-[11px] uppercase tracking-wide pb-2">
                          Avg AED/sqft
                        </th>
                        <th className="text-right font-semibold text-[11px] uppercase tracking-wide pb-2">
                          Value
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {areas.map((a, i) => (
                        <tr key={`${a.area}-${i}`} style={{ borderTop: '1px solid var(--gb)' }}>
                          <td className="py-2 pr-3" style={{ color: 'var(--ink-2)' }}>
                            {a.area}
                          </td>
                          <td className="py-2 text-right mono" style={{ color: 'var(--ink-3)' }}>
                            {a.count}
                          </td>
                          <td className="py-2 text-right mono" style={{ color: 'var(--ink-3)' }}>
                            {aed(a.avgPsfAed)}
                          </td>
                          <td className="py-2 text-right mono" style={{ color: 'var(--ink-3)' }}>
                            AED {compactAed(a.volumeAed)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="sm:hidden space-y-2">
                  {areas.map((a, i) => (
                    <div
                      key={`${a.area}-m-${i}`}
                      className="rounded-[10px] px-3 py-2"
                      style={{ background: 'var(--g3)', border: '1px solid var(--gb)' }}
                    >
                      <div className="text-[13px] font-medium" style={{ color: 'var(--ink)' }}>
                        {a.area}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1 text-[11px] mono" style={muted}>
                        <span>{a.count} sales</span>
                        <span>AED {aed(a.avgPsfAed)}/sqft</span>
                        <span>AED {compactAed(a.volumeAed)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Highest-value sales */}
          <div className={card}>
            <h2 className="text-[14px] font-semibold mb-3" style={{ color: 'var(--ink)' }}>
              Highest price per sqft
            </h2>
            {deals.length === 0 ? (
              <p className="text-[12px]" style={muted}>
                No registered sales to show — the register is empty.
              </p>
            ) : (
              <div className="space-y-2">
                {deals.map((d, i) => (
                  <div
                    key={`${d.building}-${i}`}
                    className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-[10px] px-3 py-2"
                    style={{ background: 'var(--g3)', border: '1px solid var(--gb)' }}
                  >
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium" style={{ color: 'var(--ink)' }}>
                        {d.building || d.area || 'Unnamed unit'}
                      </div>
                      <div className="text-[11px]" style={muted}>
                        {d.area} · {d.date}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[13px] font-semibold mono" style={{ color: 'var(--b600)' }}>
                        AED {aed(d.psfAed)}/sqft
                      </div>
                      <div className="text-[11px] mono" style={muted}>
                        AED {compactAed(d.totalAed)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {data.generatedAt && (
            <p className="text-[11px] mt-4" style={muted}>
              Generated {new Date(data.generatedAt).toLocaleString('en-AE')} · refreshed daily.
            </p>
          )}

          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="sm:hidden mt-4 flex items-center gap-1.5 rounded-[10px] px-3 py-2 text-[12px] font-medium"
              style={{ background: 'var(--g3)', border: '1px solid var(--gb)', color: 'var(--ink-4)' }}
            >
              <ArrowLeft size={14} /> Back
            </button>
          )}
        </>
      )}
    </div>
  )
}
