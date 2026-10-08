/**
 * Day 19 — sentiment gauge for the daily digest.
 *
 * A -1..+1 score is a poor thing to show a reader as a raw float: the sign is the
 * meaning and the magnitude is fuzzy. So the bar places a neutral tick at the
 * midpoint and the label states the band, with the number kept alongside for anyone
 * who wants it. The brief's thresholds (+/-0.3) are kept.
 */

interface Props {
  score: number | null
  compact?: boolean
}

function band(score: number): { label: string; color: string } {
  if (score > 0.3) return { label: 'Bullish', color: '#16a34a' }
  if (score < -0.3) return { label: 'Bearish', color: '#dc2626' }
  return { label: 'Neutral', color: '#6b7280' }
}

export default function SentimentGauge({ score, compact = false }: Props) {
  // A missing score is shown as missing. Defaulting to 0 would render "Neutral" for a
  // day that was never scored, which reads as a real market judgement.
  if (score === null || !Number.isFinite(score)) {
    return (
      <div className={compact ? 'text-xs' : 'text-sm'} style={{ color: 'var(--ink-5)' }}>
        Sentiment not scored for this digest.
      </div>
    )
  }

  const pct = ((Math.max(-1, Math.min(1, score)) + 1) / 2) * 100
  const { label, color } = band(score)

  return (
    <div style={{ marginBottom: compact ? 8 : 16 }}>
      {!compact && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 11,
            color: 'var(--ink-5)',
            marginBottom: 4,
          }}
        >
          <span>Very Bearish</span>
          <span>Neutral</span>
          <span>Very Bullish</span>
        </div>
      )}
      <div
        style={{ background: '#e2e8f0', borderRadius: 4, height: 8, position: 'relative' }}
        role="meter"
        aria-valuemin={-1}
        aria-valuemax={1}
        aria-valuenow={score}
        aria-label={`Market sentiment ${label}`}
      >
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: -2,
            width: 2,
            height: 12,
            background: '#cbd5e1',
          }}
        />
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: 'linear-gradient(90deg, #dc2626, #6b7280, #16a34a)',
            borderRadius: 4,
          }}
        />
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, color, marginTop: 4, textAlign: 'center' }}>
        {label} ({score > 0 ? '+' : ''}
        {score.toFixed(2)})
      </div>
    </div>
  )
}
