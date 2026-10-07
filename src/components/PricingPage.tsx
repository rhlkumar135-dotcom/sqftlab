import { useEffect, useState } from 'react'
import { Check, Minus, Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { PAYMENTS_ENABLED, handlePaymentAttempt } from '@/lib/payments'
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'

// ─── Pricing page (Day 5 Task C) ─────────────────────────────────────────────
//
// Public: no auth required. Prices are in AED and rendered in the data font.
//
// Two deliberate departures from the Day 5 sketch:
//
// 1. The trust strip does not assert the DLD feed unconditionally. That claim
//    is only true when the feed is actually connected, and this project has
//    already been burned by one unconditional "Real-time" label over an empty
//    table (see AboutPage). The strip reads /sqftlab/sources and says what is
//    true on this deployment.
//
// 2. The paid CTAs do not fake a redirect while the payment kill switch is off.
//    They explain, via the same toast the rest of the site uses.

type Billing = 'monthly' | 'annual'
type PaidPlan = 'pro' | 'enterprise'

interface Plan {
  id: 'free' | PaidPlan | 'institutional'
  name: string
  badge: string
  monthly: number
  annual: number
  blurb: string
  cta: string
  featured?: boolean
  dark?: boolean
  features: string[]
  excluded?: string[]
}

const PLANS: Plan[] = [
  {
    id: 'free',
    name: 'Free',
    badge: 'Start here',
    monthly: 0,
    annual: 0,
    blurb: 'See the market before you commit to anything.',
    cta: 'Get started free',
    features: [
      'Market dashboard',
      'Community search (6 communities)',
      '12-month price trends',
      'Investment score (number only)',
      'AI chatbot (10 messages/day)',
      'Mortgage calculator',
    ],
    excluded: ['Saved searches', 'Price alerts', 'CMA', 'PDF reports', 'Portfolio', 'Capital flow', 'API', 'CSV export'],
  },
  {
    id: 'pro',
    name: 'Pro',
    badge: 'Most popular',
    monthly: 499,
    annual: 4990,
    blurb: 'For the investor tracking a portfolio, not a listing.',
    cta: 'Start Pro – 14-day free trial',
    featured: true,
    features: [
      'Everything in Free',
      'Unlimited communities',
      '5-year price trends',
      'Investment score breakdown',
      '5 saved searches',
      'Email + WhatsApp alerts',
      'Portfolio (5 properties)',
      'Ejari yield data',
      'CSV export (1,000 rows/mo)',
      '500 API calls/day',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    badge: 'For brokerages & funds',
    monthly: 4999,
    annual: 49990,
    blurb: 'Positioning, comparables and reporting, at desk scale.',
    cta: 'Start Enterprise – 30-day free trial',
    features: [
      'Everything in Pro',
      'CMA tool',
      'White-label PDF reports',
      'Unlimited portfolio',
      'Capital flow tracker',
      'Developer positioning',
      'Building-level floor breakdown',
      'CSV + Excel export (unlimited)',
      '10,000 API calls/day',
      '3 user seats',
    ],
  },
  {
    id: 'institutional',
    name: 'Institutional',
    badge: 'For banks, developers & funds',
    monthly: 15000,
    annual: 150000,
    blurb: 'The raw feed and the room it feeds.',
    cta: 'Talk to us',
    dark: true,
    features: [
      'Everything in Enterprise',
      'Raw DLD feed access',
      'Webhooks',
      'Deal origination',
      '20 user seats',
      '100,000 API calls/day',
      'SLA 99.9%',
      'Named account manager',
      'Monthly market briefing',
    ],
  },
]

/** Comparison rows. `true` renders a tick, a string renders as-is, `false` a dash. */
const COMPARISON: { label: string; values: [boolean | string, boolean | string, boolean | string, boolean | string] }[] = [
  { label: 'Market dashboard', values: [true, true, true, true] },
  { label: 'Communities covered', values: ['6', 'Unlimited', 'Unlimited', 'Unlimited'] },
  { label: 'Price history', values: ['12 months', '5 years', '5 years +', '5 years +'] },
  { label: 'Investment score', values: ['Number only', 'Full breakdown', 'Full breakdown', 'Full breakdown'] },
  { label: 'AI chatbot', values: ['10 msg/day', '200 msg/day', 'Unlimited', 'Unlimited'] },
  { label: 'Saved searches', values: [false, '5', 'Unlimited', 'Unlimited'] },
  { label: 'Email + WhatsApp alerts', values: [false, true, true, true] },
  { label: 'Portfolio tracking', values: [false, '5 properties', 'Unlimited', 'Unlimited'] },
  { label: 'Ejari yield data', values: [false, true, true, true] },
  { label: 'CMA tool', values: [false, false, true, true] },
  { label: 'White-label PDF reports', values: [false, false, true, true] },
  { label: 'Capital flow tracker', values: [false, false, true, true] },
  { label: 'Developer positioning', values: [false, false, true, true] },
  { label: 'Building-level floors', values: [false, false, true, true] },
  { label: 'CSV export', values: [false, '1,000 rows/mo', 'Unlimited', 'Unlimited'] },
  { label: 'Excel export', values: [false, false, 'Unlimited', 'Unlimited'] },
  { label: 'API calls', values: [false, '500/day', '10,000/day', '100,000/day'] },
  { label: 'User seats', values: ['1', '1', '3', '20'] },
  { label: 'Raw DLD feed + webhooks', values: [false, false, false, true] },
  { label: 'Deal origination', values: [false, false, false, true] },
  { label: 'SLA', values: [false, false, false, '99.9%'] },
  { label: 'Account manager', values: [false, false, false, true] },
  { label: 'Support', values: ['Community', 'Email', 'Priority', 'Named contact'] },
]

const FAQS: { q: string; a: string }[] = [
  {
    q: 'Where does the data come from?',
    a: 'Live portal listings are always included. Registered government transaction records are included where the feed is connected, and the app labels each figure with the source it actually came from — a source that is not connected says so rather than being filled in with an estimate. The Data Sources table on the About page shows current status.',
  },
  {
    q: 'What happens after the free trial?',
    a: 'You keep access for the full trial period — 14 days on Pro, 30 on Enterprise. We do not charge you at the end: a card is only charged once you confirm the subscription continues. Cancel any time before then and nothing is billed.',
  },
  {
    q: 'Can I cancel or change plan later?',
    a: 'Yes. Plans are month-to-month or annual, and you can move between tiers or cancel at any time. Cancelling keeps your access until the end of the period you have already paid for, then drops the account to Free.',
  },
  {
    q: 'How do the API keys work?',
    a: 'API access is included from Pro upwards at the listed daily call limit. Keys are issued on request rather than self-serve, so there is no key-management screen to find — contact us and we will issue one against your account.',
  },
  {
    q: 'Are prices inclusive of VAT?',
    a: 'Prices are quoted in AED. UAE VAT is applied at checkout where it applies, and a tax invoice is issued for every payment. Annual billing is charged once for the year at the discounted rate.',
  },
]

type CellValue = boolean | string

function CompareCell({ value, dark }: { value: CellValue; dark?: boolean }) {
  if (value === true) {
    return <Check size={16} className="mx-auto" style={{ color: 'var(--up)' }} aria-label="Included" />
  }
  if (value === false) {
    return <Minus size={16} className="mx-auto" style={{ color: 'var(--ink-5)' }} aria-label="Not included" />
  }
  return (
    <span className="text-xs whitespace-nowrap" style={{ color: dark ? 'rgba(255,255,255,0.85)' : 'var(--ink-3)' }}>
      {value}
    </span>
  )
}

export default function PricingPage({ onNavigate }: { onNavigate: (page: 'signin' | 'waitlist' | 'dashboard') => void }) {
  const [billing, setBilling] = useState<Billing>('monthly')
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // Deliberately null until known, so the strip cannot assert a feed it has not checked.
  const [dldConnected, setDldConnected] = useState<boolean | null>(null)

  useEffect(() => {
    let alive = true
    // bare-fetch-ok: a public capability probe — which data sources are connected.
    fetch('/api/sqftlab/sources')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { available?: { name: string; connected: boolean }[] } | null) => {
        if (!alive || !d?.available) return
        const dld = d.available.find((s) => s.name.toLowerCase().includes('dld'))
        setDldConnected(dld?.connected ?? false)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  /** Annual is charged once for the year; show what that saves against twelve months. */
  const annualSaving = (p: Plan) => Math.max(0, p.monthly * 12 - p.annual)

  async function startCheckout(plan: PaidPlan) {
    if (!PAYMENTS_ENABLED) {
      handlePaymentAttempt()
      setNotice('Paid plans are not enabled on this deployment yet — the price list above is the planned pricing.')
      return
    }
    setNotice(null)
    setBusy(plan)
    try {
      // bare-fetch-ok: checkout runs on the cookie session (credentials: 'include').
      const res = await fetch('/api/sqftlab/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ plan, billing }),
      })
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string }
      if (res.ok && body.url) {
        window.location.href = body.url
        return
      }
      if (res.status === 401) {
        setNotice('Please sign in to start a subscription.')
        onNavigate('signin')
        return
      }
      setNotice(typeof body.error === 'string' ? body.error : `Request failed (${res.status})`)
    } catch {
      setNotice('Could not reach the server. Please try again.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-10 sm:py-14">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="text-center mb-8">
        <h1 className="text-3xl sm:text-4xl font-extrabold mb-3" style={{ color: 'var(--ink)' }}>
          Intelligence that pays for itself
        </h1>
        <p className="max-w-[620px] mx-auto mb-6 text-sm sm:text-base" style={{ color: 'var(--ink-4)' }}>
          {/*
            The brief's subtitle claims live DLD data on every plan. On this
            deployment the DLD feed is NOT connected, so showing it verbatim would
            sell a paying customer a source that does not exist — the same mistake
            the About page already had to fix. It appears only once the feed is
            genuinely connected; until then the copy says what is actually true.
          */}
          {dldConnected
            ? 'Every plan includes live DLD transaction data. No setup fees. Cancel anytime.'
            : 'Live portal listing data on every plan. Registered DLD transaction records join as soon as that feed is connected. No setup fees. Cancel anytime.'}
        </p>

        <div
          className="inline-flex items-center gap-1 p-1 rounded-[14px]"
          role="group"
          aria-label="Billing period"
          style={{ background: 'var(--g2)', border: '1px solid var(--gb)' }}
        >
          {(['monthly', 'annual'] as const).map((b) => (
            <button
              key={b}
              onClick={() => setBilling(b)}
              aria-pressed={billing === b}
              className={cn(
                'px-4 py-1.5 rounded-[10px] text-sm font-medium transition-all',
                billing === b ? 'font-semibold' : '',
              )}
              style={{
                background: billing === b ? 'var(--b600)' : 'transparent',
                color: billing === b ? '#fff' : 'var(--ink-4)',
              }}
            >
              {b === 'monthly' ? 'Monthly' : 'Annual'}
              {b === 'annual' && (
                <span className="ml-1.5 text-[10px]" style={{ color: billing === 'annual' ? 'rgba(255,255,255,0.9)' : 'var(--up)' }}>
                  2 months free
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {notice && (
        <div
          role="status"
          className="mb-6 p-3 rounded-[14px] text-sm text-center"
          style={{ background: 'var(--b50, rgba(37,99,235,0.08))', border: '1px solid var(--b100)', color: 'var(--ink-2)' }}
        >
          {notice}
        </div>
      )}

      {/* ── Plan cards ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 mb-14 items-start">
        {PLANS.map((p) => {
          const showMonthlyEquivalent = p.monthly > 0 && billing === 'annual'
          const headline = showMonthlyEquivalent ? Math.round(p.annual / 12) : p.monthly
          const isDark = p.dark === true
          return (
            <div
              key={p.id}
              data-tier={p.id}
              className={cn(
                'p-5 sm:p-6 rounded-[18px] relative flex flex-col h-full',
                p.featured && 'lg:scale-[1.02]',
              )}
              style={{
                background: isDark ? '#1a1a2e' : 'var(--g2)',
                border: p.featured ? '2px solid var(--b600)' : `1px solid ${isDark ? '#1a1a2e' : 'var(--gb)'}`,
                boxShadow: p.featured ? 'var(--sh-blue)' : 'var(--sh-card)',
                backdropFilter: isDark ? undefined : 'var(--gblur)',
              }}
            >
              {p.featured && (
                <div
                  className="absolute -top-3 left-1/2 -translate-x-1/2 text-[10px] font-bold px-3 py-1 rounded-full text-white whitespace-nowrap"
                  style={{ background: 'var(--b600)' }}
                >
                  {p.badge}
                </div>
              )}

              <h2 className="text-lg font-bold" style={{ color: isDark ? '#fff' : 'var(--ink)' }}>
                {p.name}
              </h2>
              <p className="text-[11px] mt-0.5 mb-3" style={{ color: isDark ? 'rgba(255,255,255,0.65)' : 'var(--ink-5)' }}>
                {p.featured ? p.blurb : p.badge === 'Start here' ? p.blurb : p.badge}
              </p>

              <div className="mb-1">
                {p.monthly === 0 ? (
                  <span className="text-3xl font-bold" style={{ fontFamily: 'var(--font-data)', color: isDark ? '#fff' : 'var(--ink)' }}>
                    AED 0
                  </span>
                ) : (
                  <>
                    <span className="text-3xl font-bold" style={{ fontFamily: 'var(--font-data)', color: isDark ? '#fff' : 'var(--ink)' }}>
                      AED {headline.toLocaleString('en-AE')}
                    </span>
                    <span className="text-sm" style={{ color: isDark ? 'rgba(255,255,255,0.6)' : 'var(--ink-5)' }}>/mo</span>
                  </>
                )}
              </div>

              {p.monthly > 0 && (
                <p className="text-[11px] mb-4" style={{ fontFamily: 'var(--font-data)', color: isDark ? 'rgba(255,255,255,0.6)' : 'var(--ink-5)' }}>
                  {billing === 'annual' ? (
                    <>
                      AED {p.annual.toLocaleString('en-AE')} billed yearly ·{' '}
                      <span style={{ color: 'var(--up)' }}>save AED {annualSaving(p).toLocaleString('en-AE')}</span>
                    </>
                  ) : (
                    <>AED {(p.monthly * 12).toLocaleString('en-AE')} billed yearly · save AED {annualSaving(p).toLocaleString('en-AE')}</>
                  )}
                </p>
              )}
              {p.monthly === 0 && <div className="mb-4" />}

              <ul className="space-y-2 mb-6 flex-1">
                {p.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-[13px]" style={{ color: isDark ? 'rgba(255,255,255,0.9)' : 'var(--ink-2)' }}>
                    <Check size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--up)' }} aria-hidden="true" />
                    <span>{f}</span>
                  </li>
                ))}
                {p.excluded?.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-[13px]" style={{ color: 'var(--ink-5)' }}>
                    <Minus size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>

              <button
                onClick={() => {
                  if (p.id === 'free') onNavigate('signin')
                  else if (p.id === 'institutional') onNavigate('waitlist')
                  else void startCheckout(p.id)
                }}
                disabled={busy === p.id}
                aria-label={`${p.cta} — ${p.name} plan`}
                className="w-full py-2.5 rounded-[14px] font-semibold transition-colors flex items-center justify-center gap-2 disabled:opacity-70"
                style={{
                  background: p.featured ? 'var(--b600)' : isDark ? 'rgba(255,255,255,0.12)' : 'var(--g3)',
                  color: p.featured ? '#fff' : isDark ? '#fff' : 'var(--ink)',
                  border: p.featured ? 'none' : `1px solid ${isDark ? 'rgba(255,255,255,0.25)' : 'var(--gb)'}`,
                }}
              >
                {busy === p.id && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                {p.cta}
              </button>
            </div>
          )
        })}
      </div>

      {/* ── Feature comparison ─────────────────────────────────────────────── */}
      <section className="mb-14" aria-labelledby="compare-heading">
        <h2 id="compare-heading" className="text-xl sm:text-2xl font-bold mb-1" style={{ color: 'var(--ink)' }}>
          Everything, side by side
        </h2>
        <p className="text-sm mb-4" style={{ color: 'var(--ink-4)' }}>
          {COMPARISON.length} features across four plans.
        </p>
        <div className="rounded-[18px] overflow-hidden" style={{ background: 'var(--g2)', border: '1px solid var(--gb)', boxShadow: 'var(--sh-card)' }}>
          <div className="overflow-x-auto">
            <Table className="min-w-[640px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="text-left">Feature</TableHead>
                  {PLANS.map((p) => (
                    <TableHead key={p.id} className="text-center whitespace-nowrap">
                      {p.name}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {COMPARISON.map((row) => (
                  <TableRow key={row.label}>
                    <TableCell className="text-left text-[13px] font-medium" style={{ color: 'var(--ink-2)' }}>
                      {row.label}
                    </TableCell>
                    {row.values.map((v, i) => (
                      <TableCell key={PLANS[i].id} className="text-center">
                        <CompareCell value={v} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </section>

      {/* ── FAQ ────────────────────────────────────────────────────────────── */}
      <section className="mb-12" aria-labelledby="faq-heading">
        <h2 id="faq-heading" className="text-xl sm:text-2xl font-bold mb-4" style={{ color: 'var(--ink)' }}>
          Questions
        </h2>
        <Accordion className="rounded-[18px] overflow-hidden" style={{ background: 'var(--g2)', border: '1px solid var(--gb)' }}>
          {FAQS.map((f, i) => (
            <AccordionItem key={f.q} value={`faq-${i}`} defaultOpen={i === 0}>
              <AccordionTrigger className="text-left" style={{ color: 'var(--ink)' }}>
                {f.q}
              </AccordionTrigger>
              <AccordionContent style={{ color: 'var(--ink-3)' }}>{f.a}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </section>

      {/* ── Trust strip ────────────────────────────────────────────────────── */}
      <div
        className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-center text-[11px] px-4 py-3 rounded-[14px]"
        style={{ background: 'var(--g3)', border: '1px solid var(--gb)', color: 'var(--ink-4)' }}
      >
        <span>
          Data:{' '}
          {dldConnected === null
            ? 'checking sources…'
            : dldConnected
              ? 'DLD official records connected'
              : 'live portal listings — DLD records not connected on this deployment'}
        </span>
        <span aria-hidden="true">·</span>
        <span>Updated daily</span>
        <span aria-hidden="true">·</span>
        <span>Pricing in AED</span>
      </div>
    </div>
  )
}
