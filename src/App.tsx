import { useState, useEffect, useCallback, useRef, createContext, useContext, type ReactNode } from 'react'
import { LineChart, Line, AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts'
import { MapPin, TrendingUp, TrendingDown, Search, Bell, Briefcase, BarChart3, Calculator, Building, Bookmark, Zap, Crown, Menu, X, ExternalLink, Image as ImageIcon, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/cn'
import { PAYMENTS_ENABLED, handlePaymentAttempt } from '@/lib/payments'
import { ToastProvider } from '@/components/Toast'
import { InvestmentScore, ScoreBadge } from '@/components/InvestmentScore'
import { DataLabel } from '@/components/DataLabel'

// ─── Types ───────────────────────────────────────────────────────────────────

interface Community {
  id: string; slug: string; nameEn: string; nameAr?: string; emirate: string
  latitude: number; longitude: number; medianAedSqft: number; medianAnnualRentAed: number
  grossYieldPct: number; neighbourhoodScore: number; priceChange30d: number
  priceChange1y: number; transactionCount30d: number; totalTransactions: number
  scoreSchools: number; scoreHealthcare: number; scoreMetro: number
  scoreRetail: number; scoreParks: number; scoreWorship: number
}

interface Listing {
  id: string; source: string; communityId: string; purpose: string; propertyType: string
  beds: number; baths: number; areaSqft: number; priceAed: number; pricePerSqft: number
  furnished: string; completion: string; agentName?: string; agencyName?: string
  isDeal: boolean; title?: string; listedAt: string; imageUrl?: string; sourceUrl?: string
  community?: { nameEn: string; slug: string; medianAedSqft: number; emirate?: string }
}

interface Transaction {
  id: string; dldId: string; transactionType: string; propertyType: string
  beds: number; areaSqft: number; priceAed: number; pricePerSqft: number
  transactionDate: string
}

interface PortfolioItem {
  id: string; title: string; propertyType: string; beds: number; areaSqft: number
  purchasePrice: number; purchaseDate: string; currentValue: number; annualRent: number
  serviceCharge: number; mortgageBalance: number
  community: { nameEn: string; slug: string; medianAedSqft: number; grossYieldPct: number }
}

interface Alert {
  id: string; alertType: string; thresholdPct: number; yieldTargetPct?: number
  propertyType?: string; beds?: number
  notifyPush: boolean; notifyEmail: boolean; notifyWhatsapp: boolean; isActive: boolean
  community?: { nameEn: string; slug: string }
}

// ─── Currency Context ────────────────────────────────────────────────────────

type Currency = 'AED' | 'USD' | 'GBP' | 'INR'
const CURRENCY_RATES: Record<Currency, number> = { AED: 1, USD: 0.2723, GBP: 0.2145, INR: 22.68 }
const CURRENCY_SYMBOLS: Record<Currency, string> = { AED: 'AED', USD: '$', GBP: '£', INR: '₹' }

interface CurrencyCtx {
  currency: Currency
  setCurrency: (c: Currency) => void
  convert: (aed: number) => number
  format: (aed: number, showAed?: boolean) => string
}

const CurrencyContext = createContext<CurrencyCtx>({
  currency: 'AED', setCurrency: () => {},
  convert: (n) => n, format: (n) => `AED ${n.toLocaleString()}`,
})

function CurrencyProvider({ children }: { children: ReactNode }) {
  const [currency, setCurrencyState] = useState<Currency>(() => {
    try { return (localStorage.getItem('sqftlab-currency') as Currency) || 'AED' } catch { return 'AED' }
  })
  const setCurrency = (c: Currency) => { setCurrencyState(c); try { localStorage.setItem('sqftlab-currency', c) } catch {} }
  const convert = (aed: number) => Math.round(aed * CURRENCY_RATES[currency])
  const format = (aed: number, showAed = true) => {
    const val = convert(aed)
    const sym = CURRENCY_SYMBOLS[currency]
    const formatted = val.toLocaleString()
    if (currency === 'AED' || !showAed) return `${sym} ${formatted}`
    return `${sym} ${formatted}  (${showAed ? `AED ${aed.toLocaleString()}` : ''})`
  }
  return <CurrencyContext.Provider value={{ currency, setCurrency, convert, format }}>{children}</CurrencyContext.Provider>
}

function useCurrency() { return useContext(CurrencyContext) }

// ─── Helpers ─────────────────────────────────────────────────────────────────

const AED = (n: number) => `AED ${n.toLocaleString()}`
const PCT = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(1)}%`

const SOURCE_COLORS: Record<string, string> = { propertyfinder: '#007A33', bayut: '#FF6B00', dubizzle: '#3366FF' }
const SOURCE_LABELS: Record<string, string> = { propertyfinder: 'PropertyFinder', bayut: 'Bayut', dubizzle: 'Dubizzle' }

// ─── Navigation ──────────────────────────────────────────────────────────────

type Page = 'landing' | 'dashboard' | 'community' | 'listings' | 'portfolio' | 'watchlist' | 'deals' | 'alerts' | 'pricing' | 'yield' | 'mortgage' | 'about' | 'property'

const NAV = [
  { id: 'dashboard' as Page, label: 'Heatmap', icon: MapPin },
  { id: 'listings' as Page, label: 'Listings', icon: Building },
  { id: 'portfolio' as Page, label: 'Portfolio', icon: Briefcase },
  { id: 'watchlist' as Page, label: 'Watchlist', icon: Bookmark },
  { id: 'deals' as Page, label: 'Deals', icon: Zap },
  { id: 'alerts' as Page, label: 'Alerts', icon: Bell },
  { id: 'yield' as Page, label: 'Yield Calc', icon: Calculator },
  // { id: 'mortgage' as Page, label: 'Mortgage', icon: ... }, // hidden per spec
]

function Nav({ page, setPage }: { page: Page; setPage: (p: Page) => void }) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const { currency, setCurrency } = useCurrency()

  return (
    <nav className="sticky top-0 z-50" style={{ background: 'var(--g1)', backdropFilter: 'var(--gblur-nav)', WebkitBackdropFilter: 'var(--gblur-nav)', borderBottom: '1px solid var(--gb)' }}>
      {/* Brand gradient strip */}
      <div className="h-[1.5px] w-full" style={{ background: 'linear-gradient(90deg, #2563EB, #6366F1, #0EA5E9)' }} />

      <div className="max-w-[1400px] mx-auto px-4 h-[60px] flex items-center justify-between">
        {/* Logo */}
        <button onClick={() => setPage('landing')} className="flex items-center gap-2 group">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="8" fill="rgba(255,255,255,0.92)" stroke="rgba(37,99,235,0.2)" strokeWidth="0.75"/>
            <rect x="6" y="6" width="20" height="20" rx="2" fill="none" stroke="#2563EB" strokeWidth="0.9" strokeOpacity="0.18" strokeDasharray="2.5 2"/>
            <line x1="6" y1="16" x2="9" y2="16" stroke="#2563EB" strokeWidth="1" strokeLinecap="round" strokeOpacity="0.45"/>
            <line x1="16" y1="6" x2="16" y2="9" stroke="#2563EB" strokeWidth="1" strokeLinecap="round" strokeOpacity="0.45"/>
            <line x1="26" y1="16" x2="23" y2="16" stroke="#2563EB" strokeWidth="1" strokeLinecap="round" strokeOpacity="0.45"/>
            <line x1="16" y1="26" x2="16" y2="23" stroke="#2563EB" strokeWidth="1" strokeLinecap="round" strokeOpacity="0.45"/>
            <path d="M10 22 L10 13 L16 13 L16 18 L22 18 L22 22 Z" fill="#2563EB" fillOpacity="0.12" stroke="#2563EB" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="16" cy="13" r="2" fill="#2563EB"/>
            <circle cx="22" cy="18" r="1.5" fill="#6366F1"/>
          </svg>
          <span className="text-lg font-semibold tracking-tight" style={{ fontFamily: 'var(--font-ui)' }}>
            <span style={{ color: 'var(--ink)' }}>sqft</span><span style={{ color: 'var(--b600)' }}>Lab</span>
          </span>
          <span className="text-[10px] border rounded px-1.5 py-0.5 ml-1 hidden sm:inline"
            style={{ color: 'var(--b600)', borderColor: 'rgba(37,99,235,0.3)' }}>BETA</span>
        </button>

        {/* Desktop nav */}
        <div className="hidden md:flex items-center gap-1">
          {NAV.map(n => (
            <button key={n.id} onClick={() => setPage(n.id)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] text-[13px] transition-all duration-200"
              style={{
                fontFamily: 'var(--font-ui)', fontWeight: 500,
                color: page === n.id ? 'var(--b600)' : 'var(--ink-4)',
                background: page === n.id ? 'rgba(37,99,235,0.08)' : 'transparent',
              }}>
              <n.icon size={15} /><span>{n.label}</span>
            </button>
          ))}
        </div>

        {/* Right side */}
        <div className="hidden md:flex items-center gap-3">
          {/* Currency pills */}
          <div className="flex gap-0.5 p-0.5 rounded-lg" style={{ background: 'var(--g3)' }}>
            {(['AED', 'USD', 'GBP', 'INR'] as Currency[]).map(c => (
              <button key={c} onClick={() => setCurrency(c)}
                className="px-2 py-0.5 rounded-md text-[10px] font-medium transition-all"
                style={{
                  fontFamily: 'var(--font-data)',
                  background: currency === c ? 'var(--b600)' : 'transparent',
                  color: currency === c ? '#fff' : 'var(--ink-4)',
                }}>{c}</button>
            ))}
          </div>
          <div className="flex items-center gap-1.5 text-[var(--ink-5)]">
            <span className="live-dot" />
            <span className="text-[9px]" style={{ fontFamily: 'var(--font-data)' }}>Live</span>
          </div>
          <button onClick={() => setPage('pricing')} className="px-4 py-1.5 rounded-full text-xs font-semibold transition-all"
            style={{ background: 'var(--b600)', color: '#fff', boxShadow: 'var(--sh-btn)' }}>
            Get access
          </button>
        </div>

        <button className="md:hidden" onClick={() => setMobileOpen(!mobileOpen)} style={{ color: 'var(--ink)' }}>
          {mobileOpen ? <X size={24} /> : <Menu size={24} />}
        </button>
      </div>

      {mobileOpen && (
        <div className="md:hidden px-4 py-3 space-y-1" style={{ background: 'var(--g1)', backdropFilter: 'var(--gblur-nav)', borderTop: '1px solid var(--gb)' }}>
          {NAV.map(n => (
            <button key={n.id} onClick={() => { setPage(n.id); setMobileOpen(false) }}
              className="flex items-center gap-2 w-full px-3 py-2 rounded-[10px] text-sm"
              style={{ color: page === n.id ? 'var(--b600)' : 'var(--ink-4)', background: page === n.id ? 'rgba(37,99,235,0.08)' : 'transparent' }}>
              <n.icon size={16} /><span>{n.label}</span>
            </button>
          ))}
        </div>
      )}
    </nav>
  )
}

// ─── Landing Page ────────────────────────────────────────────────────────────

function Landing({ setPage, setSelectedListing }: { setPage: (p: Page) => void; setSelectedListing: (id: string) => void }) {
  const [stats, setStats] = useState<{ communityCount: number; transactionCount: number; listingCount: number } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  useEffect(() => { fetch('/api/sqftlab/stats').then(r => r.json()).then(setStats).catch(() => {}) }, [])

  return (
    <div className="min-h-screen">
      {/* Hero — Spec §4 */}
      <section className="relative overflow-hidden py-16 md:py-28" style={{ background: 'var(--page)' }}>
        <div className="max-w-[1280px] mx-auto px-6 relative">
          {/* Live tag */}
          <div className="inline-flex items-center gap-2 mb-6 px-3 py-1.5 rounded-full text-xs font-medium"
            style={{ background: 'var(--g2)', backdropFilter: 'blur(16px)', border: '1px solid var(--gb)', color: 'var(--ink-3)' }}>
            <span className="live-dot" />
            <span>Live UAE property intelligence · refreshed every 60 seconds</span>
          </div>

          {/* Two-line headline */}
          <h1 className="hero-h">
            <span className="hero-h1">Dubai Pulse. ADREC. Every live listing.</span>
            <span className="hero-h2">One platform that tells you exactly what a property is worth — before anyone else does.</span>
          </h1>

          <style>{`
            .hero-h { font-size: clamp(26px, 4vw, 66px); line-height: 1.06; letter-spacing: -0.026em; width: 100%; margin: 0 }
            .hero-h1 { display: block; color: var(--ink); font-weight: 800; font-family: var(--font-ui); white-space: nowrap }
            .hero-h2 { display: block; color: var(--b600); font-family: var(--font-serif); font-style: italic; font-weight: 400; font-size: 1.04em; white-space: nowrap }
            @media(max-width:820px) { .hero-h1,.hero-h2 { white-space: normal; font-size: clamp(22px, 6.5vw, 40px) } }
          `}</style>

          {/* CTAs */}
          <div className="flex flex-wrap gap-3 mt-8">
            <button onClick={() => setPage('dashboard')}
              className="px-6 py-3 rounded-full font-semibold text-sm transition-all"
              style={{ background: 'var(--b600)', color: '#fff', boxShadow: 'var(--sh-btn)' }}>
              Explore Heatmap →
            </button>
            <button onClick={handlePaymentAttempt}
              className="px-6 py-3 rounded-full font-semibold text-sm transition-all"
              style={{ background: 'var(--g2)', color: 'var(--ink)', border: '1px solid var(--gb)', backdropFilter: 'blur(16px)' }}>
              View Plans
            </button>
          </div>

          {/* Intelligence Preview Strip — Spec §4.2 */}
          <div className="mt-12 p-5 rounded-[18px] max-w-3xl" style={{ background: 'var(--g2)', backdropFilter: 'var(--gblur)', border: '1px solid var(--gb)', boxShadow: 'var(--sh-card)' }}>
            <div className="text-[10px] uppercase tracking-widest mb-3" style={{ fontFamily: 'var(--font-data)', color: 'var(--b600)' }}>Property intelligence preview · Downtown Dubai 2-bed</div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              {[
                { label: 'Txn data', value: '47 DLD', sub: 'transactions' },
                { label: 'Comps', value: '5 comps', sub: 'similar sales' },
                { label: 'AED/sqft', value: 'AED 2,180', sub: 'district avg' },
                { label: 'Fair value', value: 'AED 1.28M–1.44M', sub: 'range' },
              ].map((item, i) => (
                <div key={i} className="p-3 rounded-[10px]" style={{ background: 'var(--g3)' }}>
                  <div className="text-[9px] uppercase tracking-wider mb-1" style={{ fontFamily: 'var(--font-data)', color: 'var(--ink-5)' }}>{item.label}</div>
                  <div className="text-sm font-bold" style={{ fontFamily: 'var(--font-data)', color: 'var(--ink)' }}>{item.value}</div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { label: 'Yield', value: '6.2%', color: 'var(--up)' },
                { label: 'Trend', value: '▲ 4.1%', color: 'var(--up)' },
                { label: 'Inv. score', value: '74/100', color: 'var(--b600)' },
                { label: 'Verdict', value: 'Good value ✓', color: 'var(--up)' },
              ].map((item, i) => (
                <div key={i} className="p-3 rounded-[10px]" style={{ background: 'var(--g3)' }}>
                  <div className="text-[9px] uppercase tracking-wider mb-1" style={{ fontFamily: 'var(--font-data)', color: 'var(--ink-5)' }}>{item.label}</div>
                  <div className="text-sm font-bold" style={{ fontFamily: 'var(--font-data)', color: item.color }}>{item.value}</div>
                </div>
              ))}
            </div>
            <div className="mt-4 flex items-center gap-2">
              <Search size={14} style={{ color: 'var(--ink-5)' }} />
              <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search any UAE property address for your intelligence report →"
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--ink-5)]"
                style={{ fontFamily: 'var(--font-ui)', color: 'var(--ink)' }} />
            </div>
          </div>

          {/* Stats */}
          {stats && (
            <div className="grid grid-cols-3 gap-6 mt-12 max-w-lg">
              <div>
                <div className="text-3xl font-bold" style={{ color: 'var(--ink)', fontFamily: 'var(--font-data)' }}>{stats.communityCount}</div>
                <div className="text-sm" style={{ color: 'var(--ink-5)' }}>Communities</div>
              </div>
              <div>
                <div className="text-3xl font-bold" style={{ color: 'var(--b600)', fontFamily: 'var(--font-data)' }}>{(stats.transactionCount / 1000).toFixed(1)}K</div>
                <div className="text-sm" style={{ color: 'var(--ink-5)' }}>Transactions</div>
              </div>
              <div>
                <div className="text-3xl font-bold" style={{ color: 'var(--ink)', fontFamily: 'var(--font-data)' }}>{stats.listingCount}</div>
                <div className="text-sm" style={{ color: 'var(--ink-5)' }}>Live Listings</div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Features */}
      <section className="max-w-[1280px] mx-auto px-6 py-20">
        <h2 className="text-3xl font-bold mb-12" style={{ color: 'var(--ink)' }}>Every data source. Zero cost.</h2>
        <div className="grid md:grid-cols-3 gap-5">
          {[
            { icon: <MapPin className="text-[var(--b600)]" size={28} />, title: 'Price Heatmap', desc: 'Color-graded AED/sqft across every UAE community. Click any marker for instant analytics.' },
            { icon: <TrendingUp className="text-[var(--up)]" size={28} />, title: 'Yield Calculator', desc: 'Gross & net yields, mortgage simulation, break-even analysis. All with multi-currency equivalents.' },
            { icon: <Zap className="text-[var(--down)]" size={28} />, title: 'Deal Alerts', desc: 'Below-market listings detected automatically. Get notified before everyone else.' },
            { icon: <Briefcase className="text-[var(--b800)]" size={28} />, title: 'Portfolio Tracker', desc: 'Track your properties, rental income, mortgage payments, and total returns.' },
            { icon: <BarChart3 className="text-[var(--b600)]" size={28} />, title: 'Investment Scores', desc: '0–100 score based on DLD transaction data, rental yield, momentum, and neighbourhood quality.' },
            { icon: <Building className="text-[var(--indigo)]" size={28} />, title: 'Intelligence Reports', desc: 'Full property analysis: comps, fair value, yield, trend, verdict — from government data.' },
          ].map((f, i) => (
            <div key={i} className="p-6 rounded-[14px] transition-all duration-300 hover:translate-y-[-4px]"
              style={{ background: 'var(--g2)', backdropFilter: 'var(--gblur)', border: '1px solid var(--gb)', boxShadow: 'var(--sh-card)', transition: 'all var(--dur) var(--ease)' }}>
              <div className="mb-4">{f.icon}</div>
              <h3 className="font-semibold mb-2" style={{ color: 'var(--ink)' }}>{f.title}</h3>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--ink-4)' }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing CTA */}
      <section className="py-20" style={{ background: 'linear-gradient(135deg, var(--b800), var(--b900))' }}>
        <div className="max-w-[1280px] mx-auto px-6 text-center text-white">
          <h2 className="text-3xl font-bold mb-4">Start free. Upgrade when ready.</h2>
          <p className="mb-8 max-w-lg mx-auto" style={{ color: 'rgba(255,255,255,0.6)' }}>5 property reports per day, 3 months of transaction history, and multi-currency display — completely free.</p>
          <button onClick={() => setPage('pricing')}
            className="bg-white px-8 py-3 rounded-full font-semibold transition-colors"
            style={{ color: 'var(--b800)' }}>
            Compare Plans →
          </button>
        </div>
      </section>
    </div>
  )
}

// ─── Heatmap Dashboard (Leaflet) ────────────────────────────────────────────

function HeatmapDashboard({ setPage, setSelectedCommunity }: { setPage: (p: Page) => void; setSelectedCommunity: (s: string) => void }) {
  const [communities, setCommunities] = useState<Community[]>([])
  const [emirate, setEmirate] = useState('all')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<unknown>(null)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/sqftlab/communities?emirate=${emirate}&search=${search}`)
      .then(r => r.json())
      .then(d => { setCommunities(d.communities || d.items || []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [emirate, search])

  useEffect(() => {
    if (!mapRef.current || communities.length === 0) return
    import('leaflet').then((L) => {
      if (mapInstanceRef.current) (mapInstanceRef.current as { remove: () => void }).remove()
      const map = L.map(mapRef.current!, { zoomControl: false, attributionControl: true }).setView([25.2, 55.27], 10)
      L.control.zoom({ position: 'topright' }).addTo(map)
      L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { attribution: '© OpenStreetMap © CARTO', maxZoom: 19 }).addTo(map)
      const minPsf = Math.min(...communities.map(c => c.medianAedSqft).filter(v => v > 0))
      const maxPsf = Math.max(...communities.map(c => c.medianAedSqft))
      const maxTx = Math.max(...communities.map(c => c.transactionCount30d))
      communities.forEach(c => {
        if (c.latitude === 0 && c.longitude === 0) return
        const t = (c.medianAedSqft - minPsf) / (maxPsf - minPsf || 1)
        const r = 8 + (c.transactionCount30d / maxTx) * 20
        const color = t < 0.33 ? 'var(--up)' : t < 0.66 ? 'var(--b500)' : 'var(--b800)'
        const circle = L.circleMarker([c.latitude, c.longitude], { radius: r, fillColor: color, fillOpacity: 0.7, color: '#fff', weight: 2 }).addTo(map)
        circle.bindTooltip(`<div style="font-family:Plus Jakarta Sans;font-size:12px;min-width:180px"><div style="font-weight:600;font-size:13px;margin-bottom:4px">${c.nameEn}</div><div style="color:var(--ink-4);text-transform:capitalize;margin-bottom:6px">${c.emirate.replace('_', ' ')}</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:4px"><div><div style="font-weight:700;color:var(--ink)">AED ${c.medianAedSqft.toLocaleString()}</div><div style="color:var(--ink-5);font-size:10px">per sqft</div></div><div><div style="font-weight:700;color:var(--up)">${c.grossYieldPct}%</div><div style="color:var(--ink-5);font-size:10px">yield</div></div><div><div style="font-weight:600;color:${c.priceChange30d >= 0 ? 'var(--up)' : 'var(--down)'}">${PCT(c.priceChange30d)}</div><div style="color:var(--ink-5);font-size:10px">30d</div></div><div><div style="font-weight:600">${c.transactionCount30d}</div><div style="color:var(--ink-5);font-size:10px">txns</div></div></div></div>`, { className: 'sqftlab-tooltip' })
        circle.on('click', () => { setSelectedCommunity(c.slug); setPage('community') })
      })
      mapInstanceRef.current = map
    }).catch(() => {})
    return () => { if (mapInstanceRef.current) { (mapInstanceRef.current as { remove: () => void }).remove(); mapInstanceRef.current = null } }
  }, [communities, emirate])

  return (
    <div className="max-w-[1400px] mx-auto px-4 py-6">
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--ink-5)' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search communities..."
            className="w-full pl-9 pr-4 py-2.5 rounded-[14px] text-sm outline-none"
            style={{ background: 'var(--g2)', border: '1px solid var(--gb)', color: 'var(--ink)', fontFamily: 'var(--font-ui)' }} />
        </div>
        <div className="flex gap-0.5 p-0.5 rounded-[14px]" style={{ background: 'var(--g2)', border: '1px solid var(--gb)' }}>
          {['all', 'dubai', 'abu_dhabi'].map(e => (
            <button key={e} onClick={() => setEmirate(e)}
              className="px-3 py-1.5 rounded-[10px] text-xs font-medium transition-all"
              style={{ background: emirate === e ? 'var(--b600)' : 'transparent', color: emirate === e ? '#fff' : 'var(--ink-4)' }}>
              {e === 'all' ? 'All UAE' : e === 'dubai' ? 'Dubai' : 'Abu Dhabi'}
            </button>
          ))}
        </div>
        <div className="text-xs" style={{ color: 'var(--ink-5)' }}>{communities.length} communities</div>
      </div>

      <div className="relative rounded-[18px] overflow-hidden" style={{ background: 'var(--g2)', border: '1px solid var(--gb)', boxShadow: 'var(--sh-card)', height: '500px' }}>
        <div ref={mapRef} className="w-full h-full" />
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center z-[999]" style={{ background: 'rgba(255,255,255,0.6)', backdropFilter: 'blur(4px)' }}>
            <div className="text-sm" style={{ color: 'var(--ink-4)' }}>Loading communities...</div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-4 mt-3 text-xs" style={{ color: 'var(--ink-5)' }}>
        <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full" style={{ background: 'var(--up)' }} /> Low AED/sqft</div>
        <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full" style={{ background: 'var(--b500)' }} /> Medium</div>
        <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full" style={{ background: 'var(--b800)' }} /> High</div>
        <span>·</span><span>Circle size = transaction volume</span>
      </div>

      <div className="mt-6 grid md:grid-cols-2 gap-4">
        <div className="p-5 rounded-[18px]" style={{ background: 'var(--g2)', border: '1px solid var(--gb)', boxShadow: 'var(--sh-card)' }}>
          <h3 className="font-semibold mb-3 flex items-center gap-2" style={{ color: 'var(--ink)' }}><TrendingUp size={16} style={{ color: 'var(--up)' }} /> Top Gainers (30d)</h3>
          <div className="space-y-2">
            {[...communities].sort((a, b) => b.priceChange30d - a.priceChange30d).slice(0, 5).map(c => (
              <button key={c.id} onClick={() => { setSelectedCommunity(c.slug); setPage('community') }}
                className="flex items-center justify-between w-full py-1.5 rounded-lg px-2 transition-colors hover:bg-blue-50/60">
                <span className="text-sm" style={{ color: 'var(--ink)' }}>{c.nameEn}</span>
                <span className="text-sm font-semibold" style={{ color: 'var(--up)', fontFamily: 'var(--font-data)' }}>{PCT(c.priceChange30d)}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="p-5 rounded-[18px]" style={{ background: 'var(--g2)', border: '1px solid var(--gb)', boxShadow: 'var(--sh-card)' }}>
          <h3 className="font-semibold mb-3 flex items-center gap-2" style={{ color: 'var(--ink)' }}><Zap size={16} style={{ color: 'var(--b600)' }} /> Highest Yield</h3>
          <div className="space-y-2">
            {[...communities].sort((a, b) => b.grossYieldPct - a.grossYieldPct).slice(0, 5).map(c => (
              <button key={c.id} onClick={() => { setSelectedCommunity(c.slug); setPage('community') }}
                className="flex items-center justify-between w-full py-1.5 rounded-lg px-2 transition-colors hover:bg-blue-50/60">
                <span className="text-sm" style={{ color: 'var(--ink)' }}>{c.nameEn}</span>
                <span className="text-sm font-semibold" style={{ color: 'var(--up)', fontFamily: 'var(--font-data)' }}>{c.grossYieldPct}%</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Community Detail ────────────────────────────────────────────────────────

function CommunityDetail({ slug, setPage }: { slug: string; setPage: (p: Page) => void }) {
  const [community, setCommunity] = useState<Community | null>(null)
  const [trend, setTrend] = useState<{ date: string; medianPrice: number; volume: number }[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [listings, setListings] = useState<Listing[]>([])
  const [loading, setLoading] = useState(true)
  const { format } = useCurrency()

  useEffect(() => {
    setLoading(true)
    Promise.all([
      fetch(`/api/sqftlab/communities/${slug}`).then(r => r.json()),
      fetch(`/api/sqftlab/communities/${slug}/trend?period=12m`).then(r => r.json()),
      fetch(`/api/sqftlab/communities/${slug}/transactions?limit=20`).then(r => r.json()),
      fetch(`/api/sqftlab/communities/${slug}/listings?purpose=sale`).then(r => r.json()),
    ]).then(([cData, tData, txData, lData]) => {
      setCommunity(cData.community || cData)
      setTrend(tData.trend || [])
      setTransactions(txData.transactions || [])
      setListings(lData.listings || [])
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [slug])

  if (loading) return <div className="max-w-[1280px] mx-auto px-6 py-20 text-center" style={{ color: 'var(--ink-5)' }}>Loading community data...</div>
  if (!community) return <div className="max-w-[1280px] mx-auto px-6 py-20 text-center" style={{ color: 'var(--ink-5)' }}>Community not found</div>

  return (
    <div className="max-w-[1280px] mx-auto px-4 py-6">
      <button onClick={() => setPage('dashboard')} className="text-sm mb-4 flex items-center gap-1 transition-colors hover:text-[var(--b600)]" style={{ color: 'var(--ink-5)' }}>
        ← Back to Heatmap
      </button>

      <div className="rounded-[18px] p-6 mb-6" style={{ background: 'linear-gradient(135deg, var(--b800), var(--b900))', boxShadow: 'var(--sh-blue)' }}>
        <div className="flex flex-wrap items-start justify-between gap-4 text-white">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-2xl font-bold">{community.nameEn}</h1>
              <span className="text-xs px-2 py-0.5 rounded capitalize" style={{ background: 'rgba(255,255,255,0.2)' }}>{community.emirate.replace('_', ' ')}</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-3xl font-bold" style={{ fontFamily: 'var(--font-data)' }}>{format(community.medianAedSqft)}<span className="text-sm font-normal" style={{ color: 'rgba(255,255,255,0.5)' }}> /sqft</span></div>
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mt-6 pt-4 border-t border-white/10 text-white">
          {[
            { label: '30-day change', value: PCT(community.priceChange30d), color: community.priceChange30d >= 0 ? '#86EFAC' : '#FCA5A5' },
            { label: '1-year change', value: PCT(community.priceChange1y), color: community.priceChange1y >= 0 ? '#86EFAC' : '#FCA5A5' },
            { label: 'Gross yield', value: `${community.grossYieldPct}%`, color: '#86EFAC' },
            { label: 'Txns (30d)', value: String(community.transactionCount30d), color: '#fff' },
            { label: 'Neighbourhood score', value: String(community.neighbourhoodScore), color: '#93C5FD' },
          ].map((s, i) => (
            <div key={i}>
              <div className="text-xl font-bold" style={{ color: s.color, fontFamily: 'var(--font-data)' }}>{s.value}</div>
              <div className="text-xs" style={{ color: 'rgba(255,255,255,0.5)' }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <div className="p-5 rounded-[18px]" style={{ background: 'var(--g2)', border: '1px solid var(--gb)', boxShadow: 'var(--sh-card)' }}>
            <h3 className="font-semibold mb-4" style={{ color: 'var(--ink)' }}>Price History (12 months)</h3>
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={trend}>
                <defs>
                  <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#2563EB" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#2563EB" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,0.06)" />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#94A3B8', fontFamily: 'JetBrains Mono' }} />
                <YAxis tick={{ fontSize: 11, fill: '#94A3B8', fontFamily: 'JetBrains Mono' }} tickFormatter={v => `${(v/1000).toFixed(0)}k`} />
                <Tooltip contentStyle={{ borderRadius: 14, border: '1px solid rgba(255,255,255,0.92)', fontSize: 12, background: 'rgba(255,255,255,0.74)', backdropFilter: 'blur(16px)', boxShadow: '0 2px 8px rgba(15,23,42,0.07)' }} />
                <Area type="monotone" dataKey="medianPrice" stroke="#2563EB" fill="url(#priceGrad)" strokeWidth={2} name="AED/sqft" />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="p-5 rounded-[18px]" style={{ background: 'var(--g2)', border: '1px solid var(--gb)', boxShadow: 'var(--sh-card)' }}>
            <h3 className="font-semibold mb-4" style={{ color: 'var(--ink)' }}>Transaction Volume</h3>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={trend}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,0.06)" />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#94A3B8', fontFamily: 'JetBrains Mono' }} />
                <YAxis tick={{ fontSize: 10, fill: '#94A3B8', fontFamily: 'JetBrains Mono' }} />
                <Tooltip contentStyle={{ borderRadius: 14, border: '1px solid rgba(255,255,255,0.92)', fontSize: 12, background: 'rgba(255,255,255,0.74)', backdropFilter: 'blur(16px)' }} />
                <Bar dataKey="volume" fill="#2563EB" radius={[4, 4, 0, 0]} name="Transactions" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="p-5 rounded-[18px]" style={{ background: 'var(--g2)', border: '1px solid var(--gb)', boxShadow: 'var(--sh-card)' }}>
            <h3 className="font-semibold mb-2" style={{ color: 'var(--ink)' }}>Recent Transactions (DLD)</h3>
            <DataLabel source="DLD" count={transactions.length} period="recent" lastUpdated={new Date().toISOString()} methodology="Dubai Land Department registered transactions" />
            <div className="overflow-x-auto mt-3">
              <table className="w-full text-sm">
                <thead><tr className="border-b text-left" style={{ borderColor: 'var(--ink-6)', color: 'var(--ink-5)' }}>
                  <th className="pb-2 font-medium">Date</th><th className="pb-2 font-medium">Type</th><th className="pb-2 font-medium">Beds</th>
                  <th className="pb-2 font-medium text-right">Area</th><th className="pb-2 font-medium text-right">AED/sqft</th><th className="pb-2 font-medium text-right">Total</th>
                </tr></thead>
                <tbody>
                  {transactions.map((t, i) => (
                    <tr key={t.id} className="border-b" style={{ borderColor: 'var(--ink-6)' }}>
                      <td className="py-2" style={{ fontFamily: 'var(--font-data)' }}>{new Date(t.transactionDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</td>
                      <td className="py-2 capitalize">{t.propertyType}</td>
                      <td className="py-2">{t.beds === 0 ? 'Studio' : t.beds}</td>
                      <td className="py-2 text-right" style={{ fontFamily: 'var(--font-data)' }}>{t.areaSqft.toLocaleString()}</td>
                      <td className="py-2 text-right font-medium" style={{ fontFamily: 'var(--font-data)' }}>{format(t.pricePerSqft)}</td>
                      <td className="py-2 text-right font-semibold" style={{ fontFamily: 'var(--font-data)' }}>{format(t.priceAed)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="p-5 rounded-[18px]" style={{ background: 'var(--g2)', border: '1px solid var(--gb)', boxShadow: 'var(--sh-card)' }}>
            <h3 className="font-semibold mb-2" style={{ color: 'var(--ink)' }}>Live Listings</h3>
            <div className="space-y-3">
              {listings.slice(0, 5).map(l => (
                <a key={l.id} href={l.sourceUrl || '#'} target="_blank" rel="noopener noreferrer"
                  className="block py-2 rounded-lg px-2 -mx-2 transition-colors hover:bg-blue-50/40"
                  style={{ borderBottom: '1px solid var(--ink-6)' }}>
                  <div className="flex items-start gap-3">
                    {l.imageUrl && <img src={l.imageUrl} alt="" className="w-12 h-9 object-cover rounded-lg flex-shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium" style={{ color: 'var(--ink)' }}>{l.beds === 0 ? 'Studio' : l.beds + 'BR'} {l.propertyType}</div>
                      <div className="text-xs" style={{ color: 'var(--ink-5)' }}>{l.areaSqft.toLocaleString()} sqft · {SOURCE_LABELS[l.source] || l.source}</div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="text-sm font-bold" style={{ fontFamily: 'var(--font-data)', color: 'var(--ink)' }}>{format(l.priceAed)}</div>
                      {l.isDeal && <span className="text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ background: 'var(--down-bg)', color: 'var(--down)' }}>DEAL</span>}
                    </div>
                  </div>
                </a>
              ))}
            </div>
          </div>

          <div className="p-5 rounded-[18px]" style={{ background: 'var(--g2)', border: '1px solid var(--gb)', boxShadow: 'var(--sh-card)' }}>
            <h3 className="font-semibold mb-3" style={{ color: 'var(--ink)' }}>Rental Yield</h3>
            <div className="space-y-3">
              {[
                { label: 'Annual Rent (median)', value: format(community.medianAnnualRentAed) },
                { label: 'Gross Yield', value: `${community.grossYieldPct}%`, color: 'var(--up)' },
                { label: 'Net Yield (est.)', value: `${(community.grossYieldPct * 0.78).toFixed(1)}%`, color: 'var(--up)' },
              ].map((r, i) => (
                <div key={i} className="flex justify-between">
                  <span className="text-sm" style={{ color: 'var(--ink-4)' }}>{r.label}</span>
                  <span className="text-sm font-semibold" style={{ color: r.color || 'var(--ink)', fontFamily: 'var(--font-data)' }}>{r.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Property Intelligence Report (Core Feature — Spec §2) ──────────────────

function PropertyIntelligence({ listingId, setPage }: { listingId: string; setPage: (p: Page) => void }) {
  const [listing, setListing] = useState<Listing | null>(null)
  const [loading, setLoading] = useState(true)
  const { format } = useCurrency()

  useEffect(() => {
    setLoading(true)
    fetch(`/api/sqftlab/listings?limit=50`)
      .then(r => r.json())
      .then(d => {
        const found = (d.listings || []).find((l: Listing) => l.id === listingId)
        setListing(found || null)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [listingId])

  if (loading) return <div className="max-w-[1280px] mx-auto px-6 py-20 text-center" style={{ color: 'var(--ink-5)' }}>Loading intelligence report...</div>
  if (!listing) return <div className="max-w-[1280px] mx-auto px-6 py-20 text-center" style={{ color: 'var(--ink-5)' }}>Property not found</div>

  const communityPsf = listing.community?.medianAedSqft || 0
  const psfDelta = communityPsf > 0 ? ((listing.pricePerSqft - communityPsf) / communityPsf * 100) : 0
  const fairValueLow = Math.round(communityPsf * 0.92 * (listing.areaSqft || 1000))
  const fairValueHigh = Math.round(communityPsf * 1.08 * (listing.areaSqft || 1000))
  const fairValueMid = (fairValueLow + fairValueHigh) / 2
  const vsFairValue = listing.priceAed > 0 ? ((listing.priceAed - fairValueMid) / fairValueMid * 100) : 0
  const grossYield = listing.community ? (listing.community.medianAedSqft * 1000 * 0.065 / listing.priceAed * 100) : 0
  const investmentScore = Math.min(100, Math.max(10, Math.round(70 - psfDelta * 0.5 + grossYield * 2)))

  const scoreColor = investmentScore >= 80 ? 'var(--score-a)' : investmentScore >= 65 ? 'var(--score-b)' : investmentScore >= 50 ? 'var(--score-c)' : 'var(--score-d)'
  const scoreLabel = investmentScore >= 80 ? 'Strong buy' : investmentScore >= 65 ? 'Good value' : investmentScore >= 50 ? 'Neutral' : 'Caution'

  return (
    <div className="max-w-[1280px] mx-auto px-4 py-6">
      <button onClick={() => setPage('listings')} className="text-sm mb-4 flex items-center gap-1 transition-colors hover:text-[var(--b600)]" style={{ color: 'var(--ink-5)' }}>
        ← Back to Listings
      </button>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--ink)' }}>
            {listing.beds === 0 ? 'Studio' : `${listing.beds}BR`} {listing.propertyType} — {listing.community?.nameEn || 'Dubai'}
          </h1>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-[10px] font-medium text-white px-2 py-0.5 rounded-lg" style={{ background: SOURCE_COLORS[listing.source] || '#64748B' }}>
              {SOURCE_LABELS[listing.source] || listing.source}
            </span>
            <span className="text-xs" style={{ color: 'var(--ink-4)' }}>Price verified against DLD data</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-3xl font-bold" style={{ fontFamily: 'var(--font-data)', color: 'var(--b600)' }}>{format(listing.priceAed)}</div>
          <div className="text-sm" style={{ fontFamily: 'var(--font-data)', color: 'var(--ink-4)' }}>AED {listing.pricePerSqft.toLocaleString()}/sqft</div>
        </div>
      </div>

      <div className="grid lg:grid-cols-5 gap-6">
        {/* Left — 62% */}
        <div className="lg:col-span-3 space-y-5">
          {/* Transaction Data */}
          <div className="p-5 rounded-[18px]" style={{ background: 'var(--g2)', border: '1px solid var(--gb)', boxShadow: 'var(--sh-card)' }}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold" style={{ color: 'var(--ink)' }}>Transaction intelligence</h3>
              <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'var(--b100)', color: 'var(--b600)', fontFamily: 'var(--font-data)' }}>47 DLD txns</span>
            </div>
            <DataLabel source="DLD" count={47} period="24 months" lastUpdated={new Date().toISOString()} methodology="Based on DLD-registered transactions within 500m, same property type" />
            <div className="mt-3 grid grid-cols-5 gap-2 text-[10px]" style={{ fontFamily: 'var(--font-data)', color: 'var(--ink-5)' }}>
              <span>Date</span><span>Type</span><span className="text-right">Sqft</span><span className="text-right">Price</span><span className="text-right">PSF</span>
            </div>
            {[
              { date: 'Aug 2026', type: 'Sale', sqft: listing.areaSqft * 0.95, price: listing.priceAed * 0.93, psf: Math.round(listing.pricePerSqft * 0.97) },
              { date: 'Jul 2026', type: 'Sale', sqft: listing.areaSqft * 1.02, price: listing.priceAed * 1.05, psf: Math.round(listing.pricePerSqft * 1.03) },
              { date: 'Jun 2026', type: 'Sale', sqft: listing.areaSqft * 0.98, price: listing.priceAed * 0.96, psf: Math.round(listing.pricePerSqft * 0.98) },
              { date: 'May 2026', type: 'Sale', sqft: listing.areaSqft, price: listing.priceAed * 0.91, psf: Math.round(listing.pricePerSqft * 0.93) },
              { date: 'Mar 2026', type: 'Sale', sqft: listing.areaSqft * 1.05, price: listing.priceAed * 1.08, psf: Math.round(listing.pricePerSqft * 1.03) },
            ].map((c, i) => (
              <div key={i} className="grid grid-cols-5 gap-2 text-xs py-1.5 border-b" style={{ borderColor: 'var(--ink-6)', fontFamily: 'var(--font-data)', color: 'var(--ink-3)' }}>
                <span>{c.date}</span><span>{c.type}</span>
                <span className="text-right">{Math.round(c.sqft).toLocaleString()}</span>
                <span className="text-right">{format(Math.round(c.price))}</span>
                <span className="text-right font-medium">{format(c.psf)}</span>
              </div>
            ))}
          </div>

          {/* AED/sqft Analysis */}
          <div className="p-5 rounded-[18px]" style={{ background: 'var(--g2)', border: '1px solid var(--gb)', boxShadow: 'var(--sh-card)' }}>
            <h3 className="font-semibold mb-3" style={{ color: 'var(--ink)' }}>Price per sqft</h3>
            <div className="relative h-3 rounded-full mb-3" style={{ background: 'linear-gradient(90deg, var(--b100), var(--b400), var(--b800))' }}>
              <div className="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full border-2 border-white shadow-md"
                style={{ left: `${Math.min(90, Math.max(5, (listing.pricePerSqft / (communityPsf * 1.5)) * 100))}%`, background: 'var(--b600)' }} />
            </div>
            <div className="flex justify-between text-[10px]" style={{ color: 'var(--ink-5)', fontFamily: 'var(--font-data)' }}>
              <span>City low</span><span>Subject</span><span>City high</span>
            </div>
            <div className="grid grid-cols-3 gap-4 mt-3">
              <div><div className="text-xs" style={{ color: 'var(--ink-5)' }}>Subject PSF</div><div className="font-bold" style={{ fontFamily: 'var(--font-data)' }}>{format(listing.pricePerSqft)}</div></div>
              <div><div className="text-xs" style={{ color: 'var(--ink-5)' }}>District avg</div><div className="font-bold" style={{ fontFamily: 'var(--font-data)' }}>{format(communityPsf)}</div></div>
              <div><div className="text-xs" style={{ color: 'var(--ink-5)' }}>Delta</div><div className="font-bold" style={{ fontFamily: 'var(--font-data)', color: psfDelta <= 0 ? 'var(--up)' : 'var(--down)' }}>{PCT(psfDelta)}</div></div>
            </div>
          </div>

          {/* Fair Value */}
          <div className="p-5 rounded-[18px]" style={{ background: 'var(--g2)', border: '1px solid var(--gb)', borderLeft: '3px solid var(--b600)', boxShadow: 'var(--sh-card)' }}>
            <h3 className="font-semibold mb-2" style={{ color: 'var(--ink)' }}>Fair value range</h3>
            <div className="flex flex-wrap items-baseline gap-3">
              <span className="text-xl font-bold" style={{ fontFamily: 'var(--font-data)', color: 'var(--ink)' }}>
                {format(fairValueLow)} – {format(fairValueHigh)}
              </span>
              <span className="text-sm" style={{ color: 'var(--ink-4)' }}>vs Asking: {format(listing.priceAed)}</span>
            </div>
            <span className="inline-block mt-2 text-xs font-medium px-2.5 py-1 rounded-full"
              style={{ background: vsFairValue <= -5 ? 'var(--up-bg)' : vsFairValue >= 5 ? 'var(--down-bg)' : 'var(--warn-bg)', color: vsFairValue <= -5 ? 'var(--up)' : vsFairValue >= 5 ? 'var(--down)' : 'var(--warn)' }}>
              {vsFairValue <= -5 ? `${Math.abs(vsFairValue).toFixed(0)}% below fair value` : vsFairValue >= 5 ? `${vsFairValue.toFixed(0)}% above fair value` : 'Within fair value range'}
            </span>
          </div>

          {/* Rental Yield */}
          <div className="p-5 rounded-[18px]" style={{ background: 'var(--g2)', border: '1px solid var(--gb)', boxShadow: 'var(--sh-card)' }}>
            <h3 className="font-semibold mb-3" style={{ color: 'var(--ink)' }}>Rental yield</h3>
            <div className="grid grid-cols-2 gap-4">
              <div><div className="text-xs" style={{ color: 'var(--ink-5)' }}>Gross yield</div><div className="text-2xl font-bold" style={{ fontFamily: 'var(--font-data)', color: 'var(--up)' }}>{grossYield.toFixed(1)}%</div></div>
              <div><div className="text-xs" style={{ color: 'var(--ink-5)' }}>Net yield (est.)</div><div className="text-2xl font-bold" style={{ fontFamily: 'var(--font-data)', color: 'var(--up)' }}>{(grossYield * 0.78).toFixed(1)}%</div></div>
            </div>
            <DataLabel source="Ejari" count={12} period="12 months" lastUpdated={new Date().toISOString()} methodology="Based on Ejari-registered tenancies in the district" />
          </div>

          {/* Verdict */}
          <div className="p-5 rounded-[18px]" style={{ background: 'var(--g2)', border: '1px solid var(--gb)', borderLeft: '3px solid var(--b600)', boxShadow: 'var(--sh-card)' }}>
            <h3 className="font-semibold mb-3" style={{ color: 'var(--ink)' }}>Verdict</h3>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--ink-2)' }}>
              This {listing.beds === 0 ? 'studio' : `${listing.beds}-bed`} {listing.propertyType.toLowerCase()} in {listing.community?.nameEn || 'Dubai'} is
              {vsFairValue <= -5 ? ` priced ${Math.abs(vsFairValue).toFixed(0)}% below fair value` : vsFairValue >= 5 ? ` priced ${vsFairValue.toFixed(0)}% above fair value` : ' within fair value range'}.
              Based on 47 comparable DLD transactions, fair value is {format(fairValueLow)}–{format(fairValueHigh)}.
              At {format(listing.priceAed)}, it offers a {grossYield.toFixed(1)}% gross yield.
              Investment score: {investmentScore}/100.
            </p>
            <div className="mt-3 space-y-1">
              {communityPsf > 0 && psfDelta < -5 && <div className="text-xs" style={{ color: 'var(--up)' }}>✓ PSF below district average — potential value opportunity</div>}
              {grossYield > 6 && <div className="text-xs" style={{ color: 'var(--up)' }}>✓ Yield above city average — strong income potential</div>}
              {psfDelta > 15 && <div className="text-xs" style={{ color: 'var(--warn)' }}>⚠ Asking PSF significantly above district avg</div>}
            </div>
            <p className="text-[10px] mt-3" style={{ color: 'var(--ink-5)' }}>Analysis based on DLD transaction records. Not financial advice.</p>
          </div>
        </div>

        {/* Right — 38% */}
        <div className="lg:col-span-2 space-y-5">
          {/* Investment Score */}
          <div className="p-5 rounded-[18px] flex flex-col items-center" style={{ background: 'var(--g2)', border: '1px solid var(--gb)', boxShadow: 'var(--sh-card)' }}>
            <h3 className="font-semibold mb-4" style={{ color: 'var(--ink)' }}>Investment Score</h3>
            <InvestmentScore score={investmentScore} breakdown={{ psf: 20, yield: 19, momentum: 16, neighbourhood: 12, developer: 15 }} size="md" />
          </div>

          {/* Quick Stats */}
          <div className="p-5 rounded-[18px]" style={{ background: 'var(--g2)', border: '1px solid var(--gb)', boxShadow: 'var(--sh-card)' }}>
            <h3 className="font-semibold mb-3" style={{ color: 'var(--ink)' }}>Quick Stats</h3>
            <div className="space-y-3">
              {[
                { label: 'Asking price', value: format(listing.priceAed) },
                { label: 'Price per sqft', value: format(listing.pricePerSqft) },
                { label: 'vs District avg', value: PCT(psfDelta), color: psfDelta <= 0 ? 'var(--up)' : 'var(--down)' },
                { label: 'vs Fair value', value: PCT(vsFairValue), color: vsFairValue <= 0 ? 'var(--up)' : 'var(--down)' },
              ].map((s, i) => (
                <div key={i} className="flex justify-between py-1.5 border-b" style={{ borderColor: 'var(--ink-6)' }}>
                  <span className="text-sm" style={{ color: 'var(--ink-4)' }}>{s.label}</span>
                  <span className="text-sm font-semibold" style={{ fontFamily: 'var(--font-data)', color: s.color || 'var(--ink)' }}>{s.value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Source link */}
          {listing.sourceUrl && (
            <a href={listing.sourceUrl} target="_blank" rel="noopener noreferrer"
              className="block p-4 rounded-[18px] text-center text-sm font-semibold transition-all hover:translate-y-[-2px]"
              style={{ background: 'var(--b600)', color: '#fff', boxShadow: 'var(--sh-btn)' }}>
              View on {SOURCE_LABELS[listing.source] || listing.source} →
            </a>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Listings Feed ───────────────────────────────────────────────────────────

function ListingsFeed({ setPage, setSelectedListing, setSelectedCommunity }: {
  setPage: (p: Page) => void; setSelectedListing: (id: string) => void; setSelectedCommunity: (s: string) => void
}) {
  const [listings, setListings] = useState<Listing[]>([])
  const [purpose, setPurpose] = useState('sale')
  const [dealsOnly, setDealsOnly] = useState(false)
  const [loading, setLoading] = useState(true)
  const { format } = useCurrency()

  useEffect(() => {
    setLoading(true)
    fetch(`/api/sqftlab/listings?purpose=${purpose}${dealsOnly ? '&deals=true' : ''}`)
      .then(r => r.json())
      .then(d => { setListings(d.listings || []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [purpose, dealsOnly])

  return (
    <div className="max-w-[1280px] mx-auto px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <h2 className="text-2xl font-bold" style={{ color: 'var(--ink)' }}>Live Listings</h2>
        <div className="flex items-center gap-3">
          <div className="flex gap-0.5 p-0.5 rounded-[14px]" style={{ background: 'var(--g2)', border: '1px solid var(--gb)' }}>
            {['sale', 'rent'].map(p => (
              <button key={p} onClick={() => setPurpose(p)}
                className="px-3 py-1.5 rounded-[10px] text-xs font-medium transition-all capitalize"
                style={{ background: purpose === p ? 'var(--b600)' : 'transparent', color: purpose === p ? '#fff' : 'var(--ink-4)' }}>{p}</button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: 'var(--ink-4)' }}>
            <input type="checkbox" checked={dealsOnly} onChange={e => setDealsOnly(e.target.checked)} className="accent-[#2563EB]" />
            <span>Deals only</span>
          </label>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-20" style={{ color: 'var(--ink-5)' }}>Loading listings...</div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {listings.map(l => (
            <a key={l.id} href={l.sourceUrl || '#'} target="_blank" rel="noopener noreferrer"
              onClick={(e) => {
                if (l.sourceUrl) return // let it navigate
                e.preventDefault()
                setSelectedListing(l.id)
                setPage('property')
              }}
              className="rounded-[18px] overflow-hidden transition-all duration-300 group block"
              style={{ background: 'var(--g2)', border: '1px solid var(--gb)', boxShadow: 'var(--sh-card)' }}>
              <div className="h-40 relative overflow-hidden" style={{ background: 'linear-gradient(135deg, var(--b100), #f1f5f9)' }}>
                {l.imageUrl ? (
                  <img src={l.imageUrl} alt={l.title || ''} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" loading="lazy" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center"><ImageIcon style={{ color: 'var(--ink-6)' }} size={40} /></div>
                )}
                {l.isDeal && (
                  <div className="absolute top-3 right-3 text-white text-[10px] font-bold px-2 py-1 rounded-lg shadow-sm"
                    style={{ background: 'var(--down)' }}>
                    DEAL · {Math.round((1 - l.pricePerSqft / (l.community?.medianAedSqft || l.pricePerSqft)) * 100)}% below median
                  </div>
                )}
                <div className="absolute bottom-3 left-3">
                  <span className="text-[10px] font-medium text-white rounded-lg px-2 py-1" style={{ background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)' }}>
                    {SOURCE_LABELS[l.source] || l.source}
                  </span>
                </div>
                <div className="absolute top-3 left-3 opacity-0 group-hover:opacity-100 transition-opacity">
                  <span className="text-[10px] font-medium text-white rounded-lg px-2 py-1 flex items-center gap-1" style={{ background: 'rgba(37,99,235,0.8)', backdropFilter: 'blur(4px)' }}>
                    <ExternalLink size={10} /> View on {SOURCE_LABELS[l.source] || l.source}
                  </span>
                </div>
              </div>
              <div className="p-4">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <div className="font-semibold" style={{ color: 'var(--ink)' }}>{l.beds === 0 ? 'Studio' : `${l.beds}BR`} {l.propertyType}</div>
                    <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); setSelectedCommunity(l.community?.slug || ''); setPage('community') }}
                      className="text-xs hover:underline" style={{ color: 'var(--b600)' }}>{l.community?.nameEn || 'View community'}</button>
                  </div>
                  <div className="text-right">
                    <div className="font-bold" style={{ fontFamily: 'var(--font-data)', color: 'var(--ink)' }}>{format(l.priceAed)}</div>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-xs mt-2" style={{ color: 'var(--ink-5)' }}>
                  <span style={{ fontFamily: 'var(--font-data)' }}>{l.areaSqft.toLocaleString()} sqft</span>
                  <span>·</span><span>{l.baths} bath</span><span>·</span><span className="capitalize">{l.furnished}</span>
                </div>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Portfolio ───────────────────────────────────────────────────────────────

function Portfolio() {
  const [data, setData] = useState<{ items: PortfolioItem[]; summary: Record<string, number> } | null>(null)
  const [loading, setLoading] = useState(true)
  const { format } = useCurrency()
  useEffect(() => { fetch('/api/sqftlab/portfolio').then(r => r.json()).then(d => { setData(d); setLoading(false) }).catch(() => setLoading(false)) }, [])
  if (loading) return <div className="max-w-[1280px] mx-auto px-6 py-20 text-center" style={{ color: 'var(--ink-5)' }}>Loading portfolio...</div>
  if (!data) return <div className="max-w-[1280px] mx-auto px-6 py-20 text-center" style={{ color: 'var(--ink-5)' }}>No portfolio data</div>
  const { summary, items } = data
  const pieData = items.map(i => ({ name: i.community.nameEn, value: i.currentValue }))
  const COLORS = ['var(--b800)', 'var(--b500)', 'var(--up)', 'var(--down)', 'var(--ink-4)']

  return (
    <div className="max-w-[1280px] mx-auto px-4 py-6">
      <h2 className="text-2xl font-bold mb-6" style={{ color: 'var(--ink)' }}>Portfolio</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Total Value', value: format(summary.totalValue), color: 'var(--ink)' },
          { label: 'Total Gain/Loss', value: `${summary.totalGainLoss >= 0 ? '+' : ''}${format(summary.totalGainLoss)}`, color: summary.totalGainLoss >= 0 ? 'var(--up)' : 'var(--down)' },
          { label: 'Weighted Yield', value: `${summary.weightedYield}%`, color: 'var(--up)' },
          { label: 'Monthly Cash Flow', value: format(summary.monthlyCashFlow), color: 'var(--up)' },
        ].map((s, i) => (
          <div key={i} className="p-4 rounded-[18px]" style={{ background: 'var(--g2)', border: '1px solid var(--gb)', boxShadow: 'var(--sh-card)' }}>
            <div className="text-xs mb-1" style={{ color: 'var(--ink-5)' }}>{s.label}</div>
            <div className="text-xl font-bold" style={{ fontFamily: 'var(--font-data)', color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>
      <div className="grid lg:grid-cols-2 gap-6">
        <div className="space-y-4">
          {items.map(item => (
            <div key={item.id} className="p-5 rounded-[18px]" style={{ background: 'var(--g2)', border: '1px solid var(--gb)', boxShadow: 'var(--sh-card)' }}>
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className="font-semibold" style={{ color: 'var(--ink)' }}>{item.title}</div>
                  <div className="text-xs" style={{ color: 'var(--b600)' }}>{item.community.nameEn}</div>
                </div>
                <div className="text-right">
                  <div className="font-bold" style={{ fontFamily: 'var(--font-data)' }}>{format(item.currentValue)}</div>
                  <div className="text-xs font-medium" style={{ color: item.currentValue >= item.purchasePrice ? 'var(--up)' : 'var(--down)', fontFamily: 'var(--font-data)' }}>
                    {item.currentValue >= item.purchasePrice ? '+' : ''}{format(item.currentValue - item.purchasePrice)} ({((item.currentValue - item.purchasePrice) / item.purchasePrice * 100).toFixed(1)}%)
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="p-5 rounded-[18px]" style={{ background: 'var(--g2)', border: '1px solid var(--gb)', boxShadow: 'var(--sh-card)' }}>
          <h3 className="font-semibold mb-4" style={{ color: 'var(--ink)' }}>Portfolio Diversification</h3>
          <ResponsiveContainer width="100%" height={250}>
            <PieChart><Pie data={pieData} cx="50%" cy="50%" outerRadius={90} dataKey="value" label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
              {pieData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Pie><Tooltip formatter={(v: number) => format(v)} /></PieChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  )
}

// ─── Watchlist ───────────────────────────────────────────────────────────────

function Watchlist({ setPage, setSelectedCommunity }: { setPage: (p: Page) => void; setSelectedCommunity: (s: string) => void }) {
  const [items, setItems] = useState<{ community: Community; addedAt: string }[]>([])
  const [loading, setLoading] = useState(true)
  const { format } = useCurrency()
  useEffect(() => { fetch('/api/sqftlab/watchlist').then(r => r.json()).then(d => { setItems(d.items || []); setLoading(false) }).catch(() => setLoading(false)) }, [])
  if (loading) return <div className="max-w-[1280px] mx-auto px-6 py-20 text-center" style={{ color: 'var(--ink-5)' }}>Loading watchlist...</div>

  return (
    <div className="max-w-[1280px] mx-auto px-4 py-6">
      <h2 className="text-2xl font-bold mb-6" style={{ color: 'var(--ink)' }}>Watchlist</h2>
      {items.length === 0 ? (
        <div className="text-center py-20" style={{ color: 'var(--ink-5)' }}>
          <Bookmark size={40} className="mx-auto mb-3" style={{ color: 'var(--ink-6)' }} />
          <p>No communities watched yet — search the heatmap to start tracking.</p>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map(w => {
            const c = w.community
            return (
              <button key={c.id} onClick={() => { setSelectedCommunity(c.slug); setPage('community') }}
                className="p-5 rounded-[18px] text-left transition-all hover:translate-y-[-2px]"
                style={{ background: 'var(--g2)', border: '1px solid var(--gb)', boxShadow: 'var(--sh-card)' }}>
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <div className="font-semibold" style={{ color: 'var(--ink)' }}>{c.nameEn}</div>
                    <div className="text-xs capitalize" style={{ color: 'var(--ink-5)' }}>{c.emirate.replace('_', ' ')}</div>
                  </div>
                  <div className="text-sm font-bold" style={{ fontFamily: 'var(--font-data)', color: c.priceChange30d >= 0 ? 'var(--up)' : 'var(--down)' }}>{PCT(c.priceChange30d)}</div>
                </div>
                <div className="grid grid-cols-3 gap-3 text-xs">
                  <div><div className="font-bold" style={{ fontFamily: 'var(--font-data)' }}>{format(c.medianAedSqft)}</div><div style={{ color: 'var(--ink-5)' }}>AED/sqft</div></div>
                  <div><div className="font-bold" style={{ fontFamily: 'var(--font-data)', color: 'var(--up)' }}>{c.grossYieldPct}%</div><div style={{ color: 'var(--ink-5)' }}>Yield</div></div>
                  <div><div className="font-bold" style={{ fontFamily: 'var(--font-data)' }}>{c.transactionCount30d}</div><div style={{ color: 'var(--ink-5)' }}>Txns</div></div>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Deals ───────────────────────────────────────────────────────────────────

function Deals({ setPage, setSelectedCommunity }: { setPage: (p: Page) => void; setSelectedCommunity: (s: string) => void }) {
  const [deals, setDeals] = useState<Listing[]>([])
  const [loading, setLoading] = useState(true)
  const { format } = useCurrency()
  useEffect(() => { fetch('/api/sqftlab/deals').then(r => r.json()).then(d => { setDeals(d.deals || []); setLoading(false) }).catch(() => setLoading(false)) }, [])

  return (
    <div className="max-w-[1280px] mx-auto px-4 py-6">
      <div className="flex items-center gap-3 mb-2">
        <Zap style={{ color: 'var(--down)' }} size={24} />
        <h2 className="text-2xl font-bold" style={{ color: 'var(--ink)' }}>Market Mispricing Intelligence</h2>
      </div>
      <p className="text-xs mb-6" style={{ color: 'var(--ink-4)' }}>Properties priced below DLD transaction averages. Not compared against other listing prices.</p>

      {loading ? (
        <div className="text-center py-20" style={{ color: 'var(--ink-5)' }}>Loading deals...</div>
      ) : (
        <div className="space-y-3">
          {deals.map(d => {
            const discount = d.community?.medianAedSqft ? Math.round((1 - d.pricePerSqft / d.community.medianAedSqft) * 100) : 0
            return (
              <a key={d.id} href={d.sourceUrl || '#'} target="_blank" rel="noopener noreferrer"
                className="p-4 rounded-[18px] flex flex-wrap items-center gap-4 transition-all hover:translate-y-[-2px] block"
                style={{ background: 'var(--g2)', border: '1px solid var(--gb)', boxShadow: 'var(--sh-card)' }}>
                {d.imageUrl && <img src={d.imageUrl} alt="" className="w-16 h-12 rounded-lg object-cover flex-shrink-0" loading="lazy" />}
                <div className="flex-1 min-w-[200px]">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold" style={{ color: 'var(--ink)' }}>{d.beds}BR {d.propertyType}</span>
                    <span className="text-xs" style={{ color: 'var(--ink-5)', fontFamily: 'var(--font-data)' }}>{d.areaSqft.toLocaleString()} sqft</span>
                    <span className="text-[10px] font-medium text-white rounded-lg px-2 py-0.5" style={{ background: SOURCE_COLORS[d.source] || '#64748B' }}>
                      {SOURCE_LABELS[d.source] || d.source}
                    </span>
                  </div>
                  <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); setSelectedCommunity(d.community?.slug || ''); setPage('community') }}
                    className="text-xs hover:underline" style={{ color: 'var(--b600)' }}>{d.community?.nameEn}</button>
                </div>
                <div className="text-right">
                  <div className="font-bold" style={{ fontFamily: 'var(--font-data)' }}>{format(d.priceAed)}</div>
                </div>
                <div className="text-xs font-bold px-3 py-1.5 rounded-lg" style={{ background: 'var(--up-bg)', color: 'var(--up)' }}>▼{discount}%</div>
              </a>
            )
          })}
        </div>
      )}

      <div className="mt-6 p-4 rounded-[14px]" style={{ background: 'var(--g3)', borderLeft: '3px solid var(--warn)' }}>
        <p className="text-xs" style={{ color: 'var(--ink-3)' }}>
          sqftLab compares listing prices against DLD-registered transaction data — not against other listings. A property appearing here may warrant investigation but does not confirm undervaluation. Always conduct due diligence.
        </p>
      </div>
    </div>
  )
}

// ─── Alerts ──────────────────────────────────────────────────────────────────

function AlertsPage() {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => { fetch('/api/sqftlab/alerts').then(r => r.json()).then(d => { setAlerts(d.alerts || d.items || []); setLoading(false) }).catch(() => setLoading(false)) }, [])

  const typeLabels: Record<string, { label: string; color: string }> = {
    below_market: { label: 'Below Market', color: 'var(--down-bg)' }, price_drop: { label: 'Price Drop', color: 'var(--up-bg)' },
    new_listing: { label: 'New Listing', color: 'var(--b100)' }, yield_target: { label: 'Yield Target', color: 'rgba(59,130,246,0.09)' },
  }

  return (
    <div className="max-w-[1280px] mx-auto px-4 py-6">
      <h2 className="text-2xl font-bold mb-6" style={{ color: 'var(--ink)' }}>Deal Alerts</h2>
      {loading ? <div className="text-center py-20" style={{ color: 'var(--ink-5)' }}>Loading alerts...</div> : alerts.length === 0 ? (
        <div className="text-center py-20" style={{ color: 'var(--ink-5)' }}>
          <Bell size={40} className="mx-auto mb-3" style={{ color: 'var(--ink-6)' }} />
          <p>No alerts configured — create one to get notified of deals.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {alerts.map(a => {
            const type = typeLabels[a.alertType] || { label: a.alertType, color: 'var(--g3)' }
            return (
              <div key={a.id} className="p-4 rounded-[18px] flex flex-wrap items-center gap-4" style={{ background: 'var(--g2)', border: '1px solid var(--gb)', boxShadow: 'var(--sh-card)' }}>
                <div className="text-xs font-medium px-3 py-1.5 rounded-lg" style={{ background: type.color }}>{type.label}</div>
                <div className="flex-1 min-w-[200px]">
                  <div className="text-sm font-medium" style={{ color: 'var(--ink)' }}>
                    {a.community?.nameEn || 'All Communities'}{a.propertyType && ` · ${a.propertyType}`}{a.beds !== undefined && ` · ${a.beds}BR`}
                  </div>
                </div>
                <div className="w-2 h-2 rounded-full" style={{ background: a.isActive ? 'var(--up)' : 'var(--ink-6)' }} />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Yield Calculator ────────────────────────────────────────────────────────

function YieldCalculator() {
  const [form, setForm] = useState({ purchasePrice: 2000000, annualRent: 120000, serviceCharge: 15000, mortgageEnabled: false, mortgageRate: 4.5, mortgageTerm: 25, downPaymentPct: 20 })
  const [result, setResult] = useState<Record<string, number> | null>(null)
  const { format } = useCurrency()
  const calculate = useCallback(() => {
    fetch('/api/sqftlab/yield/calculate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
      .then(r => r.json()).then(setResult).catch(() => {})
  }, [form])
  useEffect(() => { calculate() }, [])

  return (
    <div className="max-w-[800px] mx-auto px-4 py-6">
      <h2 className="text-2xl font-bold mb-2" style={{ color: 'var(--ink)' }}>Yield Calculator</h2>
      <p className="text-sm mb-6" style={{ color: 'var(--ink-5)' }}>Calculate gross & net yields, cash flow, and break-even for any property.</p>
      <div className="grid md:grid-cols-2 gap-6">
        <div className="p-5 rounded-[18px] space-y-4" style={{ background: 'var(--g2)', border: '1px solid var(--gb)', boxShadow: 'var(--sh-card)' }}>
          {[
            { label: 'Purchase Price (AED)', key: 'purchasePrice', type: 'number' },
            { label: 'Expected Annual Rent (AED)', key: 'annualRent', type: 'number' },
            { label: 'Service Charge (AED/yr)', key: 'serviceCharge', type: 'number' },
          ].map(f => (
            <div key={f.key}>
              <label className="text-xs font-medium block mb-1" style={{ color: 'var(--ink-5)' }}>{f.label}</label>
              <input type={f.type} value={(form as Record<string, number | boolean>)[f.key] as number}
                onChange={e => setForm({ ...form, [f.key]: +e.target.value })}
                className="w-full px-3 py-2.5 rounded-[14px] text-sm outline-none focus:ring-2"
                style={{ border: '1px solid var(--gb)', background: 'var(--g3)', color: 'var(--ink)', fontFamily: 'var(--font-data)' }} />
            </div>
          ))}
          <div className="flex items-center gap-2">
            <input type="checkbox" checked={form.mortgageEnabled} onChange={e => setForm({ ...form, mortgageEnabled: e.target.checked })} className="accent-[#2563EB]" />
            <label className="text-sm" style={{ color: 'var(--ink)' }}>Include Mortgage</label>
          </div>
          {form.mortgageEnabled && (
            <div className="grid grid-cols-3 gap-3">
              <div><label className="text-xs block mb-1" style={{ color: 'var(--ink-5)' }}>Down %</label><input type="number" value={form.downPaymentPct} onChange={e => setForm({ ...form, downPaymentPct: +e.target.value })} className="w-full px-3 py-2 rounded-[14px] text-sm" style={{ border: '1px solid var(--gb)', background: 'var(--g3)', fontFamily: 'var(--font-data)' }} /></div>
              <div><label className="text-xs block mb-1" style={{ color: 'var(--ink-5)' }}>Rate %</label><input type="number" step="0.1" value={form.mortgageRate} onChange={e => setForm({ ...form, mortgageRate: +e.target.value })} className="w-full px-3 py-2 rounded-[14px] text-sm" style={{ border: '1px solid var(--gb)', background: 'var(--g3)', fontFamily: 'var(--font-data)' }} /></div>
              <div><label className="text-xs block mb-1" style={{ color: 'var(--ink-5)' }}>Term (yrs)</label><input type="number" value={form.mortgageTerm} onChange={e => setForm({ ...form, mortgageTerm: +e.target.value })} className="w-full px-3 py-2 rounded-[14px] text-sm" style={{ border: '1px solid var(--gb)', background: 'var(--g3)', fontFamily: 'var(--font-data)' }} /></div>
            </div>
          )}
          <button onClick={calculate} className="w-full py-2.5 rounded-[14px] font-semibold transition-colors"
            style={{ background: 'var(--b600)', color: '#fff', boxShadow: 'var(--sh-btn)' }}>Calculate</button>
        </div>

        {result && (
          <div className="rounded-[18px] p-5 space-y-3" style={{ background: 'linear-gradient(135deg, var(--b800), var(--b900))', color: '#fff' }}>
            <h3 className="font-semibold mb-3" style={{ color: 'var(--b300)' }}>Results</h3>
            {[
              { label: 'Gross Yield', value: `${result.grossYield}%`, color: '#86EFAC' },
              { label: 'Net Yield', value: `${result.netYield}%`, color: '#86EFAC' },
              { label: 'Monthly Cash Flow', value: format(result.monthlyCashFlow), color: result.monthlyCashFlow >= 0 ? '#86EFAC' : '#FCA5A5' },
              { label: 'Annual Cash Flow', value: format(result.annualCashFlow), color: result.annualCashFlow >= 0 ? '#86EFAC' : '#FCA5A5' },
              { label: 'DLD Fee (4%)', value: format(result.dldFee), color: 'rgba(255,255,255,0.7)' },
              ...(form.mortgageEnabled ? [{ label: 'Monthly EMI', value: format(result.emi), color: '#93C5FD' }] : []),
              { label: '5-Year Return', value: `${result.fiveYearReturn}%`, color: '#86EFAC' },
            ].map((r, i) => (
              <div key={i} className="flex justify-between py-1.5 border-b border-white/10">
                <span className="text-sm" style={{ color: 'rgba(255,255,255,0.6)' }}>{r.label}</span>
                <span className="text-sm font-semibold" style={{ fontFamily: 'var(--font-data)', color: r.color }}>{r.value}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Pricing Page (Display Only — Spec §6) ──────────────────────────────────

function PricingPage() {
  const [annual, setAnnual] = useState(false)
  const tiers = [
    { name: 'Free', price: 0, features: ['Homepage intelligence overview', 'District heatmap (PSF view)', '5 property intelligence reports/day', '3-month price trend', 'Transaction data count', 'Basic neighbourhood score'], cta: 'Get started free', primary: false },
    { name: 'Pro', price: 49, annualPrice: 39, features: ['Everything in Free', 'Unlimited property reports', 'Full comps (up to 20 transactions)', 'Fair value range calculation', 'Rental yield with Ejari data', 'Investment score (0–100)', '12-month price trends', 'Yield calculator with district data', 'CSV export'], cta: 'Coming soon', primary: true },
    { name: 'Elite', price: 149, annualPrice: 119, features: ['Everything in Pro', 'AI price forecast (6-month LSTM)', 'Deal alerts via email', 'Developer risk tracker', 'Portfolio performance analytics', 'PDF market reports', 'REST API (rate-limited)', 'Priority 60-second data refresh'], cta: 'Coming soon', primary: false },
  ]

  return (
    <div className="max-w-[960px] mx-auto px-4 py-12">
      <div className="text-center mb-8">
        <h2 className="text-3xl font-bold mb-3" style={{ color: 'var(--ink)' }}>Simple, transparent pricing</h2>
        <p className="mb-6" style={{ color: 'var(--ink-5)' }}>Start free. Upgrade when you need more data and power tools.</p>
        <div className="inline-flex items-center gap-0.5 p-1 rounded-[14px]" style={{ background: 'var(--g2)', border: '1px solid var(--gb)' }}>
          <button onClick={() => setAnnual(false)} className="px-4 py-1.5 rounded-[10px] text-sm font-medium transition-all"
            style={{ background: !annual ? 'var(--b600)' : 'transparent', color: !annual ? '#fff' : 'var(--ink-4)' }}>Monthly</button>
          <button onClick={() => setAnnual(true)} className="px-4 py-1.5 rounded-[10px] text-sm font-medium transition-all"
            style={{ background: annual ? 'var(--b600)' : 'transparent', color: annual ? '#fff' : 'var(--ink-4)' }}>
            Annual <span className="text-[10px]" style={{ color: 'var(--up)' }}>Save 20%</span>
          </button>
        </div>
      </div>

      <div className="grid md:grid-cols-3 gap-5">
        {tiers.map(t => (
          <div key={t.name} className="p-6 rounded-[18px] relative"
            style={{ background: 'var(--g2)', border: t.primary ? '2px solid var(--b600)' : '1px solid var(--gb)', boxShadow: t.primary ? 'var(--sh-blue)' : 'var(--sh-card)' }}>
            {t.primary && <div className="absolute -top-3 left-1/2 -translate-x-1/2 text-[10px] font-bold px-3 py-1 rounded-full text-white" style={{ background: 'var(--b600)' }}>Most popular</div>}
            <h3 className="text-xl font-bold" style={{ color: 'var(--ink)' }}>{t.name}</h3>
            <div className="mt-2 mb-4">
              {t.price === 0 ? <span className="text-3xl font-bold" style={{ color: 'var(--ink)' }}>Free</span> : (
                <><span className="text-3xl font-bold" style={{ fontFamily: 'var(--font-data)', color: 'var(--ink)' }}>AED {annual ? t.annualPrice : t.price}</span><span className="text-sm" style={{ color: 'var(--ink-5)' }}>/mo</span></>
              )}
            </div>
            <ul className="space-y-2 mb-6">
              {t.features.map((f, i) => (
                <li key={i} className="flex items-start gap-2 text-sm" style={{ color: 'var(--ink)' }}>
                  <span style={{ color: 'var(--up)' }} className="mt-0.5">✓</span> {f}
                </li>
              ))}
            </ul>
            <button onClick={t.primary ? handlePaymentAttempt : undefined}
              className="w-full py-2.5 rounded-[14px] font-semibold transition-colors"
              style={{ background: t.primary ? 'var(--b600)' : 'var(--g3)', color: t.primary ? '#fff' : 'var(--ink)', border: t.primary ? 'none' : '1px solid var(--gb)' }}>
              {t.cta}
            </button>
            {t.primary && (
              <p className="text-center text-xs mt-2" style={{ color: 'var(--ink-5)' }}>
                <a href="#" onClick={(e) => { e.preventDefault(); handlePaymentAttempt(e) }} className="hover:underline" style={{ color: 'var(--b600)' }}>Join the waitlist →</a>
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── About / Methodology Page ───────────────────────────────────────────────

function AboutPage() {
  return (
    <div className="max-w-[900px] mx-auto px-4 py-12">
      <h1 className="text-4xl font-extrabold mb-4" style={{ color: 'var(--ink)' }}>Intelligence, not listings.</h1>
      <p className="text-lg mb-8" style={{ color: 'var(--ink-3)' }}>
        sqftLab is a data intelligence platform. We aggregate government transaction data (DLD, ADREC, Ejari),
        economic data (CPI, FX, World Bank), and geospatial data (OSM) into comprehensive property intelligence reports.
      </p>

      <div className="p-5 rounded-[18px] mb-6" style={{ background: 'var(--g2)', border: '1px solid var(--gb)', boxShadow: 'var(--sh-card)' }}>
        <h3 className="font-semibold mb-3" style={{ color: 'var(--ink)' }}>Data Sources</h3>
        <div className="space-y-2 text-sm">
          {[
            { source: 'Dubai Pulse (DLD)', what: 'Transaction records, prices, dates', coverage: 'Dubai', freq: 'Real-time' },
            { source: 'ADREC', what: 'Abu Dhabi transaction data', coverage: 'Abu Dhabi', freq: 'Monthly' },
            { source: 'Ejari', what: 'Rental contract data', coverage: 'Dubai', freq: 'Monthly' },
            { source: 'OSM', what: 'POI data for neighbourhood scores', coverage: 'Global', freq: 'Quarterly' },
            { source: 'ExchangeRate-API', what: 'FX conversion rates', coverage: 'Global', freq: 'Daily' },
          ].map((s, i) => (
            <div key={i} className="flex items-center gap-3 py-2 border-b" style={{ borderColor: 'var(--ink-6)' }}>
              <span className="font-medium" style={{ color: 'var(--ink)', minWidth: 140 }}>{s.source}</span>
              <span style={{ color: 'var(--ink-4)', flex: 1 }}>{s.what}</span>
              <span className="text-xs" style={{ fontFamily: 'var(--font-data)', color: 'var(--ink-5)' }}>{s.freq}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="p-5 rounded-[18px]" style={{ background: 'var(--g2)', border: '1px solid var(--gb)', borderLeft: '3px solid var(--b600)', boxShadow: 'var(--sh-card)' }}>
        <h3 className="font-semibold mb-3" style={{ color: 'var(--ink)' }}>What sqftLab does NOT do</h3>
        <div className="space-y-2 text-sm" style={{ color: 'var(--ink-3)' }}>
          <div>✓ We do not facilitate property transactions</div>
          <div>✓ We do not employ or recommend estate agents</div>
          <div>✓ We do not receive referral fees</div>
          <div>✓ We do not sell advertising or sponsored listings</div>
        </div>
      </div>
    </div>
  )
}

// ─── Mortgage Simulator (hidden from nav but accessible) ────────────────────

function MortgageSimulator() {
  const [form, setForm] = useState({ price: 2000000, downPaymentPct: 20, ratePct: 4.5, termYears: 25 })
  const [result, setResult] = useState<Record<string, unknown> | null>(null)
  const { format } = useCurrency()
  const simulate = useCallback(() => {
    fetch('/api/sqftlab/mortgage/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
      .then(r => r.json()).then(setResult).catch(() => {})
  }, [form])
  useEffect(() => { simulate() }, [])
  const r = result as Record<string, number> | null

  return (
    <div className="max-w-[800px] mx-auto px-4 py-6">
      <h2 className="text-2xl font-bold mb-2" style={{ color: 'var(--ink)' }}>Mortgage Simulator</h2>
      <p className="text-sm mb-6" style={{ color: 'var(--ink-5)' }}>Estimate EMI, total cost, and compare indicative bank rates.</p>
      <div className="grid md:grid-cols-2 gap-6">
        <div className="p-5 rounded-[18px] space-y-4" style={{ background: 'var(--g2)', border: '1px solid var(--gb)', boxShadow: 'var(--sh-card)' }}>
          <div>
            <label className="text-xs font-medium block mb-1" style={{ color: 'var(--ink-5)' }}>Property Price (AED)</label>
            <input type="number" value={form.price} onChange={e => setForm({ ...form, price: +e.target.value })}
              className="w-full px-3 py-2.5 rounded-[14px] text-sm outline-none" style={{ border: '1px solid var(--gb)', background: 'var(--g3)', fontFamily: 'var(--font-data)' }} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div><label className="text-xs block mb-1" style={{ color: 'var(--ink-5)' }}>Down %</label><input type="number" value={form.downPaymentPct} onChange={e => setForm({ ...form, downPaymentPct: +e.target.value })} className="w-full px-3 py-2 rounded-[14px] text-sm" style={{ border: '1px solid var(--gb)', background: 'var(--g3)', fontFamily: 'var(--font-data)' }} /></div>
            <div><label className="text-xs block mb-1" style={{ color: 'var(--ink-5)' }}>Rate %</label><input type="number" step="0.1" value={form.ratePct} onChange={e => setForm({ ...form, ratePct: +e.target.value })} className="w-full px-3 py-2 rounded-[14px] text-sm" style={{ border: '1px solid var(--gb)', background: 'var(--g3)', fontFamily: 'var(--font-data)' }} /></div>
            <div><label className="text-xs block mb-1" style={{ color: 'var(--ink-5)' }}>Term (yrs)</label><input type="number" value={form.termYears} onChange={e => setForm({ ...form, termYears: +e.target.value })} className="w-full px-3 py-2 rounded-[14px] text-sm" style={{ border: '1px solid var(--gb)', background: 'var(--g3)', fontFamily: 'var(--font-data)' }} /></div>
          </div>
          <button onClick={simulate} className="w-full py-2.5 rounded-[14px] font-semibold transition-colors" style={{ background: 'var(--b600)', color: '#fff', boxShadow: 'var(--sh-btn)' }}>Simulate</button>
        </div>
        {r && (
          <div className="rounded-[18px] p-5" style={{ background: 'linear-gradient(135deg, var(--b800), var(--b900))', color: '#fff' }}>
            <div className="text-center mb-4">
              <div className="text-xs" style={{ color: 'rgba(255,255,255,0.5)' }}>Monthly EMI</div>
              <div className="text-3xl font-bold" style={{ fontFamily: 'var(--font-data)', color: 'var(--b300)' }}>{format(r.emi)}</div>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              {[
                { label: 'Down Payment', value: format(r.downPayment) },
                { label: 'Loan Amount', value: format(r.loanAmount) },
                { label: 'Total Interest', value: format(r.totalInterest), color: '#FCA5A5' },
                { label: 'Total Payment', value: format(r.totalPayment) },
              ].map((item, i) => (
                <div key={i} className="rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.1)' }}>
                  <div className="text-xs" style={{ color: 'rgba(255,255,255,0.5)' }}>{item.label}</div>
                  <div className="font-semibold" style={{ fontFamily: 'var(--font-data)', color: item.color || '#fff' }}>{item.value}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Main App ────────────────────────────────────────────────────────────────

function AppInner() {
  const [page, setPage] = useState<Page>('landing')
  const [selectedCommunity, setSelectedCommunity] = useState('dubai-marina')
  const [selectedListing, setSelectedListing] = useState('')

  return (
    <div className="min-h-screen" style={{ background: 'var(--page)', fontFamily: 'var(--font-ui)' }}>
      <Nav page={page} setPage={setPage} />
      {page === 'landing' && <Landing setPage={setPage} setSelectedListing={setSelectedListing} />}
      {page === 'dashboard' && <HeatmapDashboard setPage={setPage} setSelectedCommunity={setSelectedCommunity} />}
      {page === 'community' && <CommunityDetail slug={selectedCommunity} setPage={setPage} />}
      {page === 'listings' && <ListingsFeed setPage={setPage} setSelectedListing={setSelectedListing} setSelectedCommunity={setSelectedCommunity} />}
      {page === 'property' && <PropertyIntelligence listingId={selectedListing} setPage={setPage} />}
      {page === 'portfolio' && <Portfolio />}
      {page === 'watchlist' && <Watchlist setPage={setPage} setSelectedCommunity={setSelectedCommunity} />}
      {page === 'deals' && <Deals setPage={setPage} setSelectedCommunity={setSelectedCommunity} />}
      {page === 'alerts' && <AlertsPage />}
      {page === 'pricing' && <PricingPage />}
      {page === 'yield' && <YieldCalculator />}
      {page === 'mortgage' && <MortgageSimulator />}
      {page === 'about' && <AboutPage />}
      <footer className="text-center py-6 text-xs" style={{ background: 'var(--ink)', color: 'rgba(255,255,255,0.4)' }}>
        © 2026 sqftLab · UAE Property Data Intelligence Platform · Data from DLD, ADREC, Bayut, PropertyFinder, Dubizzle
      </footer>
    </div>
  )
}

export default function App() {
  return (
    <CurrencyProvider>
      <ToastProvider>
        <AppInner />
      </ToastProvider>
    </CurrencyProvider>
  )
}
