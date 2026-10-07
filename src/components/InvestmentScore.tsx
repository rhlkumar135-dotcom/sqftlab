import { useEffect, useRef, useState } from 'react'
import { Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer, Tooltip } from 'recharts'
import { authedFetch } from '@/lib/session'

/**
 * Investment Score, as the engine actually defines it (src/lib/score-engine.ts).
 *
 * The five factors and their weights are the engine's, not the spec's. The spec's
 * breakdown used `psf / yield / momentum / neighbourhood / developer` at
 * 25/25/20/15/15 — a different set entirely. Rendering the engine's numbers under
 * those labels would have mislabelled every bar: `supplyAbsorption` would have
 * appeared as "Neighbourhood" and the placeholder `capitalFlow` as "Developer".
 * A reader cannot audit a number whose label does not describe it.
 */
export interface ScoreBreakdown {
  psfMomentum: number | null
  rentalYield: number | null
  supplyAbsorption: number | null
  volumeTrend: number | null
  capitalFlow: number | null
}

interface ScoreProps {
  score: number
  breakdown?: ScoreBreakdown | null
  size?: 'sm' | 'md' | 'lg'
  /** Set when the caller is not entitled to the breakdown. */
  breakdownLocked?: boolean
  lockedReason?: string | null
  /** Factors the engine filled with a neutral stand-in rather than a measurement. */
  placeholderFactors?: string[]
  /** How many of the inputs were real data (0–1). */
  dataCoverage?: number
  notes?: string | null
  onUpgrade?: () => void
}

function scoreColour(score: number): string {
  if (score >= 80) return 'var(--score-a)'
  if (score >= 65) return 'var(--score-b)'
  if (score >= 50) return 'var(--score-c)'
  return 'var(--score-d)'
}

// Descriptive bands only. The spec calls for advice wording ("Strong Buy
// Signal"); a composite score is not a recommendation, and FIX-07 removed that
// phrasing deliberately. These say what the number IS, not what to do about it.
function scoreLabel(score: number): string {
  if (score >= 80) return 'High'
  if (score >= 65) return 'Above average'
  if (score >= 50) return 'Average'
  return 'Below average'
}

const SIZE_MAP = {
  sm: { outer: 120, font: 28, label: 10, ring: 6 },
  md: { outer: 200, font: 48, label: 12, ring: 8 },
  lg: { outer: 260, font: 60, label: 14, ring: 10 },
}

/** The engine's factors, in weight order. `key` indexes ScoreBreakdown. */
const FACTORS: { key: keyof ScoreBreakdown; label: string; weight: number }[] = [
  { key: 'psfMomentum', label: 'PSF momentum', weight: 30 },
  { key: 'rentalYield', label: 'Rental yield', weight: 25 },
  { key: 'supplyAbsorption', label: 'Supply absorption', weight: 20 },
  { key: 'volumeTrend', label: 'Volume trend', weight: 15 },
  { key: 'capitalFlow', label: 'Capital flow', weight: 10 },
]

export function InvestmentScore({
  score,
  breakdown,
  size = 'md',
  breakdownLocked = false,
  lockedReason,
  placeholderFactors = [],
  dataCoverage,
  notes,
  onUpgrade,
}: ScoreProps) {
  const [offset, setOffset] = useState(314)
  const mounted = useRef(false)
  const s = SIZE_MAP[size]
  const circumference = 314

  useEffect(() => {
    if (mounted.current) return
    mounted.current = true
    const target = circumference - (circumference * Math.min(score, 100) / 100)
    requestAnimationFrame(() => setOffset(target))
  }, [score])

  return (
    <div className="flex flex-col items-center w-full">
      <div style={{ width: s.outer, height: s.outer }} className="relative">
        <svg viewBox="0 0 120 120" className="w-full h-full -rotate-90">
          <circle cx="60" cy="60" r="50" fill="none" stroke="var(--ink-6)" strokeWidth="0.5" />
          <circle
            cx="60" cy="60" r="50" fill="none"
            stroke={scoreColour(score)}
            strokeWidth={s.ring}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 800ms ease-out' }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="leading-none" style={{ color: scoreColour(score), fontSize: s.font, fontFamily: 'var(--font-data)', fontWeight: 500 }}>{score}</span>
          <span style={{ fontSize: s.label, fontFamily: 'var(--font-ui)', fontWeight: 500 }} className="text-[var(--ink-4)]">{scoreLabel(score)}</span>
        </div>
      </div>

      {breakdown && (
        <ScoreBreakdownPanel breakdown={breakdown} placeholderFactors={placeholderFactors} showRadar />
      )}

      {/* Coverage and driver notes are shown to EVERYONE, including locked
          callers. They qualify how much of the number is real data — the caveat
          matters most to the reader who can see the least. */}
      {(notes || dataCoverage != null) && (
        <p className="text-[11px] mt-3 text-center leading-relaxed" style={{ color: 'var(--ink-5)' }}>
          {notes}
          {dataCoverage != null && (
            <>
              {notes ? ' · ' : ''}
              <span style={{ fontFamily: 'var(--font-data)' }}>
                {Math.round(dataCoverage * 100)}% of inputs backed by real data
              </span>
            </>
          )}
        </p>
      )}

      {!breakdown && breakdownLocked && <LockedPanel reason={lockedReason} onUpgrade={onUpgrade} />}
    </div>
  )
}

function LockedPanel({ reason, onUpgrade }: { reason?: string | null; onUpgrade?: () => void }) {
  return (
    <div
      className="w-full mt-4 rounded-[12px] px-4 py-4 text-center"
      style={{ background: 'var(--g4)', border: '1px dashed var(--gb)' }}
    >
      <p className="text-xs leading-relaxed" style={{ color: 'var(--ink-4)' }}>
        {reason ?? 'The factor breakdown is part of the Pro plan.'}
      </p>
      {onUpgrade ? (
        <button
          onClick={onUpgrade}
          className="inline-block mt-2 px-4 py-1.5 rounded-[8px] text-xs font-semibold"
          style={{ background: 'var(--b600)', color: '#fff' }}
        >
          Upgrade to Pro →
        </button>
      ) : (
        <a
          href="/pricing"
          className="inline-block mt-2 px-4 py-1.5 rounded-[8px] text-xs font-semibold"
          style={{ background: 'var(--b600)', color: '#fff' }}
        >
          Upgrade to Pro →
        </a>
      )}
    </div>
  )
}

function ScoreBreakdownPanel({
  breakdown,
  placeholderFactors,
  showRadar,
}: {
  breakdown: ScoreBreakdown
  placeholderFactors: string[]
  showRadar?: boolean
}) {
  const radarData = FACTORS.map((f) => ({
    factor: f.label,
    value: breakdown[f.key] ?? 0,
    weight: f.weight,
  }))

  return (
    <div className="w-full mt-4">
      {showRadar && (
        <div style={{ width: '100%', height: 190 }}>
          <ResponsiveContainer width="100%" height="100%">
            <RadarChart data={radarData} outerRadius="72%">
              <PolarGrid stroke="var(--ink-6)" />
              <PolarAngleAxis dataKey="factor" tick={{ fontSize: 10, fill: 'var(--ink-4)' }} />
              <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
              <Radar dataKey="value" stroke="var(--b600)" fill="var(--b600)" fillOpacity={0.2} />
              <Tooltip
                formatter={(v: number) => [`${v}/100`, 'Score']}
                contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid var(--gb)' }}
              />
            </RadarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="w-full space-y-2 mt-2">
        {FACTORS.map((f) => {
          const value = breakdown[f.key]
          const isPlaceholder = placeholderFactors.includes(f.key)
          const pct = value == null ? 0 : Math.min(100, Math.max(0, value))
          return (
            <div key={f.key} className="flex items-center gap-2 text-xs">
              <span className="w-[104px] shrink-0 text-right" style={{ color: 'var(--ink-4)', fontFamily: 'var(--font-ui)' }}>
                {f.label}
                <span style={{ color: 'var(--ink-6)', fontFamily: 'var(--font-data)' }}> {f.weight}%</span>
              </span>
              <div className="flex-1 h-[5px] rounded-full overflow-hidden" style={{ background: 'var(--ink-6)', opacity: isPlaceholder ? 0.45 : 1 }}>
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{
                    width: `${pct}%`,
                    backgroundColor: isPlaceholder ? 'var(--ink-5)' : scoreColour(pct),
                  }}
                />
              </div>
              <span className="w-[46px] shrink-0 text-right" style={{ color: 'var(--ink-5)', fontFamily: 'var(--font-data)' }}>
                {isPlaceholder ? 'n/a' : value == null ? '—' : `${Math.round(value)}`}
              </span>
            </div>
          )
        })}
      </div>

      {placeholderFactors.length > 0 && (
        <p className="text-[10.5px] mt-2 leading-relaxed" style={{ color: 'var(--ink-5)' }}>
          Greyed factors are neutral stand-ins, not measurements — the engine has no data behind
          them yet, so they do not move the score.
        </p>
      )}
    </div>
  )
}

export function ScoreBadge({ score }: { score: number }) {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
      style={{
        background: `${scoreColour(score)}14`,
        color: scoreColour(score),
        border: `1px solid ${scoreColour(score)}30`,
      }}
    >
      <span style={{ fontFamily: 'var(--font-data)' }}>{score}</span>
      <span>{scoreLabel(score)}</span>
    </span>
  )
}

// ─── Community score card ────────────────────────────────────────────────────

interface ScoreResponse {
  community: string
  slug: string
  score: number | null
  scored: boolean
  reason?: string
  breakdown: ScoreBreakdown | null
  breakdownLocked: boolean
  lockedReason?: string | null
  placeholderFactors?: string[]
  dataCoverage: number
  notes: string | null
  tier: string
}

/**
 * Fetches one community's ENGINE score and renders it.
 *
 * Deliberately not a client-side estimate: `/sqftlab/scores/:slug` returns the
 * persisted composite from the scoring engine, and withholds the factor
 * breakdown server-side for callers below Pro. The locked state therefore
 * reflects what the server actually sent rather than a guess about the tier.
 */
export function CommunityScoreCard({ slug, onUpgrade }: { slug: string; onUpgrade?: () => void }) {
  const [data, setData] = useState<ScoreResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setData(null)
    setError(null)
    authedFetch(`/api/sqftlab/scores/${encodeURIComponent(slug)}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as ScoreResponse & { error?: string }
        if (!alive) return
        if (!res.ok) {
          // Surface the server's own words rather than a generic failure.
          setError(body.error ?? `Could not load the score (${res.status})`)
          return
        }
        setData(body)
      })
      .catch(() => {
        if (alive) setError('Could not reach the score service.')
      })
    return () => {
      alive = false
    }
  }, [slug])

  if (error) {
    return (
      <div className="p-5 rounded-[18px]" style={{ background: 'var(--g2)', border: '1px solid var(--gb)' }}>
        <h3 className="font-semibold mb-2" style={{ color: 'var(--ink)' }}>Investment Score</h3>
        <p className="text-xs" style={{ color: 'var(--warn)' }}>{error}</p>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="p-5 rounded-[18px] flex items-center justify-center" style={{ background: 'var(--g2)', border: '1px solid var(--gb)', minHeight: 220 }}>
        <p className="text-xs" style={{ color: 'var(--ink-5)' }}>Loading score…</p>
      </div>
    )
  }

  // No fabricated number when the engine has not scored this community yet.
  if (!data.scored || data.score == null) {
    return (
      <div className="p-5 rounded-[18px] flex flex-col items-center justify-center text-center" style={{ background: 'var(--g2)', border: '1px solid var(--gb)', minHeight: 220 }}>
        <h3 className="font-semibold mb-2" style={{ color: 'var(--ink)' }}>Investment Score</h3>
        <p className="text-xs leading-relaxed" style={{ color: 'var(--ink-4)' }}>
          {data.reason ?? 'This community has not been scored yet.'}
        </p>
      </div>
    )
  }

  return (
    <div className="p-5 rounded-[18px] flex flex-col items-center" style={{ background: 'var(--g2)', border: '1px solid var(--gb)', boxShadow: 'var(--sh-card)' }}>
      <h3 className="font-semibold mb-4" style={{ color: 'var(--ink)' }}>Investment Score</h3>
      <InvestmentScore
        score={data.score}
        breakdown={data.breakdown}
        breakdownLocked={data.breakdownLocked}
        lockedReason={data.lockedReason}
        placeholderFactors={data.placeholderFactors ?? []}
        dataCoverage={data.dataCoverage}
        notes={data.notes}
        onUpgrade={onUpgrade}
        size="md"
      />
    </div>
  )
}
