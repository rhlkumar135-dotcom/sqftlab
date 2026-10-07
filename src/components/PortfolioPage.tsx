/**
 * Portfolio valuation dashboard (Day 8 Task C).
 *
 * WHAT THIS SCREEN MUST NOT DO
 *
 * It must never print a number where no valuation exists. The API reports
 * `currentValue: null` and `isValued: false` for a holding that has not been valued,
 * and this screen renders "Not yet valued" for it — including in the totals, where a
 * holding is excluded rather than counted as worth what it cost. The version of this
 * screen that shipped before used `currentValue ?? purchasePrice` and summed every row,
 * which turned three seeded holdings with no transactions behind them into
 * AED 10,941,214 of market value and a confident P&L.
 *
 * The denial state is rendered by the host through `renderDenied` rather than
 * reimplemented here: App.tsx keeps one denial component so screens cannot drift into
 * showing data when the API refused them.
 */

import { useCallback, useEffect, useState } from 'react'
import { Briefcase, Loader2, Plus, Trash2, TrendingDown, TrendingUp, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/cn'
import { authedFetch } from '@/lib/session'
import { EmptyState } from '@/components/EmptyState'
import { SkeletonCardGrid } from '@/components/Skeleton'

interface PortfolioItem {
  id: string
  title: string
  buildingName: string | null
  propertyType: string
  beds: number
  areaSqft: number
  floor: number | null
  unitNumber: string | null
  purchasePrice: number
  purchaseDate: string
  purchasePsf: number | null
  currentValue: number | null
  currentPsf: number | null
  valuedAt: string | null
  valuationComps: number | null
  isValued: boolean
  gainAed: number | null
  gainPct: number | null
  community: { nameEn: string; slug: string }
}

interface PortfolioSummary {
  count: number
  valuedCount: number
  unvaluedCount: number
  totalPurchaseAed: number
  totalCurrentAed: number
  totalGainAed: number | null
  totalGainPct: number | null
  valuedPurchaseAed: number
  totalPropertyCount: number
}

interface PortfolioResponse {
  items: PortfolioItem[]
  summary: PortfolioSummary
  limit?: number
  atLimit?: boolean
  limited?: boolean
  totalCount?: number
  message?: string
}

interface CommunityOption {
  slug: string
  nameEn: string
}

export interface PortfolioPageProps {
  setPage: (p: 'pricing' | 'signin') => void
  /** Host-supplied denial state, so every gated screen refuses identically. */
  renderDenied: (status: number | null, onRetry: () => void) => React.ReactNode
  /** Host-supplied money formatter (the app has a currency switcher). */
  formatMoney: (value: number) => string
}

const EMPTY_FORM = {
  communitySlug: '',
  buildingName: '',
  beds: '1',
  areaSqft: '',
  floor: '',
  unitNumber: '',
  purchasePrice: '',
  purchaseDate: '',
}

function dataFont(): React.CSSProperties {
  return { fontFamily: 'var(--font-data)' }
}

function cardStyle(): React.CSSProperties {
  return { background: 'var(--g2)', border: '1px solid var(--gb)', boxShadow: 'var(--sh-card)' }
}

function formatDay(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function PortfolioPage({ setPage, renderDenied, formatMoney }: PortfolioPageProps) {
  const [items, setItems] = useState<PortfolioItem[]>([])
  const [summary, setSummary] = useState<PortfolioSummary | null>(null)
  const [meta, setMeta] = useState<Pick<PortfolioResponse, 'limit' | 'atLimit' | 'limited' | 'totalCount' | 'message'>>({})
  const [status, setStatus] = useState<number | null>(200)
  const [loading, setLoading] = useState(true)

  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState({ ...EMPTY_FORM })
  const [communities, setCommunities] = useState<CommunityOption[]>([])
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [formNotice, setFormNotice] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await authedFetch('/api/sqftlab/portfolio')
      setStatus(res.status)
      if (!res.ok) {
        setItems([])
        setSummary(null)
        return
      }
      const body = (await res.json()) as PortfolioResponse
      setItems(body.items ?? [])
      setSummary(body.summary ?? null)
      setMeta({
        limit: body.limit,
        atLimit: body.atLimit,
        limited: body.limited,
        totalCount: body.totalCount,
        message: body.message,
      })
    } catch {
      // A transport failure is not a denial; null means "the API did not answer".
      setStatus(null)
      setItems([])
      setSummary(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    // Loaded lazily, once the form is first opened — the dashboard itself does not need
    // the district list, and it is a large payload.
    if (!formOpen || communities.length > 0) return
    authedFetch('/api/sqftlab/communities')
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { communities?: CommunityOption[] } | null) => {
        setCommunities((b?.communities ?? []).map((c) => ({ slug: c.slug, nameEn: c.nameEn })))
      })
      .catch(() => undefined)
  }, [formOpen, communities.length])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setFormError(null)
    setFormNotice(null)

    const beds = Number(form.beds)
    const areaSqft = Number(form.areaSqft)
    const purchasePrice = Number(form.purchasePrice)

    if (!form.communitySlug) return setFormError('Choose a district.')
    if (!Number.isFinite(areaSqft) || areaSqft <= 0) return setFormError('Enter the size in sqft.')
    if (!Number.isFinite(purchasePrice) || purchasePrice <= 0) return setFormError('Enter the purchase price in AED.')

    setSaving(true)
    try {
      const res = await authedFetch('/api/sqftlab/portfolio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          communitySlug: form.communitySlug,
          buildingName: form.buildingName.trim() || undefined,
          title: form.buildingName.trim() || undefined,
          beds: Number.isFinite(beds) ? beds : 0,
          areaSqft,
          floor: form.floor === '' ? undefined : Number(form.floor),
          unitNumber: form.unitNumber.trim() || undefined,
          purchasePrice,
          purchaseDate: form.purchaseDate || undefined,
        }),
      })

      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) {
        // The route's own explanation, including the 403 that names the plan limit.
        setFormError(String(body.message ?? body.error ?? `Could not save (HTTP ${res.status})`))
        return
      }

      if (typeof body.message === 'string') {
        // Saved, but with no valuation behind it. Closing the form silently would imply
        // a market value that does not exist, so the reason stays on screen.
        setFormNotice(body.message)
        setForm({ ...EMPTY_FORM })
        await load()
        return
      }

      setFormOpen(false)
      setForm({ ...EMPTY_FORM })
      await load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not reach the server.')
    } finally {
      setSaving(false)
    }
  }

  async function remove(id: string) {
    setRowError(null)
    try {
      const res = await authedFetch(`/api/sqftlab/portfolio/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
        setRowError({ id, message: String(body.error ?? `Could not remove (HTTP ${res.status})`) })
        return
      }
      setConfirmRemove(null)
      await load()
    } catch (err) {
      setRowError({ id, message: err instanceof Error ? err.message : 'Could not reach the server.' })
    }
  }

  if (loading) {
    return (
      <div className="max-w-[1280px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <h2 className="text-2xl font-bold mb-6" style={{ color: 'var(--ink)' }}>Portfolio</h2>
        <SkeletonCardGrid count={4} label="Loading portfolio" />
      </div>
    )
  }

  if (status !== 200) {
    return (
      <div className="max-w-[1280px] mx-auto px-4 sm:px-6 py-6">
        <h2 className="text-2xl font-bold mb-6" style={{ color: 'var(--ink)' }}>Portfolio</h2>
        {renderDenied(status, () => void load())}
      </div>
    )
  }

  const s = summary
  const gainKnown = s?.totalGainAed !== null && s?.totalGainAed !== undefined
  const gainPositive = (s?.totalGainAed ?? 0) >= 0

  const tiles = [
    {
      label: 'Total Portfolio Value',
      value: s && s.valuedCount > 0 ? formatMoney(s.totalCurrentAed) : 'Not yet valued',
      muted: !s || s.valuedCount === 0,
      sub: s ? `${s.valuedCount} of ${s.count} valued` : '',
      color: 'var(--ink)',
    },
    { label: 'Total Purchase Price', value: s ? formatMoney(s.totalPurchaseAed) : '—', muted: false, sub: '', color: 'var(--ink)' },
    {
      label: 'Total Gain / Loss',
      // An unknown gain is not a gain of zero. Rendering 0 here would state that a
      // portfolio nobody has valued is exactly break-even.
      value: gainKnown ? `${gainPositive ? '+' : ''}${formatMoney(s!.totalGainAed!)}` : 'Unknown',
      muted: !gainKnown,
      sub: gainKnown && s?.totalGainPct !== null && s?.totalGainPct !== undefined ? `${gainPositive ? '+' : ''}${s.totalGainPct}%` : 'No valuations yet',
      color: !gainKnown ? 'var(--ink-5)' : gainPositive ? 'var(--up)' : 'var(--down)',
    },
    { label: 'Properties', value: String(s?.count ?? 0), muted: false, sub: s && s.unvaluedCount > 0 ? `${s.unvaluedCount} awaiting valuation` : 'All valued', color: 'var(--ink)' },
  ]

  return (
    <div className="max-w-[1280px] mx-auto px-4 sm:px-6 py-6">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
        <div>
          <h2 className="text-2xl font-bold" style={{ color: 'var(--ink)' }}>Portfolio</h2>
          <p className="text-sm mt-1" style={{ color: 'var(--ink-4)' }}>
            Holdings valued from recorded comparable sales. Renewed nightly.
          </p>
        </div>
        <button
          onClick={() => { setFormOpen((v) => !v); setFormError(null); setFormNotice(null) }}
          className="inline-flex h-10 items-center gap-2 rounded-full px-5 text-sm font-semibold"
          style={{ background: 'var(--b600)', color: '#fff' }}
        >
          {formOpen ? <X size={15} /> : <Plus size={15} />}
          {formOpen ? 'Close' : 'Add property'}
        </button>
      </div>

      {meta.atLimit && (
        <div className="mb-5 rounded-[14px] px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-2"
          style={{ background: 'var(--warn-bg, var(--b600)14)', border: '1px solid var(--gb)' }}>
          <span className="text-sm font-semibold" style={{ ...dataFont(), color: 'var(--ink)' }}>
            {meta.totalCount ?? 0}/{meta.limit} properties
          </span>
          <span className="text-sm" style={{ color: 'var(--ink-3)' }}>
            {meta.message ?? `Your plan tracks up to ${meta.limit} properties.`}
          </span>
          <button onClick={() => setPage('pricing')} className="text-sm font-semibold underline" style={{ color: 'var(--b600)' }}>
            Upgrade for unlimited
          </button>
        </div>
      )}

      {formOpen && (
        <form onSubmit={submit} className="mb-6 rounded-[18px] p-4 sm:p-5" style={cardStyle()}>
          <h3 className="font-semibold mb-4" style={{ color: 'var(--ink)' }}>Add a property</h3>

          {formError && (
            <p className="mb-3 text-sm rounded-xl px-3 py-2" style={{ background: 'var(--down-bg)', color: 'var(--down)' }}>{formError}</p>
          )}
          {formNotice && (
            <p className="mb-3 text-sm rounded-xl px-3 py-2" style={{ background: 'var(--up-bg)', color: 'var(--up)' }}>{formNotice}</p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="sm:col-span-2 lg:col-span-3">
              <Label htmlFor="pf-community">District</Label>
              <Select value={form.communitySlug} onValueChange={(v) => setForm((f) => ({ ...f, communitySlug: v }))}>
                <SelectTrigger id="pf-community" className="mt-1">
                  <SelectValue placeholder="Choose a district" />
                </SelectTrigger>
                <SelectContent>
                  {communities.map((c) => (
                    <SelectItem key={c.slug} value={c.slug}>{c.nameEn}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="sm:col-span-2">
              <Label htmlFor="pf-building">Building</Label>
              <Input id="pf-building" className="mt-1" placeholder="e.g. Marina Gate 2"
                value={form.buildingName} onChange={(e) => setForm((f) => ({ ...f, buildingName: e.target.value }))} />
            </div>

            <div>
              <Label htmlFor="pf-beds">Bedrooms</Label>
              <Select value={form.beds} onValueChange={(v) => setForm((f) => ({ ...f, beds: v }))}>
                <SelectTrigger id="pf-beds" className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['0', '1', '2', '3', '4', '5'].map((b) => (
                    <SelectItem key={b} value={b}>{b === '0' ? 'Studio' : `${b} BR`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label htmlFor="pf-size">Size (sqft)</Label>
              <Input id="pf-size" className="mt-1" type="number" min="1" inputMode="numeric"
                value={form.areaSqft} onChange={(e) => setForm((f) => ({ ...f, areaSqft: e.target.value }))} />
            </div>

            <div>
              <Label htmlFor="pf-floor">Floor</Label>
              <Input id="pf-floor" className="mt-1" type="number" inputMode="numeric" placeholder="optional"
                value={form.floor} onChange={(e) => setForm((f) => ({ ...f, floor: e.target.value }))} />
            </div>

            <div>
              <Label htmlFor="pf-unit">Unit</Label>
              <Input id="pf-unit" className="mt-1" placeholder="optional"
                value={form.unitNumber} onChange={(e) => setForm((f) => ({ ...f, unitNumber: e.target.value }))} />
            </div>

            <div>
              <Label htmlFor="pf-price">Purchase price (AED)</Label>
              <Input id="pf-price" className="mt-1" type="number" min="1" inputMode="numeric"
                value={form.purchasePrice} onChange={(e) => setForm((f) => ({ ...f, purchasePrice: e.target.value }))} />
            </div>

            <div>
              <Label htmlFor="pf-date">Purchase date</Label>
              <Input id="pf-date" className="mt-1" type="date"
                value={form.purchaseDate} onChange={(e) => setForm((f) => ({ ...f, purchaseDate: e.target.value }))} />
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button type="submit" disabled={saving}
              className={cn('inline-flex h-10 items-center gap-2 rounded-full px-5 text-sm font-semibold', saving && 'opacity-60 cursor-not-allowed')}
              style={{ background: 'var(--b600)', color: '#fff' }}>
              {saving && <Loader2 size={15} className="animate-spin" />}
              {saving ? 'Saving…' : 'Save property'}
            </button>
            <span className="text-xs" style={{ color: 'var(--ink-5)' }}>
              Value comes from comparable sales — a property with no comparables is saved as “not yet valued”.
            </span>
          </div>
        </form>
      )}

      {items.length === 0 ? (
        <EmptyState
          icon={<Briefcase size={40} />}
          title="No properties tracked"
          body="Add your first property to see its current DLD market value against what you paid."
          action={{ label: '+ Add Property', onClick: () => setFormOpen(true) }}
        />
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            {tiles.map((t) => (
              <div key={t.label} className="p-4 rounded-[18px]" style={cardStyle()}>
                <div className="text-xs mb-1" style={{ color: 'var(--ink-5)' }}>{t.label}</div>
                <div className={cn('font-bold', t.muted ? 'text-base' : 'text-xl')} style={{ ...dataFont(), color: t.color }}>{t.value}</div>
                {t.sub && <div className="text-xs mt-1" style={{ color: 'var(--ink-5)' }}>{t.sub}</div>}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {items.map((item) => {
              const up = (item.gainAed ?? 0) >= 0
              return (
                <div key={item.id} className="p-5 rounded-[18px]" style={cardStyle()}>
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="min-w-0">
                      <div className="font-semibold" style={{ color: 'var(--ink)' }}>
                        {item.title || item.buildingName || 'Untitled holding'}
                      </div>
                      <div className="text-xs mt-0.5" style={{ color: 'var(--b600)' }}>
                        {item.community.nameEn} · {item.beds === 0 ? 'Studio' : `${item.beds} BR`} · {item.areaSqft.toLocaleString()} sqft
                        {item.floor !== null ? ` · Floor ${item.floor}` : ''}
                        {item.unitNumber ? ` · Unit ${item.unitNumber}` : ''}
                      </div>
                    </div>
                    <button
                      onClick={() => setConfirmRemove(item.id === confirmRemove ? null : item.id)}
                      className="shrink-0 inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold"
                      style={{ background: 'var(--g3, rgba(0,0,0,0.04))', color: 'var(--ink-4)' }}
                      aria-label={`Remove ${item.title}`}>
                      <Trash2 size={13} /> Remove
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                      <div className="text-[11px]" style={{ color: 'var(--ink-5)' }}>Purchase</div>
                      <div className="font-semibold text-sm" style={dataFont()}>{formatMoney(item.purchasePrice)}</div>
                      <div className="text-[11px]" style={{ color: 'var(--ink-5)' }}>{formatDay(item.purchaseDate)}</div>
                    </div>
                    <div>
                      <div className="text-[11px]" style={{ color: 'var(--ink-5)' }}>Current market value</div>
                      {item.isValued ? (
                        <>
                          <div className="font-semibold text-sm" style={dataFont()}>{formatMoney(item.currentValue!)}</div>
                          <div className="text-[11px]" style={{ color: 'var(--ink-5)' }}>
                            Valued {formatDay(item.valuedAt)} · {item.valuationComps ?? 0} comps
                          </div>
                        </>
                      ) : (
                        <>
                          {/* Not a number, and not the purchase price dressed up as one. */}
                          <div className="font-semibold text-sm" style={{ color: 'var(--ink-5)' }}>Not yet valued</div>
                          <div className="text-[11px]" style={{ color: 'var(--ink-5)' }}>
                            No comparable sales for this unit yet
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  {item.isValued && item.gainAed !== null && (
                    <div className="inline-flex items-center gap-1.5 text-sm font-semibold"
                      style={{ ...dataFont(), color: up ? 'var(--up)' : 'var(--down)' }}>
                      {up ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                      {up ? '+' : ''}{formatMoney(item.gainAed)}
                      {item.gainPct !== null && <span>({up ? '+' : ''}{item.gainPct}%)</span>}
                    </div>
                  )}

                  {rowError?.id === item.id && (
                    <p className="mt-2 text-xs" style={{ color: 'var(--down)' }}>{rowError.message}</p>
                  )}

                  {confirmRemove === item.id && (
                    <div className="mt-3 flex items-center gap-3 rounded-xl px-3 py-2" style={{ background: 'var(--down-bg)' }}>
                      <span className="text-xs" style={{ color: 'var(--down)' }}>Remove this property?</span>
                      <button onClick={() => void remove(item.id)} className="text-xs font-semibold underline" style={{ color: 'var(--down)' }}>Yes, remove</button>
                      <button onClick={() => setConfirmRemove(null)} className="text-xs font-semibold" style={{ color: 'var(--ink-4)' }}>Cancel</button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
