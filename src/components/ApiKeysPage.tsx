import { useCallback, useEffect, useRef, useState } from 'react'
import {
  KeyRound, Plus, Copy, Check, Trash2, ArrowRight, AlertTriangle, BookOpen, Loader2, ShieldAlert,
} from 'lucide-react'
import { authedFetch } from '@/lib/session'
import { usePageMeta } from '@/lib/seo'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'

/**
 * API key management (Day 17 Task D). Pro and above.
 *
 * Two things differ from the brief, both about not stating something false:
 *
 *  · The brief's usage card is "Calls today: XX / 500" — one account-wide figure against
 *    one limit. The server enforces limits PER KEY (see API_DAILY_LIMITS and the /v1
 *    middleware), so two keys do not share a 500/day pool. Reporting a single bar would
 *    invent a shared quota and show a two-key account at "900/500". The bar tracks the
 *    BUSIEST key against the per-key ceiling, and says so; the account-wide total is shown
 *    beside it, explicitly not compared to a limit.
 *  · The brief greys out nothing but assumes a client-side tier string. The tier, the
 *    limits and the key cap all come from the server's `usage` block, so the page cannot
 *    promise a limit the API will not apply.
 *
 * Entitlement is decided server-side: a 403 renders the upgrade notice rather than a
 * disabled button, because the server refuses regardless of what this page draws.
 */

interface KeyRow {
  id: string
  prefix: string
  name: string
  tier: string
  callsToday: number
  callsMonth: number
  dailyLimit: number
  remainingToday: number
  lastUsedAt: string | null
  createdAt: string
}

interface Usage {
  tier: string
  keyCount: number
  maxKeys: number
  dailyLimitPerKey: number
  monthlyLimitPerKey: number
  busiestKeyName: string | null
  busiestKeyCallsToday: number
  totalCallsToday: number
  totalCallsMonth: number
  resetsAtUtc: string
  monthResetsAtUtc: string
}

const TIER_LABEL: Record<string, string> = {
  free: 'Free', pro: 'Pro', elite: 'Elite', enterprise: 'Enterprise', institutional: 'Institutional',
}

function fmtDate(iso: string | null): string {
  if (!iso) return 'Never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'Never'
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function fmtRelative(iso: string | null): string {
  if (!iso) return 'Never'
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return 'Never'
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} hr ago`
  const days = Math.floor(hrs / 24)
  return days === 1 ? 'Yesterday' : `${days} days ago`
}

export default function ApiKeysPage({ onNavigate }: { onNavigate?: (page: 'docs' | 'pricing' | 'signin') => void }) {
  usePageMeta({
    title: 'API Keys',
    description: 'Create and revoke sqftLab API keys, and track per-key usage against your plan limits.',
    canonicalPath: '/keys',
  })

  const [keys, setKeys] = useState<KeyRow[]>([])
  const [usage, setUsage] = useState<Usage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [blocked, setBlocked] = useState<{ requiredTier: string } | null>(null)
  const [signedOut, setSignedOut] = useState(false)

  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [rawKey, setRawKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const [revokeTarget, setRevokeTarget] = useState<KeyRow | null>(null)
  const [revoking, setRevoking] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await authedFetch('/api/sqftlab/api-keys')
      const body = (await res.json().catch(() => ({}))) as {
        keys?: KeyRow[]; usage?: Usage; error?: string; requiredTier?: string
      }
      if (res.status === 401) {
        setSignedOut(true)
        setBlocked(null)
      } else if (res.status === 403) {
        setBlocked({ requiredTier: body.requiredTier ?? 'pro' })
      } else if (!res.ok) {
        // Surface the server's own message — a generic "Failed to load" here strands the
        // user with no way to tell a broken key from an unentitled account.
        setError(body.error ?? `Request failed (${res.status})`)
      } else {
        setBlocked(null)
        setSignedOut(false)
        setKeys(body.keys ?? [])
        setUsage(body.usage ?? null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error')
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const createKey = async () => {
    setCreating(true)
    setCreateError(null)
    try {
      const res = await authedFetch('/api/sqftlab/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim() || 'Untitled key' }),
      })
      const body = (await res.json().catch(() => ({}))) as { key?: string; error?: string; maxKeys?: number; current?: number }
      if (!res.ok) {
        setCreateError(body.error ?? `Could not create the key (${res.status})`)
        return
      }
      setRawKey(body.key ?? null)
      setNewName('')
      await load()
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : 'Network error')
    } finally {
      if (mounted.current) setCreating(false)
    }
  }

  const revoke = async () => {
    if (!revokeTarget) return
    setRevoking(true)
    try {
      const res = await authedFetch(`/api/sqftlab/api-keys/${revokeTarget.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setNotice(body.error ?? `Could not revoke the key (${res.status})`)
      } else {
        setNotice(`Revoked “${revokeTarget.name}”.`)
      }
      setRevokeTarget(null)
      await load()
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Network error')
    } finally {
      if (mounted.current) setRevoking(false)
    }
  }

  const copyRaw = async () => {
    if (!rawKey) return
    try {
      await navigator.clipboard.writeText(rawKey)
      setCopied(true)
      setTimeout(() => { if (mounted.current) setCopied(false) }, 1600)
    } catch {
      // Clipboard unavailable (plain http, embedded browser). The key is selectable.
    }
  }

  // ── Blocked / signed out ───────────────────────────────────────────────────
  if (signedOut || blocked) {
    return (
      <div className="max-w-[900px] mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <div className="g2 p-6 sm:p-8 text-center space-y-3">
          <div className="inline-flex p-3 rounded-full" style={{ background: 'rgba(37,99,235,0.08)' }}>
            <ShieldAlert size={22} style={{ color: 'var(--b600)' }} />
          </div>
          <h1 className="text-lg font-semibold" style={{ color: 'var(--ink)' }}>
            {signedOut ? 'Sign in to manage API keys' : 'API keys need a Pro plan'}
          </h1>
          <p className="text-sm max-w-md mx-auto" style={{ color: 'var(--ink-4)' }}>
            {signedOut
              ? 'API keys belong to your account, so we need to know who you are before showing them.'
              : `Your current plan does not include API access. The API requires ${TIER_LABEL[blocked?.requiredTier ?? 'pro'] ?? blocked?.requiredTier} or above.`}
          </p>
          <div className="flex justify-center gap-2 pt-1">
            <button
              onClick={() => onNavigate?.(signedOut ? 'signin' : 'pricing')}
              className="px-4 py-2 rounded-full text-xs font-semibold"
              style={{ background: 'var(--b600)', color: '#fff', boxShadow: 'var(--sh-btn)' }}
            >
              {signedOut ? 'Sign in' : 'See plans'}
            </button>
            <button
              onClick={() => onNavigate?.('docs')}
              className="px-4 py-2 rounded-full text-xs font-semibold"
              style={{ color: 'var(--ink-3)', border: '1px solid var(--line)' }}
            >
              API documentation
            </button>
          </div>
        </div>
      </div>
    )
  }

  const pct = usage && usage.dailyLimitPerKey > 0
    ? Math.round((usage.busiestKeyCallsToday / usage.dailyLimitPerKey) * 100)
    : 0
  const atKeyCap = usage ? usage.keyCount >= usage.maxKeys : false

  return (
    <div className="max-w-[900px] mx-auto px-4 sm:px-6 py-8 sm:py-12 space-y-6">
      <header className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight flex items-center gap-2" style={{ color: 'var(--ink)' }}>
            <KeyRound size={22} style={{ color: 'var(--b600)' }} /> API Keys
          </h1>
          <p className="text-sm" style={{ color: 'var(--ink-4)' }}>
            Authenticate your applications with the sqftLab API.
          </p>
        </div>
        <button
          onClick={() => onNavigate?.('docs')}
          className="flex items-center gap-1.5 text-xs font-semibold self-start sm:self-auto"
          style={{ color: 'var(--b600)' }}
        >
          <BookOpen size={14} /> API Documentation <ArrowRight size={13} />
        </button>
      </header>

      {notice && (
        <div className="g4 px-3 py-2 text-xs flex items-start gap-2" style={{ color: 'var(--ink-4)' }}>
          <AlertTriangle size={13} className="mt-0.5 shrink-0" style={{ color: '#b45309' }} />
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} className="font-semibold" style={{ color: 'var(--ink-3)' }}>Dismiss</button>
        </div>
      )}

      {loading && (
        <div className="g2 p-6 flex items-center gap-2 text-sm" style={{ color: 'var(--ink-4)' }}>
          <Loader2 size={15} className="animate-spin" /> Loading your keys…
        </div>
      )}

      {!loading && error && (
        <div className="g2 p-5 space-y-2" role="alert">
          <div className="text-sm font-semibold" style={{ color: '#b91c1c' }}>Could not load your API keys</div>
          <div className="text-xs" style={{ color: 'var(--ink-4)' }}>{error}</div>
          <button onClick={() => void load()} className="text-xs font-semibold" style={{ color: 'var(--b600)' }}>
            Try again
          </button>
        </div>
      )}

      {!loading && !error && usage && (
        <>
          {/* Usage summary */}
          <section className="g2 p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--ink-4)' }}>
                  Busiest key today
                </div>
                <div className="flex items-baseline gap-2 mt-1">
                  <span className="text-2xl font-semibold mono" style={{ color: 'var(--ink)' }}>
                    {usage.busiestKeyCallsToday.toLocaleString()}
                  </span>
                  <span className="text-sm mono" style={{ color: 'var(--ink-4)' }}>
                    / {usage.dailyLimitPerKey.toLocaleString()}
                  </span>
                </div>
                {usage.busiestKeyName && (
                  <div className="text-[11px] mt-0.5" style={{ color: 'var(--ink-4)' }}>
                    “{usage.busiestKeyName}”
                  </div>
                )}
              </div>
              <div className="text-left sm:text-right">
                <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--ink-4)' }}>Plan</div>
                <div className="text-sm font-semibold mt-1" style={{ color: 'var(--ink)' }}>
                  {TIER_LABEL[usage.tier] ?? usage.tier}
                </div>
                <div className="text-[11px]" style={{ color: 'var(--ink-4)' }}>
                  Resets midnight UTC
                </div>
              </div>
            </div>

            <Progress
              value={usage.busiestKeyCallsToday}
              max={Math.max(usage.dailyLimitPerKey, 1)}
              aria-label="Busiest key daily usage"
            />

            {/* Limits are per key, so the account-wide totals are reported separately and
                deliberately not drawn against a single bar. */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
              <div className="g4 p-3">
                <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--ink-4)' }}>Calls this month</div>
                <div className="text-base font-semibold mono" style={{ color: 'var(--ink)' }}>
                  {usage.totalCallsMonth.toLocaleString()}
                </div>
                <div className="text-[10px]" style={{ color: 'var(--ink-4)' }}>all keys, combined</div>
              </div>
              <div className="g4 p-3">
                <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--ink-4)' }}>Calls today</div>
                <div className="text-base font-semibold mono" style={{ color: 'var(--ink)' }}>
                  {usage.totalCallsToday.toLocaleString()}
                </div>
                <div className="text-[10px]" style={{ color: 'var(--ink-4)' }}>across {usage.keyCount} key{usage.keyCount === 1 ? '' : 's'}</div>
              </div>
              <div className="g4 p-3">
                <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--ink-4)' }}>Keys</div>
                <div className="text-base font-semibold mono" style={{ color: 'var(--ink)' }}>
                  {usage.keyCount}/{usage.maxKeys}
                </div>
                <div className="text-[10px]" style={{ color: 'var(--ink-4)' }}>
                  {atKeyCap ? 'at your plan limit' : `${usage.maxKeys - usage.keyCount} available`}
                </div>
              </div>
            </div>

            <p className="text-[11px]" style={{ color: 'var(--ink-4)' }}>
              Limits apply per key, not per account — {usage.dailyLimitPerKey.toLocaleString()} calls a day for each
              key, resetting at midnight UTC. The bar tracks your busiest key.
            </p>
          </section>

          {/* Keys */}
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Active keys</h2>
              <button
                onClick={() => { setCreateOpen(true); setRawKey(null); setCreateError(null) }}
                disabled={atKeyCap}
                title={atKeyCap ? `Your plan allows ${usage.maxKeys} active keys` : undefined}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-semibold disabled:opacity-45 disabled:cursor-not-allowed"
                style={{ background: 'var(--b600)', color: '#fff', boxShadow: 'var(--sh-btn)' }}
              >
                <Plus size={13} /> Create New Key
              </button>
            </div>

            {atKeyCap && (
              <div className="g4 px-3 py-2 text-[11px] flex items-center gap-2" style={{ color: 'var(--ink-4)' }}>
                <AlertTriangle size={12} style={{ color: '#b45309' }} />
                <span className="flex-1">
                  {usage.keyCount}/{usage.maxKeys} keys on {TIER_LABEL[usage.tier] ?? usage.tier}. Revoke one, or upgrade for more.
                </span>
                <button onClick={() => onNavigate?.('pricing')} className="font-semibold shrink-0" style={{ color: 'var(--b600)' }}>
                  Upgrade
                </button>
              </div>
            )}

            {keys.length === 0 ? (
              <div className="g2 p-6 text-center space-y-1">
                <div className="text-sm font-medium" style={{ color: 'var(--ink)' }}>No API keys yet</div>
                <div className="text-xs" style={{ color: 'var(--ink-4)' }}>
                  Create one to start querying the API. Read the{' '}
                  <button onClick={() => onNavigate?.('docs')} className="font-semibold" style={{ color: 'var(--b600)' }}>
                    documentation
                  </button>{' '}
                  for endpoints and examples.
                </div>
              </div>
            ) : (
              <div className="g2 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[760px]">
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--gb)' }}>
                        {['Name', 'Prefix', 'Created', 'Last used', 'Today', 'This month', ''].map((h, i) => (
                          <th key={h || i} className="text-left px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide"
                            style={{ color: 'var(--ink-4)' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {keys.map((k) => (
                        <tr key={k.id} style={{ borderBottom: '1px solid var(--gb)' }}>
                          <td className="px-4 py-3 font-medium text-[13px]" style={{ color: 'var(--ink)' }}>{k.name}</td>
                          <td className="px-4 py-3 mono text-[12px]" style={{ color: 'var(--ink-4)' }}>
                            {k.prefix}<span style={{ opacity: 0.5 }}>…</span>
                          </td>
                          <td className="px-4 py-3 text-[12px] whitespace-nowrap" style={{ color: 'var(--ink-4)' }}>{fmtDate(k.createdAt)}</td>
                          <td className="px-4 py-3 text-[12px] whitespace-nowrap" style={{ color: 'var(--ink-4)' }}>
                            {k.lastUsedAt ? fmtRelative(k.lastUsedAt) : 'Never used'}
                          </td>
                          <td className="px-4 py-3 mono text-[12px]" style={{ color: 'var(--ink-4)' }}>
                            {k.callsToday.toLocaleString()}/{k.dailyLimit.toLocaleString()}
                          </td>
                          <td className="px-4 py-3 mono text-[12px]" style={{ color: 'var(--ink-4)' }}>
                            {k.callsMonth.toLocaleString()}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button
                              onClick={() => setRevokeTarget(k)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[11px] font-semibold"
                              style={{ color: '#b91c1c', border: '1px solid rgba(185,28,28,0.25)' }}
                            >
                              <Trash2 size={12} /> Revoke
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        </>
      )}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={(o) => { setCreateOpen(o); if (!o) { setRawKey(null); setCreateError(null); setNewName('') } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{rawKey ? 'Your new API key' : 'Create an API key'}</DialogTitle>
            <DialogDescription>
              {rawKey
                ? 'This is the only time the full key is shown. Store it somewhere safe.'
                : 'Give the key a name so you can tell your applications apart.'}
            </DialogDescription>
          </DialogHeader>

          {rawKey ? (
            <div className="space-y-3">
              <div className="flex items-start gap-2 px-3 py-2 rounded-lg text-[12px]"
                style={{ background: 'rgba(180,83,9,0.10)', color: '#92400e' }}>
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>Copy this key now — it will not be shown again. We store only a hash of it.</span>
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 overflow-x-auto px-3 py-2 rounded-lg text-[12px] mono"
                  style={{ background: '#1a1a2e', color: '#fff' }}>
                  {rawKey}
                </code>
                <button onClick={copyRaw} className="flex items-center gap-1 px-3 py-2 rounded-lg text-[11px] font-semibold shrink-0"
                  style={{ background: 'var(--b600)', color: '#fff' }}>
                  {copied ? <Check size={12} /> : <Copy size={12} />}{copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="key-name">Key name</Label>
              <Input
                id="key-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Production"
                maxLength={60}
                autoFocus
              />
              {createError && <div className="text-[12px]" style={{ color: '#b91c1c' }}>{createError}</div>}
            </div>
          )}

          <DialogFooter>
            {rawKey ? (
              <button onClick={() => { setCreateOpen(false); setRawKey(null) }}
                className="px-4 py-2 rounded-full text-xs font-semibold"
                style={{ background: 'var(--b600)', color: '#fff' }}>
                I&apos;ve saved it — Close
              </button>
            ) : (
              <>
                <button onClick={() => setCreateOpen(false)}
                  className="px-4 py-2 rounded-full text-xs font-semibold"
                  style={{ color: 'var(--ink-3)', border: '1px solid var(--line)' }}>
                  Cancel
                </button>
                <button onClick={createKey} disabled={creating}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-semibold disabled:opacity-50"
                  style={{ background: 'var(--b600)', color: '#fff' }}>
                  {creating && <Loader2 size={12} className="animate-spin" />} Create
                </button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke confirm — a Dialog, never window.confirm() */}
      <Dialog open={revokeTarget !== null} onOpenChange={(o) => { if (!o) setRevokeTarget(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke this key?</DialogTitle>
            <DialogDescription>
              Revoke “{revokeTarget?.name}”? This cannot be undone. Any application using{' '}
              <span className="mono">{revokeTarget?.prefix}…</span> will start receiving 401 errors immediately.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button onClick={() => setRevokeTarget(null)}
              className="px-4 py-2 rounded-full text-xs font-semibold"
              style={{ color: 'var(--ink-3)', border: '1px solid var(--line)' }}>
              Cancel
            </button>
            <button onClick={revoke} disabled={revoking}
              className="flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-semibold disabled:opacity-50"
              style={{ background: '#b91c1c', color: '#fff' }}>
              {revoking && <Loader2 size={12} className="animate-spin" />} Revoke key
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
