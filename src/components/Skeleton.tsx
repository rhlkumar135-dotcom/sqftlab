import type { CSSProperties } from 'react'

/**
 * Day 15 Task D1 — loading placeholders.
 *
 * The brief asked to create `Skeleton.tsx` and to add a `shimmer` keyframe to global
 * CSS. Both already exist: `index.css` defines `@keyframes shimmer` and a `.sk` class
 * (white-glass gradient, tuned for this app's translucent cards), and
 * `src/components/ui/skeleton.tsx` provides the shadcn primitive. So this file adds no
 * new animation — it is the *shape* layer, so a card/row/chart placeholder looks the same
 * on every screen instead of each page inventing its own. The primitives below build on
 * the app's existing `.sk` class.
 *
 * `animate-pulse` (what ui/skeleton uses) fades opacity, which on these glass cards reads
 * as "slightly too light" rather than "loading"; the moving gradient is the clearer cue,
 * and it is already defined.
 */

/** A single bar. Width/height accept any CSS length. */
export function Skeleton({ width = '100%', height = 16, radius, style }: {
  width?: string | number
  height?: string | number
  radius?: number
  style?: CSSProperties
}) {
  return (
    <div
      aria-hidden="true"
      className="sk"
      style={{ width, height, ...(radius !== undefined ? { borderRadius: radius } : {}), ...style }}
    />
  )
}

/** A block of text lines, last one short — reads as a paragraph rather than a box. */
export function SkeletonText({ lines = 3, style }: { lines?: number; style?: CSSProperties }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, ...style }}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} height={12} width={i === lines - 1 ? '55%' : '100%'} />
      ))}
    </div>
  )
}

/** A card with a title bar and a few lines — the shape of a community/property tile. */
export function SkeletonCard({ height }: { height?: number }) {
  return (
    <div
      style={{
        padding: 20,
        borderRadius: 18,
        border: '1px solid var(--gb)',
        background: 'var(--g1)',
        minHeight: height,
      }}
    >
      <Skeleton width="52%" height={16} />
      <SkeletonText lines={3} style={{ marginTop: 16 }} />
    </div>
  )
}

/** `count` cards in the dashboard grid. Announced once, not once per card. */
export function SkeletonCardGrid({ count = 6, label = 'Loading' }: { count?: number; label?: string }) {
  return (
    <div
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} height={132} />
      ))}
    </div>
  )
}

/** Table rows, sized to the table's own rhythm so the layout does not jump on load. */
export function SkeletonRows({ rows = 5, style }: { rows?: number; style?: CSSProperties }) {
  return (
    <div role="status" aria-live="polite" aria-label="Loading rows" style={style}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ display: 'flex', gap: 12, padding: '9px 0' }}>
          <Skeleton width="22%" height={11} />
          <Skeleton width="30%" height={11} />
          <Skeleton width="18%" height={11} />
          <Skeleton width="14%" height={11} />
        </div>
      ))}
    </div>
  )
}

export default Skeleton
