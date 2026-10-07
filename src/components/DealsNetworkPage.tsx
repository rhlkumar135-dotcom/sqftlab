import { useCallback, useEffect, useState } from 'react'
import {
  Network, Plus, ArrowRight, Lock, AlertTriangle, Loader2, Building2, BedDouble, Inbox,
} from 'lucide-react'
import { authedFetch } from '@/lib/session'
import { usePageMeta } from '@/lib/seo'
import { EmptyState } from '@/components/EmptyState'
import { SkeletonRows } from '@/components/Skeleton'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectTrigger, SelectContent, SelectItem } from '@/components/ui/select'

/**
 * Deal Origination Network (Day 16 Task C).
 *
 * A private, enterprise-only deal-sharing layer. Three notes on how this differs
 * from the brief, all of them because the brief assumes things this codebase
 * does not have:
 *
 *  · The brief puts the page at `/deals` and the API at `/sqftlab/deals`. The API
 *    path was already the Day 8 market scan, so the network's routes live under
 *    `/sqftlab/deal-briefs` (see the note in custom-routes.ts). The PAGE is at
 *    `/deals` as asked — that URL was unclaimed.
 *  · The brief's "DLD context" line is the headline feature and cannot work in
 *    this deployment: the transaction register is empty, so `dldAvgPsfAed` is
 *    null for every brief. The card states the absence and shows the area's
 *    listing-derived median beside it, labelled with its provenance, rather than
 *    printing a market level that was invented to fill the gap.
 *  · The gate is driven by the SERVER's 403 (with `requiredTier`), not by a tier
 *    string the client guessed. `elite` is below `enterprise` here, so the demo
 *    account genuinely sees this screen.
 */

export const DEAL_TYPES = ['acquisition', 'off-plan', 'portfolio-sale', 'distressed'] as const
export type DealType = (typeof DEAL_TYPES)[number]

const TYPE_META: Record<string, { label: string; color: string; bg: string }> = {
  acquisition: { label: 'Acquisition', color: 'var(--b700)', bg: 'rgba(37,99,235,0.10)' },
  'off-plan': { label: 'Off-plan', color: 'var(--up)', bg: 'var(--up-bg)' },
  'portfolio-sale': { label: 'Portfolio sale', color: 'var(--violet)', bg: 'rgba(124,58,237,0.10)' },
  distressed: { label: 'Distressed', color: 'var(--down)', bg: 'var(--down-bg)' },
}

const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  active: { label: 'Active', color: 'var(--b700)', bg: 'rgba(37,99,235,0.10)' },
  'under-offer': { label: 'Under offer', color: 'var(--warn)', bg: 'var(--warn-bg)' },
  closed: { label: 'Closed', color: 'var(--ink-4)', bg: 'rgba(100,116,139,0.12)' },
}

interface MarketContext {
  communityName: string | null
  medianAedSqft: number | null
  source: string | null
  matched: boolean
}

export interface DealBrief {
  id: string
  title: string
  community: string
  bedrooms: number | null
  sizeSqftMin: number | null
  sizeSqftMax: number | null
  askingPriceAed: number | null
  targetYieldPct: number | null
  dealType: string
  description: string
  isConfidential: boolean
  status: string
  dldAvgPsfAed: number | null
  dldTransCount: number | null
  createdAt: string
  user?: { name: string | null; company: string | null }
  _count?: { expressions: number }
  marketContext?: MarketContext
}

export function aed(n: number | null | undefined): string {
  if (n == null) return '—'
  return new Intl.NumberFormat('en-AE', { maximumFractionDigits: 0 }).format(n)
}

/** "DLD avg: AED 1,890/sqft · 12 transactions (90d)" — or the reason it is blank. */
export function DldContextLine({ deal }: { deal: DealBrief }) {
  const ctx = deal.marketContext
  return (
    <div className="space-y-1">
      <div className="text-[11px] leading-relaxed" style={{ color: 'var(--ink-4)' }}>
        {deal.dldAvgPsfAed != null ? (
          <>
            DLD avg: AED <span className="mono">{aed(deal.dldAvgPsfAed)}</span>/sqft ·{' '}
            <span className="mono">{deal.dldTransCount ?? 0}</span> transactions (90d)
          </>
        ) : (
          <>
            DLD avg: <span style={{ color: 'var(--warn)' }}>no registered transactions</span>
            {ctx?.matched ? (
              <>
                {' '}in {ctx.communityName}
              </>
            ) : null}
          </>
        )}
      </div>
      {ctx?.medianAedSqft != null && (
        <div className="text-[11px]" style={{ color: 'var(--ink-5)' }}>
          Area median AED <span className="mono">{aed(ctx.medianAedSqft)}</span>/sqft ·{' '}
          <span title={ctx.source === 'dld' ? 'Derived from the DLD register' : 'Derived from asking prices, not the DLD register'}>
            {ctx.source === 'dld' ? 'DLD-derived' : 'listing-derived'}
          </span>
        </div>
      )}
    </div>
  )
}

export function TypeBadge({ type }: { type: string }) {
  const meta = TYPE_META[type] ?? { label: type, color: 'var(--ink-4)', bg: 'var(--g4)' }
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-[3px] text-[10px] font-semibold uppercase tracking-wide"
      style={{ color: meta.color, background: meta.bg }}
    >
      {meta.label}
    </span>
  )
}

export default function DealsNetworkPage({
  onOpenDeal,
  onNavigate,
}: {
  onOpenDeal: (id: string) => void
  onNavigate: (page: 'pricing' | 'signin') => void
}) {
  usePageMeta({
    title: 'Deal Origination Network',
    description:
      'Private deal-sharing for institutional investors and major brokerages. Post off-market opportunities and express interest, with sqftLab market context attached.',
    canonicalPath: '/deals',
  })

  const [deals, setDeals] = useState<DealBrief[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Populated only from a server 403, so the gate reflects what the API will do.
  const [gate, setGate] = useState<{ currentTier: string; requiredTier: string } | null>(null)

  const [typeFilter, setTypeFilter] = useState('all')
  const [communityFilter, setCommunityFilter] = useState('')
  const [appliedCommunity, setAppliedCommunity] = useState('')

  const [postOpen, setPostOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams()
      if (typeFilter !== 'all') qs.set('dealType', typeFilter)
      if (appliedCommunity) qs.set('community', appliedCommunity)
      const res = await authedFetch(`/api/sqftlab/deal-briefs?${qs.toString()}`)
      const body = (await res.json().catch(() => ({}))) as {
        deals?: DealBrief[]
        error?: string
        currentTier?: string
        requiredTier?: string
      }
      if (res.status === 403) {
        setGate({ currentTier: body.currentTier ?? 'guest', requiredTier: body.requiredTier ?? 'enterprise' })
        setDeals([])
        return
      }
      if (!res.ok) {
        // Surface the server's own message — a generic "failed to load" would hide
        // exactly the detail needed to tell a plan problem from a broken deploy.
        setError(body.error ?? `Request failed (${res.status})`)
        return
      }
      setGate(null)
      setDeals(Array.isArray(body.deals) ? body.deals : [])
    } catch {
      setError('Could not reach the API.')
    } finally {
      setLoading(false)
    }
  }, [typeFilter, appliedCommunity])

  useEffect(() => {
    void load()
  }, [load])

  if (gate) {
    return (
      <div className="max-w-[720px] mx-auto px-4 sm:px-6 py-10">
        <div className="g2 p-6 sm:p-8 text-center">
          <div
            className="mx-auto w-12 h-12 rounded-[14px] flex items-center justify-center mb-4"
            style={{ background: 'rgba(37,99,235,0.09)' }}
          >
            <Lock size={22} style={{ color: 'var(--b600)' }} />
          </div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight" style={{ color: 'var(--ink)' }}>
            Deal Origination Network
          </h1>
          <p className="text-[13px] sm:text-[14px] mt-2 leading-relaxed" style={{ color: 'var(--ink-4)' }}>
            This network is exclusive to Enterprise and Institutional members. Share and discover
            off-market property deals with verified counterparties.
          </p>
          <p className="text-[12px] mt-3" style={{ color: 'var(--ink-5)' }}>
            Your current plan is <strong style={{ color: 'var(--ink-3)' }}>{gate.currentTier}</strong>; this
            feature requires <strong style={{ color: 'var(--ink-3)' }}>{gate.requiredTier}</strong>.
          </p>
          <button
            onClick={() => onNavigate('pricing')}
            className="mt-5 inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-semibold"
            style={{ background: 'linear-gradient(90deg,#2563EB,#6366F1)', color: '#fff', boxShadow: 'var(--sh-btn)' }}
          >
            Upgrade to Enterprise <ArrowRight size={15} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-5">
        <div className="flex items-start gap-3">
          <div className="rounded-[14px] p-2.5 shrink-0" style={{ background: 'rgba(37,99,235,0.09)' }}>
            <Network size={20} style={{ color: 'var(--b600)' }} />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight" style={{ color: 'var(--ink)' }}>
              Deal Origination Network
            </h1>
            <p className="text-[13px] mt-0.5" style={{ color: 'var(--ink-4)' }}>
              Private deal-sharing for institutional investors and major brokerages
            </p>
          </div>
        </div>
        <button
          onClick={() => setPostOpen(true)}
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-full text-[13px] font-semibold shrink-0"
          style={{ background: 'linear-gradient(90deg,#2563EB,#6366F1)', color: '#fff', boxShadow: 'var(--sh-btn)' }}
        >
          <Plus size={15} /> Post a Deal
        </button>
      </div>

      <div className="g2 p-4 sm:p-5 mb-5">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="sm:w-[220px] shrink-0">
            <Label className="text-[11px] mb-1.5 block" style={{ color: 'var(--ink-4)' }}>
              Deal type
            </Label>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              {/* SelectTrigger renders only what you give it — SelectValue would print
                  the raw slug ("portfolio-sale"), so the label is written here. */}
              <SelectTrigger aria-label="Filter by deal type">
                <span>{typeFilter === 'all' ? 'All types' : (TYPE_META[typeFilter]?.label ?? typeFilter)}</span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {DEAL_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TYPE_META[t]?.label ?? t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1">
            <Label htmlFor="deal-community-filter" className="text-[11px] mb-1.5 block" style={{ color: 'var(--ink-4)' }}>
              Community
            </Label>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                setAppliedCommunity(communityFilter.trim())
              }}
            >
              <Input
                id="deal-community-filter"
                value={communityFilter}
                onChange={(e) => setCommunityFilter(e.target.value)}
                placeholder="e.g. Dubai Marina"
              />
              <button
                type="submit"
                className="px-4 rounded-md text-[13px] font-medium shrink-0"
                style={{ background: 'var(--g3)', border: '1px solid var(--gb)', color: 'var(--ink-3)' }}
              >
                Filter
              </button>
            </form>
          </div>
        </div>
      </div>

      {loading && <SkeletonRows rows={4} />}

      {!loading && error && (
        <div className="g2 p-4 flex items-start gap-2.5">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" style={{ color: 'var(--down)' }} />
          <p className="text-[13px]" style={{ color: 'var(--ink-3)' }}>
            {error}
          </p>
        </div>
      )}

      {!loading && !error && deals.length === 0 && (
        <EmptyState
          icon={<Inbox size={40} />}
          title="No deal briefs yet"
          body={
            appliedCommunity || typeFilter !== 'all'
              ? 'Nothing matches these filters. Clear them to see the whole network.'
              : 'The network is private, so it starts empty. Post the first brief and other enterprise members can express interest.'
          }
        />
      )}

      {!loading && !error && deals.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {deals.map((d) => (
            <button
              key={d.id}
              onClick={() => onOpenDeal(d.id)}
              className="g2 p-4 sm:p-5 text-left flex flex-col gap-3 transition-shadow hover:shadow-[var(--sh-lift)]"
              style={{ borderRadius: 'var(--r)' }}
            >
              <div className="flex items-center justify-between gap-2">
                <TypeBadge type={d.dealType} />
                <span
                  className="text-[10px] font-semibold uppercase tracking-wide"
                  style={{ color: STATUS_META[d.status]?.color ?? 'var(--ink-4)' }}
                >
                  {STATUS_META[d.status]?.label ?? d.status}
                </span>
              </div>

              <div>
                <h2 className="text-[15px] font-semibold leading-snug" style={{ color: 'var(--ink)' }}>
                  {d.title}
                </h2>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-[12px]" style={{ color: 'var(--ink-4)' }}>
                  <span className="inline-flex items-center gap-1">
                    <Building2 size={12} /> {d.community}
                  </span>
                  {d.bedrooms != null && (
                    <span className="inline-flex items-center gap-1">
                      <BedDouble size={12} /> {d.bedrooms} bed
                    </span>
                  )}
                </div>
              </div>

              <div className="mono text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>
                {d.askingPriceAed != null ? <>AED {aed(d.askingPriceAed)}</> : <span style={{ color: 'var(--ink-5)', fontSize: 13 }}>Price on request</span>}
              </div>

              <DldContextLine deal={d} />

              <div className="flex items-center justify-between gap-2 pt-2 mt-auto" style={{ borderTop: '1px solid var(--gb)' }}>
                <span className="text-[11px]" style={{ color: 'var(--ink-5)' }}>
                  {d.user?.name ?? 'A member'}
                  {d.user?.company ? ` · ${d.user.company}` : ''}
                </span>
                <span className="text-[11px] shrink-0" style={{ color: 'var(--b600)' }}>
                  {d._count?.expressions ?? 0} interested
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      <PostDealDialog
        open={postOpen}
        onOpenChange={setPostOpen}
        onPosted={() => {
          setPostOpen(false)
          void load()
        }}
      />
    </div>
  )
}

function PostDealDialog({
  open,
  onOpenChange,
  onPosted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPosted: () => void
}) {
  const [title, setTitle] = useState('')
  const [community, setCommunity] = useState('')
  const [dealType, setDealType] = useState<string>('acquisition')
  const [bedrooms, setBedrooms] = useState('')
  const [sizeMin, setSizeMin] = useState('')
  const [sizeMax, setSizeMax] = useState('')
  const [price, setPrice] = useState('')
  const [yieldPct, setYieldPct] = useState('')
  const [description, setDescription] = useState('')
  const [confidential, setConfidential] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setTitle(''); setCommunity(''); setDealType('acquisition'); setBedrooms('')
    setSizeMin(''); setSizeMax(''); setPrice(''); setYieldPct(''); setDescription('')
    setConfidential(true); setError(null)
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const num = (v: string) => (v.trim() === '' ? null : Number(v))
      const payload: Record<string, unknown> = {
        title: title.trim(),
        community: community.trim(),
        dealType,
        description: description.trim(),
        isConfidential: confidential,
      }
      // Empty strings must be omitted, not sent as null: the API treats an explicit
      // null as "no value" but a "" as an out-of-range number.
      for (const [key, val] of [
        ['bedrooms', num(bedrooms)],
        ['sizeSqftMin', num(sizeMin)],
        ['sizeSqftMax', num(sizeMax)],
        ['askingPriceAed', num(price)],
        ['targetYieldPct', num(yieldPct)],
      ] as const) {
        if (val != null) payload[key] = val
      }

      const res = await authedFetch('/api/sqftlab/deal-briefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string; communityMatched?: boolean }
      if (!res.ok) {
        setError(body.error ?? `Could not post the deal (${res.status}).`)
        return
      }
      reset()
      onPosted()
    } catch {
      setError('Could not reach the API.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) reset()
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Post a deal brief</DialogTitle>
          <DialogDescription>
            Visible to Enterprise and Institutional members only. sqftLab attaches the latest market
            context for the community you name.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label htmlFor="deal-title">Title</Label>
            <Input id="deal-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Marina tower floor, off-market" />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="deal-community">Community</Label>
              <Input id="deal-community" value={community} onChange={(e) => setCommunity(e.target.value)} placeholder="Dubai Marina" />
            </div>
            <div>
              <Label>Deal type</Label>
              <Select value={dealType} onValueChange={setDealType}>
                <SelectTrigger aria-label="Deal type">
                  <span>{TYPE_META[dealType]?.label ?? dealType}</span>
                </SelectTrigger>
                <SelectContent>
                  {DEAL_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {TYPE_META[t]?.label ?? t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <Label htmlFor="deal-beds">Bedrooms</Label>
              <Input id="deal-beds" type="number" min={0} value={bedrooms} onChange={(e) => setBedrooms(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="deal-sizemin">Size min (sqft)</Label>
              <Input id="deal-sizemin" type="number" min={0} value={sizeMin} onChange={(e) => setSizeMin(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="deal-sizemax">Size max (sqft)</Label>
              <Input id="deal-sizemax" type="number" min={0} value={sizeMax} onChange={(e) => setSizeMax(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="deal-price">Asking price (AED)</Label>
              <Input id="deal-price" type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="deal-yield">Target yield (%)</Label>
              <Input id="deal-yield" type="number" min={0} max={100} step="0.1" value={yieldPct} onChange={(e) => setYieldPct(e.target.value)} />
            </div>
          </div>

          <div>
            <Label htmlFor="deal-desc">Description</Label>
            <Textarea
              id="deal-desc"
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What the asset is, why it is available, and anything a counterparty needs to assess it."
            />
          </div>

          <label className="flex items-start gap-2.5 cursor-pointer">
            <Checkbox checked={confidential} onCheckedChange={setConfidential} className="mt-0.5" />
            <span className="text-[12px] leading-relaxed" style={{ color: 'var(--ink-4)' }}>
              Mark as confidential — asks counterparties to handle the asset discreetly. It does not
              hide the brief: everyone in the network sees the same fields.
            </span>
          </label>

          {error && (
            <div className="flex items-start gap-2" role="alert">
              <AlertTriangle size={15} className="shrink-0 mt-0.5" style={{ color: 'var(--down)' }} />
              <p className="text-[12px]" style={{ color: 'var(--down)' }}>
                {error}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <button
            onClick={() => onOpenChange(false)}
            className="px-4 py-2 rounded-md text-[13px]"
            style={{ background: 'var(--g3)', border: '1px solid var(--gb)', color: 'var(--ink-3)' }}
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy}
            className="px-4 py-2 rounded-md text-[13px] font-semibold inline-flex items-center gap-2 disabled:opacity-60"
            style={{ background: 'linear-gradient(90deg,#2563EB,#6366F1)', color: '#fff' }}
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            Post deal
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
