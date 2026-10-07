import { useEffect, useMemo, useState } from 'react'
import { Calculator, Download, Info, Loader2, Lock, TrendingDown, TrendingUp } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { authedFetch } from '@/lib/session'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'

// ─── CMA tool page (Day 6 Task B) ────────────────────────────────────────────
//
// Enterprise-only. The server enforces the gate (`requireTier(c,'enterprise',…)`);
// the overlay here exists so the visitor sees WHAT is locked instead of an empty
// page and a silent failure — it is UX, not security.
//
// Live data note: this deployment has no DLD feed connected, so the API answers
// 422 rather than a valuation. That path is rendered as a first-class state below
// ("The comparable-sales feed is not connected") and NOT as an error toast or a
// zeroed-out valuation. A CMA page that showed AED 0 — or a figure computed from
// nothing — would be worse than one that says it cannot answer yet.
//
// shadcn components are used as structure with the project's tokens applied via
// className/inline style, matching how PricingPage composes Table and Accordion.
// (This app defines its palette in src/styles/tokens.css and has no Tailwind
// @theme, so shadcn's own semantic utilities like `border-input` resolve to
// nothing — every surface below styles itself explicitly.)

const ENTERPRISE_TIERS = new Set(['enterprise', 'institutional'])

const FIELD_CLASS =
  'h-10 rounded-xl text-sm border-[var(--gb)] bg-white/70 text-[var(--ink)] ' +
  'placeholder:text-[var(--ink-5)] focus-visible:ring-2 focus-visible:ring-[var(--b400)]'

interface Community {
  slug: string
  nameEn: string
}

interface RecentComp {
  date: string
  pricePsf: number
  totalAed: number
  sizeSqft: number
  building: string | null
  floor: number | null
}

interface CmaResult {
  subject: {
    buildingName: string
    community: string
    bedrooms: number
    sizeSqft: number
    floor: number | null
    condition: string | null
  }
  compsUsed: number
  compsInCommunity: number
  sameBuildingCount: number
  compBasis: 'building' | 'community'
  dateRange: string
  windowDays: number
  medianPsf: number
  avgPsf: number
  p25Psf: number
  p75Psf: number
  adjustedPsf: number
  estimatedValueAed: number
  floorAdjustmentPct: number
  conditionAdjPct: number
  listingPriceAed: number | null
  listingPremiumPct: number | null
  verdict: string | null
  recentComps: RecentComp[]
}

interface CmaFailure {
  error: string
  message?: string
  fields?: string[]
  expected?: Record<string, string>
  compsFound?: number
  dldConnected?: boolean
  communityFound?: boolean
}

const aed = new Intl.NumberFormat('en-AE', { maximumFractionDigits: 0 })
const BEDROOM_CHOICES: Array<{ value: string; label: string }> = [
  { value: '0', label: 'Studio' },
  { value: '1', label: '1' },
  { value: '2', label: '2' },
  { value: '3', label: '3' },
  { value: '4', label: '4' },
  { value: '5', label: '5+' },
]
const CONDITION_CHOICES = [
  { value: 'unspecified', label: 'Not specified' },
  { value: 'excellent', label: 'Excellent' },
  { value: 'good', label: 'Good' },
  { value: 'average', label: 'Average' },
  { value: 'poor', label: 'Poor' },
]

/** Verdict tint. Green on a discount, amber near the top of the normal band, red past it. */
function verdictColor(premiumPct: number): string {
  if (premiumPct < 0) return 'var(--up)'
  if (premiumPct < 8) return 'var(--b600)'
  if (premiumPct < 20) return 'var(--warn)'
  return 'var(--down)'
}

function Card({ title, children, className }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('g2 p-4 sm:p-5', className)}>
      {title && (
        <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: 'var(--ink-4)' }}>
          {title}
        </div>
      )}
      {children}
    </div>
  )
}

// The CTA below is the only navigation this page performs, so the prop is typed to
// exactly that. Narrowing it (rather than taking App's whole `Page` union) keeps this
// component free of a type import from App, which would be a cycle — and a caller
// passing a general `(p: Page) => void` still satisfies it.
export default function CmaPage({ onNavigate }: { onNavigate?: (page: 'pricing') => void }) {
  const [tier, setTier] = useState<string | null>(null)
  const [communities, setCommunities] = useState<Community[]>([])

  const [buildingName, setBuildingName] = useState('')
  const [community, setCommunity] = useState('')
  const [bedrooms, setBedrooms] = useState('2')
  const [sizeSqft, setSizeSqft] = useState('')
  const [floor, setFloor] = useState('')
  const [condition, setCondition] = useState('unspecified')
  const [listingPrice, setListingPrice] = useState('')

  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<CmaResult | null>(null)
  const [failure, setFailure] = useState<CmaFailure | null>(null)
  const [pdfBusy, setPdfBusy] = useState(false)
  const [pdfError, setPdfError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    authedFetch('/api/sqftlab/me')
      .then((r) => r.json())
      .catch(() => ({}))
      .then((d: { user?: { tier?: string } | null }) => {
        if (alive) setTier(d?.user?.tier ?? 'guest')
      })
    authedFetch('/api/sqftlab/communities')
      .then((r) => r.json())
      .catch(() => ({}))
      .then((d: { communities?: Community[] }) => {
        if (alive) setCommunities(d?.communities ?? [])
      })
    return () => {
      alive = false
    }
  }, [])

  const unlocked = tier !== null && ENTERPRISE_TIERS.has(tier)

  const sizeNum = useMemo(() => Number(sizeSqft), [sizeSqft])

  async function runCma() {
    setBusy(true)
    setFailure(null)
    setResult(null)

    const payload: Record<string, unknown> = {
      buildingName: buildingName.trim(),
      community: community.trim(),
      bedrooms: Number(bedrooms),
      sizeSqft: sizeNum,
    }
    // Omit rather than send empty strings — the route validates what it is given,
    // and a bare `floor: ''` is not "no floor", it is bad input.
    if (floor.trim() !== '') payload.floor = Number(floor)
    if (condition !== 'unspecified') payload.condition = condition
    if (listingPrice.trim() !== '') payload.listingPrice = Number(listingPrice)

    try {
      const res = await authedFetch('/api/sqftlab/cma', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        // Surface the server's own words. A generic "something went wrong" would
        // hide the single most useful thing here: whether the feed is connected.
        setFailure(
          typeof body?.error === 'string'
            ? (body as CmaFailure)
            : { error: `CMA request failed (HTTP ${res.status})` },
        )
        return
      }
      setResult(body as CmaResult)
    } catch {
      setFailure({ error: 'Could not reach the CMA service. Check your connection and try again.' })
    } finally {
      setBusy(false)
    }
  }

  /**
   * Download the white-label report (Day 7 Task C).
   *
   * Only reachable once a valuation exists: the route refuses without enough recorded
   * sales, so a report can only ever be produced for a subject the CMA tool itself
   * priced. Failures surface the server's own words — including the honest 422 when the
   * feed is empty — because a generic "failed" would hide the one fact that matters.
   */
  async function downloadReport() {
    if (!result) return
    setPdfBusy(true)
    setPdfError(null)

    const payload: Record<string, unknown> = {
      propertyAddress: `${buildingName.trim()}, ${community.trim()}`,
      building: buildingName.trim(),
      community: community.trim(),
      bedrooms: Number(bedrooms),
      sizeSqft: sizeNum,
    }
    if (listingPrice.trim() !== '') payload.listingPriceAed = Number(listingPrice)

    try {
      const res = await authedFetch('/api/sqftlab/report/property', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
        setPdfError(
          typeof body?.error === 'string'
            ? String(body.message ?? body.error)
            : `Report generation failed (HTTP ${res.status})`,
        )
        return
      }

      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const slug = community.trim().toLowerCase().replace(/\s+/g, '-')
      const a = document.createElement('a')
      a.href = url
      a.download = `sqftlab-report-${slug}.pdf`
      // Firefox only honours a synthetic click on an anchor that is attached.
      document.body.appendChild(a)
      a.click()
      a.remove()
      // Revoking in the same tick can cancel an in-flight download; the blob is small
      // and the timer is cleared by the browser once the download has started.
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (err) {
      setPdfError(err instanceof Error ? err.message : 'Could not reach the report service.')
    } finally {
      setPdfBusy(false)
    }
  }

  const canSubmit = buildingName.trim() !== '' && community.trim() !== '' && sizeNum > 0 && !busy

  return (
    <div className="mx-auto w-full max-w-[1240px] px-4 sm:px-6 py-6 sm:py-10">
      <header className="mb-6">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: 'var(--b600)' }}>
          <Calculator size={14} /> Enterprise tool
        </div>
        <h1 className="mt-2 text-2xl sm:text-3xl font-bold" style={{ color: 'var(--ink)' }}>
          Comparable Market Analysis
        </h1>
        <p className="mt-2 max-w-2xl text-sm" style={{ color: 'var(--ink-3)' }}>
          Value a unit from recorded sales of comparable units in the same building or area.
          Every figure is derived from transactions sqftLab has on record — nothing is modelled
          or interpolated, and the comparables are shown so you can check the working.
        </p>
      </header>

      <div className="relative">
        <div
          className={cn('flex flex-col lg:flex-row gap-5', !unlocked && 'pointer-events-none')}
          style={!unlocked && tier !== null ? { filter: 'blur(6px)', userSelect: 'none' } : undefined}
          aria-hidden={tier !== null && !unlocked ? true : undefined}
        >
          {/* ── Input form ─────────────────────────────────────────────── */}
          <Card title="Subject property" className="lg:w-[40%] shrink-0">
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault()
                if (canSubmit) void runCma()
              }}
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cma-building" className="text-xs font-semibold" style={{ color: 'var(--ink-2)' }}>
                  Building name
                </Label>
                <Input
                  id="cma-building"
                  value={buildingName}
                  onChange={(e) => setBuildingName(e.target.value)}
                  placeholder="e.g. Marina Gate"
                  className={FIELD_CLASS}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cma-community" className="text-xs font-semibold" style={{ color: 'var(--ink-2)' }}>
                  Community / area
                </Label>
                <Input
                  id="cma-community"
                  value={community}
                  onChange={(e) => setCommunity(e.target.value)}
                  placeholder="e.g. Dubai Marina"
                  list="cma-community-list"
                  className={FIELD_CLASS}
                />
                {/* Free text with suggestions: the matcher on the server accepts a
                    near-miss, so a typo still resolves, and an area added to the
                    database later works without a client release. */}
                <datalist id="cma-community-list">
                  {communities.map((x) => (
                    <option key={x.slug} value={x.nameEn} />
                  ))}
                </datalist>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs font-semibold" style={{ color: 'var(--ink-2)' }}>
                    Bedrooms
                  </Label>
                  <Select value={bedrooms} onValueChange={setBedrooms}>
                    <SelectTrigger className={FIELD_CLASS}>
                      <SelectValue placeholder="2" />
                    </SelectTrigger>
                    <SelectContent style={{ background: '#fff', border: '1px solid var(--gb)' }}>
                      {BEDROOM_CHOICES.map((b) => (
                        <SelectItem key={b.value} value={b.value}>
                          {b.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cma-size" className="text-xs font-semibold" style={{ color: 'var(--ink-2)' }}>
                    Size (sqft)
                  </Label>
                  <Input
                    id="cma-size"
                    type="number"
                    min={1}
                    inputMode="numeric"
                    value={sizeSqft}
                    onChange={(e) => setSizeSqft(e.target.value)}
                    placeholder="1200"
                    className={cn(FIELD_CLASS, 'mono')}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cma-floor" className="text-xs font-semibold" style={{ color: 'var(--ink-2)' }}>
                    Floor <span style={{ color: 'var(--ink-5)' }}>optional</span>
                  </Label>
                  <Input
                    id="cma-floor"
                    type="number"
                    min={0}
                    inputMode="numeric"
                    value={floor}
                    onChange={(e) => setFloor(e.target.value)}
                    placeholder="—"
                    className={cn(FIELD_CLASS, 'mono')}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs font-semibold" style={{ color: 'var(--ink-2)' }}>
                    Condition
                  </Label>
                  <Select value={condition} onValueChange={setCondition}>
                    <SelectTrigger className={FIELD_CLASS}>
                      <SelectValue placeholder="Not specified" />
                    </SelectTrigger>
                    <SelectContent style={{ background: '#fff', border: '1px solid var(--gb)' }}>
                      {CONDITION_CHOICES.map((c) => (
                        <SelectItem key={c.value} value={c.value}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cma-listing" className="text-xs font-semibold" style={{ color: 'var(--ink-2)' }}>
                  Asking price, AED <span style={{ color: 'var(--ink-5)' }}>optional</span>
                </Label>
                <Input
                  id="cma-listing"
                  type="number"
                  min={1}
                  inputMode="numeric"
                  value={listingPrice}
                  onChange={(e) => setListingPrice(e.target.value)}
                  placeholder="For deal analysis"
                  className={cn(FIELD_CLASS, 'mono')}
                />
                <p className="text-[11px]" style={{ color: 'var(--ink-5)' }}>
                  Add the price the unit is being offered at to see whether it is above or below
                  what comparable sales support.
                </p>
              </div>

              <button
                type="submit"
                disabled={!canSubmit}
                className="mt-1 inline-flex h-11 items-center justify-center gap-2 rounded-full text-sm font-semibold text-white disabled:opacity-50 transition-opacity"
                style={{ background: 'linear-gradient(90deg,#2563EB,#6366F1)', boxShadow: 'var(--sh-btn)' }}
              >
                {busy ? <Loader2 size={16} className="animate-spin" /> : <Calculator size={16} />}
                {busy ? 'Analysing…' : 'Run CMA'}
              </button>
            </form>
          </Card>

          {/* ── Results ────────────────────────────────────────────────── */}
          <div className="flex flex-col gap-5 lg:w-[60%] min-w-0">
            {!result && !failure && (
              <Card className="flex flex-col items-center justify-center gap-2 py-14 text-center">
                <Calculator size={26} style={{ color: 'var(--ink-5)' }} />
                <div className="text-sm font-semibold" style={{ color: 'var(--ink-2)' }}>
                  No analysis yet
                </div>
                <p className="max-w-sm text-xs" style={{ color: 'var(--ink-4)' }}>
                  Enter the subject property and run the CMA. The estimated value, the market range
                  and the comparable sales it was built from will appear here.
                </p>
              </Card>
            )}

            {failure && (
              <div
                className="rounded-[18px] p-4 sm:p-5"
                style={{
                  background: failure.dldConnected === false ? 'var(--warn-bg)' : 'rgba(255,255,255,0.7)',
                  border: `1px solid ${failure.dldConnected === false ? 'var(--warn)' : 'var(--gb)'}`,
                }}
              >
                <div className="flex items-start gap-2">
                  <Info size={16} className="mt-0.5 shrink-0" style={{ color: failure.dldConnected === false ? 'var(--warn)' : 'var(--b600)' }} />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
                      {failure.error}
                    </div>
                    {failure.message && (
                      <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--ink-3)' }}>
                        {failure.message}
                      </p>
                    )}
                    {typeof failure.compsFound === 'number' && (
                      <p className="mt-2 text-xs" style={{ color: 'var(--ink-4)' }}>
                        Comparable sales found: <span className="mono">{failure.compsFound}</span>
                      </p>
                    )}
                    {failure.fields && failure.fields.length > 0 && (
                      <ul className="mt-2 space-y-0.5 text-xs" style={{ color: 'var(--ink-3)' }}>
                        {failure.fields.map((f) => (
                          <li key={f}>
                            <span className="mono font-semibold">{f}</span>
                            {failure.expected?.[f] ? ` — ${failure.expected[f]}` : ''}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
            )}

            {result && (
              <>
                <Card title="Estimated value">
                  <div className="mono text-3xl sm:text-4xl font-bold tracking-tight" style={{ color: 'var(--ink)' }}>
                    AED {aed.format(result.estimatedValueAed)}
                  </div>
                  <div className="mt-1 text-sm" style={{ color: 'var(--ink-3)' }}>
                    <span className="mono">AED {aed.format(result.adjustedPsf)}</span> / sqft (adjusted)
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px]" style={{ color: 'var(--ink-4)' }}>
                    <span>
                      Floor adjustment <span className="mono">{result.floorAdjustmentPct > 0 ? '+' : ''}{result.floorAdjustmentPct}%</span>
                    </span>
                    <span>
                      Condition adjustment <span className="mono">{result.conditionAdjPct > 0 ? '+' : ''}{result.conditionAdjPct}%</span>
                    </span>
                  </div>
                </Card>

                <Card title={`Market range — last ${result.windowDays} days`}>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {[
                      { k: 'P25', v: result.p25Psf },
                      { k: 'Median', v: result.medianPsf },
                      { k: 'P75', v: result.p75Psf },
                      { k: 'Average', v: result.avgPsf },
                    ].map((x) => (
                      <div key={x.k}>
                        <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-4)' }}>
                          {x.k}
                        </div>
                        <div className="mono text-base font-semibold" style={{ color: 'var(--ink)' }}>
                          {aed.format(x.v)}
                        </div>
                        <div className="text-[10px]" style={{ color: 'var(--ink-5)' }}>
                          AED / sqft
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="mt-3 text-[11px]" style={{ color: 'var(--ink-4)' }}>
                    Built from <span className="mono">{result.compsUsed}</span> comparable sale
                    {result.compsUsed === 1 ? '' : 's'}{' '}
                    {result.compBasis === 'building'
                      ? `in ${result.subject.buildingName}`
                      : `across ${result.subject.community}`}
                    {result.compBasis === 'community' && result.sameBuildingCount > 0
                      ? ` (only ${result.sameBuildingCount} in this building — too few to value from, so the area was used)`
                      : ''}
                    .
                  </p>
                </Card>

                {result.verdict && result.listingPremiumPct !== null && (
                  <Card title="Verdict">
                    <div className="flex items-start gap-2">
                      <span
                        className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: verdictColor(result.listingPremiumPct) }}
                        aria-hidden="true"
                      />
                      <div>
                        <div className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
                          {result.verdict}
                        </div>
                        <p className="mt-1 text-xs" style={{ color: 'var(--ink-3)' }}>
                          The asking price of{' '}
                          <span className="mono">AED {aed.format(result.listingPriceAed ?? 0)}</span> is{' '}
                          <span className="mono font-semibold">{Math.abs(result.listingPremiumPct)}%</span>{' '}
                          {result.listingPremiumPct >= 0 ? 'above' : 'below'} the estimate from comparable sales.
                        </p>
                      </div>
                    </div>
                  </Card>
                )}

                <Card title="Comparable transactions">
                  {result.recentComps.length === 0 ? (
                    <p className="text-xs" style={{ color: 'var(--ink-4)' }}>No comparable sales to display.</p>
                  ) : (
                    <Table className="min-w-[520px]">
                      <TableHeader>
                        <TableRow>
                          <TableHead className="text-left text-[11px]">Date</TableHead>
                          <TableHead className="text-right text-[11px]">AED / sqft</TableHead>
                          <TableHead className="text-right text-[11px]">Total AED</TableHead>
                          <TableHead className="text-right text-[11px]">Size (sqft)</TableHead>
                          <TableHead className="text-left text-[11px]">Building</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {result.recentComps.map((t, i) => (
                          <TableRow key={`${t.date}-${i}`}>
                            <TableCell className="mono text-[12px] whitespace-nowrap" style={{ color: 'var(--ink-2)' }}>
                              {t.date}
                            </TableCell>
                            <TableCell className="mono text-[12px] text-right" style={{ color: 'var(--ink-2)' }}>
                              {aed.format(t.pricePsf)}
                            </TableCell>
                            <TableCell className="mono text-[12px] text-right" style={{ color: 'var(--ink-2)' }}>
                              {aed.format(t.totalAed)}
                            </TableCell>
                            <TableCell className="mono text-[12px] text-right" style={{ color: 'var(--ink-2)' }}>
                              {aed.format(t.sizeSqft)}
                            </TableCell>
                            <TableCell className="text-[12px]" style={{ color: 'var(--ink-3)' }}>
                              {t.building ?? '—'}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </Card>

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => void downloadReport()}
                    disabled={pdfBusy || !result}
                    className={cn(
                      'inline-flex h-10 items-center gap-2 rounded-full px-5 text-sm font-semibold transition',
                      pdfBusy || !result ? 'opacity-60 cursor-not-allowed' : 'hover:opacity-90',
                    )}
                    style={{ background: 'var(--b600)', color: '#fff' }}
                  >
                    {pdfBusy ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
                    {pdfBusy ? 'Generating report…' : 'Download PDF report'}
                  </button>
                  <span className="text-[11px]" style={{ color: 'var(--ink-5)' }}>
                    Branded PDF with the comparables behind this valuation
                  </span>
                </div>
                {pdfError && (
                  // The route's own explanation, not a generic failure. When there are too
                  // few recorded sales it says so, which is the only useful thing to know.
                  <p className="mt-2 max-w-2xl text-[11px] leading-relaxed" style={{ color: 'var(--down)' }}>
                    {pdfError}
                  </p>
                )}
              </>
            )}
          </div>
        </div>

        {/* ── Enterprise gate ──────────────────────────────────────────── */}
        {tier !== null && !unlocked && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center">
            <Lock size={22} style={{ color: 'var(--b600)' }} />
            <div className="text-base font-bold" style={{ color: 'var(--ink)' }}>
              Comparable Market Analysis
            </div>
            <p className="max-w-md text-xs leading-relaxed" style={{ color: 'var(--ink-3)' }}>
              CMA is an Enterprise tool. It values a unit from real recorded sales of comparable
              units, with the comparables shown — currently available on{' '}
              <span className="font-semibold">Enterprise</span>
              {tier !== 'guest' ? (
                <>
                  {' '}
                  (your plan: <span className="capitalize">{tier}</span>)
                </>
              ) : null}
              .
            </p>
            <button
              type="button"
              onClick={() => onNavigate?.('pricing')}
              className="mt-1 rounded-full px-5 py-2.5 text-sm font-semibold text-white"
              style={{ background: 'linear-gradient(90deg,#2563EB,#6366F1)', boxShadow: 'var(--sh-btn)' }}
            >
              {tier === 'guest' ? 'Sign in to continue' : 'Upgrade to Enterprise'}
            </button>
            <button
              type="button"
              onClick={() => onNavigate?.('pricing')}
              className="inline-flex items-center gap-1.5 text-[11px] font-medium underline-offset-2 hover:underline"
              style={{ color: 'var(--ink-4)' }}
            >
              {tier === 'guest' ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
              Compare plans
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
