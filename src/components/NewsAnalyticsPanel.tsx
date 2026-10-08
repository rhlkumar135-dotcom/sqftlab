import { useCallback, useEffect, useState } from 'react'
import { BarChart3, ChevronDown, TrendingDown, TrendingUp, ExternalLink } from 'lucide-react'

/**
 * Collection and semantic analytics for the news window.
 *
 * Two things this panel must not do:
 *
 *  1. Present unanalysed articles as neutral. Items the AI pass has not reached are
 *     reported as their own count, because folding them into 'neutral' would drag every
 *     sentiment figure toward the middle and make a quiet week look balanced.
 *  2. Draw a conclusion from a comparison with no baseline. When there is no prior-period
 *     coverage the deltas render as "no comparison", not as 0% — "flat" and "unknown" are
 *     different statements and only one of them is true.
 */

interface Collection {
  id: string
  label: string
  description: string
  count: number
  share: number
  sentiment: { positive: number; neutral: number; negative: number }
  topAreas: string[]
  samples: Array<{ id: string; headline: string; sourceName: string; publishedAt: string; sourceUrl: string }>
}

interface Analytics {
  emirate?: string
  windowDays?: number
  coverage?: {
    total: number
    analysed: number
    unanalysed: number
    oldest: string | null
    newest: string | null
    daysCovered: number
    publishers: number
  }
  sentiment?: { positive: number; neutral: number; negative: number; positiveShare: number; negativeShare: number }
  signals?: Array<{ signal: string; count: number; share: number }>
  collections?: Collection[]
  topAreas?: Array<{ area: string; count: number; sentiment: { positive: number; neutral: number; negative: number } }>
  publishers?: Array<{ name: string; count: number }>
  weekly?: Array<{ weekStart: string; total: number; positive: number; neutral: number; negative: number }>
  momentum?: {
    recentVolume: number
    priorVolume: number
    volumeChangePct: number | null
    sentimentShiftPct: number | null
    recentPositiveShare: number | null
    priorPositiveShare: number | null
  }
  figures?: Array<{ value: string | null; pct: string | null; units: string | null; headline: string; sourceName: string; sourceUrl: string }>
}

const fmtDay = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleDateString('en-AE', { day: 'numeric', month: 'short' }) : '—'

export default function NewsAnalyticsPanel({ emirate }: { emirate: string }) {
  const [data, setData] = useState<Analytics | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = emirate && emirate !== 'all' ? `?emirate=${encodeURIComponent(emirate)}` : ''
      const res = await fetch(`/api/sqftlab/news/analytics${qs}`)
      const body = (await res.json().catch(() => ({}))) as Analytics & { error?: string }
      if (!res.ok) {
        setError(body.error ?? `Analysis could not be loaded (HTTP ${res.status}).`)
        return
      }
      setData(body)
    } catch {
      setError('Analysis could not be reached. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }, [emirate])

  useEffect(() => {
    void load()
  }, [load])

  const muted = { color: 'var(--ink-5)' }
  const cov = data?.coverage
  const sent = data?.sentiment
  const mom = data?.momentum
  const analysed = cov?.analysed ?? 0

  if (loading) {
    return (
      <div className="g2 p-4 sm:p-5">
        <div className="text-[13px]" style={muted}>
          Analysing the last 30 days…
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="g2 p-4 sm:p-5">
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
    )
  }

  if (!data || analysed === 0) {
    return (
      <div className="g2 p-4 sm:p-5">
        <div className="flex items-center gap-2 mb-1.5">
          <BarChart3 size={15} style={{ color: 'var(--b600)' }} />
          <h3 className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>
            Collection &amp; semantic analysis
          </h3>
        </div>
        <p className="text-[12px] leading-relaxed" style={{ color: 'var(--ink-4)' }}>
          No analysed articles in this window yet, so there is nothing to analyse. Items are
          collected first and analysed on the next pass.
        </p>
      </div>
    )
  }

  const totalSent = (sent?.positive ?? 0) + (sent?.neutral ?? 0) + (sent?.negative ?? 0)

  return (
    <div className="g2 p-4 sm:p-5">
      <div className="flex items-start gap-2.5 mb-3">
        <div className="rounded-[10px] p-2 shrink-0" style={{ background: 'rgba(37,99,235,0.09)' }}>
          <BarChart3 size={16} style={{ color: 'var(--b600)' }} />
        </div>
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>
            Collection &amp; semantic analysis
          </h3>
          <p className="text-[12px] mt-0.5" style={{ color: 'var(--ink-4)' }}>
            Last {data.windowDays ?? 30} days · {cov?.analysed ?? 0} analysed across {cov?.publishers ?? 0}{' '}
            publishers · {fmtDay(cov?.oldest)} to {fmtDay(cov?.newest)}
          </p>
        </div>
      </div>

      {/* Momentum — what changed, which a static breakdown cannot answer. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mb-3">
        <div className="rounded-[10px] p-3" style={{ background: 'rgba(0,0,0,0.025)' }}>
          <div className="text-[10px] font-semibold uppercase tracking-wide mb-1" style={muted}>
            Volume · last 7 days
          </div>
          <div className="flex items-center gap-1.5">
            {mom?.volumeChangePct === null || mom?.volumeChangePct === undefined ? (
              <span className="text-[13px]" style={{ color: 'var(--ink-4)' }}>
                No prior period to compare
              </span>
            ) : (
              <>
                {mom.volumeChangePct >= 0 ? (
                  <TrendingUp size={14} style={{ color: 'var(--b600)' }} />
                ) : (
                  <TrendingDown size={14} style={{ color: '#dc2626' }} />
                )}
                <span className="text-[15px] font-semibold mono" style={{ color: 'var(--ink)' }}>
                  {mom.volumeChangePct >= 0 ? '+' : ''}
                  {mom.volumeChangePct}%
                </span>
                <span className="text-[11px]" style={muted}>
                  ({mom.recentVolume} vs {mom.priorVolume})
                </span>
              </>
            )}
          </div>
        </div>
        <div className="rounded-[10px] p-3" style={{ background: 'rgba(0,0,0,0.025)' }}>
          <div className="text-[10px] font-semibold uppercase tracking-wide mb-1" style={muted}>
            Tone shift · positive share
          </div>
          <div className="flex items-center gap-1.5">
            {mom?.sentimentShiftPct === null || mom?.sentimentShiftPct === undefined ? (
              <span className="text-[13px]" style={{ color: 'var(--ink-4)' }}>
                No prior period to compare
              </span>
            ) : (
              <>
                <span className="text-[15px] font-semibold mono" style={{ color: 'var(--ink)' }}>
                  {mom.sentimentShiftPct >= 0 ? '+' : ''}
                  {mom.sentimentShiftPct}pp
                </span>
                <span className="text-[11px]" style={muted}>
                  {mom.priorPositiveShare}% → {mom.recentPositiveShare}%
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Sentiment — one bar, so the mix is legible at a glance on a phone. */}
      <div className="mb-3">
        <div className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={muted}>
          Tone across {analysed} analysed articles
        </div>
        <div className="flex h-2.5 rounded-full overflow-hidden" style={{ background: 'rgba(0,0,0,0.06)' }}>
          <div style={{ width: `${(sent?.positive ?? 0) / (totalSent || 1) * 100}%`, background: '#16a34a' }} />
          <div style={{ width: `${(sent?.neutral ?? 0) / (totalSent || 1) * 100}%`, background: '#94a3b8' }} />
          <div style={{ width: `${(sent?.negative ?? 0) / (totalSent || 1) * 100}%`, background: '#dc2626' }} />
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-[11px]">
          <span style={{ color: '#16a34a' }}>● {sent?.positive ?? 0} positive ({sent?.positiveShare ?? 0}%)</span>
          <span style={{ color: '#64748b' }}>● {sent?.neutral ?? 0} neutral</span>
          <span style={{ color: '#dc2626' }}>● {sent?.negative ?? 0} negative ({sent?.negativeShare ?? 0}%)</span>
          {(cov?.unanalysed ?? 0) > 0 && (
            <span style={muted}>● {cov?.unanalysed} not yet analysed (excluded)</span>
          )}
        </div>
      </div>

      {/* Collections — the navigable themes. */}
      {(data.collections ?? []).length > 0 && (
        <div className="mb-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={muted}>
            Collections · {data.collections?.length} themes
          </div>
          <div className="flex flex-col gap-1.5">
            {(data.collections ?? []).map((col) => {
              const cSent = col.sentiment.positive + col.sentiment.neutral + col.sentiment.negative
              const isOpen = open === col.id
              return (
                <div key={col.id} className="rounded-[10px] overflow-hidden" style={{ border: '1px solid rgba(0,0,0,0.07)' }}>
                  <button
                    type="button"
                    onClick={() => setOpen(isOpen ? null : col.id)}
                    className="w-full text-left p-2.5 flex items-center gap-2"
                    aria-expanded={isOpen}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
                        {col.label}
                      </div>
                      <div className="text-[11px] mt-0.5" style={{ color: 'var(--ink-4)' }}>
                        {col.count} article{col.count === 1 ? '' : 's'} · {col.share}% of analysed
                      </div>
                    </div>
                    <div className="flex h-2 w-14 rounded-full overflow-hidden shrink-0" style={{ background: 'rgba(0,0,0,0.06)' }}>
                      <div style={{ width: `${(col.sentiment.positive / (cSent || 1)) * 100}%`, background: '#16a34a' }} />
                      <div style={{ width: `${(col.sentiment.neutral / (cSent || 1)) * 100}%`, background: '#94a3b8' }} />
                      <div style={{ width: `${(col.sentiment.negative / (cSent || 1)) * 100}%`, background: '#dc2626' }} />
                    </div>
                    <ChevronDown
                      size={14}
                      style={{ color: 'var(--ink-5)', transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}
                    />
                  </button>
                  {isOpen && (
                    <div className="px-2.5 pb-2.5">
                      <p className="text-[11px] leading-relaxed mb-2" style={{ color: 'var(--ink-4)' }}>
                        {col.description}
                      </p>
                      {col.topAreas.length > 0 && (
                        <div className="flex flex-wrap gap-1 mb-2">
                          {col.topAreas.map((a) => (
                            <span
                              key={a}
                              className="text-[10px] px-1.5 py-0.5 rounded"
                              style={{ background: 'rgba(37,99,235,0.08)', color: 'var(--b600)' }}
                            >
                              {a}
                            </span>
                          ))}
                        </div>
                      )}
                      {col.samples.map((s) => (
                        <a
                          key={s.id}
                          href={s.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-start gap-1.5 py-1.5"
                          style={{ borderTop: '1px solid rgba(0,0,0,0.05)' }}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="text-[12px] leading-snug" style={{ color: 'var(--ink)' }}>
                              {s.headline}
                            </div>
                            <div className="text-[10px] mt-0.5" style={muted}>
                              {s.sourceName} · {fmtDay(s.publishedAt)}
                            </div>
                          </div>
                          <ExternalLink size={11} className="shrink-0 mt-0.5" style={{ color: 'var(--ink-5)' }} />
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Areas named in coverage. */}
      {(data.topAreas ?? []).length > 0 && (
        <div className="mb-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={muted}>
            Communities &amp; areas named
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(data.topAreas ?? []).map((a) => (
              <span
                key={a.area}
                className="text-[11px] px-2 py-1 rounded-md"
                style={{ background: 'rgba(0,0,0,0.04)', color: 'var(--ink-3)' }}
              >
                {a.area} <span style={muted}>{a.count}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Weekly volume — a real time series over the window. */}
      {(data.weekly ?? []).length > 1 && (
        <div className="mb-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={muted}>
            Coverage by week
          </div>
          <div className="flex items-end gap-2 overflow-x-auto pb-1">
            {(data.weekly ?? []).map((w) => {
              const peak = Math.max(...(data.weekly ?? []).map((x) => x.total), 1)
              const h = Math.max(3, Math.round((w.total / peak) * 40))
              return (
                <div key={w.weekStart} className="flex flex-col items-center gap-1 shrink-0" style={{ width: 42 }}>
                  <span className="text-[10px] mono" style={muted}>
                    {w.total}
                  </span>
                  <div className="flex flex-col justify-end" style={{ height: 40 }}>
                    <div style={{ height: w.negative ? (w.negative / w.total) * h : 0, width: 18, background: '#dc2626', borderRadius: '3px 3px 0 0' }} />
                    <div style={{ height: (w.neutral / w.total) * h, width: 18, background: '#94a3b8' }} />
                    <div style={{ height: (w.positive / w.total) * h, width: 18, background: '#16a34a', borderRadius: '0 0 3px 3px' }} />
                  </div>
                  <span className="text-[9px] whitespace-nowrap" style={{ color: 'var(--ink-5)' }}>
                    {fmtDay(w.weekStart)}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Figures actually quoted in the coverage. */}
      {(data.figures ?? []).length > 0 && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={muted}>
            Figures quoted in coverage
          </div>
          <div className="flex flex-col">
            {(data.figures ?? []).slice(0, 6).map((f, i) => (
              <a
                key={i}
                href={f.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="py-1.5"
                style={{ borderTop: i === 0 ? 'none' : '1px solid rgba(0,0,0,0.05)' }}
              >
                <div className="text-[12px] leading-snug" style={{ color: 'var(--ink)' }}>
                  {f.value ?? f.pct ?? f.units}
                  {f.pct && f.value ? ` · ${f.pct}` : ''}
                  {f.units ? ` · ${f.units}` : ''}
                </div>
                <div className="text-[10px] mt-0.5" style={muted}>
                  {f.headline} — {f.sourceName}
                </div>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
