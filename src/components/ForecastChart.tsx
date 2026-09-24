interface HistoryPoint {
  date: string
  psf: number
}

interface ForecastPoint {
  date: string
  psf: number
  lower?: number
  upper?: number
  confidence?: number
}

interface ForecastChartProps {
  history: HistoryPoint[]
  forecast: ForecastPoint[]
  height?: number
}

const W = 820
const PAD = { top: 18, right: 16, bottom: 34, left: 52 }

function monthLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })
}

/**
 * TASK 10 — price trend projection.
 *
 * Historical realised PSF is drawn as a solid blue line; the regression
 * projection is a dashed violet line with a shaded confidence band in between.
 * Pure SVG, no charting dependency, so it renders identically in the SSR-less
 * canvas preview and on the deployed site.
 */
export function ForecastChart({ history, forecast, height = 260 }: ForecastChartProps) {
  const hist = history.filter((p) => Number.isFinite(p.psf))
  const fore = forecast.filter((p) => Number.isFinite(p.psf))

  if (hist.length < 2) {
    return (
      <div
        className="flex items-center justify-center text-xs rounded-[14px]"
        style={{ height, color: 'var(--ink-5)', background: 'var(--g1)' }}
      >
        Not enough monthly history to chart a trend.
      </div>
    )
  }

  const all = [...hist, ...fore]
  const values = all.flatMap((p) => {
    const pts = [p.psf]
    if ('lower' in p && typeof p.lower === 'number') pts.push(p.lower)
    if ('upper' in p && typeof p.upper === 'number') pts.push(p.upper)
    return pts
  })

  const rawMin = Math.min(...values)
  const rawMax = Math.max(...values)
  const pad = (rawMax - rawMin) * 0.12 || 10
  const min = rawMin - pad
  const max = rawMax + pad
  const span = max - min || 1

  const plotW = W - PAD.left - PAD.right
  const plotH = height - PAD.top - PAD.bottom

  const xAt = (i: number) => PAD.left + (i / Math.max(1, all.length - 1)) * plotW
  const yAt = (v: number) => PAD.top + plotH - ((v - min) / span) * plotH

  const histLine = hist.map((p, i) => `${xAt(i).toFixed(2)},${yAt(p.psf).toFixed(2)}`).join(' ')
  const foreOffset = hist.length - 1
  const foreLine = fore
    .map((p, i) => `${xAt(foreOffset + i + 1).toFixed(2)},${yAt(p.psf).toFixed(2)}`)
    .join(' ')

  // Bridge the gap so the projection visibly continues from the last actual.
  const lastHist = hist[hist.length - 1]
  const bridge = `${xAt(foreOffset).toFixed(2)},${yAt(lastHist.psf).toFixed(2)} ${foreLine}`

  const hasBand = fore.some((p) => typeof p.lower === 'number' && typeof p.upper === 'number')
  const bandPoints = hasBand
    ? [
        ...fore.map((p, i) => `${xAt(foreOffset + i + 1).toFixed(2)},${yAt(p.upper ?? p.psf).toFixed(2)}`),
        `${xAt(foreOffset).toFixed(2)},${yAt(lastHist.psf).toFixed(2)}`,
        ...[...fore]
          .reverse()
          .map((p, i) => `${xAt(foreOffset + (fore.length - i)).toFixed(2)},${yAt(p.lower ?? p.psf).toFixed(2)}`),
      ].join(' ')
    : ''

  const ticks = 4
  const yTicks = Array.from({ length: ticks + 1 }, (_, i) => min + (span * i) / ticks)

  // Label roughly every other month so the axis does not collide on narrow screens.
  const labelStep = all.length > 12 ? 2 : 1

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${W} ${height}`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
        role="img"
        aria-label="Price per square foot history and forecast"
      >
        <defs>
          <linearGradient id="fc-band" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#8B5CF6" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#8B5CF6" stopOpacity="0.06" />
          </linearGradient>
        </defs>

        {yTicks.map((t, i) => (
          <g key={`y${i}`}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={yAt(t)}
              y2={yAt(t)}
              stroke="var(--gb)"
              strokeWidth="1"
              strokeDasharray={i === 0 ? '0' : '3 4'}
            />
            <text
              x={PAD.left - 8}
              y={yAt(t) + 3.5}
              textAnchor="end"
              fontSize="10"
              fill="var(--ink-5)"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              {Math.round(t).toLocaleString('en-US')}
            </text>
          </g>
        ))}

        {hasBand && <polygon points={bandPoints} fill="url(#fc-band)" />}

        {/* Divider between actuals and projection */}
        <line
          x1={xAt(foreOffset)}
          x2={xAt(foreOffset)}
          y1={PAD.top}
          y2={PAD.top + plotH}
          stroke="var(--ink-6)"
          strokeWidth="1"
          strokeDasharray="2 4"
        />

        <polyline
          points={histLine}
          fill="none"
          stroke="#2563EB"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {fore.length > 0 && (
          <polyline
            points={bridge}
            fill="none"
            stroke="#8B5CF6"
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="6 5"
          />
        )}

        {hist.map((p, i) =>
          i % labelStep === 0 ? (
            <text
              key={`x${i}`}
              x={xAt(i)}
              y={height - 12}
              textAnchor="middle"
              fontSize="10"
              fill="var(--ink-5)"
            >
              {monthLabel(p.date)}
            </text>
          ) : null,
        )}
      </svg>

      <div className="flex flex-wrap items-center gap-4 mt-2 text-[11px]" style={{ color: 'var(--ink-4)' }}>
        <span className="flex items-center gap-1.5">
          <span style={{ width: 16, height: 2, background: '#2563EB', display: 'inline-block' }} />
          Actual (DLD)
        </span>
        <span className="flex items-center gap-1.5">
          <span
            style={{
              width: 16,
              height: 2,
              display: 'inline-block',
              backgroundImage: 'linear-gradient(90deg,#8B5CF6 60%,transparent 0)',
              backgroundSize: '6px 2px',
            }}
          />
          Forecast
        </span>
        {hasBand && (
          <span className="flex items-center gap-1.5">
            <span
              style={{
                width: 16,
                height: 8,
                display: 'inline-block',
                background: 'rgba(139,92,246,0.18)',
                borderRadius: 2,
              }}
            />
            95% confidence band
          </span>
        )}
      </div>
    </div>
  )
}
