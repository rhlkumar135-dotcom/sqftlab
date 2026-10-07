import { useCallback, useEffect, useMemo, useState } from 'react'
import { Building2, Calculator, Info, Loader2, Lock, Sparkles } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { computeMortgage, minDownPaymentPct, upfrontCosts } from '@/lib/mortgage'
import { usePageMeta } from '@/lib/seo'

/**
 * UAE Mortgage Calculator (Day 14 Task D).
 *
 * Free for every tier — the brief is explicit, and it differs from the CMA next door, so
 * nothing here is gated and the route it reads (`/mortgage/estimate`) is public.
 *
 * Why the figures are computed locally: the calculator must respond to every slider drag
 * and keystroke. Calling `/mortgage/simulate` per input event would be a round trip per
 * frame. The maths lives in `@/lib/mortgage` and `verify-day14.ts` asserts it agrees with
 * the server route to the dirham, so "local" does not mean "a second opinion".
 *
 * On the DLD pre-fill: the estimate is only applied when the register actually produced a
 * figure. Where there is no transaction data — which is the state of this deployment —
 * the button reports that instead of pre-filling a plausible-looking price, because a
 * mortgage sized on an invented price is worse than one the user typed themselves.
 */

interface EstimateResponse {
  community?: string
  communityName?: string
  avgPsfAed?: number | null
  estimatedPriceAed?: number | null
  basedOnTx?: number
  period?: string
  source?: string
  note?: string | null
  error?: string
}

interface Community {
  slug: string
  nameEn: string
}

const FIELD_CLASS =
  'h-10 rounded-xl text-sm border-[var(--gb)] bg-white/70 text-[var(--ink)] ' +
  'placeholder:text-[var(--ink-5)] focus-visible:ring-2 focus-visible:ring-[var(--b400)]'

const CARD = 'rounded-[18px] p-5'
const CARD_STYLE = { background: 'var(--g2)', border: '1px solid var(--gb)', boxShadow: 'var(--sh-card)' }

const aed = (n: number): string => `AED ${Math.round(n).toLocaleString('en-AE')}`

export default function MortgagePage({ onNavigate }: { onNavigate?: (page: 'cma') => void }) {
  usePageMeta({
    title: 'UAE Mortgage Calculator — Pre-filled from DLD Data',
    description:
      'Calculate your UAE mortgage with real DLD property prices. Includes transfer fee and registration cost estimates.',
    canonicalPath: '/mortgage',
  })

  const [communities, setCommunities] = useState<Community[]>([])
  const [community, setCommunity] = useState('')
  const [bedrooms, setBedrooms] = useState('2')
  const [sizeSqft, setSizeSqft] = useState('1100')

  const [price, setPrice] = useState(2_000_000)
  const [downPct, setDownPct] = useState(25)
  const [ratePct, setRatePct] = useState(4.5)
  const [termYears, setTermYears] = useState(25)
  const [mortgageType, setMortgageType] = useState('fixed')

  const [estimate, setEstimate] = useState<EstimateResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    // bare-fetch-ok: the public community list — it reads no account data.
    fetch('/api/sqftlab/communities')
      .then((r) => r.json())
      .then((d: { communities?: Community[] }) => {
        const list = d.communities ?? []
        setCommunities(list)
        setCommunity((prev) => prev || list[0]?.slug || '')
      })
      .catch(() => {
        // The calculator works without the picker: a user can type a size and price.
      })
  }, [])

  const loadMarketPrice = useCallback(async () => {
    if (!community) return
    setLoading(true)
    setLoaded(false)
    try {
      const qs = new URLSearchParams({ community, bedrooms })
      if (sizeSqft) qs.set('sizeSqft', sizeSqft)
      // bare-fetch-ok: a public calculator endpoint — it reads no account data.
      const res = await fetch(`/api/sqftlab/mortgage/estimate?${qs.toString()}`)
      const body = (await res.json().catch(() => ({}))) as EstimateResponse
      setEstimate(body)
      setLoaded(true)
      // Only adopt a figure the register actually produced.
      if (typeof body.estimatedPriceAed === 'number' && body.estimatedPriceAed > 0) {
        setPrice(body.estimatedPriceAed)
      }
    } catch {
      setEstimate({ error: 'Could not reach the market data service.' })
      setLoaded(true)
    } finally {
      setLoading(false)
    }
  }, [community, bedrooms, sizeSqft])

  const result = useMemo(
    () => computeMortgage({ price, downPaymentPct: downPct, ratePct, termYears }),
    [price, downPct, ratePct, termYears],
  )
  const costs = useMemo(() => upfrontCosts(price), [price])

  const floorPct = minDownPaymentPct(price)
  const belowFloor = downPct < floorPct
  const upfrontCash = result.downPayment + costs.total

  // Year 1 and the final year, which is what the brief asks to compare.
  const first = result.schedule[0]
  const last = result.schedule[result.schedule.length - 1]
  const share = (s: { principalPaid: number; interestPaid: number } | undefined) => {
    if (!s) return { principal: 0, interest: 100 }
    const total = s.principalPaid + s.interestPaid
    if (total <= 0) return { principal: 0, interest: 100 }
    return { principal: (s.principalPaid / total) * 100, interest: (s.interestPaid / total) * 100 }
  }
  const y1 = share(first)
  const yN = share(last)

  return (
    <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <div className="flex items-start gap-3 mb-5">
        <div className="rounded-[14px] p-2.5 shrink-0" style={{ background: 'rgba(37,99,235,0.09)' }}>
          <Calculator size={20} style={{ color: 'var(--b600)' }} />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight" style={{ color: 'var(--ink)' }}>
            UAE Mortgage Calculator
          </h1>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--ink-4)' }}>
            Pre-filled with live DLD transaction data
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* ── Left: inputs ── */}
        <div className="space-y-5">
          <div className={CARD} style={CARD_STYLE}>
            <div className="flex items-center gap-2 mb-4">
              <Building2 size={15} style={{ color: 'var(--b600)' }} />
              <h2 className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>
                Property
              </h2>
            </div>

            <div className="space-y-3">
              <div>
                <Label htmlFor="mtg-community" className="text-xs font-semibold" style={{ color: 'var(--ink-2)' }}>
                  Community
                </Label>
                <Select value={community} onValueChange={setCommunity}>
                  <SelectTrigger id="mtg-community" className={`${FIELD_CLASS} mt-1`}>
                    <SelectValue placeholder="Select a community" />
                  </SelectTrigger>
                  <SelectContent>
                    {communities.map((c) => (
                      <SelectItem key={c.slug} value={c.slug}>
                        {c.nameEn}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="mtg-beds" className="text-xs font-semibold" style={{ color: 'var(--ink-2)' }}>
                    Bedrooms
                  </Label>
                  <Select value={bedrooms} onValueChange={setBedrooms}>
                    <SelectTrigger id="mtg-beds" className={`${FIELD_CLASS} mt-1`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {['1', '2', '3', '4'].map((b) => (
                        <SelectItem key={b} value={b}>
                          {b}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="mtg-size" className="text-xs font-semibold" style={{ color: 'var(--ink-2)' }}>
                    Size (sqft)
                  </Label>
                  <Input
                    id="mtg-size"
                    type="number"
                    min={1}
                    value={sizeSqft}
                    onChange={(e) => setSizeSqft(e.target.value)}
                    className={`${FIELD_CLASS} mt-1`}
                  />
                </div>
              </div>

              <button
                type="button"
                onClick={() => void loadMarketPrice()}
                disabled={loading || !community}
                className="w-full py-2.5 rounded-xl font-semibold text-[13px] flex items-center justify-center gap-2 disabled:opacity-50"
                style={{ background: 'var(--b600)', color: '#fff', boxShadow: 'var(--sh-btn)' }}
              >
                {loading ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
                {loading ? 'Loading…' : 'Load DLD Market Price'}
              </button>

              {loaded && estimate && (
                <div
                  className="rounded-[12px] px-3 py-2.5 text-[12px] leading-relaxed"
                  style={{
                    background: estimate.avgPsfAed ? 'rgba(37,99,235,0.06)' : 'var(--warn-bg)',
                    color: 'var(--ink-3)',
                  }}
                >
                  {estimate.avgPsfAed ? (
                    <>
                      Based on <strong>{estimate.basedOnTx}</strong> DLD transaction(s) in the last{' '}
                      {estimate.period ?? '90 days'} · <strong>{aed(estimate.avgPsfAed)}/sqft</strong>
                      {estimate.estimatedPriceAed ? <> · estimated {aed(estimate.estimatedPriceAed)}</> : null}
                    </>
                  ) : (
                    <>
                      {estimate.note ??
                        estimate.error ??
                        'No DLD market price is available for this selection, so the price below is not pre-filled.'}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className={CARD} style={CARD_STYLE}>
            <h2 className="text-[14px] font-semibold mb-4" style={{ color: 'var(--ink)' }}>
              Mortgage
            </h2>
            <div className="space-y-4">
              <div>
                <Label htmlFor="mtg-price" className="text-xs font-semibold" style={{ color: 'var(--ink-2)' }}>
                  Property price (AED)
                </Label>
                <Input
                  id="mtg-price"
                  type="number"
                  min={0}
                  value={price}
                  onChange={(e) => setPrice(Number(e.target.value))}
                  className={`${FIELD_CLASS} mt-1 mono`}
                />
              </div>

              <div>
                <div className="flex items-baseline justify-between">
                  <Label htmlFor="mtg-down" className="text-xs font-semibold" style={{ color: 'var(--ink-2)' }}>
                    Down payment
                  </Label>
                  <span className="text-[13px] font-semibold mono" style={{ color: 'var(--ink)' }}>
                    {downPct}% · {aed(result.downPayment)}
                  </span>
                </div>
                <input
                  id="mtg-down"
                  type="range"
                  min={0}
                  max={70}
                  step={1}
                  value={downPct}
                  onChange={(e) => setDownPct(Number(e.target.value))}
                  className="w-full mt-2"
                  style={{ accentColor: 'var(--b600)' }}
                />
                <div className="flex items-center justify-between text-[11px] mt-1" style={{ color: 'var(--ink-5)' }}>
                  <span>0%</span>
                  <span>UAE minimum {floorPct}%</span>
                  <span>70%</span>
                </div>
                {belowFloor && (
                  <p className="text-[11px] mt-1.5 rounded-[10px] px-2.5 py-1.5" style={{ background: 'var(--warn-bg)', color: 'var(--ink-3)' }}>
                    Below the {floorPct}% minimum typically required in the UAE
                    {price > 5_000_000 ? ' for properties above AED 5M' : ''}. The figures below still calculate, but a lender would not approve this structure.
                  </p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="mtg-rate" className="text-xs font-semibold" style={{ color: 'var(--ink-2)' }}>
                    Interest rate (%)
                  </Label>
                  <Input
                    id="mtg-rate"
                    type="number"
                    step="0.1"
                    min={0}
                    value={ratePct}
                    onChange={(e) => setRatePct(Number(e.target.value))}
                    className={`${FIELD_CLASS} mt-1 mono`}
                  />
                </div>
                <div>
                  <Label htmlFor="mtg-term" className="text-xs font-semibold" style={{ color: 'var(--ink-2)' }}>
                    Loan term
                  </Label>
                  <Select value={String(termYears)} onValueChange={(v) => setTermYears(Number(v))}>
                    <SelectTrigger id="mtg-term" className={`${FIELD_CLASS} mt-1`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {['10', '15', '20', '25'].map((y) => (
                        <SelectItem key={y} value={y}>
                          {y} years
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <Label htmlFor="mtg-type" className="text-xs font-semibold" style={{ color: 'var(--ink-2)' }}>
                  Mortgage type
                </Label>
                <Select value={mortgageType} onValueChange={setMortgageType}>
                  <SelectTrigger id="mtg-type" className={`${FIELD_CLASS} mt-1`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fixed">Fixed rate</SelectItem>
                    <SelectItem value="variable">Variable rate</SelectItem>
                  </SelectContent>
                </Select>
                {/* The type does not change the arithmetic — it changes what the rate DOES
                    over the term, so claiming a different payment for it would be a
                    fabricated distinction. */}
                <p className="text-[11px] mt-1.5" style={{ color: 'var(--ink-5)' }}>
                  {mortgageType === 'fixed'
                    ? 'Your rate is held for the term, so this payment is what you would pay throughout.'
                    : 'A variable rate moves with the market, so the payment above is only the current indication.'}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* ── Right: results ── */}
        <div className="space-y-5">
          <div className="rounded-[18px] p-5" style={{ background: 'linear-gradient(135deg, var(--b800), var(--b900))', color: '#fff' }}>
            <div className="mb-4">
              <div className="text-xs" style={{ color: 'rgba(255,255,255,0.5)' }}>
                Monthly payment
              </div>
              <div className="text-3xl sm:text-4xl font-bold mono" style={{ color: 'var(--b300)' }}>
                {aed(result.monthly)}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              {[
                { label: 'Loan amount', value: aed(result.loanAmount) },
                { label: 'Total interest', value: aed(result.totalInterest), color: '#FCA5A5' },
                { label: 'Total cost', value: aed(result.totalPayment) },
                { label: 'Upfront cash', value: aed(upfrontCash) },
              ].map((item) => (
                <div key={item.label} className="rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.1)' }}>
                  <div className="text-xs" style={{ color: 'rgba(255,255,255,0.5)' }}>
                    {item.label}
                  </div>
                  <div className="font-semibold mono" style={{ color: item.color || '#fff' }}>
                    {item.value}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className={CARD} style={CARD_STYLE}>
            <h2 className="text-[14px] font-semibold mb-3" style={{ color: 'var(--ink)' }}>
              Principal vs interest
            </h2>
            {[
              { year: 1, s: y1, label: 'Year 1' },
              { year: termYears, s: yN, label: `Year ${termYears}` },
            ].map((row) => (
              <div key={row.year} className="mb-3 last:mb-0">
                <div className="flex items-center justify-between text-[11px] mb-1" style={{ color: 'var(--ink-4)' }}>
                  <span>{row.label}</span>
                  <span className="mono">
                    {row.s.principal.toFixed(0)}% principal · {row.s.interest.toFixed(0)}% interest
                  </span>
                </div>
                <div className="flex h-2.5 rounded-full overflow-hidden" style={{ background: 'var(--g3)' }}>
                  <div style={{ width: `${row.s.principal}%`, background: 'var(--b600)' }} />
                  <div style={{ width: `${row.s.interest}%`, background: '#FCA5A5' }} />
                </div>
              </div>
            ))}
            <p className="text-[11px] mt-2" style={{ color: 'var(--ink-5)' }}>
              Early payments are mostly interest; the balance shifts toward principal as the loan amortises.
            </p>
          </div>

          <div className={CARD} style={CARD_STYLE}>
            <div className="flex items-center gap-2 mb-3">
              <Info size={14} style={{ color: 'var(--b600)' }} />
              <h2 className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>
                UAE purchase costs
              </h2>
            </div>
            <div className="space-y-2 text-[13px]">
              {[
                { label: 'Down payment', value: aed(result.downPayment) },
                { label: 'DLD transfer fee (4%)', value: aed(costs.transferFee) },
                { label: 'Registration fee', value: aed(costs.registrationFee) },
              ].map((row) => (
                <div key={row.label} className="flex items-center justify-between">
                  <span style={{ color: 'var(--ink-4)' }}>{row.label}</span>
                  <span className="mono font-medium" style={{ color: 'var(--ink)' }}>
                    {row.value}
                  </span>
                </div>
              ))}
              <div
                className="flex items-center justify-between pt-2 mt-1"
                style={{ borderTop: '1px solid var(--gb)' }}
              >
                <span className="font-semibold" style={{ color: 'var(--ink-2)' }}>
                  Total upfront
                </span>
                <span className="mono font-bold" style={{ color: 'var(--b600)' }}>
                  {aed(upfrontCash)}
                </span>
              </div>
            </div>
            <p className="text-[11px] mt-3" style={{ color: 'var(--ink-5)' }}>
              Indicative. The transfer fee is normally split between buyer and seller, and off-plan terms differ.
            </p>
          </div>

          {onNavigate && (
            <button
              type="button"
              onClick={() => onNavigate('cma')}
              className="w-full rounded-[16px] px-4 py-3 text-left flex items-center justify-between gap-3"
              style={{ background: 'var(--g2)', border: '1px solid var(--gb)' }}
            >
              <span>
                <span className="block text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
                  Need a valuation report?
                </span>
                <span className="block text-[11px] mt-0.5" style={{ color: 'var(--ink-5)' }}>
                  Generate a PDF from DLD comparables
                </span>
              </span>
              <span className="flex items-center gap-1 text-[11px] font-semibold shrink-0" style={{ color: 'var(--b600)' }}>
                <Lock size={11} /> Enterprise
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
