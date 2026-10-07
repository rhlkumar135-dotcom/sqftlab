import { useEffect, useState } from 'react'
import { Mail, ArrowRight, Check } from 'lucide-react'

// Sign-in (Task C) — email magic link + Google, on the sqftLab design system.
//
// PORT NOTE: the spec targets NextAuth v5, a Next.js library that cannot run in
// this Vite SPA. The endpoints below are the native equivalent (see the auth
// section of custom-routes.ts). Google reports itself as unconfigured rather
// than failing when GOOGLE_CLIENT_ID is absent.
//
// IDENTITY MODEL: the session cookie identifies the caller to the API. It is not
// a security boundary — the API takes the presented token at face value, exactly
// as it already did before this page existed.

const CARD_STYLE: React.CSSProperties = {
  background: 'rgba(255,255,255,0.7)',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
  border: '1px solid rgba(255,255,255,0.6)',
  boxShadow: '0 1px 2px rgba(16,24,40,0.04), 0 12px 32px rgba(16,24,40,0.08)',
}

const ROLES = ['investor', 'agent', 'developer', 'analyst', 'other'] as const
const TOP_AREAS = [
  'dubai-marina', 'downtown-dubai', 'jumeirah-village-circle', 'business-bay',
  'palm-jumeirah', 'difc', 'arabian-ranches', 'dubai-hills-estate',
  'jumeirah-lake-towers', 'al-reem-island',
]

type Step = 'signin' | 'sent' | 'onboard'

export default function SignInPage({
  reason,
  setPage,
}: {
  reason?: string
  setPage: (p: 'landing' | 'dashboard') => void
}) {
  const [step, setStep] = useState<Step>('signin')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [devLink, setDevLink] = useState<string | null>(null)
  const [googleConfigured, setGoogleConfigured] = useState<boolean | null>(null)

  // Onboarding state (Task C4)
  const [role, setRole] = useState<string>('')
  const [areas, setAreas] = useState<string[]>([])
  const [whatsapp, setWhatsapp] = useState(false)
  const [phone, setPhone] = useState('')

  // Probe Google availability so the button tells the truth instead of bouncing
  // the visitor to a 501.
  useEffect(() => {
    // bare-fetch-ok: a capability probe — it only asks whether Google sign-in is configured.
    fetch('/api/sqftlab/auth/google', { redirect: 'manual' })
      .then((r) => setGoogleConfigured(r.status !== 501))
      .catch(() => setGoogleConfigured(false))
  }, [])

  // Returning from the magic link: the server redirects with ?signed_in=1
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('signed_in') === '1') {
      setStep(params.get('welcome') === '1' ? 'onboard' : 'signin')
    }
  }, [])

  const requestLink = async () => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      // bare-fetch-ok: this IS the sign-in request. Presenting an existing identity here
      // would be asking the server to sign the visitor in as that other account.
      const res = await fetch('/api/sqftlab/auth/magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || `Request failed (${res.status})`)
        return
      }
      setStep('sent')
      setNotice(body.message ?? '')
      // Present only while no mail transport is configured, so the flow stays
      // testable on a deployment without SMTP.
      setDevLink(typeof body.devLink === 'string' ? body.devLink : null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setBusy(false)
    }
  }

  const finishOnboarding = async () => {
    setBusy(true)
    setError('')
    try {
      // bare-fetch-ok: runs on the session the magic link just established, server-side.
      const res = await fetch('/api/sqftlab/auth/onboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: role || null, areas, whatsappEnabled: whatsapp, whatsappPhone: phone }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || `Request failed (${res.status})`)
        return
      }
      setPage('dashboard')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setBusy(false)
    }
  }

  const shell = (children: React.ReactNode) => (
    <div className="max-w-[520px] mx-auto px-4 py-14">
      <div className="p-6 sm:p-8 rounded-[22px]" style={CARD_STYLE}>
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-xl font-bold tracking-tight" style={{ color: 'var(--ink-1)' }}>
            sqft<span style={{ color: 'var(--b600)' }}>Lab</span>
          </span>
        </div>
        <p className="text-xs mb-6" style={{ color: 'var(--ink-5)' }}>
          UAE property intelligence. Sign in to continue.
        </p>
        {reason && (
          <div
            className="mb-5 px-3 py-2 rounded-xl text-[11px]"
            style={{ background: 'rgba(37,99,235,0.08)', color: 'var(--b700)' }}
          >
            {reason}
          </div>
        )}
        {children}
        {error && (
          <div className="mt-4 px-3 py-2 rounded-xl text-[11px]" style={{ background: 'rgba(220,38,38,0.08)', color: 'var(--down)' }}>
            {error}
          </div>
        )}
        <p className="mt-6 text-[10px] leading-relaxed" style={{ color: 'var(--ink-5)' }}>
          By signing in, you agree to our Terms. No spam. Cancel anytime.
        </p>
      </div>
      <div className="text-center mt-5">
        <button
          onClick={() => setPage('landing')}
          className="text-xs font-semibold transition-colors hover:text-[var(--b600)]"
          style={{ color: 'var(--ink-4)' }}
        >
          Continue as guest →
        </button>
      </div>
    </div>
  )

  if (step === 'sent') {
    return shell(
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Mail size={16} style={{ color: 'var(--b600)' }} />
          <span className="text-sm font-semibold" style={{ color: 'var(--ink-1)' }}>Check your inbox</span>
        </div>
        <p className="text-xs leading-relaxed mb-4" style={{ color: 'var(--ink-4)' }}>
          We sent a sign-in link to <strong>{email}</strong>. It expires in 15 minutes and can only be used once.
        </p>
        {notice && (
          <p className="text-[11px] mb-4" style={{ color: 'var(--ink-5)' }}>{notice}</p>
        )}
        {devLink && (
          // Only rendered when the API reported `delivery: "unconfigured"`.
          <a
            href={devLink}
            className="inline-flex items-center gap-1.5 text-xs font-semibold px-4 py-2 rounded-full"
            style={{ background: 'var(--b600)', color: '#fff' }}
          >
            Open sign-in link <ArrowRight size={13} />
          </a>
        )}
        <button
          onClick={() => { setStep('signin'); setDevLink(null) }}
          className="block mt-5 text-[11px] font-semibold"
          style={{ color: 'var(--ink-4)' }}
        >
          Use a different email
        </button>
      </div>,
    )
  }

  if (step === 'onboard') {
    return shell(
      <div>
        <h2 className="text-base font-bold mb-1" style={{ color: 'var(--ink-1)' }}>Welcome to sqftLab 👋</h2>
        <p className="text-[11px] mb-5" style={{ color: 'var(--ink-5)' }}>
          Two quick questions so the dashboard opens on what you care about.
        </p>

        <p className="text-[11px] font-semibold mb-2" style={{ color: 'var(--ink-3)' }}>What describes you best?</p>
        <div className="flex flex-wrap gap-2 mb-5">
          {ROLES.map((r) => (
            <button
              key={r}
              onClick={() => setRole(r)}
              className="px-3 py-1.5 rounded-full text-[11px] font-semibold capitalize transition-all"
              style={role === r
                ? { background: 'var(--b600)', color: '#fff' }
                : { background: 'rgba(255,255,255,0.7)', color: 'var(--ink-3)', border: '1px solid var(--line)' }}
            >
              {r}
            </button>
          ))}
        </div>

        <p className="text-[11px] font-semibold mb-2" style={{ color: 'var(--ink-3)' }}>Which areas are you tracking?</p>
        <div className="flex flex-wrap gap-2 mb-5">
          {TOP_AREAS.map((a) => {
            const on = areas.includes(a)
            return (
              <button
                key={a}
                onClick={() => setAreas(on ? areas.filter((x) => x !== a) : [...areas, a])}
                className="px-3 py-1.5 rounded-full text-[11px] transition-all capitalize"
                style={on
                  ? { background: 'rgba(37,99,235,0.12)', color: 'var(--b700)', border: '1px solid rgba(37,99,235,0.3)' }
                  : { background: 'rgba(255,255,255,0.7)', color: 'var(--ink-3)', border: '1px solid var(--line)' }}
              >
                {on && <Check size={10} className="inline mr-1" />}
                {a.replace(/-/g, ' ')}
              </button>
            )
          })}
        </div>

        <label className="flex items-center gap-2 mb-3 text-[11px]" style={{ color: 'var(--ink-3)' }}>
          <input type="checkbox" checked={whatsapp} onChange={(e) => setWhatsapp(e.target.checked)} />
          Send me a WhatsApp digest
        </label>
        {whatsapp && (
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+971 50 123 4567"
            className="w-full mb-4 px-3 py-2 rounded-xl text-xs outline-none"
            style={{ background: 'rgba(255,255,255,0.8)', border: '1px solid var(--line)', color: 'var(--ink-1)' }}
          />
        )}

        <button
          onClick={finishOnboarding}
          disabled={busy}
          className="w-full py-2.5 rounded-full text-xs font-semibold transition-all disabled:opacity-60"
          style={{ background: 'var(--b600)', color: '#fff' }}
        >
          {busy ? 'Saving…' : 'Go to dashboard'}
        </button>
        <button
          onClick={() => setPage('dashboard')}
          className="block w-full mt-3 text-[11px] font-semibold"
          style={{ color: 'var(--ink-4)' }}
        >
          Skip for now
        </button>
      </div>,
    )
  }

  return shell(
    <div>
      <a
        href="/api/sqftlab/auth/google"
        className="w-full flex items-center justify-center gap-2.5 py-2.5 rounded-full text-xs font-semibold transition-all mb-4"
        style={{ background: '#fff', color: 'var(--ink-1)', border: '1px solid var(--line)' }}
      >
        <svg width="15" height="15" viewBox="0 0 48 48" aria-hidden>
          <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.3 13.2 17.6 9.5 24 9.5z" />
          <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-2.8-.4-4.1H24v8.4h12.5c-.3 2.1-1.6 5.2-4.6 7.3l7.6 5.9c4.5-4.2 6.6-10.3 6.6-17.5z" />
          <path fill="#FBBC05" d="M10.4 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.8-6.1C1 16.4 0 20.1 0 24s1 7.6 2.6 10.8l7.8-6.1z" />
          <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.6-5.9l-7.6-5.9c-2 1.4-4.7 2.4-8 2.4-6.4 0-11.7-3.7-13.6-9.1l-7.8 6.1C6.5 42.6 14.6 48 24 48z" />
        </svg>
        Continue with Google
      </a>
      {googleConfigured === false && (
        <p className="text-[10px] mb-4 -mt-2" style={{ color: 'var(--ink-5)' }}>
          Google sign-in is not configured on this deployment — use email below.
        </p>
      )}

      <div className="flex items-center gap-3 mb-4">
        <div className="flex-1 h-px" style={{ background: 'var(--line)' }} />
        <span className="text-[10px]" style={{ color: 'var(--ink-5)' }}>or</span>
        <div className="flex-1 h-px" style={{ background: 'var(--line)' }} />
      </div>

      <label className="block text-[11px] font-semibold mb-1.5" style={{ color: 'var(--ink-3)' }}>
        Sign in with email
      </label>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && email) void requestLink() }}
        placeholder="you@company.com"
        className="w-full mb-3 px-3 py-2.5 rounded-xl text-xs outline-none"
        style={{ background: 'rgba(255,255,255,0.8)', border: '1px solid var(--line)', color: 'var(--ink-1)' }}
      />
      <button
        onClick={requestLink}
        disabled={busy || !email}
        className="w-full py-2.5 rounded-full text-xs font-semibold transition-all disabled:opacity-60"
        style={{ background: 'var(--b600)', color: '#fff' }}
      >
        {busy ? 'Sending…' : 'Email me a sign-in link'}
      </button>
    </div>,
  )
}
