import { useEffect, useRef, useState } from 'react'
import { Search, Building2, ArrowRight, Info } from 'lucide-react'
import { authedFetch } from '@/lib/session'
import { EmptyState } from '@/components/EmptyState'
import { SkeletonRows } from '@/components/Skeleton'

/**
 * Building search (Day 10 Task C).
 *
 * Type-ahead over `GET /api/sqftlab/buildings?q=`. The dataset has no building
 * rows at all — `building_profiles` is empty and `Listing` carries no building
 * column — so the honest state is an explanation, not an empty result list that
 * reads as "no such building".
 */

interface BuildingHit {
  name: string
  slug: string
  community: string | null
  source: 'profile' | 'transaction'
}

export default function BuildingSearchPage({ onOpenBuilding }: { onOpenBuilding: (slug: string) => void }) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<BuildingHit[]>([])
  const [searched, setSearched] = useState(false)
  const [busy, setBusy] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current)
    const term = q.trim()
    if (term.length < 2) {
      setHits([])
      setSearched(false)
      return
    }
    // Debounced so a fast typist issues one request per pause rather than per key.
    timer.current = window.setTimeout(async () => {
      setBusy(true)
      try {
        const res = await authedFetch(`/api/sqftlab/buildings?q=${encodeURIComponent(term)}`)
        const body = (await res.json().catch(() => ({}))) as { buildings?: BuildingHit[] }
        setHits(Array.isArray(body.buildings) ? body.buildings : [])
        setSearched(true)
      } finally {
        setBusy(false)
      }
    }, 250)
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [q])

  return (
    <div className="max-w-[900px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <div className="flex items-start gap-3 mb-5">
        <div className="rounded-[14px] p-2.5 shrink-0" style={{ background: 'rgba(37,99,235,0.09)' }}>
          <Building2 size={20} style={{ color: 'var(--b600)' }} />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight" style={{ color: 'var(--ink)' }}>
            Building Scorecards
          </h1>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--ink-4)' }}>
            Price per square foot, floor by floor, for an individual tower
          </p>
        </div>
      </div>

      <div className="g2 p-4 sm:p-5">
        <div className="relative">
          <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--ink-5)' }} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search buildings in Dubai…"
            className="w-full rounded-[12px] pl-10 pr-3 py-3 text-[14px] outline-none"
            style={{ background: 'var(--g3)', border: '1px solid var(--gb)', color: 'var(--ink)' }}
            aria-label="Search buildings"
          />
        </div>

        <div className="mt-4">
          {busy && <SkeletonRows rows={3} />}

          {!busy && hits.length > 0 && (
            <div className="space-y-1">
              {hits.map((b) => (
                <button
                  key={b.slug}
                  onClick={() => onOpenBuilding(b.slug)}
                  className="w-full flex items-center gap-3 rounded-[12px] px-3 py-3 text-left transition-colors"
                  style={{ background: 'var(--g4)' }}
                >
                  <Building2 size={15} className="shrink-0" style={{ color: 'var(--ink-4)' }} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-[13px] font-medium" style={{ color: 'var(--ink)' }}>
                      {b.name}
                    </span>
                    {b.community && (
                      <span className="block text-[11px]" style={{ color: 'var(--ink-5)' }}>
                        {b.community}
                      </span>
                    )}
                  </span>
                  <ArrowRight size={15} className="shrink-0" style={{ color: 'var(--b600)' }} />
                </button>
              ))}
            </div>
          )}

          {!busy && searched && hits.length === 0 && (
            <div className="flex items-start gap-2.5 py-2">
              <Info size={16} className="shrink-0 mt-0.5" style={{ color: 'var(--warn)' }} />
              <p className="text-[13px] leading-relaxed" style={{ color: 'var(--ink-4)' }}>
                No buildings matched. Building-level rows come from the DLD transaction register
                (its <span className="mono">building_name</span> column) and the building-profile
                table — neither is populated in this dataset yet, so no building can be found
                regardless of the name.
              </p>
            </div>
          )}

          {!searched && !busy && (
            <EmptyState
              icon={<Search size={40} />}
              title="Search buildings"
              body="Type a building name to find its transaction history."
            />
          )}
        </div>
      </div>
    </div>
  )
}
