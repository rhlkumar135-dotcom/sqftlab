import { useEffect, useRef, useState } from 'react'

interface ScoreBreakdown {
  psf: number        // max 25
  yield: number      // max 25
  momentum: number   // max 20
  neighbourhood: number  // max 15
  developer: number  // max 15
}

interface ScoreProps {
  score: number
  breakdown?: ScoreBreakdown
  size?: 'sm' | 'md' | 'lg'
}

function scoreColour(score: number): string {
  if (score >= 80) return 'var(--score-a)'
  if (score >= 65) return 'var(--score-b)'
  if (score >= 50) return 'var(--score-c)'
  return 'var(--score-d)'
}

function scoreLabel(score: number): string {
  if (score >= 80) return 'Strong buy'
  if (score >= 65) return 'Good value'
  if (score >= 50) return 'Neutral'
  return 'Caution'
}

const SIZE_MAP = {
  sm: { outer: 120, font: 28, label: 10, ring: 6 },
  md: { outer: 200, font: 48, label: 12, ring: 8 },
  lg: { outer: 260, font: 60, label: 14, ring: 10 },
}

export function InvestmentScore({ score, breakdown, size = 'md' }: ScoreProps) {
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
    <div className="flex flex-col items-center">
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
        <ScoreBreakdownPanel breakdown={breakdown} />
      )}
    </div>
  )
}

function ScoreBreakdownPanel({ breakdown }: { breakdown: ScoreBreakdown }) {
  const items = [
    { label: 'PSF vs value', value: breakdown.psf, max: 25 },
    { label: 'Rental yield', value: breakdown.yield, max: 25 },
    { label: 'Price momentum', value: breakdown.momentum, max: 20 },
    { label: 'Neighbourhood', value: breakdown.neighbourhood, max: 15 },
    { label: 'Developer', value: breakdown.developer, max: 15 },
  ]

  return (
    <div className="w-full space-y-2 mt-4">
      {items.map((item) => {
        const pct = (item.value / item.max) * 100
        const color = scoreColour(pct * 100 / 100)
        return (
          <div key={item.label} className="flex items-center gap-2 text-xs">
            <span className="text-[var(--ink-4)] w-24 text-right" style={{ fontFamily: 'var(--font-ui)' }}>{item.label}</span>
            <div className="flex-1 h-[5px] rounded-full bg-[var(--ink-6)]/20 overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-700"
                style={{ width: `${pct}%`, backgroundColor: color }}
              />
            </div>
            <span className="text-[var(--ink-5)] w-8 text-right" style={{ fontFamily: 'var(--font-data)' }}>{item.value}/{item.max}</span>
          </div>
        )
      })}
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
