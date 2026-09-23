interface SparklineProps {
  data: number[]
  color?: string
  height?: number
  width?: number
}

// 32px inline trend line for KPI cards (spec Part 7.1): solid stroke over a
// 7%-opacity area fill, no axes and no tooltip — it reads as texture, not a chart.
export function Sparkline({
  data,
  color = '#2563EB',
  height = 32,
  width = 120,
}: SparklineProps) {
  const points = data.filter((n) => Number.isFinite(n))
  if (points.length < 2) return <div style={{ height }} />

  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = max - min || 1
  const stepX = width / (points.length - 1)

  const coords = points.map((n, i) => {
    const x = i * stepX
    const y = height - ((n - min) / span) * (height - 4) - 2
    return `${x.toFixed(2)},${y.toFixed(2)}`
  })

  const id = `spark-${color.replace(/[^a-z0-9]/gi, '')}-${points.length}`

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{ display: 'block', overflow: 'visible' }}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.07" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon
        points={`0,${height} ${coords.join(' ')} ${width},${height}`}
        fill={`url(#${id})`}
      />
      <polyline
        points={coords.join(' ')}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
