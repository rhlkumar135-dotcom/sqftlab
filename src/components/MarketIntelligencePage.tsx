import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, ArrowRight, Newspaper, RefreshCw } from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { usePageMeta } from '@/lib/seo'
import { EmptyState } from '@/components/EmptyState'
import { SkeletonCard, SkeletonRows } from '@/components/Skeleton'
import SentimentGauge from '@/components/SentimentGauge'
import NewsCard, { SIGNAL_CONFIG, signalMeta, type NewsItemRow } from '@/components/NewsCard'

/**
 * Day 19 — Market Intelligence Feed. PUBLIC: no session required, by design. This is
 * the SEO and top-of-funnel surface, so it must render for a crawler and for a
 * signed-out visitor arriving from a search result.
 *
 * Published at `/news`, NOT the `/intelligence` the brief asks for. `/intelligence`
 * is already taken by the Pro-tier intelligence report (`App.tsx`, "spec Part 8.3"),
 * which owns the `intelligence` page id and the `/sqftlab/intelligence` API. Two
 * different products cannot share one URL, and repointing the existing page would
 * have silently moved a paying feature's address. `/news` is single-segment, so it
 * also survives the edge proxy that answers every `/api…` prefix (see the `/keys`
 * note in `PAGE_PATHS`).
 *
 * The page never states a market fact it does not have. When the ingest has not run,
 * or no article has been analysed yet, it says so and points at the status route
 * rather than rendering an empty feed that reads as "a quiet news day".
 */

interface Digest {
  id: string
  date: string
  headline: string
  summary: string
  topSignals: Array<{ type: string; headline: string; impact: string }>
  sentimentScore: number | null
  areasInFocus: string[]
  articlesScanned: number
  sourcesUsed: string[]
  isToday?: boolean
}

interface SignalCount {
  type: string
  count: number
}

interface SourceInfo {
  total: number
  latestPublishedAt: string | null
  feeds: Array<{ id: string; name: string; region: string; category: string; stored: number }>
  publishers: Array<{ name: string; count: number }>
}

interface NewsStatus {
  aiConfigured: boolean
  feeds: number
  items: { total: number; processed: number; pending: number }
  lastIngestAt: string | null
  lastIngestStatus: string | null
}

const SIGNAL_FILTERS = ['', ...Object.keys(SIGNAL_CONFIG)] as const
const SENTIMENT_FILTERS = ['', 'positive', 'neutral', 'negative'] as const

export default function MarketIntelligencePage({ onSignIn }: { onSignIn?: () => void }) {
  usePageMeta({
    title: 'UAE Property Market Intelligence | Real-Time News',
    description:
      'AI-analysed Dubai and Abu Dhabi real estate news. Price movements, project launches and regulatory changes, updated every 30 minutes from major UAE sources.',
    canonicalPath: '/news',
  })

  const [digest, setDigest] = useState<Digest | null>(null)
  const [history, setHistory] = useState<Digest[]>([])
  const [signals, setSignals] = useState<SignalCount[]>([])
  const [sources, setSources] = useState<SourceInfo | null>(null)
  const [status, setStatus] = useState<NewsStatus | null>(null)
  const [items, setItems] = useState<NewsItemRow[]>([])
  const [total, setTotal] = useState(0)

  const [signalFilter, setSignalFilter] = useState('')
  const [sentimentFilter, setSentimentFilter] = useState('')
  const [areaFilter, setAreaFilter] = useState('')

  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [openHistory, setOpenHistory] = useState<string | null>(null)

  // Surface the server's own message rather than a generic one: an unconfigured
  // feature and a broken route are different problems with different fixes.
  const fetchJson = useCallback(async <T,>(url: string): Promise<T> => {
    const res = await fetch(url)
    const body = (await res.json().catch(() => ({}))) as T & { error?: string }
    if (!res.ok) throw new Error(body.error ?? `Request failed (HTTP ${res.status})`)
    return body
  }, [])

  const loadSidebar = useCallback(async () => {
    const [d, h, s, src, st] = await Promise.all([
      fetchJson<{ digest: Digest | null }>('/api/sqftlab/news/digest').catch(() => ({ digest: null })),
      fetchJson<{ history: Digest[] }>('/api/sqftlab/news/digest/history').catch(() => ({ history: [] })),
      fetchJson<{ signals: SignalCount[] }>('/api/sqftlab/news/signals').catch(() => ({ signals: [] })),
      fetchJson<SourceInfo>('/api/sqftlab/news/sources').catch(() => null),
      fetchJson<NewsStatus>('/api/sqftlab/news/status').catch(() => null),
    ])
    setDigest(d.digest)
    setHistory(h.history)
    setSignals(s.signals)
    setSources(src)
    setStatus(st)
  }, [fetchJson])

  const loadFeed = useCallback(
    async (targetPage: number) => {
      const params = new URLSearchParams()
      if (signalFilter) params.set('signal', signalFilter)
      if (sentimentFilter) params.set('sentiment', sentimentFilter)
      if (areaFilter.trim()) params.set('area', areaFilter.trim())
      params.set('page', String(targetPage))
      return fetchJson<{ items: NewsItemRow[]; total: number }>(`/api/sqftlab/news?${params.toString()}`)
    },
    [signalFilter, sentimentFilter, areaFilter, fetchJson],
  )

  // Sidebar is loaded once; the feed reloads whenever a filter changes.
  useEffect(() => {
    void loadSidebar()
  }, [loadSidebar])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setPage(1)
    loadFeed(1)
      .then((r) => {
        if (cancelled) return
        setItems(r.items)
        setTotal(r.total)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load the feed')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [loadFeed])

  const loadMore = async () => {
    const next = page + 1
    setLoadingMore(true)
    try {
      const r = await loadFeed(next)
      setItems((prev) => [...prev, ...r.items])
      setPage(next)
      setTotal(r.total)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not load more')
    } finally {
      setLoadingMore(false)
    }
  }

  const paragraphs = useMemo(() => (digest?.summary ?? '').split(/\n{2,}/).filter(Boolean), [digest])
  const maxSignal = useMemo(() => Math.max(1, ...signals.map((s) => s.count)), [signals])
  const hasMore = items.length < total

  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 sm:px-6 py-6 sm:py-10">
      {/* ── header ── */}
      <header className="mb-6">
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <h1 className="text-2xl sm:text-3xl font-bold" style={{ color: 'var(--ink)' }}>
            Market Intelligence
          </h1>
          <span
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold"
            style={{ background: '#fef2f2', color: '#dc2626' }}
          >
            <span className="live-dot" style={{ width: 7, height: 7, borderRadius: '50%', background: '#dc2626' }} />
            LIVE
          </span>
        </div>
        <p className="text-sm" style={{ color: 'var(--ink-5)' }}>
          Real-time UAE property &amp; financial news, AI-analysed. Updated every 30 minutes.
        </p>
        {status && (
          <p className="text-xs mt-2" style={{ color: 'var(--ink-5)' }}>
            {status.items.processed} analysed of {status.items.total} stored
            {status.lastIngestAt ? ` · last ingest ${new Date(status.lastIngestAt).toLocaleString('en-AE')}` : ' · ingest has not run yet'}
            {status.lastIngestStatus ? ` (${status.lastIngestStatus})` : ''}
          </p>
        )}
      </header>

      {/* ── today's digest ── */}
      <section className="glass-card p-4 sm:p-6 mb-6">
        {digest ? (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
              <h2 className="text-lg sm:text-xl font-bold" style={{ color: 'var(--ink)' }}>
                {digest.headline}
              </h2>
              <span className="text-xs whitespace-nowrap" style={{ color: 'var(--ink-5)' }}>
                {new Date(digest.date).toLocaleDateString('en-AE', {
                  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Dubai',
                })}
                {digest.isToday === false ? ' · latest available' : ''}
              </span>
            </div>

            <div className="my-4 max-w-md">
              <SentimentGauge score={digest.sentimentScore} />
            </div>

            <div className="text-sm leading-relaxed" style={{ color: 'var(--ink-4, #475569)' }}>
              {(expanded ? paragraphs : paragraphs.slice(0, 1)).map((p, i) => (
                <p key={i} className="mb-3">
                  {p}
                </p>
              ))}
            </div>
            {paragraphs.length > 1 && (
              <button
                onClick={() => setExpanded((v) => !v)}
                className="text-sm font-semibold mb-2"
                style={{ color: '#2563EB' }}
              >
                {expanded ? 'Show less' : `Read full digest (${paragraphs.length} paragraphs)`}
              </button>
            )}

            {digest.topSignals.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-4">
                {digest.topSignals.map((s, i) => {
                  const meta = signalMeta(s.type)
                  return (
                    <span
                      key={i}
                      title={`${s.headline} — ${s.impact}`}
                      className="px-2.5 py-1 rounded-full text-[11px] font-semibold cursor-help"
                      style={{ background: meta.bg, color: meta.color }}
                    >
                      {meta.emoji} {s.headline}
                    </span>
                  )
                })}
              </div>
            )}

            {digest.areasInFocus.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 mt-3">
                <span className="text-xs" style={{ color: 'var(--ink-5)' }}>Areas in focus:</span>
                {digest.areasInFocus.map((a) => (
                  <button
                    key={a}
                    onClick={() => setAreaFilter(a)}
                    className="px-2 py-0.5 rounded-full text-[11px]"
                    style={{ background: '#eff6ff', color: '#2563EB' }}
                  >
                    {a}
                  </button>
                ))}
              </div>
            )}

            <p className="text-xs mt-3" style={{ color: 'var(--ink-5)' }}>
              Analysed {digest.articlesScanned} articles from {digest.sourcesUsed.length} sources.
            </p>
          </>
        ) : (
          <EmptyState
            icon={<Newspaper className="w-8 h-8" />}
            title="No digest yet"
            body={
              status && !status.aiConfigured
                ? 'News is being collected, but the AI digest layer is not configured on this deployment.'
                : status && status.items.total === 0
                  ? 'The news ingest has not run yet. The digest appears once the first articles have been collected and analysed.'
                  : 'The daily digest is generated once per day from the previous 24 hours of articles. It has not been generated yet.'
            }
          />
        )}
      </section>

      {/* ── filters ── */}
      <section className="glass-card p-3 sm:p-4 mb-6">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold" style={{ color: 'var(--ink-5)' }}>Signal</span>
            {SIGNAL_FILTERS.map((s) => {
              const active = signalFilter === s
              const meta = s ? SIGNAL_CONFIG[s] : null
              return (
                <button
                  key={s || 'all'}
                  onClick={() => setSignalFilter(s)}
                  className="px-2.5 py-1 rounded-full text-[11px] font-semibold"
                  style={{
                    background: active ? meta?.color ?? '#2563EB' : meta?.bg ?? '#f1f5f9',
                    color: active ? '#fff' : meta?.color ?? 'var(--ink-5)',
                  }}
                >
                  {meta ? `${meta.emoji} ${meta.label}` : 'All'}
                </button>
              )
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold" style={{ color: 'var(--ink-5)' }}>Sentiment</span>
            {SENTIMENT_FILTERS.map((s) => (
              <button
                key={s || 'all'}
                onClick={() => setSentimentFilter(s)}
                className="px-2.5 py-1 rounded-full text-[11px] font-semibold capitalize"
                style={{
                  background: sentimentFilter === s ? '#2563EB' : '#f1f5f9',
                  color: sentimentFilter === s ? '#fff' : 'var(--ink-5)',
                }}
              >
                {s || 'All'}
              </button>
            ))}
          </div>
          <input
            value={areaFilter}
            onChange={(e) => setAreaFilter(e.target.value)}
            placeholder="Filter by area (e.g. Dubai Marina, Saadiyat Island)"
            aria-label="Filter news by area"
            className="w-full px-3 py-2 rounded-lg text-sm"
            style={{ background: '#fff', border: '1px solid var(--gb)', color: 'var(--ink)' }}
          />
        </div>
      </section>

      {/* ── feed + sidebar ── */}
      {/* Stacks on a phone; two columns from lg. A pinned rail would be unusable at 390px. */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          {error && (
            <div
              className="rounded-xl p-4 mb-4 text-sm"
              style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}
            >
              {error}
            </div>
          )}

          {loading ? (
            <div className="flex flex-col gap-3">
              <SkeletonCard height={120} />
              <SkeletonCard height={120} />
              <SkeletonCard height={120} />
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={<Newspaper className="w-8 h-8" />}
              title="No articles match"
              body={
                signalFilter || sentimentFilter || areaFilter.trim()
                  ? 'No analysed article matches this filter. Try clearing it.'
                  : 'No analysed articles yet. The feed fills once the ingest and AI passes have run.'
              }
            />
          ) : (
            <div className="flex flex-col gap-3">
              {items.map((item) => (
                <NewsCard key={item.id} item={item} />
              ))}
              {hasMore && (
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="w-full py-3 rounded-xl font-semibold text-sm disabled:opacity-60"
                  style={{ background: '#2563EB', color: '#fff' }}
                >
                  {loadingMore ? 'Loading…' : `Load more (${items.length} of ${total})`}
                </button>
              )}
            </div>
          )}
        </div>

        {/* ── sidebar ── */}
        <aside className="flex flex-col gap-6">
          <section className="glass-card p-4">
            <h3 className="font-bold mb-3 text-sm" style={{ color: 'var(--ink)' }}>7-Day Digest History</h3>
            {history.length === 0 ? (
              <p className="text-xs" style={{ color: 'var(--ink-5)' }}>No digests yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {history.map((h) => (
                  <li key={h.id} className="pb-2" style={{ borderBottom: '1px solid var(--gb)' }}>
                    <button
                      className="w-full text-left"
                      onClick={() => setOpenHistory(openHistory === h.id ? null : h.id)}
                    >
                      <div className="flex items-center gap-2 mb-0.5">
                        <span
                          style={{
                            width: 8, height: 8, borderRadius: '50%', display: 'inline-block',
                            background:
                              h.sentimentScore === null ? '#94a3b8'
                                : h.sentimentScore > 0.3 ? '#16a34a'
                                  : h.sentimentScore < -0.3 ? '#dc2626' : '#6b7280',
                          }}
                        />
                        <span className="text-[11px]" style={{ color: 'var(--ink-5)' }}>
                          {new Date(h.date).toLocaleDateString('en-AE', { day: 'numeric', month: 'short', timeZone: 'Asia/Dubai' })}
                        </span>
                      </div>
                      <div className="text-xs font-semibold" style={{ color: 'var(--ink)' }}>{h.headline}</div>
                    </button>
                    {openHistory === h.id && (
                      <div className="text-xs mt-2 whitespace-pre-line" style={{ color: 'var(--ink-5)' }}>
                        {h.summary}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="glass-card p-4">
            <h3 className="font-bold mb-3 text-sm" style={{ color: 'var(--ink)' }}>Signal Breakdown (7d)</h3>
            {signals.every((s) => s.count === 0) ? (
              <p className="text-xs" style={{ color: 'var(--ink-5)' }}>No analysed articles in the last 7 days.</p>
            ) : (
              <div style={{ height: 190 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={signals} layout="vertical" margin={{ left: 4, right: 12, top: 4, bottom: 4 }}>
                    <XAxis type="number" domain={[0, maxSignal]} hide />
                    <YAxis
                      type="category"
                      dataKey="type"
                      width={92}
                      tick={{ fontSize: 10, fill: '#64748b' }}
                      tickFormatter={(t: string) => signalMeta(t).label}
                    />
                    <Tooltip
                      formatter={(v: number) => [v, 'articles']}
                      labelFormatter={(t: string) => signalMeta(t).label}
                      contentStyle={{ fontSize: 12, borderRadius: 8 }}
                    />
                    <Bar dataKey="count" fill="#2563EB" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </section>

          <section className="glass-card p-4">
            <h3 className="font-bold mb-3 text-sm" style={{ color: 'var(--ink)' }}>Sources</h3>
            {sources && sources.publishers.length > 0 ? (
              <ul className="flex flex-col gap-1.5 mb-3">
                {sources.publishers.map((p) => (
                  <li key={p.name} className="flex items-center justify-between gap-2 text-xs">
                    <span style={{ color: 'var(--ink-4, #475569)' }}>{p.name}</span>
                    <span className="flex items-center gap-1.5">
                      <span style={{ color: 'var(--ink-5)' }}>{p.count}</span>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#16a34a', display: 'inline-block' }} />
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs mb-3" style={{ color: 'var(--ink-5)' }}>No articles stored yet.</p>
            )}
            <p className="text-[11px]" style={{ color: 'var(--ink-5)' }}>
              {sources ? `${sources.feeds.length} feeds configured · ${sources.total} articles stored` : ''}
            </p>
          </section>

          {onSignIn && (
            <section
              className="rounded-xl p-4"
              style={{ background: 'rgba(37,99,235,0.05)', border: '1px solid rgba(37,99,235,0.15)' }}
            >
              <div className="font-semibold text-sm mb-1" style={{ color: 'var(--ink)' }}>
                Get this digest in your inbox daily
              </div>
              <div className="text-xs mb-3" style={{ color: 'var(--ink-5)' }}>
                Free account — market data, alerts and the daily digest.
              </div>
              <button
                onClick={onSignIn}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold"
                style={{ background: '#2563EB', color: '#fff' }}
              >
                Sign up free <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </section>
          )}

          <button
            onClick={() => window.location.reload()}
            className="inline-flex items-center justify-center gap-2 text-xs py-2 rounded-lg"
            style={{ color: 'var(--ink-5)', border: '1px solid var(--gb)' }}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <Activity className="w-3.5 h-3.5" /> Refresh
          </button>
        </aside>
      </div>
    </div>
  )
}
