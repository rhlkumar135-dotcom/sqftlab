import { useCallback, useEffect, useState } from 'react'
import {
  ArrowLeft, Lock, AlertTriangle, Loader2, Building2, BedDouble, Ruler, Percent,
  Inbox, Handshake, Check, ShieldCheck, Mail,
} from 'lucide-react'
import { authedFetch } from '@/lib/session'
import { usePageMeta } from '@/lib/seo'
import { EmptyState } from '@/components/EmptyState'
import { SkeletonRows } from '@/components/Skeleton'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { TypeBadge, DldContextLine, aed, type DealBrief } from '@/components/DealsNetworkPage'

/**
 * Deal detail (Day 16 Task C).
 *
 * The brief's layout is left 60% / right 40%; that becomes a single column under
 * `lg` so the comparables table is not squeezed to ~140px on a phone.
 *
 * The comparables table is empty in this deployment — the transaction register has no
 * rows — so the panel prints the server's `compsNote` explaining which area it looked
 * in and over what window, rather than an empty table that reads as "no comparables".
 */

interface Comp {
  transactionDate: string
  pricePerSqft: number
  priceAed: number
  areaSqft: number
  beds: number
  buildingName: string | null
}

interface Expression {
  id: string
  message: string | null
  contactOk: boolean
  createdAt: string
  user?: { name: string | null; company: string | null }
}

interface DetailResponse {
  deal?: DealBrief & { isOwner: boolean; userId?: string }
  comps?: Comp[]
  compWindowDays?: number
  marketContext?: { communityName: string | null; medianAedSqft: number | null; source: string | null; matched: boolean }
  expressions?: Expression[]
  myExpression?: { id: string; createdAt: string } | null
  compsNote?: string | null
  error?: string
  currentTier?: string
  requiredTier?: string
}

export default function DealDetailPage({
  dealId,
  onBack,
  onNavigate,
}: {
  dealId: string | null
  onBack: () => void
  onNavigate: (page: 'pricing') => void
}) {
  usePageMeta({
    title: 'Deal brief',
    description: 'A private deal brief on the sqftLab Deal Origination Network.',
    canonicalPath: '/deals',
  })

  const [data, setData] = useState<DetailResponse | null>(null)
  const [status, setStatus] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [gate, setGate] = useState<{ currentTier: string; requiredTier: string } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!dealId) {
      setLoading(false)
      setStatus(404)
      return
    }
    setLoading(true)
    setActionError(null)
    try {
      const res = await authedFetch(`/api/sqftlab/deal-briefs/${encodeURIComponent(dealId)}`)
      const body = (await res.json().catch(() => ({}))) as DetailResponse
      setStatus(res.status)
      if (res.status === 403) {
        setGate({ currentTier: body.currentTier ?? 'guest', requiredTier: body.requiredTier ?? 'enterprise' })
        return
      }
      setGate(null)
      setData(res.ok ? body : null)
    } catch {
      setStatus(null)
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [dealId])

  useEffect(() => {
    void load()
  }, [load])

  const setDealStatus = async (next: 'under-offer' | 'closed') => {
    if (!dealId) return
    setBusy(true)
    setActionError(null)
    try {
      const res = await authedFetch(`/api/sqftlab/deal-briefs/${encodeURIComponent(dealId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setActionError(body.error ?? `Could not update the deal (${res.status}).`)
        return
      }
      await load()
    } catch {
      setActionError('Could not reach the API.')
    } finally {
      setBusy(false)
    }
  }

  if (gate) {
    return (
      <div className="max-w-[720px] mx-auto px-4 sm:px-6 py-10">
        <div className="g2 p-6 sm:p-8 text-center">
          <Lock size={22} className="mx-auto mb-3" style={{ color: 'var(--b600)' }} />
          <h1 className="text-lg font-semibold" style={{ color: 'var(--ink)' }}>
            Deal Origination Network
          </h1>
          <p className="text-[13px] mt-2" style={{ color: 'var(--ink-4)' }}>
            This network is exclusive to Enterprise and Institutional members.
          </p>
          <p className="text-[12px] mt-3" style={{ color: 'var(--ink-5)' }}>
            Your current plan is <strong style={{ color: 'var(--ink-3)' }}>{gate.currentTier}</strong>; this
            feature requires <strong style={{ color: 'var(--ink-3)' }}>{gate.requiredTier}</strong>.
          </p>
          <button
            onClick={() => onNavigate('pricing')}
            className="mt-5 px-5 py-2.5 rounded-full text-[13px] font-semibold"
            style={{ background: 'linear-gradient(90deg,#2563EB,#6366F1)', color: '#fff', boxShadow: 'var(--sh-btn)' }}
          >
            Upgrade to Enterprise
          </button>
        </div>
      </div>
    )
  }

  const back = (
    <button
      onClick={onBack}
      className="inline-flex items-center gap-1.5 text-[13px] mb-4"
      style={{ color: 'var(--ink-4)' }}
    >
      <ArrowLeft size={15} /> Back to the network
    </button>
  )

  if (loading) {
    return (
      <div className="max-w-[1200px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {back}
        <SkeletonRows rows={6} />
      </div>
    )
  }

  if (status === null) {
    return (
      <div className="max-w-[1200px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {back}
        <EmptyState
          icon={<AlertTriangle size={40} />}
          title="Couldn't load this deal"
          body="The API did not answer. This is usually temporary."
          action={{ label: 'Retry', onClick: () => void load() }}
        />
      </div>
    )
  }

  if (status === 404 || !data?.deal) {
    return (
      <div className="max-w-[1200px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {back}
        <EmptyState icon={<Inbox size={40} />} title="Deal not found" body="This brief does not exist, or it was removed." />
      </div>
    )
  }

  const deal = data.deal
  const comps = data.comps ?? []
  const expressions = data.expressions ?? []
  const ctx = data.marketContext

  return (
    <div className="max-w-[1200px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
      {back}

      <div className="flex flex-col lg:flex-row gap-5">
        {/* ── Left: the brief ── */}
        <div className="lg:flex-[3] min-w-0 space-y-5">
          <div className="g2 p-5 sm:p-6">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <TypeBadge type={deal.dealType} />
              {deal.status !== 'active' && (
                <span
                  className="inline-flex items-center rounded-full px-2.5 py-[3px] text-[10px] font-semibold uppercase tracking-wide"
                  style={
                    deal.status === 'closed'
                      ? { color: 'var(--ink-4)', background: 'rgba(100,116,139,0.12)' }
                      : { color: 'var(--warn)', background: 'var(--warn-bg)' }
                  }
                >
                  {deal.status === 'closed' ? 'Closed' : 'Under offer'}
                </span>
              )}
              {deal.isConfidential && (
                <span className="inline-flex items-center gap-1 text-[11px]" style={{ color: 'var(--ink-4)' }}>
                  <ShieldCheck size={12} /> Confidential
                </span>
              )}
            </div>

            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight leading-snug" style={{ color: 'var(--ink)' }}>
              {deal.title}
            </h1>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-2 text-[13px]" style={{ color: 'var(--ink-4)' }}>
              <span className="inline-flex items-center gap-1.5">
                <Building2 size={13} /> {deal.community}
              </span>
              {deal.bedrooms != null && (
                <span className="inline-flex items-center gap-1.5">
                  <BedDouble size={13} /> {deal.bedrooms} bed
                </span>
              )}
              {(deal.sizeSqftMin != null || deal.sizeSqftMax != null) && (
                <span className="inline-flex items-center gap-1.5">
                  <Ruler size={13} />
                  {deal.sizeSqftMin != null ? aed(deal.sizeSqftMin) : '—'}
                  {deal.sizeSqftMax != null ? `–${aed(deal.sizeSqftMax)}` : ''} sqft
                </span>
              )}
              {deal.targetYieldPct != null && (
                <span className="inline-flex items-center gap-1.5">
                  <Percent size={13} /> target {deal.targetYieldPct}% yield
                </span>
              )}
            </div>

            <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--gb)' }}>
              <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-5)' }}>
                Asking price
              </div>
              <div className="mono text-2xl font-semibold mt-0.5" style={{ color: 'var(--ink)' }}>
                {deal.askingPriceAed != null ? `AED ${aed(deal.askingPriceAed)}` : 'Price on request'}
              </div>
            </div>

            {deal.isConfidential && (
              <p className="mt-4 text-[12px] leading-relaxed" style={{ color: 'var(--ink-4)' }}>
                The poster has marked this brief confidential: please handle the asset discreetly. The
                network is invitation-only, but the flag does not redact any field — every Enterprise
                member sees the brief in full.
              </p>
            )}
          </div>

          <div className="g2 p-5 sm:p-6">
            <h2 className="text-[13px] font-semibold uppercase tracking-wide mb-2.5" style={{ color: 'var(--ink-4)' }}>
              Description
            </h2>
            <p className="text-[14px] leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--ink-3)' }}>
              {deal.description}
            </p>
            <div className="mt-4 pt-3 text-[11px]" style={{ color: 'var(--ink-5)', borderTop: '1px solid var(--gb)' }}>
              Posted by {deal.user?.name ?? 'a member'}
              {deal.user?.company ? ` · ${deal.user.company}` : ''} ·{' '}
              {new Date(deal.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
            </div>
          </div>

          {/* Owner-only: the inbox. The API returns `expressions` for the poster and
              omits the field for everyone else, so this branch cannot show another
              member's messages. */}
          {deal.isOwner && (
            <div className="g2 p-5 sm:p-6">
              <h2 className="text-[13px] font-semibold uppercase tracking-wide mb-3 flex items-center gap-2" style={{ color: 'var(--ink-4)' }}>
                <Handshake size={14} /> Interest received ({expressions.length})
              </h2>

              {expressions.length === 0 ? (
                <p className="text-[13px]" style={{ color: 'var(--ink-4)' }}>
                  Nobody has expressed interest yet. Members see this brief in the network and can
                  register interest from this page.
                </p>
              ) : (
                <div className="space-y-2.5">
                  {expressions.map((e) => (
                    <div key={e.id} className="rounded-[12px] p-3.5" style={{ background: 'var(--g3)', border: '1px solid var(--gb)' }}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-[13px] font-medium" style={{ color: 'var(--ink)' }}>
                          {e.user?.name ?? 'A member'}
                          {e.user?.company ? <span style={{ color: 'var(--ink-4)' }}> · {e.user.company}</span> : null}
                        </span>
                        <span className="text-[11px]" style={{ color: 'var(--ink-5)' }}>
                          {new Date(e.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                        </span>
                      </div>
                      {e.message && (
                        <p className="text-[12px] mt-1.5 leading-relaxed" style={{ color: 'var(--ink-3)' }}>
                          {e.message}
                        </p>
                      )}
                      <div className="mt-1.5 text-[11px]" style={{ color: e.contactOk ? 'var(--up)' : 'var(--ink-5)' }}>
                        {e.contactOk ? (
                          <span className="inline-flex items-center gap-1">
                            <Check size={11} /> Consents to being contacted directly
                          </span>
                        ) : (
                          'Has not consented to direct contact'
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* No mail transport is configured in this deployment, so the poster is
                  told where to look rather than being told a message was sent. */}
              <p className="mt-3 text-[11px] leading-relaxed flex items-start gap-1.5" style={{ color: 'var(--ink-5)' }}>
                <Mail size={12} className="shrink-0 mt-0.5" />
                <span>
                  Interest appears here. Email notification to the poster is dormant until a mail
                  transport is configured — the expression of interest is always recorded.
                </span>
              </p>

              <div className="flex flex-wrap gap-2 mt-4 pt-4" style={{ borderTop: '1px solid var(--gb)' }}>
                <button
                  onClick={() => void setDealStatus('under-offer')}
                  disabled={busy || deal.status === 'under-offer'}
                  className="px-4 py-2 rounded-md text-[13px] font-medium disabled:opacity-50"
                  style={{ background: 'var(--warn-bg)', color: 'var(--warn)', border: '1px solid var(--gb)' }}
                >
                  Mark Under Offer
                </button>
                <button
                  onClick={() => void setDealStatus('closed')}
                  disabled={busy || deal.status === 'closed'}
                  className="px-4 py-2 rounded-md text-[13px] font-medium disabled:opacity-50"
                  style={{ background: 'var(--g3)', color: 'var(--ink-3)', border: '1px solid var(--gb)' }}
                >
                  Mark Closed
                </button>
              </div>
              {actionError && (
                <p className="text-[12px] mt-2" role="alert" style={{ color: 'var(--down)' }}>
                  {actionError}
                </p>
              )}
            </div>
          )}
        </div>

        {/* ── Right: market context + comparables + the CTA ── */}
        <div className="lg:flex-[2] min-w-0 space-y-5">
          {!deal.isOwner && (
            <div className="g2 p-5">
              {data.myExpression ? (
                <div className="text-center">
                  <Check size={22} className="mx-auto mb-2" style={{ color: 'var(--up)' }} />
                  <p className="text-[13px] font-medium" style={{ color: 'var(--ink)' }}>
                    You expressed interest
                  </p>
                  <p className="text-[12px] mt-1" style={{ color: 'var(--ink-4)' }}>
                    on {new Date(data.myExpression.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                  </p>
                  <ExpressButton dealId={dealId} alreadyExpressed onDone={load} />
                </div>
              ) : (
                <ExpressButton dealId={dealId} onDone={load} />
              )}
            </div>
          )}

          <div className="g2 p-5">
            <h2 className="text-[13px] font-semibold uppercase tracking-wide mb-3" style={{ color: 'var(--ink-4)' }}>
              Market context
            </h2>
            <DldContextLine deal={{ ...deal, marketContext: ctx }} />
            {!ctx?.matched && (
              <p className="text-[11px] mt-2 leading-relaxed" style={{ color: 'var(--warn)' }}>
                No area in the database matches “{deal.community}”, so no market context could be
                attached. The deal is unaffected.
              </p>
            )}
          </div>

          <div className="g2 p-5">
            <h2 className="text-[13px] font-semibold uppercase tracking-wide mb-3" style={{ color: 'var(--ink-4)' }}>
              DLD comparables
              <span className="ml-1.5 font-normal normal-case tracking-normal" style={{ color: 'var(--ink-5)' }}>
                (last {data.compWindowDays ?? 180} days)
              </span>
            </h2>

            {comps.length === 0 ? (
              <p className="text-[12px] leading-relaxed" style={{ color: 'var(--ink-4)' }}>
                {data.compsNote ?? 'No comparables available for this area.'}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Building</TableHead>
                      <TableHead className="text-right">Beds</TableHead>
                      <TableHead className="text-right">Sqft</TableHead>
                      <TableHead className="text-right">PSF</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {comps.map((c, i) => (
                      <TableRow key={`${c.transactionDate}-${i}`}>
                        <TableCell className="whitespace-nowrap text-[12px]">
                          {new Date(c.transactionDate).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })}
                        </TableCell>
                        <TableCell className="text-[12px]">{c.buildingName ?? '—'}</TableCell>
                        <TableCell className="text-right mono text-[12px]">{c.beds}</TableCell>
                        <TableCell className="text-right mono text-[12px]">{aed(c.areaSqft)}</TableCell>
                        <TableCell className="text-right mono text-[12px] font-semibold">{aed(c.pricePerSqft)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function ExpressButton({ dealId, alreadyExpressed, onDone }: { dealId: string | null; alreadyExpressed?: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [contactOk, setContactOk] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [emailStatus, setEmailStatus] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await authedFetch(`/api/sqftlab/deal-briefs/${encodeURIComponent(dealId ?? '')}/express`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message.trim() || undefined, contactOk }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string; emailStatus?: string }
      if (!res.ok) {
        setError(body.error ?? `Could not register interest (${res.status}).`)
        return
      }
      setEmailStatus(body.emailStatus ?? null)
      setOpen(false)
      onDone()
    } catch {
      setError('Could not reach the API.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="mt-3 w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-full text-[13px] font-semibold"
        style={{ background: 'linear-gradient(90deg,#2563EB,#6366F1)', color: '#fff', boxShadow: 'var(--sh-btn)' }}
      >
        <Handshake size={15} /> {alreadyExpressed ? 'Update your interest' : 'Express Interest'}
      </button>
      {emailStatus === 'unconfigured' && (
        <p className="text-[11px] mt-2 text-center" style={{ color: 'var(--ink-5)' }}>
          Recorded. The poster has not been emailed — no mail transport is configured yet.
        </p>
      )}

      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          if (!o) setError(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Express interest</DialogTitle>
            <DialogDescription>
              The poster sees your name{', '}company and your message. They are not told your email
              address unless you consent to being contacted.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <label className="text-[12px] block mb-1.5" style={{ color: 'var(--ink-4)' }} htmlFor="express-message">
                Message (optional)
              </label>
              <Textarea
                id="express-message"
                rows={3}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Introduce yourself and say what you are looking for."
              />
            </div>

            <label className="flex items-start gap-2.5 cursor-pointer">
              <Checkbox checked={contactOk} onCheckedChange={setContactOk} className="mt-0.5" />
              <span className="text-[12px] leading-relaxed" style={{ color: 'var(--ink-4)' }}>
                I consent to being contacted directly by the deal poster.
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
              onClick={() => setOpen(false)}
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
              Submit Interest
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
