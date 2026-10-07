import { useCallback, useEffect, useState } from 'react'
import { ArrowRight, Check, Sparkles, X } from 'lucide-react'
import { authedFetch } from '@/lib/session'

/**
 * Day 15 Task A — the getting-started tour.
 *
 * Progress is held in `User.tourSteps` (a bitmask) / `User.tourCompleted`, NOT
 * `onboardingCompleted`: the sign-up wizard already owns that flag, so sharing it would
 * hide the tour from everyone who finished sign-up and mislabel the wizard as done when a
 * user merely dismissed a banner. See the schema comment.
 *
 * The bitmask (rather than a high-water mark) is deliberate: each checklist row claims a
 * specific page was visited, and "reached step N" would tick rows the user never opened —
 * a deep link to `/portfolio` would have marked the CMA step done too.
 *
 * Two deliberate departures from the brief, both because its version would not work here:
 *
 *  1. The steps navigate IN-APP instead of via `<a href>`. The brief's hrefs
 *     (`/communities/downtown-dubai`, `/alerts`) are not routes this app publishes — only
 *     `/cma` and `/portfolio` are in `PAGE_PATHS`. A real anchor would do a full page
 *     load, the router would not recognise the path, and the user would land back on the
 *     marketing page having "clicked" a step.
 *
 *  2. The market-comparison badge reads **Enterprise**, not "Pro/Enterprise". `/cma` is
 *     gated by `requireTier(c, 'enterprise', 'CMA Tool')`, so a "Pro" badge would sell an
 *     upgrade that still gets refused at the door — the exact false promise the paywall
 *     copy exists to avoid.
 */

/** Destination pages. Ids match the `Page` union in App.tsx. */
export type OnboardingTarget = 'community' | 'cma' | 'alerts' | 'portfolio'

interface TourStep {
  /** Matches the server's step numbering (0 = signed in, 4 = last). */
  step: number
  label: string
  detail: string
  target?: OnboardingTarget
  /** The tier the destination actually requires, or undefined when free. */
  badge?: string
}

const STEPS: TourStep[] = [
  { step: 0, label: 'Sign in', detail: 'You are here' },
  {
    step: 1,
    label: 'Browse a community',
    detail: 'See PSF, transactions and the neighbourhood score',
    target: 'community',
  },
  {
    step: 2,
    label: 'Run a market comparison',
    detail: 'Value a property against the DLD register',
    target: 'cma',
    badge: 'Enterprise',
  },
  {
    step: 3,
    label: 'Save a price alert',
    detail: 'Get told when a matching transaction closes',
    target: 'alerts',
    badge: 'Pro',
  },
  {
    step: 4,
    label: 'Add a property to your portfolio',
    detail: 'Track its DLD market value over time',
    target: 'portfolio',
    badge: 'Pro',
  },
]

/**
 * Which page id completes which step. The server owns the count and the ordering; this
 * is only the "did the user actually go there" mapping, so it must not drift — if a step
 * is added, add its page here.
 */
const STEP_FOR_PAGE: Partial<Record<OnboardingTarget, number>> = {
  community: 1,
  cma: 2,
  alerts: 3,
  portfolio: 4,
}

const LAST_STEP = STEPS.length - 1

interface Props {
  /** The page currently on screen, used to tick a step the moment it is visited. */
  page: string
  onNavigate: (target: OnboardingTarget) => void
}

export default function OnboardingBanner({ page, onNavigate }: Props) {
  const [state, setState] = useState<{ steps: number[]; completed: boolean } | null>(null)

  useEffect(() => {
    let alive = true
    authedFetch('/api/sqftlab/onboarding')
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { steps?: number[]; completed?: boolean } | null) => {
        if (alive && body && Array.isArray(body.steps)) {
          setState({ steps: body.steps, completed: body.completed === true })
        }
      })
      // A tour that cannot be read is not worth an error box; the app is fully usable
      // without it, so the banner simply does not render.
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const record = useCallback((step: number) => {
    authedFetch('/api/sqftlab/onboarding/step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { steps?: number[]; completed?: boolean } | null) => {
        if (body && Array.isArray(body.steps)) {
          setState({ steps: body.steps, completed: body.completed === true })
        }
      })
      .catch(() => {})
  }, [])

  // Visiting a destination ticks its step. Guarded on `!includes` so the state update this
  // triggers cannot re-fire the request, and so a revisit is a no-op.
  const reached = STEP_FOR_PAGE[page as OnboardingTarget]
  useEffect(() => {
    if (!state || state.completed) return
    if (!reached || state.steps.includes(reached)) return
    record(reached)
  }, [reached, state, record])

  const dismiss = useCallback(() => {
    setState((s) => (s ? { ...s, completed: true } : { steps: [], completed: true }))
    authedFetch('/api/sqftlab/onboarding/complete', { method: 'POST' }).catch(() => {})
  }, [])

  if (!state || state.completed) return null

  const done = new Set(state.steps)

  return (
    <section
      aria-label="Getting started"
      className="rounded-[16px] p-4 sm:p-5 mb-5"
      style={{ background: 'var(--g2)', border: '1px solid var(--gb)', boxShadow: 'var(--sh-card)' }}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles size={16} style={{ color: 'var(--b600)' }} className="shrink-0" />
          <h2 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
            Getting started
          </h2>
          <span
            className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
            style={{ fontFamily: 'var(--font-data)', color: 'var(--ink-4)', background: 'var(--g3)' }}
          >
            {state.steps.length}/{LAST_STEP}
          </span>
        </div>
        <button
          onClick={dismiss}
          aria-label="Dismiss getting started guide"
          className="shrink-0 p-1 rounded-md transition-colors"
          style={{ color: 'var(--ink-5)' }}
        >
          <X size={16} />
        </button>
      </div>

      <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-4 gap-y-1">
        {STEPS.map((s) => {
          // Step 0 is "Sign in" and is done by definition: the banner reads the tour from
          // an authenticated account, so nothing ever posts it. The brief shows it ticked
          // for the same reason. The counter below still counts only the four actionable
          // steps, so this does not inflate the progress number.
          const isDone = s.step === 0 || done.has(s.step)
          const canGo = !!s.target && !isDone
          return (
            <li key={s.step} className="flex items-center gap-2 py-1.5 min-w-0">
              {isDone ? (
                <Check size={14} className="shrink-0" style={{ color: '#16a34a' }} />
              ) : (
                <span
                  aria-hidden="true"
                  className="shrink-0 rounded-full"
                  style={{ width: 10, height: 10, border: '1.5px solid var(--ink-6)' }}
                />
              )}
              {canGo ? (
                <button
                  onClick={() => onNavigate(s.target as OnboardingTarget)}
                  className="flex items-center gap-1 text-[13px] text-left min-w-0 hover:underline"
                  style={{ color: 'var(--b700)', fontWeight: 500 }}
                >
                  <span className="min-w-0">{s.label}</span>
                  <ArrowRight size={12} className="shrink-0" />
                </button>
              ) : (
                <span
                  className="text-[13px] min-w-0"
                  style={{
                    color: isDone ? 'var(--ink-3)' : 'var(--ink-4)',
                    textDecoration: isDone ? 'none' : undefined,
                  }}
                >
                  {s.label}
                </span>
              )}
              {s.badge && !isDone && (
                <span
                  className="text-[9px] px-1.5 py-0.5 rounded shrink-0"
                  style={{ fontFamily: 'var(--font-data)', color: 'var(--b600)', border: '1px solid rgba(37,99,235,0.3)' }}
                >
                  {s.badge}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
