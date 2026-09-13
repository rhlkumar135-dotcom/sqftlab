interface DataLabelProps {
  source: string
  count: number
  period: string
  lastUpdated: string
  methodology?: string
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} hr${hrs > 1 ? 's' : ''} ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

export function DataLabel({ source, count, period, lastUpdated, methodology }: DataLabelProps) {
  return (
    <div className="flex items-center gap-1 text-[var(--ink-5)]" style={{ fontFamily: 'var(--font-data)', fontSize: 9, letterSpacing: '0.04em' }}>
      <span>Based on {count.toLocaleString()} {source} transactions · {period} · Updated {relativeTime(lastUpdated)}</span>
      {methodology && (
        <span className="group relative cursor-help">
          <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-[var(--ink-5)]/30 text-[8px] leading-none">ⓘ</span>
          <span className="hidden group-hover:block absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 p-2.5 rounded-[10px] text-[11px] leading-relaxed z-50"
            style={{
              background: 'rgba(255,255,255,0.74)',
              backdropFilter: 'blur(16px)',
              border: '1px solid rgba(255,255,255,0.92)',
              boxShadow: '0 2px 8px rgba(15,23,42,0.07)',
              fontFamily: 'var(--font-data)',
              color: 'var(--ink-3)',
            }}>
            {methodology}
          </span>
        </span>
      )}
    </div>
  )
}
