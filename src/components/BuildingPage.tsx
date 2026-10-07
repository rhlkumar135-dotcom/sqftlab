import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Building2, Layers, Lock, Info, TrendingUp, TrendingDown } from 'lucide-react'
import { cn } from '@/lib/cn'
import { authedFetch } from '@/lib/session'
import { usePageMeta } from '@/lib/seo'

/**
 * Building scorecard (Day 10 Task C).
 *
 * The brief's layout, using the fields `BuildingProfile` actually has. It asks for
 * `yearBuilt`, `totalUnits`, `managementCo`, `serviceCharge` and
 * `completionStatus` — none of which exist on that model, and none of which any
 * UAE open dataset provides — so the profile card shows the real columns instead:
 * liquidity, days-to-resale, owner-occupier ratio, Ejari density and the PSF trend
 * against the community and district.
 *
 * Floor-range PSF is the Enterprise line item. It is gated server-side, so when it
 * is locked the payload genuinely has no breakdown — the blur below sits over an
 * empty frame rather than over data the caller already holds.
 */

interface FloorRange {
  range: string
  avgPsfAed: number | null
  count: number
}

interface Scorecard {
  buildingName: string
  slug: string
  matched: 'profile' | 'transaction' | 'none'
  community: string | null
  district: string | null
  profile: {
    totalDldUnits: number | null
    intelligenceScore: number | null
    liquidityScore: number | null
    transactionCount12m: number | null
    avgDaysToResale: number | null
    ownerOccupierRatio: number | null
    buyerHoldRate: number | null
    ejariDensity: number | null
    avgContractedRent: number | null
    psfTrend3m: number | null
    psfTrend12m: number | null
    psfVsCommunity: number | null
    psfVsDistrict: number | null
  } | null
  stats: { transactions: number; medianPsfAed: number | null; avgPsfAed: number | null; period: string }
  recentTransactions: Array<{
    date: string
    beds: number
    areaSqft: number
    pricePerSqft: number | null
    priceAed: number
    floorNumber: number | null
  }>
  floorBreakdown: FloorRange[] | null
  floorPremium: { pct: number | null; samples: number | null; r2: number | null } | null
  floorBreakdownLocked: boolean
  methodology: string
  insufficientData?: boolean
  reason?: string
  error?: string
}

const PER_PAGE = 20
const aed = (n: number | null) =>
  n == null ? '—' : n >= 1e6 ? `AED ${(n / 1e6).toFixed(2)}m` : `AED ${Math.round(n / 1e3)}k`
const num = (n: number | null, suffix = '') => (n == null ? '—' : `${n.toLocaleString()}${suffix}`)

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className={cn('g2 p-4')}>
      <p className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-5)' }}>
        {label}
      </p>
      <p className="text-[19px] font-semibold mono mt-1.5" style={{ color: 'var(--ink)' }}>
        {value}
      </p>
      {sub && (
        <p className="text-[11px] mt-0.5" style={{ color: 'var(--ink-5)' }}>
          {sub}
        </p>
      )}
    </div>
  )
}

function ProfileRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="text-[12px]" style={{ color: 'var(--ink-4)' }}>
        {label}
      </span>
      <span className="text-[12px] mono font-medium" style={{ color: 'var(--ink)' }}>
        {value}
      </span>
    </div>
  )
}

export default function BuildingPage({
  slug,
  onNavigate,
  onBack,
}: {
  slug: string | null
  onNavigate: (p: 'pricing') => void
  onBack: () => void
}) {
  const [data, setData] = useState<Scorecard | null>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)

  // Day 15 E1 — title/description for the building deep link. Falls back to the slug
  // while loading, so a cold load is titled before the payload lands rather than
  // inheriting the previous page's title.
  const buildingLabel = data?.buildingName || slug?.replace(/-/g, ' ') || 'Building'
  usePageMeta({
    title: `${buildingLabel} Transactions`,
    description: `${buildingLabel} price history, PSF by floor, and recent DLD transactions.`,
    canonicalPath: slug ? `/buildings/${slug}` : undefined,
  })

  useEffect(() => {
    if (!slug) {
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    ;(async () => {
      const res = await authedFetch(`/api/sqftlab/buildings/${encodeURIComponent(slug)}`)
      const body = (await res.json().catch(() => ({}))) as Scorecard
      if (!alive) return
      setData(res.ok ? body : { ...body, insufficientData: true, reason: body.error ?? `Request failed (${res.status})` })
      setLoading(false)
    })()
    return () => {
      alive = false
    }
  }, [slug])

  useEffect(() => setPage(1), [slug])

  const paged = useMemo(() => {
    const rows = data?.recentTransactions ?? []
    return rows.slice((page - 1) * PER_PAGE, page * PER_PAGE)
  }, [data, page])

  const totalPages = Math.max(1, Math.ceil((data?.recentTransactions.length ?? 0) / PER_PAGE))
  const p = data?.profile ?? null
  const trend = p?.psfVsCommunity ?? null

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <button onClick={onBack} className="flex items-center gap-1.5 text-[13px] mb-4" style={{ color: 'var(--ink-4)' }}>
        <ArrowLeft size={15} /> All buildings
      </button>

      <div className="flex items-start gap-3 mb-5">
        <div className="rounded-[14px] p-2.5 shrink-0" style={{ background: 'rgba(37,99,235,0.09)' }}>
          <Building2 size={20} style={{ color: 'var(--b600)' }} />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight" style={{ color: 'var(--ink)' }}>
            {data?.buildingName ?? slug?.replace(/-/g, ' ') ?? 'Building'}
          </h1>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--ink-4)' }}>
            {[data?.community, data?.district].filter(Boolean).join(' · ') || 'Building scorecard'}
          </p>
        </div>
      </div>

      {loading && (
        <div className="g2 p-5 text-[13px]" style={{ color: 'var(--ink-4)' }}>
          Loading building data…
        </div>
      )}

      {!loading && data?.insufficientData && (
        <div className="g2 p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <Info size={18} className="shrink-0 mt-0.5" style={{ color: 'var(--warn)' }} />
            <div className="min-w-0">
              <p className="text-[14px] font-medium" style={{ color: 'var(--ink)' }}>
                No data for this building
              </p>
              <p className="text-[13px] mt-1 leading-relaxed" style={{ color: 'var(--ink-4)' }}>
                {data.reason}
              </p>
              <p className="text-[12px] mt-3 leading-relaxed" style={{ color: 'var(--ink-5)' }}>
                {data.methodology}
              </p>
            </div>
          </div>
        </div>
      )}

      {!loading && data && !data.insufficientData && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
            <Tile label="Median PSF" value={num(data.stats.medianPsfAed, ' AED')} sub={`${data.stats.period} · ${data.stats.transactions} sales`} />
            <Tile label="Average PSF" value={num(data.stats.avgPsfAed, ' AED')} />
            <Tile label="DLD units" value={num(p?.totalDldUnits ?? null)} />
            <Tile
              label="vs community"
              value={trend == null ? '—' : `${trend > 0 ? '+' : ''}${trend.toFixed(1)}%`}
              sub={trend == null ? undefined : trend > 0 ? 'above community' : 'below community'}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
            {/* Transaction history */}
            <div className="lg:col-span-3 g2 p-4 sm:p-5">
              <h2 className="text-[15px] font-semibold mb-3" style={{ color: 'var(--ink)' }}>
                Transaction history
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr style={{ color: 'var(--ink-5)' }}>
                      <th className="text-left font-medium py-2 pr-3">Date</th>
                      <th className="text-right font-medium py-2 pr-3">Beds</th>
                      <th className="text-right font-medium py-2 pr-3">Size</th>
                      <th className="text-right font-medium py-2 pr-3">PSF</th>
                      <th className="text-right font-medium py-2 pr-3">Total</th>
                      <th className="text-right font-medium py-2">Floor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paged.map((t, i) => (
                      <tr key={`${t.date}-${i}`} style={{ borderTop: '1px solid rgba(15,23,42,0.06)' }}>
                        <td className="py-2 pr-3 mono" style={{ color: 'var(--ink-3)' }}>
                          {t.date}
                        </td>
                        <td className="py-2 pr-3 text-right mono" style={{ color: 'var(--ink-3)' }}>
                          {t.beds}
                        </td>
                        <td className="py-2 pr-3 text-right mono" style={{ color: 'var(--ink-3)' }}>
                          {Math.round(t.areaSqft).toLocaleString()}
                        </td>
                        <td className="py-2 pr-3 text-right mono font-medium" style={{ color: 'var(--b600)' }}>
                          {num(t.pricePerSqft)}
                        </td>
                        <td className="py-2 pr-3 text-right mono" style={{ color: 'var(--ink)' }}>
                          {aed(t.priceAed)}
                        </td>
                        <td className="py-2 text-right mono" style={{ color: 'var(--ink-4)' }}>
                          {t.floorNumber ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {totalPages > 1 && (
                <div className="flex items-center justify-between gap-3 mt-4">
                  <button
                    disabled={page <= 1}
                    onClick={() => setPage((v) => Math.max(1, v - 1))}
                    className="rounded-[10px] px-3 py-1.5 text-[12px] disabled:opacity-40"
                    style={{ background: 'var(--g3)', color: 'var(--ink-3)' }}
                  >
                    Previous
                  </button>
                  <span className="text-[12px] mono" style={{ color: 'var(--ink-4)' }}>
                    {page} / {totalPages}
                  </span>
                  <button
                    disabled={page >= totalPages}
                    onClick={() => setPage((v) => Math.min(totalPages, v + 1))}
                    className="rounded-[10px] px-3 py-1.5 text-[12px] disabled:opacity-40"
                    style={{ background: 'var(--g3)', color: 'var(--ink-3)' }}
                  >
                    Next
                  </button>
                </div>
              )}
            </div>

            {/* Profile */}
            <div className="lg:col-span-2 space-y-5">
              <div className="g2 p-4 sm:p-5">
                <h2 className="text-[15px] font-semibold mb-2" style={{ color: 'var(--ink)' }}>
                  Building profile
                </h2>
                {p ? (
                  <div className="divide-y" style={{ borderColor: 'rgba(15,23,42,0.06)' }}>
                    <ProfileRow label="Total DLD units" value={num(p.totalDldUnits)} />
                    <ProfileRow label="Transactions (12m)" value={num(p.transactionCount12m)} />
                    <ProfileRow label="Liquidity score" value={p.liquidityScore == null ? '—' : p.liquidityScore.toFixed(0)} />
                    <ProfileRow label="Avg days to resale" value={p.avgDaysToResale == null ? '—' : `${p.avgDaysToResale.toFixed(0)} d`} />
                    <ProfileRow
                      label="Owner-occupier"
                      value={p.ownerOccupierRatio == null ? '—' : `${(p.ownerOccupierRatio * 100).toFixed(0)}%`}
                    />
                    <ProfileRow label="Ejari density" value={p.ejariDensity == null ? '—' : p.ejariDensity.toFixed(2)} />
                    <ProfileRow label="Avg contracted rent" value={aed(p.avgContractedRent)} />
                    <ProfileRow
                      label="PSF trend 12m"
                      value={p.psfTrend12m == null ? '—' : `${p.psfTrend12m > 0 ? '+' : ''}${p.psfTrend12m.toFixed(1)}%`}
                    />
                  </div>
                ) : (
                  <p className="text-[13px]" style={{ color: 'var(--ink-4)' }}>
                    No building profile row is available yet — these are computed from the DLD
                    register and appear once it is ingested.
                  </p>
                )}
              </div>

              {p?.intelligenceScore != null && (
                <div className="g2 p-4 sm:p-5">
                  <h2 className="text-[15px] font-semibold mb-1" style={{ color: 'var(--ink)' }}>
                    Building intelligence score
                  </h2>
                  <p className="text-[28px] font-semibold mono" style={{ color: 'var(--b600)' }}>
                    {p.intelligenceScore.toFixed(0)}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Floor breakdown */}
          <div className="g2 p-4 sm:p-5 mt-5">
            <div className="flex items-center gap-2 mb-1">
              <Layers size={16} style={{ color: 'var(--b600)' }} />
              <h2 className="text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>
                PSF by floor range
              </h2>
            </div>
            <p className="text-[12px] mb-4" style={{ color: 'var(--ink-5)' }}>
              Average price per square foot by storey band. Enterprise feature.
            </p>

            <div className="relative">
              <div
                className="grid grid-cols-1 sm:grid-cols-3 gap-3"
                style={data.floorBreakdownLocked ? { filter: 'blur(6px)', pointerEvents: 'none', userSelect: 'none' } : undefined}
              >
                {(data.floorBreakdown ?? [
                  { range: 'Low (1–5)', avgPsfAed: null, count: 0 },
                  { range: 'Mid (6–15)', avgPsfAed: null, count: 0 },
                  { range: 'High (16+)', avgPsfAed: null, count: 0 },
                ]).map((f) => (
                  <div key={f.range} className="rounded-[14px] p-4" style={{ background: 'var(--g4)' }}>
                    <p className="text-[12px] font-medium" style={{ color: 'var(--ink-3)' }}>
                      {f.range}
                    </p>
                    <p className="text-[20px] font-semibold mono mt-1.5" style={{ color: 'var(--ink)' }}>
                      {num(f.avgPsfAed, ' AED')}
                    </p>
                    <p className="text-[11px] mt-0.5" style={{ color: 'var(--ink-5)' }}>
                      {f.count} sale{f.count === 1 ? '' : 's'}
                    </p>
                  </div>
                ))}
              </div>

              {data.floorBreakdownLocked && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="text-center px-4">
                    <Lock size={18} className="mx-auto mb-2" style={{ color: 'var(--b600)' }} />
                    <p className="text-[13px] font-medium" style={{ color: 'var(--ink)' }}>
                      Floor-range PSF is an Enterprise feature
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

            {!data.floorBreakdownLocked && data.floorBreakdown && data.floorBreakdown.every((f) => f.count === 0) && (
              <p className="text-[12px] mt-3" style={{ color: 'var(--ink-4)' }}>
                No floor-level sales in the period, so no band can be priced.
              </p>
            )}

            {data.floorPremium && (data.floorPremium.pct != null || data.floorPremium.samples != null) && (
              <div className="flex items-center gap-2 mt-4">
                {data.floorPremium.pct != null && data.floorPremium.pct > 0 ? (
                  <TrendingUp size={14} style={{ color: 'var(--up)' }} />
                ) : (
                  <TrendingDown size={14} style={{ color: 'var(--ink-4)' }} />
                )}
                <span className="text-[12px]" style={{ color: 'var(--ink-4)' }}>
                  Floor premium {data.floorPremium.pct == null ? '—' : `${data.floorPremium.pct > 0 ? '+' : ''}${data.floorPremium.pct.toFixed(1)}%`}
                  {data.floorPremium.samples != null && ` · ${data.floorPremium.samples} samples`}
                </span>
              </div>
            )}

            <p className="text-[11px] mt-4 leading-relaxed" style={{ color: 'var(--ink-5)' }}>
              {data.methodology}
            </p>
          </div>
        </>
      )}
    </div>
  )
}
