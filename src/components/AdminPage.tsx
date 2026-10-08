import { useCallback, useEffect, useState } from 'react'
import { authedFetch, sessionHeaders, setSessionToken } from '@/lib/session'
import {
  ShieldCheck, RefreshCw, LogOut, CheckCircle2, AlertTriangle, XCircle,
  Database, Users, Activity, ExternalLink, Lock, Eye, EyeOff, Server,
} from 'lucide-react'

// Operator console (admin only).
//
// Every value on this screen comes from `/api/sqftlab/admin/*`, which verifies a
// live session row AND the `isAdmin` flag server-side. This component renders a
// login form when the caller is not an admin, but that is a convenience — the
// data simply is not sent to a non-admin, so there is no client-side gate to
// bypass here.
//
// Style follows the app's design system (CSS variables, no component library) so
// it reads as part of the product rather than a bolt-on.

const CARD: React.CSSProperties = {
  background: 'rgba(255,255,255,0.72)',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
  border: '1px solid var(--line)',
  boxShadow: '0 1px 2px rgba(16,24,40,0.04), 0 12px 32px rgba(16,24,40,0.06)',
}

interface CheckResult {
  page: string
  path: string
  note: string
  ok: boolean
  degraded: boolean
  failing: boolean
  status: number
  ms: number
  rows: number | null
  error: string | null
}

interface Overview {
  deployment: {
    commit: string
    environment: string
    database: string
    node: string
    startedAt: number
    uptimeSeconds: number
  }
  counts: Record<string, number>
  communitiesByEmirate: Array<{ emirate: string; count: number }>
  lastCronRun: {
    id: string
    status: string
    okCount: number
    failCount: number
    durationMs: number | null
    startedAt: string
    finishedAt: string | null
    steps: Array<{ step: string; status: string; ms: number; detail?: string; error?: string }>
  } | null
  dataSources: {
    configured: string[]
    dormant: Array<{ capability: string; missing: string[]; symptom: string }>
  }
}

interface AdminUser {
  id: string
  email: string
  name: string | null
  role: string | null
  tier: string
  isAdmin: boolean
  registeredVia: string | null
  createdAt: string
  lastLoginAt: string | null
  counts: { portfolios: number; watchlists: number; alerts: number; sessions: number }
}

interface CoverageDistrict {
  rank: number
  slug: string
  name: string
  medianAedSqft: number | null
  saleData: boolean
  medianAnnualRentAed: number | null
  psfSource: string
  listings: { sale: number; rent: number }
}

interface CoverageEmirate {
  emirate: string
  tracked: number
  withSalePrice: number
  saleListings: number
  rentListings: number
  top: CoverageDistrict[]
}

/** Check label → in-app page id, so "Open" navigates instead of reloading the SPA. */
const PAGE_ID: Record<string, string> = {
  Landing: 'landing',
  Heatmap: 'dashboard',
  Community: 'community',
  'Community Abu Dhabi': 'community',
  Listings: 'listings',
  Markets: 'markets',
  Predictions: 'predictions',
  'Market Pulse': 'market-pulse',
  Intelligence: 'intelligence',
  Portfolio: 'portfolio',
  Watchlist: 'watchlist',
  Deals: 'deals',
  Alerts: 'alerts',
  Yield: 'yield',
  Mortgage: 'mortgage',
  CMA: 'cma',
  Buildings: 'buildings',
  'Capital Flow': 'capital-flow',
  'Deal Network': 'deal-network',
  'API keys': 'api-keys',
  Methodology: 'about',
  Exports: 'export',
}

function statusTone(r: CheckResult) {
  if (r.ok) return { color: 'var(--up)', Icon: CheckCircle2, label: 'working' }
  if (r.degraded) return { color: '#B45309', Icon: AlertTriangle, label: 'no data' }
  return { color: 'var(--down)', Icon: XCircle, label: 'failing' }
}

function Pill({ children, tone = 'var(--ink-4)' }: { children: React.ReactNode; tone?: string }) {
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap"
      style={{ background: 'rgba(16,24,40,0.06)', color: tone }}
    >
      {children}
    </span>
  )
}

function StatCard({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="p-3 rounded-2xl" style={CARD}>
      <p className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: 'var(--ink-5)' }}>{label}</p>
      <p className="text-lg font-bold tabular-nums mt-0.5" style={{ color: 'var(--ink-1)' }}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </p>
      {hint && <p className="text-[10px] mt-0.5" style={{ color: 'var(--ink-5)' }}>{hint}</p>}
    </div>
  )
}

export default function AdminPage({ setPage }: { setPage: (p: any) => void }) {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null)
  const [sessionEmail, setSessionEmail] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const [tab, setTab] = useState<'overview' | 'pages' | 'accounts'>('overview')
  const [overview, setOverview] = useState<Overview | null>(null)
  const [checks, setChecks] = useState<{ summary: Record<string, number>; results: CheckResult[]; checkedAt: string } | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [coverage, setCoverage] = useState<CoverageEmirate[]>([])
  const [loading, setLoading] = useState(false)

  const loadSession = useCallback(async () => {
    try {
      const res = await authedFetch('/api/sqftlab/admin/session')
      const body = await res.json().catch(() => ({}))
      setIsAdmin(!!body.isAdmin)
      if (body.email) {
        setSessionEmail(body.email)
        setEmail((prev) => prev || body.email)
      }
    } catch {
      setIsAdmin(false)
    }
  }, [])

  useEffect(() => { void loadSession() }, [loadSession])

  const loadData = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [o, u, cov] = await Promise.all([
        authedFetch('/api/sqftlab/admin/overview'),
        authedFetch('/api/sqftlab/admin/users?limit=100'),
        authedFetch('/api/sqftlab/coverage?limit=10'),
      ])
      if (o.status === 401 || o.status === 403) {
        setIsAdmin(false)
        setError('Your session is no longer an administrator session. Sign in again.')
        return
      }
      const ob = await o.json().catch(() => ({}))
      if (!o.ok) throw new Error(ob.error || `Overview failed (${o.status})`)
      setOverview(ob as Overview)

      const ub = await u.json().catch(() => ({}))
      if (u.ok) setUsers((ub.users ?? []) as AdminUser[])

      const cb = await cov.json().catch(() => ({}))
      if (cov.ok) setCoverage((cb.emirates ?? []) as CoverageEmirate[])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the console.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (isAdmin) void loadData() }, [isAdmin, loadData])

  const runChecks = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await authedFetch('/api/sqftlab/admin/checks')
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `Checks failed (${res.status})`)
      setChecks(body)
      setTab('pages')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not run the page checks.')
    } finally {
      setLoading(false)
    }
  }

  const signIn = async () => {
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/sqftlab/auth/signin', {
        method: 'POST',
        credentials: 'same-origin',
        headers: sessionHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ email, password }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || `Sign-in failed (${res.status})`)
        return
      }
      if (!body.user?.isAdmin) {
        setError('That account signed in, but it is not an administrator.')
        return
      }
      // Adopt the session BEFORE flipping isAdmin, so the effect that loads the
      // console fires with the new identity already in place. Without this the
      // admin fetches run as the previous (demo) session and answer 403 — which is
      // exactly what the preview edge produces when the cookie is stripped.
      setSessionToken(typeof body.sessionToken === 'string' ? body.sessionToken : null)
      setIsAdmin(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setBusy(false)
    }
  }

  const signOut = async () => {
    await fetch('/api/sqftlab/auth/signout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: sessionHeaders(),
    }).catch(() => {})
    // Drop the token locally too. The server has revoked the session row, so this
    // is belt-and-braces — but a stale token in sessionStorage would be presented
    // on the next page load and read as a failed session rather than a clean one.
    setSessionToken(null)
    // A full reload, not just local state: the rest of the SPA holds the previous
    // identity's data (portfolio, tier gates) and would keep rendering it.
    window.location.href = '/'
  }

  // ── Login ──────────────────────────────────────────────────────────────────
  if (isAdmin === null) {
    return (
      <div className="max-w-[560px] mx-auto px-4 sm:px-6 py-14">
        <p className="text-sm" style={{ color: 'var(--ink-4)' }}>Checking your session…</p>
      </div>
    )
  }

  if (!isAdmin) {
    return (
      <div className="max-w-[460px] mx-auto px-4 sm:px-6 py-10 sm:py-14">
        <div className="p-5 sm:p-7 rounded-[22px]" style={CARD}>
          <div className="flex items-center gap-2 mb-1">
            <Lock size={16} style={{ color: 'var(--b600)' }} />
            <h1 className="text-base font-bold" style={{ color: 'var(--ink-1)' }}>Operator sign-in</h1>
          </div>
          <p className="text-[11px] mb-6" style={{ color: 'var(--ink-5)' }}>
            Administrator credentials are required. This console is not linked from anywhere in the app.
          </p>

          <label className="block text-[11px] font-semibold mb-1.5" style={{ color: 'var(--ink-3)' }}>Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            className="w-full mb-3 px-3 py-2.5 rounded-xl text-xs outline-none"
            style={{ background: 'rgba(255,255,255,0.85)', border: '1px solid var(--line)', color: 'var(--ink-1)' }}
          />

          <label className="block text-[11px] font-semibold mb-1.5" style={{ color: 'var(--ink-3)' }}>Password</label>
          <div className="relative mb-4">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && email && password) void signIn() }}
              autoComplete="current-password"
              className="w-full px-3 py-2.5 pr-10 rounded-xl text-xs outline-none"
              style={{ background: 'rgba(255,255,255,0.85)', border: '1px solid var(--line)', color: 'var(--ink-1)' }}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg"
              style={{ color: 'var(--ink-5)' }}
            >
              {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>

          <button
            onClick={signIn}
            disabled={busy || !email || !password}
            className="w-full py-2.5 rounded-full text-xs font-semibold transition-all disabled:opacity-60"
            style={{ background: 'var(--b600)', color: '#fff' }}
          >
            {busy ? 'Signing in…' : 'Sign in as administrator'}
          </button>

          {error && (
            <div className="mt-4 px-3 py-2 rounded-xl text-[11px]" style={{ background: 'rgba(220,38,38,0.08)', color: 'var(--down)' }}>
              {error}
            </div>
          )}
          {sessionEmail && (
            <p className="mt-4 text-[10px]" style={{ color: 'var(--ink-5)' }}>
              Currently signed in as {sessionEmail}, which is not an administrator.
            </p>
          )}
        </div>
        <div className="text-center mt-5">
          <button onClick={() => setPage('landing')} className="text-xs font-semibold" style={{ color: 'var(--ink-4)' }}>
            ← Back to the app
          </button>
        </div>
      </div>
    )
  }

  // ── Console ────────────────────────────────────────────────────────────────
  const tabs = [
    { id: 'overview' as const, label: 'Overview', icon: Activity },
    { id: 'pages' as const, label: 'Pages', icon: ExternalLink },
    { id: 'accounts' as const, label: 'Accounts', icon: Users },
  ]

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-2.5">
          <ShieldCheck size={20} style={{ color: 'var(--b600)' }} />
          <div>
            <h1 className="text-lg font-bold leading-tight" style={{ color: 'var(--ink-1)' }}>Operator console</h1>
            <p className="text-[11px]" style={{ color: 'var(--ink-5)' }}>System status and a page-by-page check of the live app.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={runChecks}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-semibold disabled:opacity-60"
            style={{ background: 'var(--b600)', color: '#fff' }}
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Run page checks
          </button>
          <button
            onClick={signOut}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-semibold"
            style={{ background: 'rgba(255,255,255,0.8)', color: 'var(--ink-3)', border: '1px solid var(--line)' }}
          >
            <LogOut size={13} /> Sign out
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 rounded-xl text-[11px]" style={{ background: 'rgba(220,38,38,0.08)', color: 'var(--down)' }}>
          {error}
        </div>
      )}

      <div className="flex gap-1.5 mb-5 overflow-x-auto pb-1">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-semibold whitespace-nowrap shrink-0"
            style={tab === id
              ? { background: 'var(--b600)', color: '#fff' }
              : { background: 'rgba(255,255,255,0.7)', color: 'var(--ink-3)', border: '1px solid var(--line)' }}
          >
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <OverviewTab overview={overview} coverage={coverage} loading={loading} onRefresh={loadData} />
      )}

      {tab === 'pages' && (
        <PagesTab checks={checks} loading={loading} onRun={runChecks} setPage={setPage} />
      )}

      {tab === 'accounts' && (
        <AccountsTab users={users} loading={loading} />
      )}
    </div>
  )
}

function OverviewTab({ overview, coverage, loading, onRefresh }: { overview: Overview | null; coverage: CoverageEmirate[]; loading: boolean; onRefresh: () => void }) {
  if (!overview) {
    return (
      <div className="p-5 rounded-2xl" style={CARD}>
        <p className="text-xs" style={{ color: 'var(--ink-4)' }}>{loading ? 'Loading…' : 'No data.'}</p>
      </div>
    )
  }

  const c = overview.counts
  const d = overview.deployment
  const uptimeMin = Math.floor(d.uptimeSeconds / 60)

  return (
    <div className="space-y-5">
      <div className="p-4 rounded-2xl" style={CARD}>
        <div className="flex items-center gap-2 mb-3">
          <Server size={14} style={{ color: 'var(--b600)' }} />
          <span className="text-xs font-semibold" style={{ color: 'var(--ink-2)' }}>Deployment</span>
          <button onClick={onRefresh} className="ml-auto text-[10px] font-semibold" style={{ color: 'var(--b600)' }}>Refresh</button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
          <StatCard label="Commit" value={d.commit === 'unknown' ? 'not stamped' : d.commit.slice(0, 7)} hint={d.commit === 'unknown' ? 'RAILWAY_GIT_COMMIT_SHA unset' : undefined} />
          <StatCard label="Environment" value={d.environment} />
          <StatCard label="Database" value={d.database} hint={d.database.includes('sqlite') ? 'data will not persist on Railway' : 'persistent'} />
          <StatCard label="Runtime" value={d.node} />
          <StatCard label="Uptime" value={uptimeMin < 60 ? `${uptimeMin}m` : `${Math.floor(uptimeMin / 60)}h ${uptimeMin % 60}m`} />
          <StatCard label="Community areas" value={overview.communitiesByEmirate.reduce((n, e) => n + e.count, 0)} />
        </div>
      </div>

      <div>
        <h2 className="text-xs font-semibold mb-2" style={{ color: 'var(--ink-2)' }}>Data</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
          <StatCard label="Users" value={c.users} hint={`${c.admins} admin`} />
          <StatCard label="Live sessions" value={c.liveSessions} />
          <StatCard label="Listings" value={c.listings} />
          <StatCard label="Transactions" value={c.transactions} hint={c.transactions === 0 ? 'needs a Dubai Pulse key' : undefined} />
          <StatCard label="Portfolios" value={c.portfolios} />
          <StatCard label="Watchlist rows" value={c.watchlist} />
          <StatCard label="Deal alerts" value={c.deals} />
          <StatCard label="Cron runs" value={c.cronRuns} />
          <StatCard label="DLD areas" value={c.dldReferences - c.dldProjects} />
          <StatCard label="DLD projects" value={c.dldProjects} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="p-4 rounded-2xl" style={CARD}>
          <h2 className="text-xs font-semibold mb-3" style={{ color: 'var(--ink-2)' }}>Coverage by emirate</h2>
          <div className="space-y-2">
            {overview.communitiesByEmirate.map((e) => (
              <div key={e.emirate} className="flex items-center justify-between">
                <span className="text-xs capitalize" style={{ color: 'var(--ink-3)' }}>{e.emirate.replace('_', ' ')}</span>
                <span className="text-xs font-semibold tabular-nums" style={{ color: 'var(--ink-1)' }}>{e.count} areas</span>
              </div>
            ))}
          </div>
        </div>

        <div className="p-4 rounded-2xl" style={CARD}>
          <h2 className="text-xs font-semibold mb-3" style={{ color: 'var(--ink-2)' }}>Data sources</h2>
          <p className="text-[10px] uppercase tracking-wide font-semibold mb-1.5" style={{ color: 'var(--up)' }}>
            Live {overview.dataSources.configured.length}
          </p>
          <div className="flex flex-wrap gap-1.5 mb-4">
            {overview.dataSources.configured.map((v) => (
              <span key={v} className="px-2 py-0.5 rounded-full text-[10px] font-mono" style={{ background: 'rgba(22,163,74,0.10)', color: 'var(--up)' }}>{v}</span>
            ))}
          </div>
          <p className="text-[10px] uppercase tracking-wide font-semibold mb-1.5" style={{ color: '#B45309' }}>
            Dormant {overview.dataSources.dormant.length}
          </p>
          <div className="space-y-2">
            {overview.dataSources.dormant.map((s) => (
              <div key={s.capability}>
                <p className="text-[11px] font-semibold" style={{ color: 'var(--ink-2)' }}>{s.capability}</p>
                <p className="text-[10px] font-mono" style={{ color: 'var(--ink-5)' }}>{s.missing.join(', ')}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {coverage.length > 0 && (
        <div className="p-4 rounded-2xl" style={CARD}>
          <h2 className="text-xs font-semibold mb-1" style={{ color: 'var(--ink-2)' }}>Coverage · top 10 districts per emirate</h2>
          <p className="text-[10px] mb-4" style={{ color: 'var(--ink-5)' }}>
            Ranked by sale price per sqft. A district with no sale listings is listed last and shows its rent
            instead — an absent measurement, not a zero.
          </p>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {coverage.map((em) => (
              <div key={em.emirate}>
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <span className="text-xs font-bold capitalize" style={{ color: 'var(--ink-1)' }}>{em.emirate.replace('_', ' ')}</span>
                  <Pill>{em.withSalePrice}/{em.tracked} with sale price</Pill>
                  <Pill>{em.saleListings.toLocaleString()} sale</Pill>
                  <Pill>{em.rentListings.toLocaleString()} rent</Pill>
                </div>
                <div className="space-y-1">
                  {em.top.map((d) => (
                    <div key={d.slug} className="flex items-center gap-2 text-[11px]">
                      <span className="w-4 text-right tabular-nums shrink-0" style={{ color: 'var(--ink-5)' }}>{d.rank}</span>
                      <span className="flex-1 min-w-0 break-words" style={{ color: 'var(--ink-2)' }}>{d.name}</span>
                      {d.saleData ? (
                        <span className="tabular-nums font-semibold shrink-0" style={{ color: 'var(--ink-1)' }}>
                          AED {d.medianAedSqft?.toLocaleString()}
                        </span>
                      ) : (
                        <span className="shrink-0 italic" style={{ color: 'var(--ink-5)' }}>
                          {d.medianAnnualRentAed ? `rent AED ${d.medianAnnualRentAed.toLocaleString()}/yr` : 'no data'}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="p-4 rounded-2xl" style={CARD}>
        <h2 className="text-xs font-semibold mb-3" style={{ color: 'var(--ink-2)' }}>Last hourly refresh</h2>
        {!overview.lastCronRun ? (
          <p className="text-xs" style={{ color: 'var(--ink-4)' }}>No runs recorded.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <Pill tone={overview.lastCronRun.status === 'success' ? 'var(--up)' : '#B45309'}>{overview.lastCronRun.status}</Pill>
              <Pill>{overview.lastCronRun.okCount} ok</Pill>
              {overview.lastCronRun.failCount > 0 && <Pill tone="var(--down)">{overview.lastCronRun.failCount} failed</Pill>}
              {overview.lastCronRun.durationMs != null && <Pill>{(overview.lastCronRun.durationMs / 1000).toFixed(1)}s</Pill>}
              <Pill>{new Date(overview.lastCronRun.startedAt).toLocaleString()}</Pill>
            </div>
            <div className="space-y-1.5">
              {overview.lastCronRun.steps.map((s) => (
                <div key={s.step} className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3">
                  <span className="text-[11px] font-semibold sm:w-40 shrink-0" style={{ color: 'var(--ink-2)' }}>{s.step}</span>
                  <Pill tone={s.status === 'ok' ? 'var(--up)' : s.status === 'skipped' ? '#B45309' : 'var(--down)'}>{s.status}</Pill>
                  <span className="text-[10px] break-words" style={{ color: 'var(--ink-5)' }}>{s.error || s.detail || ''}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function PagesTab({
  checks, loading, onRun, setPage,
}: {
  checks: { summary: Record<string, number>; results: CheckResult[]; checkedAt: string } | null
  loading: boolean
  onRun: () => void
  setPage: (p: any) => void
}) {
  if (!checks) {
    return (
      <div className="p-5 rounded-2xl" style={CARD}>
        <p className="text-xs mb-3" style={{ color: 'var(--ink-4)' }}>
          Runs every page's backing endpoint as you, and reports what came back.
        </p>
        <button
          onClick={onRun}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-semibold disabled:opacity-60"
          style={{ background: 'var(--b600)', color: '#fff' }}
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> {loading ? 'Checking…' : 'Run page checks'}
        </button>
      </div>
    )
  }

  const s = checks.summary
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
        <StatCard label="Pages checked" value={s.total ?? 0} />
        <StatCard label="Working" value={s.ok ?? 0} />
        <StatCard label="No data yet" value={s.degraded ?? 0} hint="route fine, source missing" />
        <StatCard label="Failing" value={s.failing ?? 0} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={onRun}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-semibold disabled:opacity-60"
          style={{ background: 'var(--b600)', color: '#fff' }}
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Re-run
        </button>
        <span className="text-[10px]" style={{ color: 'var(--ink-5)' }}>Checked {new Date(checks.checkedAt).toLocaleTimeString()}</span>
      </div>

      <div className="rounded-2xl overflow-hidden" style={CARD}>
        {checks.results.map((r) => {
          const tone = statusTone(r)
          const target = PAGE_ID[r.page]
          return (
            <div
              key={r.page}
              className="flex flex-col sm:flex-row sm:items-center gap-2 px-3.5 py-3 border-b last:border-b-0"
              style={{ borderColor: 'var(--line)' }}
            >
              <div className="flex items-center gap-2 sm:w-56 shrink-0">
                <tone.Icon size={14} style={{ color: tone.color }} />
                <span className="text-xs font-semibold" style={{ color: 'var(--ink-1)' }}>{r.page}</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 flex-1">
                <Pill tone={tone.color}>{tone.label}</Pill>
                <Pill>HTTP {r.status}</Pill>
                <Pill>{r.ms}ms</Pill>
                {r.rows !== null && <Pill>{r.rows} rows</Pill>}
              </div>
              <div className="flex items-center gap-2 sm:justify-end">
                {r.error && (
                  <span className="text-[10px] flex-1 sm:max-w-[280px]" style={{ color: 'var(--ink-5)' }}>{r.error}</span>
                )}
                {target && (
                  <button
                    onClick={() => setPage(target)}
                    className="text-[10px] font-semibold px-2.5 py-1 rounded-full shrink-0"
                    style={{ background: 'rgba(37,99,235,0.08)', color: 'var(--b700)' }}
                  >
                    Open
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function AccountsTab({ users, loading }: { users: AdminUser[]; loading: boolean }) {
  if (users.length === 0) {
    return (
      <div className="p-5 rounded-2xl" style={CARD}>
        <p className="text-xs" style={{ color: 'var(--ink-4)' }}>{loading ? 'Loading…' : 'No accounts.'}</p>
      </div>
    )
  }
  return (
    <div className="p-4 rounded-2xl" style={CARD}>
      <div className="flex items-center gap-2 mb-3">
        <Database size={14} style={{ color: 'var(--b600)' }} />
        <h2 className="text-xs font-semibold" style={{ color: 'var(--ink-2)' }}>{users.length} account{users.length === 1 ? '' : 's'}</h2>
      </div>
      <div className="space-y-2.5">
        {users.map((u) => (
          <div key={u.id} className="flex flex-col sm:flex-row sm:items-center gap-2 pb-2.5 border-b last:border-b-0 last:pb-0" style={{ borderColor: 'var(--line)' }}>
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-semibold break-all" style={{ color: 'var(--ink-1)' }}>{u.email}</span>
                {u.isAdmin && <Pill tone="var(--b700)">admin</Pill>}
                <Pill tone={u.tier === 'free' ? 'var(--ink-4)' : 'var(--up)'}>{u.tier}</Pill>
              </div>
              <p className="text-[10px] mt-0.5" style={{ color: 'var(--ink-5)' }}>
                {u.name ?? 'no name'} · via {u.registeredVia ?? 'unknown'} · joined {new Date(u.createdAt).toLocaleDateString()}
                {u.lastLoginAt ? ` · last login ${new Date(u.lastLoginAt).toLocaleDateString()}` : ''}
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5 shrink-0">
              <Pill>{u.counts.portfolios} portfolio</Pill>
              <Pill>{u.counts.watchlists} watchlist</Pill>
              <Pill>{u.counts.alerts} alerts</Pill>
              <Pill>{u.counts.sessions} sessions</Pill>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
