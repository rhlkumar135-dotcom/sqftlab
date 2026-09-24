// Part 9 — animation primitives.
//
// The spec is prescriptive here: one easing constant for the whole app, and a
// fixed duration per interaction ("Easing: [0.16, 1, 0.3, 1] everywhere. No
// exceptions."). Centralising both means a caller picks an intent — reveal,
// stagger, count up — and cannot drift from the spec by inventing its own curve.
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { animate, motion, useInView } from 'framer-motion'

/** The single easing curve. Every animation in the app must use this. */
export const EASE = [0.16, 1, 0.3, 1] as const

/** Scroll-triggered fade + rise. Cards move y32→0 (spec: "On scroll"). */
export function Reveal({
  children,
  delay = 0,
  y = 32,
  duration = 0.6,
  className,
}: {
  children: ReactNode
  delay?: number
  y?: number
  duration?: number
  className?: string
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.25 }}
      transition={{ duration, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  )
}

/** Fade only — for elements that should not move (nav, headline, tag). */
export function FadeIn({
  children,
  delay = 0,
  duration = 0.4,
  className,
}: {
  children: ReactNode
  delay?: number
  duration?: number
  className?: string
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  )
}

/**
 * Staggers its children's reveal. `gap` is the spec's per-child delay — 80ms for
 * card grids, 150ms for the intelligence pipeline, 60ms for headline words.
 */
export function Stagger({
  children,
  gap = 0.08,
  delay = 0,
  className,
}: {
  children: ReactNode
  gap?: number
  delay?: number
  className?: string
}) {
  return (
    <motion.div
      className={className}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, amount: 0.2 }}
      variants={{ hidden: {}, show: { transition: { staggerChildren: gap, delayChildren: delay } } }}
    >
      {children}
    </motion.div>
  )
}

/** A child of <Stagger>. Rises into place when the parent enters the viewport. */
export function StaggerItem({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      className={className}
      variants={{
        hidden: { opacity: 0, y: 32 },
        show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE } },
      }}
    >
      {children}
    </motion.div>
  )
}

/**
 * Counts a number up when it scrolls into view (spec: 1200ms).
 *
 * Writes to the DOM node directly instead of through state: a per-frame setState
 * would re-render the whole KPI row sixty times a second, and these rows sit
 * inside pages that already fetch and render a lot.
 *
 * `format` is held in a ref so a caller passing an inline arrow function — which
 * changes identity every render — does not restart the animation mid-flight.
 */
export function CountUp({
  value,
  format,
  duration = 1.2,
  className,
}: {
  value: number
  format?: (n: number) => string
  duration?: number
  className?: string
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const formatRef = useRef(format)
  formatRef.current = format
  const inView = useInView(ref, { once: true, amount: 0.4 })

  useEffect(() => {
    const el = ref.current
    if (!inView || !el || !Number.isFinite(value)) return
    const render = (n: number) => {
      el.textContent = formatRef.current ? formatRef.current(n) : Math.round(n).toLocaleString()
    }
    render(0)
    const controls = animate(0, value, { duration, ease: EASE, onUpdate: render })
    return () => {
      controls.stop()
      // Settle on the exact target: the final frame can land a hair under it.
      render(value)
    }
  }, [inView, value, duration])

  return <span ref={ref} className={className}>{formatRef.current ? formatRef.current(0) : '0'}</span>
}

/**
 * Hover lift for cards and buttons (spec: cards y-4 over 300ms, buttons y-1 over
 * 200ms). CSS `:hover` cannot carry the shared easing without duplicating it, so
 * these stay in JS.
 */
export function HoverLift({
  children,
  className,
  style,
  lift = -4,
  duration = 0.3,
}: {
  children: ReactNode
  className?: string
  style?: CSSProperties
  lift?: number
  duration?: number
}) {
  return (
    <motion.div className={className} style={style} whileHover={{ y: lift }} transition={{ duration, ease: EASE }}>
      {children}
    </motion.div>
  )
}

/**
 * Splits a headline into words and staggers them in (spec: 60ms per word), for
 * the hero's two-line headline.
 */
export function StaggerWords({
  text,
  gap = 0.06,
  delay = 0,
  className,
  wordClassName,
}: {
  text: string
  gap?: number
  delay?: number
  className?: string
  wordClassName?: string
}) {
  const words = text.split(' ')
  return (
    <motion.span
      className={className}
      initial="hidden"
      animate="show"
      variants={{ hidden: {}, show: { transition: { staggerChildren: gap, delayChildren: delay } } }}
    >
      {words.map((w, i) => (
        <motion.span
          key={`${w}-${i}`}
          className={wordClassName}
          style={{ display: 'inline-block', whiteSpace: 'pre' }}
          variants={{
            hidden: { opacity: 0, y: 12 },
            show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } },
          }}
        >
          {w}
          {i < words.length - 1 ? ' ' : ''}
        </motion.span>
      ))}
    </motion.span>
  )
}
