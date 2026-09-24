import { useEffect, useRef, useState } from 'react'

// Spec Part 16.4/16.5 — the client half of the real-time layer.
//
// Connects once to /api/sqftlab/stream/market and keeps market/district/deal
// state updated from the SSE feed, instead of every component polling. If the
// endpoint is unreachable (static deploy, no server) the hook settles into
// 'offline' and the UI falls back to its baked snapshot — the badge is the only
// thing that changes, never a blank panel.

// Matches the absolute `/api/...` paths used everywhere else in the app — the
// preview proxy strips the /p/<projectId>/ prefix, so no base juggling needed.
const STREAM_URL = '/api/sqftlab/stream/market'
const streamUrl = () => STREAM_URL

export interface MarketSummary {
  avgPricePsfDubai?: number | null
  avgPricePsfAD?: number | null
  totalTransactions?: number | null
  totalValueAed?: number | null
  avgRentalYield?: number | null
  momentumIndex?: number | null
  psfDelta?: number | null
  computedAt?: string | null
}

export interface DistrictUpdate {
  district: string
  avgPricePsf?: number | null
  priceChange3m?: number | null
  momentumScore?: number | null
  calculatedAt?: string
}

export interface LiveDeal {
  id: string
  title?: string | null
  purpose?: string | null
  priceAed?: number | null
  pricePerSqft?: number | null
  imageUrl?: string | null
  sourceUrl?: string | null
  detectedAt?: string
}

export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'offline'

export interface LiveMarket {
  status: StreamStatus
  summary: MarketSummary | null
  districts: Record<string, DistrictUpdate>
  deals: LiveDeal[]
  lastEventAt: number | null
  eventCount: number
}

export function useLiveMarket(): LiveMarket {
  const [status, setStatus] = useState<StreamStatus>('connecting')
  const [summary, setSummary] = useState<MarketSummary | null>(null)
  const [districts, setDistricts] = useState<Record<string, DistrictUpdate>>({})
  const [deals, setDeals] = useState<LiveDeal[]>([])
  const [lastEventAt, setLastEventAt] = useState<number | null>(null)
  const [eventCount, setEventCount] = useState(0)
  const failures = useRef(0)

  useEffect(() => {
    let es: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let disposed = false

    const connect = () => {
      if (disposed) return
      try {
        es = new EventSource(streamUrl())
      } catch {
        setStatus('offline')
        return
      }

      es.onopen = () => { failures.current = 0; setStatus('live') }

      es.onmessage = (e) => {
        try {
          const { type, payload } = JSON.parse(e.data) as { type: string; payload: unknown; ts?: number }
          setLastEventAt(Date.now())
          setEventCount((n) => n + 1)

          if (type === 'init') {
            const p = payload as { summary?: MarketSummary | null }
            if (p?.summary) setSummary(p.summary)
          } else if (type === 'market:update') {
            setSummary(payload as MarketSummary)
          } else if (type === 'district:update') {
            const d = payload as DistrictUpdate
            if (d?.district) setDistricts((prev) => ({ ...prev, [d.district]: d }))
          } else if (type === 'deal:new') {
            setDeals((prev) => [payload as LiveDeal, ...prev].slice(0, 20))
          }
        } catch { /* malformed frame — ignore, the next one will be fine */ }
      }

      es.onerror = () => {
        es?.close()
        failures.current += 1
        // Give up after a few tries rather than hammering a dead endpoint.
        if (failures.current >= 3) { setStatus('offline'); return }
        setStatus('reconnecting')
        retry = setTimeout(connect, 5000)
      }
    }

    connect()
    return () => {
      disposed = true
      if (retry) clearTimeout(retry)
      es?.close()
    }
  }, [])

  return { status, summary, districts, deals, lastEventAt, eventCount }
}

/** Compact connection indicator — one dot, one word, plus the last update time. */
export function LiveBadge({ live }: { live: LiveMarket }) {
  const colour =
    live.status === 'live' ? 'var(--up)'
    : live.status === 'connecting' || live.status === 'reconnecting' ? 'var(--warn)'
    : 'var(--ink-5)'

  const label =
    live.status === 'live' ? 'LIVE'
    : live.status === 'reconnecting' ? 'RETRY'
    : live.status === 'connecting' ? '…'
    : 'STATIC'

  const ago = live.lastEventAt ? Math.max(0, Math.round((Date.now() - live.lastEventAt) / 1000)) : null

  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full shrink-0"
      style={{
        background: 'var(--g3)',
        border: '1px solid var(--gb)',
        fontFamily: 'var(--font-data)',
        fontSize: 9,
        letterSpacing: '0.14em',
        color: colour,
      }}
      title={
        live.status === 'live'
          ? `SSE connected · ${live.eventCount} events received`
          : live.status === 'offline'
            ? 'Stream unavailable — showing the baked snapshot'
            : 'Connecting to the stream…'
      }
    >
      <span
        className={live.status === 'live' ? 'live-dot' : ''}
        style={{
          width: 6, height: 6, borderRadius: '50%', background: colour,
          display: 'inline-block', opacity: live.status === 'live' ? 1 : 0.6,
        }}
      />
      {label}
      {ago != null && live.status === 'live' && (
        <span style={{ color: 'var(--ink-5)' }}>{ago}s</span>
      )}
    </span>
  )
}
