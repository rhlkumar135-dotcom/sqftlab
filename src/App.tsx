import { useState, useEffect, useCallback, useRef } from 'react'
import { LineChart, Line, AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts'
import { MapPin, TrendingUp, TrendingDown, Search, Filter, Star, Bell, Briefcase, BarChart3, Home, Calculator, AlertTriangle, ChevronRight, ChevronDown, ArrowUpRight, ArrowDownRight, DollarSign, Building, Eye, Bookmark, Shield, Zap, Crown, Lock, Menu, X, Globe, Users, Target, IndianRupee, ExternalLink, Image as ImageIcon } from 'lucide-react'
import { cn } from '@/lib/cn'

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

const AED = (n: number) => `AED ${n.toLocaleString()}`
const INR = (n: number) => `₹${(n * 22.68).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
const PCT = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(1)}%`
const SCORE_COLOR = (s: number) => s >= 80 ? '#059669' : s >= 60 ? '#3B82F6' : '#DC2626'

const SOURCE_COLORS: Record<string, string> = {
  propertyfinder: '#007A33',
  bayut: '#FF6B00',
  dubizzle: '#3366FF',
}

const SOURCE_LABELS: Record<string, string> = {
  propertyfinder: 'PropertyFinder',
  bayut: 'Bayut',
  dubizzle: 'Dubizzle',
}

// ─── Navigation ──────────────────────────────────────────────────────────────

type Page = 'landing' | 'dashboard' | 'community' | 'listings' | 'portfolio' | 'watchlist' | 'deals' | 'alerts' | 'pricing' | 'yield' | 'mortgage'

function Nav({ page, setPage }: { page: Page; setPage: (p: Page) => void }) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const items: { id: Page; label: string; icon: React.ReactNode }[] = [
    { id: 'dashboard', label: 'Heatmap', icon: <MapPin size={16} /> },
    { id: 'listings', label: 'Listings', icon: <Building size={16} /> },
    { id: 'portfolio', label: 'Portfolio', icon: <Briefcase size={16} /> },
    { id: 'watchlist', label: 'Watchlist', icon: <Bookmark size={16} /> },
    { id: 'deals', label: 'Deals', icon: <Zap size={16} /> },
    { id: 'alerts', label: 'Alerts', icon: <Bell size={16} /> },
    { id: 'yield', label: 'Yield', icon: <Calculator size={16} /> },
    { id: 'mortgage', label: 'Mortgage', icon: <IndianRupee size={16} /> },
  ]

  return (
    <nav className="bg-white/80 backdrop-blur-xl text-[#0F172A] sticky top-0 z-50 shadow-sm border-b border-slate-200/60">
      <div className="max-w-[1400px] mx-auto px-4 h-14 flex items-center justify-between">
        <button onClick={() => setPage('landing')} className="flex items-center gap-2 group">
          <div className="w-8 h-8 bg-[#1E40AF] rounded-lg flex items-center justify-center font-bold text-white text-sm">S</div>
          <span className="text-lg font-semibold tracking-tight text-[#0F172A]">sqftLab</span>
          <span className="text-[10px] text-[#3B82F6] border border-[#3B82F6]/30 rounded px-1.5 py-0.5 ml-1 hidden sm:inline">BETA</span>
        </button>

        <div className="hidden md:flex items-center gap-1">
          {items.map(i => (
            <button key={i.id} onClick={() => setPage(i.id)}
              className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-all duration-200',
                page === i.id ? 'bg-[#1E40AF]/10 text-[#1E40AF] font-medium' : 'text-slate-500 hover:text-[#0F172A] hover:bg-slate-100/60')}>
              {i.icon}<span>{i.label}</span>
            </button>
          ))}
          <button onClick={() => setPage('pricing')}
            className={cn('ml-2 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-all duration-200',
              page === 'pricing' ? 'border-[#1E40AF] text-[#1E40AF] bg-[#1E40AF]/5' : 'border-slate-200 text-[#1E40AF] hover:bg-[#1E40AF]/5')}>
            <Crown size={16} /> Upgrade
          </button>
        </div>

        <button className="md:hidden text-[#0F172A]" onClick={() => setMobileOpen(!mobileOpen)}>
          {mobileOpen ? <X size={24} /> : <Menu size={24} />}
        </button>
      </div>

      {mobileOpen && (
        <div className="md:hidden bg-white/95 backdrop-blur-xl border-t border-slate-200/60 px-4 py-3 space-y-1">
          {items.map(i => (
            <button key={i.id} onClick={() => { setPage(i.id); setMobileOpen(false) }}
              className={cn('flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm',
                page === i.id ? 'bg-[#1E40AF]/10 text-[#1E40AF]' : 'text-slate-500')}>
              {i.icon}<span>{i.label}</span>
            </button>
          ))}
        </div>
      )}
    </nav>
  )
}

// ─── Landing Page ────────────────────────────────────────────────────────────

function Landing({ setPage }: { setPage: (p: Page) => void }) {
  const [stats, setStats] = useState<{ communityCount: number; transactionCount: number; listingCount: number } | null>(null)
  useEffect(() => { fetch('/api/sqftlab/stats').then(r => r.json()).then(setStats).catch(() => {}) }, [])

  return (
    <div className="min-h-screen">
      {/* Hero */}
      <section className="relative overflow-hidden bg-gradient-to-br from-[#1E40AF] via-[#1E3A8A] to-[#0F172A] text-white">
        <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAiIGhlaWdodD0iMjAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGNpcmNsZSBjeD0iMSIgY3k9IjEiIHI9IjEiIGZpbGw9InJnYmEoMjU1LDI1NSwyNTUsMC4wNSkiLz48L3N2Zz4=')] opacity-40" />
        <div className="max-w-[1280px] mx-auto px-6 py-20 md:py-32 relative">
          <div className="max-w-3xl">
            <div className="flex items-center gap-2 mb-6">
              <div className="w-10 h-10 bg-white/20 backdrop-blur rounded-lg flex items-center justify-center font-bold text-white text-lg">S</div>
              <span className="text-sm text-white/70 tracking-wider uppercase">sqftlab.com</span>
            </div>
            <h1 className="text-4xl md:text-6xl font-bold leading-tight mb-6">
              Dubai's property data,<br /><span className="text-[#93C5FD]">finally in one place.</span>
            </h1>
            <p className="text-lg text-white/70 mb-8 max-w-xl leading-relaxed">
              Real-time price heatmaps, AI-powered yield forecasts, deal alerts, and portfolio tracking — across every community in Dubai and Abu Dhabi.
            </p>
            <div className="flex flex-wrap gap-3">
              <button onClick={() => setPage('dashboard')}
                className="bg-white text-[#1E40AF] px-6 py-3 rounded-xl font-semibold hover:bg-white/90 transition-colors shadow-lg shadow-blue-900/30">
                Explore Heatmap →
              </button>
              <button onClick={() => setPage('pricing')}
                className="border border-white/20 text-white px-6 py-3 rounded-xl hover:bg-white/10 transition-colors backdrop-blur">
                View Plans
              </button>
            </div>
          </div>

          {stats && (
            <div className="grid grid-cols-3 gap-6 mt-16 max-w-lg">
              <div>
                <div className="text-3xl font-bold text-white">{stats.communityCount}</div>
                <div className="text-sm text-white/50">Communities</div>
              </div>
              <div>
                <div className="text-3xl font-bold text-[#93C5FD]">{(stats.transactionCount / 1000).toFixed(1)}K</div>
                <div className="text-sm text-white/50">Transactions</div>
              </div>
              <div>
                <div className="text-3xl font-bold text-white">{stats.listingCount}</div>
                <div className="text-sm text-white/50">Live Listings</div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Features */}
      <section className="max-w-[1280px] mx-auto px-6 py-20">
        <h2 className="text-3xl font-bold text-[#0F172A] mb-12">Every data source. Zero cost.</h2>
        <div className="grid md:grid-cols-3 gap-6">
          {[
            { icon: <MapPin className="text-[#3B82F6]" size={28} />, title: 'Price Heatmap', desc: 'Color-graded AED/sqft across every UAE community. Click any marker for instant analytics.' },
            { icon: <TrendingUp className="text-[#059669]" size={28} />, title: 'Yield Calculator', desc: 'Gross & net yields, mortgage simulation, break-even analysis. All with INR equivalents.' },
            { icon: <Zap className="text-[#DC2626]" size={28} />, title: 'Deal Alerts', desc: 'Below-market listings detected automatically. Get notified before everyone else.' },
            { icon: <Briefcase className="text-[#1E40AF]" size={28} />, title: 'Portfolio Tracker', desc: 'Track your properties, rental income, mortgage payments, and total returns.' },
            { icon: <Shield className="text-[#059669]" size={28} />, title: 'Developer Risk', desc: 'Handover delays, RERA compliance, and community sentiment scored for every developer.' },
            { icon: <BarChart3 className="text-[#3B82F6]" size={28} />, title: 'AI Predictions', desc: '6-month forward price forecasts trained on 25+ years of DLD transaction data.' },
          ].map((f, i) => (
            <div key={i} className="bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200/60 p-6 hover:shadow-lg hover:shadow-blue-900/5 hover:border-blue-200/60 transition-all duration-300">
              <div className="mb-4">{f.icon}</div>
              <h3 className="font-semibold text-[#0F172A] mb-2">{f.title}</h3>
              <p className="text-sm text-slate-500 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing CTA */}
      <section className="bg-gradient-to-r from-[#1E40AF] to-[#1E3A8A] text-white py-20">
        <div className="max-w-[1280px] mx-auto px-6 text-center">
          <h2 className="text-3xl font-bold mb-4">Start free. Upgrade when ready.</h2>
          <p className="text-white/60 mb-8 max-w-lg mx-auto">5 heatmap searches per day, 3 months of transaction history, and INR equivalents — completely free.</p>
          <button onClick={() => setPage('pricing')}
            className="bg-white text-[#1E40AF] px-8 py-3 rounded-xl font-semibold hover:bg-white/90 transition-colors shadow-lg">
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

    // Dynamic import Leaflet (client-side only)
    import('leaflet').then((L) => {
      if (mapInstanceRef.current) {
        (mapInstanceRef.current as { remove: () => void }).remove()
      }

      const map = L.map(mapRef.current!, {
        zoomControl: false,
        attributionControl: true,
      }).setView([25.2, 55.27], 10)

      L.control.zoom({ position: 'topright' }).addTo(map)

      L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '© OpenStreetMap contributors © CARTO',
        maxZoom: 19,
      }).addTo(map)

      const minPsf = Math.min(...communities.map(c => c.medianAedSqft).filter(v => v > 0))
      const maxPsf = Math.max(...communities.map(c => c.medianAedSqft))
      const maxTx = Math.max(...communities.map(c => c.transactionCount30d))

      communities.forEach(c => {
        if (c.latitude === 0 && c.longitude === 0) return
        const t = (c.medianAedSqft - minPsf) / (maxPsf - minPsf || 1)
        const r = 8 + (c.transactionCount30d / maxTx) * 20
        const color = t < 0.33 ? '#059669' : t < 0.66 ? '#3B82F6' : '#1E40AF'

        const circle = L.circleMarker([c.latitude, c.longitude], {
          radius: r,
          fillColor: color,
          fillOpacity: 0.7,
          color: '#fff',
          weight: 2,
        }).addTo(map)

        circle.bindTooltip(`
          <div style="font-family:Inter;font-size:12px;min-width:180px">
            <div style="font-weight:600;font-size:13px;margin-bottom:4px">${c.nameEn}</div>
            <div style="color:#64748B;text-transform:capitalize;margin-bottom:6px">${c.emirate.replace('_',' ')}</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px">
              <div><div style="font-weight:700;color:#0F172A">AED ${c.medianAedSqft.toLocaleString()}</div><div style="color:#94A3B8;font-size:10px">per sqft</div></div>
              <div><div style="font-weight:700;color:#059669">${c.grossYieldPct}%</div><div style="color:#94A3B8;font-size:10px">yield</div></div>
              <div><div style="font-weight:600;color:${c.priceChange30d >= 0 ? '#059669' : '#DC2626'}">${PCT(c.priceChange30d)}</div><div style="color:#94A3B8;font-size:10px">30d</div></div>
              <div><div style="font-weight:600">${c.transactionCount30d}</div><div style="color:#94A3B8;font-size:10px">txns</div></div>
            </div>
          </div>
        `, { className: 'sqftlab-tooltip' })

        circle.on('click', () => {
          setSelectedCommunity(c.slug)
          setPage('community')
        })
      })

      mapInstanceRef.current = map
    }).catch(() => {})

    return () => {
      if (mapInstanceRef.current) {
        (mapInstanceRef.current as { remove: () => void }).remove()
        mapInstanceRef.current = null
      }
    }
  }, [communities, emirate])

  return (
    <div className="max-w-[1400px] mx-auto px-4 py-6">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search communities..."
            className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-slate-200 bg-white/80 backdrop-blur text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]/30 focus:border-[#3B82F6] transition-all" />
        </div>
        <div className="flex gap-1 bg-white/80 backdrop-blur border border-slate-200 rounded-xl p-0.5">
          {['all', 'dubai', 'abu_dhabi'].map(e => (
            <button key={e} onClick={() => setEmirate(e)}
              className={cn('px-3 py-1.5 rounded-lg text-xs font-medium transition-all',
                emirate === e ? 'bg-[#1E40AF] text-white shadow-sm' : 'text-slate-500 hover:text-[#0F172A]')}>
              {e === 'all' ? 'All UAE' : e === 'dubai' ? 'Dubai' : 'Abu Dhabi'}
            </button>
          ))}
        </div>
        <div className="text-xs text-slate-400">{communities.length} communities</div>
      </div>

      {/* Leaflet Map */}
      <div className="bg-white/80 backdrop-blur-xl rounded-2xl overflow-hidden border border-slate-200/60 shadow-sm" style={{ height: '500px' }}>
        <div ref={mapRef} className="w-full h-full" />
        {loading && (
          <div className="absolute inset-0 bg-white/60 backdrop-blur-sm flex items-center justify-center z-[999]">
            <div className="text-sm text-slate-500">Loading communities...</div>
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 mt-3 text-xs text-slate-500">
        <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-[#059669]" /> Low AED/sqft</div>
        <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-[#3B82F6]" /> Medium</div>
        <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-[#1E40AF]" /> High</div>
        <span>·</span>
        <span>Circle size = transaction volume</span>
      </div>

      {/* Top movers */}
      <div className="mt-6 grid md:grid-cols-2 gap-4">
        <div className="bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200/60 p-5">
          <h3 className="font-semibold text-[#0F172A] mb-3 flex items-center gap-2"><TrendingUp size={16} className="text-[#059669]" /> Top Gainers (30d)</h3>
          <div className="space-y-2">
            {[...communities].sort((a, b) => b.priceChange30d - a.priceChange30d).slice(0, 5).map(c => (
              <button key={c.id} onClick={() => { setSelectedCommunity(c.slug); setPage('community') }}
                className="flex items-center justify-between w-full py-1.5 hover:bg-blue-50/60 rounded-lg px-2 transition-colors">
                <span className="text-sm text-[#0F172A]">{c.nameEn}</span>
                <span className="text-sm font-semibold text-[#059669]">{PCT(c.priceChange30d)}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200/60 p-5">
          <h3 className="font-semibold text-[#0F172A] mb-3 flex items-center gap-2"><Target size={16} className="text-[#3B82F6]" /> Highest Yield</h3>
          <div className="space-y-2">
            {[...communities].sort((a, b) => b.grossYieldPct - a.grossYieldPct).slice(0, 5).map(c => (
              <button key={c.id} onClick={() => { setSelectedCommunity(c.slug); setPage('community') }}
                className="flex items-center justify-between w-full py-1.5 hover:bg-blue-50/60 rounded-lg px-2 transition-colors">
                <span className="text-sm text-[#0F172A]">{c.nameEn}</span>
                <span className="text-sm font-semibold text-[#059669]">{c.grossYieldPct}%</span>
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

  useEffect(() => {
    setLoading(true)
    Promise.all([
      fetch(`/api/sqftlab/communities/${slug}`).then(r => r.json()),
      fetch(`/api/sqftlab/communities/${slug}/trend?period=12m`).then(r => r.json()),
      fetch(`/api/sqftlab/communities/${slug}/transactions?limit=20`).then(r => r.json()),
      fetch(`/api/sqftlab/communities/${slug}/listings?purpose=sale`).then(r => r.json()),
    ]).then(([cData, tData, txData, lData]) => {
      const c = cData.community || cData
      setCommunity(c)
      setTrend(tData.trend || [])
      setTransactions(txData.transactions || [])
      setListings(lData.listings || [])
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [slug])

  if (loading) return <div className="max-w-[1280px] mx-auto px-6 py-20 text-center text-slate-400">Loading community data...</div>
  if (!community) return <div className="max-w-[1280px] mx-auto px-6 py-20 text-center text-slate-400">Community not found</div>

  const radarData = [
    { subject: 'Schools', score: community.scoreSchools, fullMark: 10 },
    { subject: 'Healthcare', score: community.scoreHealthcare, fullMark: 10 },
    { subject: 'Metro', score: community.scoreMetro, fullMark: 10 },
    { subject: 'Retail', score: community.scoreRetail, fullMark: 10 },
    { subject: 'Parks', score: community.scoreParks, fullMark: 10 },
    { subject: 'Worship', score: community.scoreWorship, fullMark: 10 },
  ]

  return (
    <div className="max-w-[1280px] mx-auto px-4 py-6">
      <button onClick={() => setPage('dashboard')} className="text-sm text-slate-400 hover:text-[#1E40AF] mb-4 flex items-center gap-1 transition-colors">
        ← Back to Heatmap
      </button>

      {/* Price Summary Card */}
      <div className="bg-gradient-to-r from-[#1E40AF] to-[#1E3A8A] text-white rounded-2xl p-6 mb-6 shadow-lg shadow-blue-900/10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-2xl font-bold">{community.nameEn}</h1>
              <span className="text-xs bg-white/20 backdrop-blur px-2 py-0.5 rounded capitalize">{community.emirate.replace('_', ' ')}</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-3xl font-bold">{AED(community.medianAedSqft)}<span className="text-sm font-normal text-white/50"> /sqft</span></div>
            <div className="text-sm text-white/50">{INR(community.medianAedSqft)} /sqft</div>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mt-6 pt-4 border-t border-white/10">
          <div>
            <div className={cn('text-xl font-bold', community.priceChange30d >= 0 ? 'text-[#86EFAC]' : 'text-[#FCA5A5]')}>{PCT(community.priceChange30d)}</div>
            <div className="text-xs text-white/50">30-day change</div>
          </div>
          <div>
            <div className={cn('text-xl font-bold', community.priceChange1y >= 0 ? 'text-[#86EFAC]' : 'text-[#FCA5A5]')}>{PCT(community.priceChange1y)}</div>
            <div className="text-xs text-white/50">1-year change</div>
          </div>
          <div>
            <div className="text-xl font-bold text-[#86EFAC]">{community.grossYieldPct}%</div>
            <div className="text-xs text-white/50">Gross yield</div>
          </div>
          <div>
            <div className="text-xl font-bold text-white">{community.transactionCount30d}</div>
            <div className="text-xs text-white/50">Txns (30d)</div>
          </div>
          <div>
            <div className="text-xl font-bold text-[#93C5FD]">{community.neighbourhoodScore}</div>
            <div className="text-xs text-white/50">Neighbourhood score</div>
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          {/* Price Trend */}
          <div className="bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200/60 p-5">
            <h3 className="font-semibold text-[#0F172A] mb-4">Price History (12 months)</h3>
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={trend}>
                <defs>
                  <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#3B82F6" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#94A3B8' }} />
                <YAxis tick={{ fontSize: 11, fill: '#94A3B8' }} />
                <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid #E2E8F0', fontSize: 12, boxShadow: '0 4px 12px rgba(0,0,0,0.05)' }} />
                <Area type="monotone" dataKey="medianPrice" stroke="#3B82F6" fill="url(#priceGrad)" strokeWidth={2} name="AED/sqft" />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Volume */}
          <div className="bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200/60 p-5">
            <h3 className="font-semibold text-[#0F172A] mb-4">Transaction Volume</h3>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={trend}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#94A3B8' }} />
                <YAxis tick={{ fontSize: 10, fill: '#94A3B8' }} />
                <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid #E2E8F0', fontSize: 12 }} />
                <Bar dataKey="volume" fill="#3B82F6" radius={[4, 4, 0, 0]} name="Transactions" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Transactions */}
          <div className="bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200/60 p-5">
            <h3 className="font-semibold text-[#0F172A] mb-4">Recent Transactions (DLD)</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-400 text-left">
                    <th className="pb-2 font-medium">Date</th>
                    <th className="pb-2 font-medium">Type</th>
                    <th className="pb-2 font-medium">Beds</th>
                    <th className="pb-2 font-medium text-right">Area</th>
                    <th className="pb-2 font-medium text-right">AED/sqft</th>
                    <th className="pb-2 font-medium text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((t, i) => (
                    <tr key={t.id} className={cn('border-b border-slate-100', i % 2 === 0 && 'bg-blue-50/30')}>
                      <td className="py-2">{new Date(t.transactionDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</td>
                      <td className="py-2 capitalize">{t.propertyType}</td>
                      <td className="py-2">{t.beds === 0 ? 'Studio' : t.beds}</td>
                      <td className="py-2 text-right">{t.areaSqft.toLocaleString()} sqft</td>
                      <td className="py-2 text-right font-medium">{AED(t.pricePerSqft)}</td>
                      <td className="py-2 text-right font-semibold">{AED(t.priceAed)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right sidebar */}
        <div className="space-y-6">
          <div className="bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200/60 p-5">
            <h3 className="font-semibold text-[#0F172A] mb-2">Neighbourhood Score</h3>
            <div className="text-center mb-2">
              <span className="text-4xl font-bold" style={{ color: SCORE_COLOR(community.neighbourhoodScore) }}>{community.neighbourhoodScore}</span>
              <span className="text-sm text-slate-400">/100</span>
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <RadarChart data={radarData}>
                <PolarGrid stroke="#E2E8F0" />
                <PolarAngleAxis dataKey="subject" tick={{ fontSize: 10, fill: '#94A3B8' }} />
                <PolarRadiusAxis angle={30} domain={[0, 10]} tick={{ fontSize: 9 }} />
                <Radar name="Score" dataKey="score" stroke="#3B82F6" fill="#3B82F6" fillOpacity={0.15} strokeWidth={2} />
              </RadarChart>
            </ResponsiveContainer>
          </div>

          {/* Live Listings */}
          <div className="bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200/60 p-5">
            <h3 className="font-semibold text-[#0F172A] mb-3">Live Listings</h3>
            <div className="space-y-3">
              {listings.slice(0, 5).map(l => (
                <a key={l.id} href={l.sourceUrl || '#'} target="_blank" rel="noopener noreferrer"
                  className="block py-2 border-b border-slate-100 last:border-0 hover:bg-blue-50/40 rounded-lg px-2 -mx-2 transition-colors">
                  <div className="flex items-start gap-3">
                    {l.imageUrl && <img src={l.imageUrl} alt="" className="w-12 h-9 object-cover rounded-lg flex-shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-[#0F172A] truncate">{l.beds === 0 ? 'Studio' : l.beds + 'BR'} {l.propertyType}</div>
                      <div className="text-xs text-slate-400">{l.areaSqft.toLocaleString()} sqft · {SOURCE_LABELS[l.source] || l.source}</div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="text-sm font-bold text-[#0F172A]">{AED(l.priceAed)}</div>
                      {l.isDeal && <span className="text-[10px] bg-red-50 text-[#DC2626] px-1.5 py-0.5 rounded font-medium">DEAL</span>}
                    </div>
                  </div>
                </a>
              ))}
            </div>
          </div>

          {/* Rental Yield */}
          <div className="bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200/60 p-5">
            <h3 className="font-semibold text-[#0F172A] mb-3">Rental Yield</h3>
            <div className="space-y-3">
              <div className="flex justify-between"><span className="text-sm text-slate-400">Annual Rent (median)</span><span className="text-sm font-semibold">{AED(community.medianAnnualRentAed)}</span></div>
              <div className="flex justify-between"><span className="text-sm text-slate-400">Gross Yield</span><span className="text-sm font-bold text-[#059669]">{community.grossYieldPct}%</span></div>
              <div className="flex justify-between"><span className="text-sm text-slate-400">Net Yield (est.)</span><span className="text-sm font-semibold text-[#059669]">{(community.grossYieldPct * 0.78).toFixed(1)}%</span></div>
              <div className="flex justify-between"><span className="text-sm text-slate-400">INR Equivalent</span><span className="text-xs text-slate-400">{INR(community.medianAnnualRentAed)}/yr</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Listings Feed ───────────────────────────────────────────────────────────

function ListingsFeed({ setPage, setSelectedCommunity }: { setPage: (p: Page) => void; setSelectedCommunity: (s: string) => void }) {
  const [listings, setListings] = useState<Listing[]>([])
  const [purpose, setPurpose] = useState('sale')
  const [dealsOnly, setDealsOnly] = useState(false)
  const [loading, setLoading] = useState(true)

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
        <h2 className="text-2xl font-bold text-[#0F172A]">Live Listings</h2>
        <div className="flex items-center gap-3">
          <div className="flex gap-1 bg-white/80 backdrop-blur border border-slate-200 rounded-xl p-0.5">
            {['sale', 'rent'].map(p => (
              <button key={p} onClick={() => setPurpose(p)}
                className={cn('px-3 py-1.5 rounded-lg text-xs font-medium transition-all capitalize',
                  purpose === p ? 'bg-[#1E40AF] text-white shadow-sm' : 'text-slate-500')}>
                {p}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={dealsOnly} onChange={e => setDealsOnly(e.target.checked)}
              className="rounded border-slate-300 accent-[#3B82F6]" />
            <span className="text-slate-500">Deals only</span>
          </label>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-20 text-slate-400">Loading listings...</div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {listings.map(l => (
            <a key={l.id} href={l.sourceUrl || '#'} target="_blank" rel="noopener noreferrer"
              className="bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200/60 overflow-hidden hover:shadow-lg hover:shadow-blue-900/5 hover:border-blue-200/60 transition-all duration-300 group block">
              {/* Image */}
              <div className="h-40 bg-gradient-to-br from-blue-100 to-slate-100 relative overflow-hidden">
                {l.imageUrl ? (
                  <img src={l.imageUrl} alt={l.title || ''} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <ImageIcon className="text-slate-300" size={40} />
                  </div>
                )}
                {l.isDeal && (
                  <div className="absolute top-3 right-3 bg-[#DC2626] text-white text-[10px] font-bold px-2 py-1 rounded-lg shadow-sm">
                    DEAL · {Math.round((1 - l.pricePerSqft / (l.community?.medianAedSqft || l.pricePerSqft)) * 100)}% below median
                  </div>
                )}
                <div className="absolute bottom-3 left-3 flex items-center gap-1.5">
                  <span className="text-[10px] font-medium text-white bg-black/40 backdrop-blur-sm rounded-lg px-2 py-1">
                    {SOURCE_LABELS[l.source] || l.source}
                  </span>
                </div>
                <div className="absolute top-3 left-3 opacity-0 group-hover:opacity-100 transition-opacity">
                  <span className="text-[10px] font-medium text-white bg-[#1E40AF]/80 backdrop-blur-sm rounded-lg px-2 py-1 flex items-center gap-1">
                    <ExternalLink size={10} /> View on {SOURCE_LABELS[l.source] || l.source}
                  </span>
                </div>
              </div>
              <div className="p-4">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <div className="font-semibold text-[#0F172A]">{l.beds === 0 ? 'Studio' : `${l.beds}BR`} {l.propertyType}</div>
                    <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); setSelectedCommunity(l.community?.slug || ''); setPage('community') }}
                      className="text-xs text-[#3B82F6] hover:underline">
                      {l.community?.nameEn || 'View community'}
                    </button>
                  </div>
                  <div className="text-right">
                    <div className="font-bold text-[#0F172A]">{AED(l.priceAed)}</div>
                    <div className="text-[10px] text-slate-400">{INR(l.priceAed)}</div>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-xs text-slate-400 mt-2">
                  <span>{l.areaSqft.toLocaleString()} sqft</span>
                  <span>·</span>
                  <span>{l.baths} bath</span>
                  <span>·</span>
                  <span className="capitalize">{l.furnished}</span>
                </div>
                {l.agentName && (
                  <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
                    <span className="text-slate-400">{l.agentName}</span>
                    <span className="text-slate-400">{l.agencyName}</span>
                  </div>
                )}
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

  useEffect(() => {
    fetch('/api/sqftlab/portfolio').then(r => r.json()).then(d => { setData(d); setLoading(false) }).catch(() => setLoading(false))
  }, [])

  if (loading) return <div className="max-w-[1280px] mx-auto px-6 py-20 text-center text-slate-400">Loading portfolio...</div>
  if (!data) return <div className="max-w-[1280px] mx-auto px-6 py-20 text-center text-slate-400">No portfolio data</div>

  const { summary, items } = data
  const pieData = items.map(i => ({ name: i.community.nameEn, value: i.currentValue }))
  const COLORS = ['#1E40AF', '#3B82F6', '#059669', '#DC2626', '#64748B']

  return (
    <div className="max-w-[1280px] mx-auto px-4 py-6">
      <h2 className="text-2xl font-bold text-[#0F172A] mb-6">Portfolio</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Total Value', value: AED(summary.totalValue), color: 'text-[#0F172A]' },
          { label: 'Total Gain/Loss', value: `${summary.totalGainLoss >= 0 ? '+' : ''}${AED(summary.totalGainLoss)}`, color: summary.totalGainLoss >= 0 ? 'text-[#059669]' : 'text-[#DC2626]' },
          { label: 'Weighted Yield', value: `${summary.weightedYield}%`, color: 'text-[#059669]' },
          { label: 'Monthly Cash Flow', value: AED(summary.monthlyCashFlow), color: 'text-[#059669]' },
        ].map((s, i) => (
          <div key={i} className="bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200/60 p-4">
            <div className="text-xs text-slate-400 mb-1">{s.label}</div>
            <div className={cn('text-xl font-bold', s.color)}>{s.value}</div>
          </div>
        ))}
      </div>
      <div className="grid lg:grid-cols-2 gap-6">
        <div className="space-y-4">
          {items.map(item => (
            <div key={item.id} className="bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200/60 p-5">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className="font-semibold text-[#0F172A]">{item.title}</div>
                  <button className="text-xs text-[#3B82F6] hover:underline">{item.community.nameEn}</button>
                </div>
                <div className="text-right">
                  <div className="font-bold text-[#0F172A]">{AED(item.currentValue)}</div>
                  <div className={cn('text-xs font-medium', item.currentValue >= item.purchasePrice ? 'text-[#059669]' : 'text-[#DC2626]')}>
                    {item.currentValue >= item.purchasePrice ? '+' : ''}{AED(item.currentValue - item.purchasePrice)} ({((item.currentValue - item.purchasePrice) / item.purchasePrice * 100).toFixed(1)}%)
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200/60 p-5">
          <h3 className="font-semibold text-[#0F172A] mb-4">Portfolio Diversification</h3>
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie data={pieData} cx="50%" cy="50%" outerRadius={90} dataKey="value" label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                {pieData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip formatter={(v: number) => AED(v)} />
            </PieChart>
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

  useEffect(() => {
    fetch('/api/sqftlab/watchlist').then(r => r.json()).then(d => { setItems(d.items || []); setLoading(false) }).catch(() => setLoading(false))
  }, [])

  if (loading) return <div className="max-w-[1280px] mx-auto px-6 py-20 text-center text-slate-400">Loading watchlist...</div>

  return (
    <div className="max-w-[1280px] mx-auto px-4 py-6">
      <h2 className="text-2xl font-bold text-[#0F172A] mb-6">Watchlist</h2>
      {items.length === 0 ? (
        <div className="text-center py-20 text-slate-400">
          <Bookmark size={40} className="mx-auto mb-3 text-slate-200" />
          <p>No communities watched yet — search the heatmap to start tracking.</p>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map(w => {
            const c = w.community
            return (
              <button key={c.id} onClick={() => { setSelectedCommunity(c.slug); setPage('community') }}
                className="bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200/60 p-5 text-left hover:shadow-lg hover:shadow-blue-900/5 transition-all">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <div className="font-semibold text-[#0F172A]">{c.nameEn}</div>
                    <div className="text-xs text-slate-400 capitalize">{c.emirate.replace('_', ' ')}</div>
                  </div>
                  <div className={cn('text-sm font-bold', c.priceChange30d >= 0 ? 'text-[#059669]' : 'text-[#DC2626]')}>{PCT(c.priceChange30d)}</div>
                </div>
                <div className="grid grid-cols-3 gap-3 text-xs">
                  <div><div className="font-bold text-[#0F172A]">{AED(c.medianAedSqft)}</div><div className="text-slate-400">AED/sqft</div></div>
                  <div><div className="font-bold text-[#059669]">{c.grossYieldPct}%</div><div className="text-slate-400">Yield</div></div>
                  <div><div className="font-bold text-[#0F172A]">{c.transactionCount30d}</div><div className="text-slate-400">Txns</div></div>
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

  useEffect(() => {
    fetch('/api/sqftlab/deals').then(r => r.json()).then(d => { setDeals(d.deals || []); setLoading(false) }).catch(() => setLoading(false))
  }, [])

  return (
    <div className="max-w-[1280px] mx-auto px-4 py-6">
      <div className="flex items-center gap-3 mb-6">
        <Zap className="text-[#DC2626]" size={24} />
        <h2 className="text-2xl font-bold text-[#0F172A]">Deal Alert Feed</h2>
        <span className="text-xs bg-red-50 text-[#DC2626] px-2 py-1 rounded-lg font-medium">{deals.length} deals</span>
      </div>

      {loading ? (
        <div className="text-center py-20 text-slate-400">Loading deals...</div>
      ) : (
        <div className="space-y-3">
          {deals.map(d => {
            const discount = d.community?.medianAedSqft ? Math.round((1 - d.pricePerSqft / d.community.medianAedSqft) * 100) : 0
            return (
              <a key={d.id} href={d.sourceUrl || '#'} target="_blank" rel="noopener noreferrer"
                className="bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200/60 p-4 flex flex-wrap items-center gap-4 hover:shadow-lg hover:shadow-blue-900/5 transition-all block">
                <div className="w-12 h-12 rounded-xl bg-red-50 flex items-center justify-center flex-shrink-0">
                  <Zap className="text-[#DC2626]" size={20} />
                </div>
                <div className="flex-1 min-w-[200px]">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-[#0F172A]">{d.beds}BR {d.propertyType}</span>
                    <span className="text-xs text-slate-400">{d.areaSqft.toLocaleString()} sqft</span>
                    <span className="text-[10px] font-medium text-white rounded-lg px-2 py-0.5" style={{ backgroundColor: SOURCE_COLORS[d.source] || '#64748B' }}>
                      {SOURCE_LABELS[d.source] || d.source}
                    </span>
                  </div>
                  <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); setSelectedCommunity(d.community?.slug || ''); setPage('community') }}
                    className="text-xs text-[#3B82F6] hover:underline">{d.community?.nameEn}</button>
                </div>
                <div className="text-right">
                  <div className="font-bold text-[#0F172A]">{AED(d.priceAed)}</div>
                </div>
                <div className="bg-[#DC2626] text-white text-xs font-bold px-3 py-1.5 rounded-lg">-{discount}%</div>
              </a>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Alerts ──────────────────────────────────────────────────────────────────

function AlertsPage() {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/sqftlab/alerts').then(r => r.json()).then(d => { setAlerts(d.alerts || d.items || []); setLoading(false) }).catch(() => setLoading(false))
  }, [])

  const typeLabels: Record<string, { label: string; color: string }> = {
    below_market: { label: 'Below Market', color: 'bg-red-50 text-[#DC2626]' },
    price_drop: { label: 'Price Drop', color: 'bg-emerald-50 text-[#059669]' },
    new_listing: { label: 'New Listing', color: 'bg-blue-50 text-[#1E40AF]' },
    yield_target: { label: 'Yield Target', color: 'bg-blue-50 text-[#3B82F6]' },
  }

  return (
    <div className="max-w-[1280px] mx-auto px-4 py-6">
      <h2 className="text-2xl font-bold text-[#0F172A] mb-6">Deal Alerts</h2>
      {loading ? (
        <div className="text-center py-20 text-slate-400">Loading alerts...</div>
      ) : alerts.length === 0 ? (
        <div className="text-center py-20 text-slate-400">
          <Bell size={40} className="mx-auto mb-3 text-slate-200" />
          <p>No alerts configured — create one to get notified of deals.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {alerts.map(a => {
            const type = typeLabels[a.alertType] || { label: a.alertType, color: 'bg-slate-100 text-slate-600' }
            return (
              <div key={a.id} className="bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200/60 p-4 flex flex-wrap items-center gap-4">
                <div className={cn('text-xs font-medium px-3 py-1.5 rounded-lg', type.color)}>{type.label}</div>
                <div className="flex-1 min-w-[200px]">
                  <div className="text-sm font-medium text-[#0F172A]">
                    {a.community?.nameEn || 'All Communities'}{a.propertyType && ` · ${a.propertyType}`}{a.beds !== undefined && ` · ${a.beds}BR`}
                  </div>
                </div>
                <div className={cn('w-2 h-2 rounded-full', a.isActive ? 'bg-[#059669]' : 'bg-slate-200')} />
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
  const [form, setForm] = useState({
    purchasePrice: 2000000, annualRent: 120000, serviceCharge: 15000,
    mortgageEnabled: false, mortgageRate: 4.5, mortgageTerm: 25, downPaymentPct: 20,
  })
  const [result, setResult] = useState<Record<string, number> | null>(null)

  const calculate = useCallback(() => {
    fetch('/api/sqftlab/yield/calculate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
    }).then(r => r.json()).then(setResult).catch(() => {})
  }, [form])

  useEffect(() => { calculate() }, [])

  return (
    <div className="max-w-[800px] mx-auto px-4 py-6">
      <h2 className="text-2xl font-bold text-[#0F172A] mb-2">Yield Calculator</h2>
      <p className="text-sm text-slate-400 mb-6">Calculate gross & net yields, cash flow, and break-even for any property.</p>
      <div className="grid md:grid-cols-2 gap-6">
        <div className="bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200/60 p-5 space-y-4">
          <div>
            <label className="text-xs font-medium text-slate-400 block mb-1">Purchase Price (AED)</label>
            <input type="number" value={form.purchasePrice} onChange={e => setForm({ ...form, purchasePrice: +e.target.value })}
              className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]/30 focus:border-[#3B82F6]" />
            <div className="text-[10px] text-slate-400 mt-0.5">{INR(form.purchasePrice)}</div>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-400 block mb-1">Expected Annual Rent (AED)</label>
            <input type="number" value={form.annualRent} onChange={e => setForm({ ...form, annualRent: +e.target.value })}
              className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]/30" />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-400 block mb-1">Service Charge (AED/yr)</label>
            <input type="number" value={form.serviceCharge} onChange={e => setForm({ ...form, serviceCharge: +e.target.value })}
              className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]/30" />
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" checked={form.mortgageEnabled} onChange={e => setForm({ ...form, mortgageEnabled: e.target.checked })} className="accent-[#3B82F6]" />
            <label className="text-sm text-[#0F172A]">Include Mortgage</label>
          </div>
          {form.mortgageEnabled && (
            <div className="grid grid-cols-3 gap-3">
              <div><label className="text-xs text-slate-400 block mb-1">Down %</label><input type="number" value={form.downPaymentPct} onChange={e => setForm({ ...form, downPaymentPct: +e.target.value })} className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm" /></div>
              <div><label className="text-xs text-slate-400 block mb-1">Rate %</label><input type="number" step="0.1" value={form.mortgageRate} onChange={e => setForm({ ...form, mortgageRate: +e.target.value })} className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm" /></div>
              <div><label className="text-xs text-slate-400 block mb-1">Term (yrs)</label><input type="number" value={form.mortgageTerm} onChange={e => setForm({ ...form, mortgageTerm: +e.target.value })} className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm" /></div>
            </div>
          )}
          <button onClick={calculate} className="w-full bg-[#1E40AF] text-white py-2.5 rounded-xl font-semibold hover:bg-[#1E3A8A] transition-colors">Calculate</button>
        </div>

        {result && (
          <div className="bg-gradient-to-br from-[#1E40AF] to-[#1E3A8A] text-white rounded-2xl p-5 space-y-3">
            <h3 className="font-semibold text-[#93C5FD] mb-3">Results</h3>
            {[
              { label: 'Gross Yield', value: `${result.grossYield}%`, color: 'text-[#86EFAC]' },
              { label: 'Net Yield', value: `${result.netYield}%`, color: 'text-[#86EFAC]' },
              { label: 'Monthly Cash Flow', value: AED(result.monthlyCashFlow), color: result.monthlyCashFlow >= 0 ? 'text-[#86EFAC]' : 'text-[#FCA5A5]' },
              { label: 'Annual Cash Flow', value: AED(result.annualCashFlow), color: result.annualCashFlow >= 0 ? 'text-[#86EFAC]' : 'text-[#FCA5A5]' },
              { label: 'DLD Fee (4%)', value: AED(result.dldFee), color: 'text-white/70' },
              ...(form.mortgageEnabled ? [
                { label: 'Monthly EMI', value: AED(result.emi), color: 'text-[#93C5FD]' },
                { label: 'Total Interest', value: AED(result.totalInterest), color: 'text-[#FCA5A5]' },
              ] : []),
              { label: '5-Year Projected Return', value: `${result.fiveYearReturn}%`, color: 'text-[#86EFAC]' },
            ].map((r, i) => (
              <div key={i} className="flex justify-between py-1.5 border-b border-white/10">
                <span className="text-sm text-white/60">{r.label}</span>
                <span className={cn('text-sm font-semibold', r.color)}>{r.value}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Mortgage Simulator ──────────────────────────────────────────────────────

function MortgageSimulator() {
  const [form, setForm] = useState({ price: 2000000, downPaymentPct: 20, ratePct: 4.5, termYears: 25 })
  const [result, setResult] = useState<Record<string, unknown> | null>(null)

  const simulate = useCallback(() => {
    fetch('/api/sqftlab/mortgage/simulate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
    }).then(r => r.json()).then(setResult).catch(() => {})
  }, [form])

  useEffect(() => { simulate() }, [])

  const r = result as Record<string, number> | null
  const amort = (result as Record<string, unknown>)?.amortization as { year: number; principalPaid: number; interestPaid: number; remainingBalance: number }[] | undefined
  const bankRates = (result as Record<string, unknown>)?.bankRates as { bank: string; rate: number; type: string }[] | undefined

  return (
    <div className="max-w-[1000px] mx-auto px-4 py-6">
      <h2 className="text-2xl font-bold text-[#0F172A] mb-2">Mortgage Simulator</h2>
      <p className="text-sm text-slate-400 mb-6">Estimate EMI, total cost, and compare indicative bank rates.</p>
      <div className="grid md:grid-cols-2 gap-6">
        <div className="bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200/60 p-5 space-y-4">
          <div>
            <label className="text-xs font-medium text-slate-400 block mb-1">Property Price (AED)</label>
            <input type="number" value={form.price} onChange={e => setForm({ ...form, price: +e.target.value })}
              className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]/30" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div><label className="text-xs text-slate-400 block mb-1">Down Payment %</label><input type="number" value={form.downPaymentPct} onChange={e => setForm({ ...form, downPaymentPct: +e.target.value })} className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm" /></div>
            <div><label className="text-xs text-slate-400 block mb-1">Rate %</label><input type="number" step="0.1" value={form.ratePct} onChange={e => setForm({ ...form, ratePct: +e.target.value })} className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm" /></div>
            <div><label className="text-xs text-slate-400 block mb-1">Term (yrs)</label><input type="number" value={form.termYears} onChange={e => setForm({ ...form, termYears: +e.target.value })} className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm" /></div>
          </div>
          <button onClick={simulate} className="w-full bg-[#1E40AF] text-white py-2.5 rounded-xl font-semibold hover:bg-[#1E3A8A] transition-colors">Simulate</button>
        </div>

        {r && (
          <div className="space-y-4">
            <div className="bg-gradient-to-br from-[#1E40AF] to-[#1E3A8A] text-white rounded-2xl p-5">
              <div className="text-center mb-4">
                <div className="text-xs text-white/50">Monthly EMI</div>
                <div className="text-3xl font-bold text-[#93C5FD]">{AED(r.emi)}</div>
                <div className="text-xs text-white/50">{INR(r.emi)}/month</div>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="bg-white/10 rounded-xl p-3"><div className="text-white/50 text-xs">Down Payment</div><div className="font-semibold">{AED(r.downPayment)}</div></div>
                <div className="bg-white/10 rounded-xl p-3"><div className="text-white/50 text-xs">Loan Amount</div><div className="font-semibold">{AED(r.loanAmount)}</div></div>
                <div className="bg-white/10 rounded-xl p-3"><div className="text-white/50 text-xs">Total Interest</div><div className="font-semibold text-[#FCA5A5]">{AED(r.totalInterest)}</div></div>
                <div className="bg-white/10 rounded-xl p-3"><div className="text-white/50 text-xs">Total Payment</div><div className="font-semibold">{AED(r.totalPayment)}</div></div>
              </div>
            </div>

            {bankRates && (
              <div className="bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200/60 p-5">
                <h3 className="font-semibold text-[#0F172A] mb-3 text-sm">Indicative Bank Rates</h3>
                <div className="space-y-2">
                  {bankRates.map((b, i) => (
                    <div key={i} className="flex items-center justify-between py-1.5 border-b border-slate-100 last:border-0">
                      <span className="text-sm text-[#0F172A]">{b.bank}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-slate-400">{b.type}</span>
                        <span className="text-sm font-semibold text-[#0F172A]">{b.rate.toFixed(2)}%</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {amort && (
              <div className="bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200/60 p-5">
                <h3 className="font-semibold text-[#0F172A] mb-3 text-sm">Amortization (First 5 Years)</h3>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={amort}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                    <XAxis dataKey="year" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 10 }} />
                    <Tooltip contentStyle={{ borderRadius: 12, fontSize: 12, border: '1px solid #E2E8F0' }} formatter={(v: number) => AED(v)} />
                    <Legend />
                    <Bar dataKey="principalPaid" name="Principal" fill="#1E40AF" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="interestPaid" name="Interest" fill="#3B82F6" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Pricing ─────────────────────────────────────────────────────────────────

function PricingPage() {
  const [annual, setAnnual] = useState(false)
  const tiers = [
    { name: 'Free', price: 0, period: '', color: 'border-slate-200', features: ['5 heatmap searches/day', '3-month transaction history', '10 live listings/day', 'Basic neighbourhood score', 'INR equivalent display', '3 community watchlist'], cta: 'Get Started', ctaStyle: 'bg-[#1E40AF] text-white' },
    { name: 'Pro', price: 49, period: '/mo', color: 'border-[#3B82F6]', badge: 'Most Popular', features: ['Unlimited heatmap searches', 'Full transaction history (1998–now)', 'Unlimited live listings', '12-month price charts', 'Yield calculator', 'Mortgage simulator', 'Developer risk scores', 'Off-plan tracker', '5-property portfolio', '20 community watchlist', '3 deal alerts', 'Comparable transactions', 'Visa eligibility screener'], cta: 'Start Pro', ctaStyle: 'bg-[#3B82F6] text-white' },
    { name: 'Elite', price: 149, period: '/mo', color: 'border-[#1E40AF]', features: ['Everything in Pro', '5-year price charts', 'AI price predictions (6-mo)', 'Unlimited portfolio', 'Unlimited watchlist', 'Unlimited deal alerts', 'PDF investment reports', 'WhatsApp alerts', 'API access (AED 299/mo add-on)'], cta: 'Start Elite', ctaStyle: 'bg-[#1E40AF] text-white' },
  ]

  return (
    <div className="max-w-[1000px] mx-auto px-4 py-12">
      <div className="text-center mb-8">
        <h2 className="text-3xl font-bold text-[#0F172A] mb-3">Simple, transparent pricing</h2>
        <p className="text-slate-400 mb-6">Start free. Upgrade when you need more data and power tools.</p>
        <div className="inline-flex items-center gap-3 bg-white/80 backdrop-blur border border-slate-200 rounded-xl p-1">
          <button onClick={() => setAnnual(false)} className={cn('px-4 py-1.5 rounded-lg text-sm font-medium transition-all', !annual ? 'bg-[#1E40AF] text-white' : 'text-slate-500')}>Monthly</button>
          <button onClick={() => setAnnual(true)} className={cn('px-4 py-1.5 rounded-lg text-sm font-medium transition-all', annual ? 'bg-[#1E40AF] text-white' : 'text-slate-500')}>
            Annual <span className="text-[10px] text-[#059669]">Save 20%</span>
          </button>
        </div>
      </div>

      <div className="grid md:grid-cols-3 gap-6">
        {tiers.map(t => (
          <div key={t.name} className={cn('bg-white/80 backdrop-blur-xl rounded-2xl border-2 p-6 relative', t.color)}>
            {t.badge && <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-[#3B82F6] text-white text-[10px] font-bold px-3 py-1 rounded-full">{t.badge}</div>}
            <h3 className="text-xl font-bold text-[#0F172A]">{t.name}</h3>
            <div className="mt-2 mb-4">
              {t.price === 0 ? <span className="text-3xl font-bold text-[#0F172A]">Free</span> : (
                <><span className="text-3xl font-bold text-[#0F172A]">AED {annual ? Math.round(t.price * 0.8) : t.price}</span><span className="text-sm text-slate-400">{t.period}</span></>
              )}
            </div>
            <ul className="space-y-2 mb-6">
              {t.features.map((f, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-[#0F172A]"><span className="text-[#059669] mt-0.5">✓</span> {f}</li>
              ))}
            </ul>
            <button className={cn('w-full py-2.5 rounded-xl font-semibold transition-colors', t.ctaStyle)}>{t.cta}</button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Main App ────────────────────────────────────────────────────────────────

export default function App() {
  const [page, setPage] = useState<Page>('landing')
  const [selectedCommunity, setSelectedCommunity] = useState('dubai-marina')

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50/80 via-slate-50 to-blue-50/40">
      <Nav page={page} setPage={setPage} />
      {page === 'landing' && <Landing setPage={setPage} />}
      {page === 'dashboard' && <HeatmapDashboard setPage={setPage} setSelectedCommunity={setSelectedCommunity} />}
      {page === 'community' && <CommunityDetail slug={selectedCommunity} setPage={setPage} />}
      {page === 'listings' && <ListingsFeed setPage={setPage} setSelectedCommunity={setSelectedCommunity} />}
      {page === 'portfolio' && <Portfolio />}
      {page === 'watchlist' && <Watchlist setPage={setPage} setSelectedCommunity={setSelectedCommunity} />}
      {page === 'deals' && <Deals setPage={setPage} setSelectedCommunity={setSelectedCommunity} />}
      {page === 'alerts' && <AlertsPage />}
      {page === 'pricing' && <PricingPage />}
      {page === 'yield' && <YieldCalculator />}
      {page === 'mortgage' && <MortgageSimulator />}
      <footer className="bg-[#0F172A] text-white/40 text-center py-6 text-xs">
        © 2026 sqftLab · UAE Property Intelligence Platform · Data from DLD, ADREC, Bayut, PropertyFinder, Dubizzle
      </footer>
    </div>
  )
}
