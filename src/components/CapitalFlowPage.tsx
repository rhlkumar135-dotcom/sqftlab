import { useEffect, useMemo, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { Globe, Lock, TrendingUp, Info } from 'lucide-react'
import { cn } from '@/lib/cn'
import { authedFetch } from '@/lib/session'

/**
 * Cross-Border Capital Flow (Day 9 Task C).
 *
 * The brief's layout, with one structural difference: the empty state is a real
 * screen rather than a chart with no bars. There are no DLD transactions carrying
 * a buyer nationality in this deployment, so the overview returns
 * `insufficientData` and the page states why instead of rendering axes over
 * nothing — which reads as "no one is buying" rather than "not ingested".
 */

interface NationalityRow {
  nationality: string
  count: number
  pct: number
  totalValueAed: number
}

interface FlowResponse {
  scope: string
  area: string | null
  period: string
  totalBuyers: number
  nationalities: NationalityRow[]
  source: string
  sourceNote: string
  methodology?: string
  insufficientData?: boolean
  reason?: string
  error?: string
}

/** Flag for a nationality as DLD spells it. Falls back to a globe, never a guess. */
const FLAGS: Record<string, string> = {
  Indian: '🇮🇳', British: '🇬🇧', Russian: '🇷🇺', Pakistani: '🇵🇰', Chinese: '🇨🇳',
  Emirati: '🇦🇪', Egyptian: '🇪🇬', French: '🇫🇷', German: '🇩🇪', American: '🇺🇸',
  Iranian: '🇮🇷', Turkish: '🇹🇷', Ukrainian: '🇺🇦', Italian: '🇮🇹', Spanish: '🇪🇸',
  Jordanian: '🇯🇴', Lebanese: '🇱🇧', Saudi: '🇸🇦', Filipino: '🇵🇭', Bangladeshi: '🇧🇩',
  Canadian: '🇨🇦', Australian: '🇦🇺', Dutch: '🇳🇱', Swiss: '🇨🇭', Swedish: '🇸🇪',
  Nigerian: '🇳🇬', Kenyan: '🇰🇪', Moroccan: '🇲🇦', Iraqi: '🇮🇶', Syrian: '🇸🇾',
  'South African': '🇿🇦', Unknown: '🏳️',
}
const flagFor = (n: string) => FLAGS[n] ?? '🌍'

const BAR_COLORS = ['#2563EB', '#3B82F6', '#6366F1', '#0EA5E9', '#7C3AED', '#0D9488', '#1D4ED8', '#60A5FA', '#93C5FD', '#CBD5E1']

const aed = (n: number) =>
  n >= 1e9 ? `AED ${(n / 1e9).toFixed(2)}b` : n >= 1e6 ? `AED ${(n / 1e6).toFixed(1)}m` : `AED ${Math.round(n / 1e3)}k`

const TIER_RANK: Record<string, number> = { guest: 0, free: 1, pro: 2, elite: 3, enterprise: 4, institutional: 5 }

export default function CapitalFlowPage({ onNavigate }: { onNavigate: (p: 'pricing') => void }) {
  const [tier, setTier] = useState<string | null>(null)
  const [overview, setOverview] = useState<FlowResponse | null>(null)
  const [areas, setAreas] = useState<Array<{ slug: string; nameEn: string }>>([])
  const [areaSlug, setAreaSlug] = useState('')
  const [areaData, setAreaData] = useState<FlowResponse | null>(null)
  const [areaError, setAreaError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // The area breakdown is the Pro line item; the Dubai overview is included. The
  // server enforces this too — this only decides whether to ask at all.
  const unlocked = tier !== null && (TIER_RANK[tier] ?? 0) >= TIER_RANK.pro

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const me = await authedFetch('/api/sqftlab/me')
        const meBody = (await me.json().catch(() => ({}))) as { user?: { tier?: string | null } | null }
        if (alive) setTier(meBody.user?.tier ?? 'guest')

        const res = await authedFetch('/api/sqftlab/capital-flow/overview')
        const body = (await res.json().catch(() => ({}))) as FlowResponse
        if (!alive) return
        setOverview(res.ok ? body : { ...body, insufficientData: true, reason: body.error ?? `Request failed (${res.status})` })

        const cs = await authedFetch('/api/sqftlab/communities')
        const csBody = (await cs.json().catch(() => ({}))) as { communities?: Array<{ slug: string; nameEn: string }> }
        if (alive && Array.isArray(csBody.communities)) setAreas(csBody.communities.slice(0, 60))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!areaSlug || !unlocked) {
      setAreaData(null)
      setAreaError(null)
      return
    }
    let alive = true
    ;(async () => {
      const res = await authedFetch(`/api/sqftlab/capital-flow/${encodeURIComponent(areaSlug)}`)
      const body = (await res.json().catch(() => ({}))) as FlowResponse
      if (!alive) return
      if (!res.ok) {
        setAreaData(null)
        setAreaError(body.error ?? `Request failed (${res.status})`)
      } else {
        setAreaError(null)
        setAreaData(body)
      }
    })()
    return () => {
      alive = false
    }
  }, [areaSlug, unlocked])

  const chartData = useMemo(
    () => (overview?.nationalities ?? []).slice(0, 10).map((n) => ({ name: n.nationality, pct: n.pct })),
    [overview],
  )

  const active = areaData ?? overview
  const rows = active?.nationalities ?? []

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <div className="flex items-start gap-3 mb-5">
        <div className="rounded-[14px] p-2.5 shrink-0" style={{ background: 'rgba(37,99,235,0.09)' }}>
          <Globe size={20} style={{ color: 'var(--b600)' }} />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight" style={{ color: 'var(--ink)' }}>
            Cross-Border Capital Flow
          </h1>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--ink-4)' }}>
            Who is buying in Dubai — by nationality, area, and quarter
          </p>
        </div>
      </div>

      {loading && (
        <div className="g2 p-5 text-[13px]" style={{ color: 'var(--ink-4)' }}>
          Loading capital-flow data…
        </div>
      )}

      {/* Honest empty state: the register carries no nationality data yet. */}
      {!loading && overview?.insufficientData && (
        <div className="g2 p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <Info size={18} className="shrink-0 mt-0.5" style={{ color: 'var(--warn)' }} />
            <div className="min-w-0">
              <p className="text-[14px] font-medium" style={{ color: 'var(--ink)' }}>
                No nationality data available yet
              </p>
              <p className="text-[13px] mt-1 leading-relaxed" style={{ color: 'var(--ink-4)' }}>
                {overview.reason}
              </p>
              {overview.methodology && (
                <p className="text-[12px] mt-3 leading-relaxed" style={{ color: 'var(--ink-5)' }}>
                  {overview.methodology}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {!loading && overview && !overview.insufficientData && (
        <>
          {/* Dubai overview */}
          <div className="g2 p-4 sm:p-5 mb-5">
            <div className="flex items-baseline justify-between gap-3 flex-wrap mb-1">
              <h2 className="text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>
                Top buyer nationalities
              </h2>
              <span className="text-[12px] mono" style={{ color: 'var(--ink-4)' }}>
                {overview.totalBuyers.toLocaleString()} sales · {overview.period}
              </span>
            </div>
            <p className="text-[12px] mb-4" style={{ color: 'var(--ink-5)' }}>
              Share of all registered DLD sales in the window
            </p>

            <div style={{ height: 260 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 4, right: 8, left: -18, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,0.06)" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 10, fill: 'var(--ink-4)' }} interval={0} angle={-30} textAnchor="end" height={70} />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--ink-4)' }} unit="%" />
                  <Tooltip
                    formatter={(v: number) => [`${v}%`, 'Share of sales']}
                    contentStyle={{ borderRadius: 12, border: '1px solid rgba(15,23,42,0.08)', fontSize: 12 }}
                  />
                  <Bar dataKey="pct" radius={[6, 6, 0, 0]}>
                    {chartData.map((_, i) => (
                      <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            <p className="text-[11px] mt-3" style={{ color: 'var(--ink-5)' }}>
              {overview.sourceNote}
            </p>
          </div>

          {/* Area selector + breakdown */}
          <div className="g2 p-4 sm:p-5">
            <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
              <h2 className="text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>
                Area breakdown
              </h2>
              {unlocked && (
                <select
                  value={areaSlug}
                  onChange={(e) => setAreaSlug(e.target.value)}
                  className="rounded-[10px] px-3 py-2 text-[13px] w-full sm:w-auto"
                  style={{ background: 'var(--g3)', border: '1px solid var(--gb)', color: 'var(--ink)' }}
                >
                  <option value="">All Dubai</option>
                  {areas.map((a) => (
                    <option key={a.slug} value={a.slug}>
                      {a.nameEn}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="relative">
              <div style={!unlocked ? { filter: 'blur(6px)', pointerEvents: 'none', userSelect: 'none' } : undefined}>
                {rows.length === 0 ? (
                  <p className="text-[13px] py-6 text-center" style={{ color: 'var(--ink-4)' }}>
                    {areaError ?? (active?.insufficientData ? active.reason : `No nationality breakdown available for this selection.`)}
                  </p>
                ) : (
                  <div className="space-y-1">
                    {rows.map((n) => (
                      <div
                        key={n.nationality}
                        className="flex items-center gap-3 rounded-[12px] px-3 py-2.5"
                        style={{ background: 'var(--g4)' }}
                      >
                        <span className="text-[17px] leading-none shrink-0">{flagFor(n.nationality)}</span>
                        <span className="text-[13px] font-medium flex-1 min-w-0" style={{ color: 'var(--ink)' }}>
                          {n.nationality}
                        </span>
                        <span className="text-[12px] mono shrink-0" style={{ color: 'var(--ink-4)' }}>
                          {n.count.toLocaleString()}
                        </span>
                        <span className="text-[12px] mono w-14 text-right shrink-0" style={{ color: 'var(--b600)', fontWeight: 600 }}>
                          {n.pct.toFixed(1)}%
                        </span>
                        <span className="text-[12px] mono w-24 text-right shrink-0 hidden sm:inline" style={{ color: 'var(--ink-3)' }}>
                          {aed(n.totalValueAed)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {!unlocked && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="text-center px-4">
                    <Lock size={18} className="mx-auto mb-2" style={{ color: 'var(--b600)' }} />
                    <p className="text-[13px] font-medium" style={{ color: 'var(--ink)' }}>
                      Area breakdown is a Pro feature
                    </p>
                    <button
                      onClick={() => onNavigate('pricing')}
                      className="mt-3 rounded-[10px] px-4 py-2 text-[13px] font-medium text-white"
                      style={{ background: 'var(--b600)' }}
                    >
                      View plans
                    </button>
                  </div>
                </div>
              )}
            </div>

            {active?.methodology && !active.insufficientData && (
              <p className="text-[11px] mt-4 leading-relaxed" style={{ color: 'var(--ink-5)' }}>
                {active.methodology}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}
