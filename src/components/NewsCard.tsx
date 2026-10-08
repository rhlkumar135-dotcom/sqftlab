/**
 * Day 19 — one news item in the Market Intelligence feed.
 *
 * The signal → colour map lives here and is exported, so the feed, the filter bar and
 * the sidebar legend all read from one table rather than three copies that drift.
 *
 * Two things the brief's version does that this one does not:
 *
 *  · It renders `item.aiSummary ?? item.rawExcerpt` with no distinction. Those are not
 *    interchangeable: a summary is the model's reading of the article, an excerpt is
 *    the publisher's own words. Presenting one as the other would be the app quietly
 *    claiming an edit it did not make, so the excerpt is labelled when it is shown.
 *  · It assumes `aiKeyFigures` is an object. It arrives from the API already decoded,
 *    but a row written before analysis still has null — handled rather than assumed.
 */

import type { JSX } from 'react'

export const SIGNAL_CONFIG: Record<string, { label: string; color: string; bg: string; emoji: string }> = {
  'price-movement': { label: 'Price Movement', color: '#dc2626', bg: '#fef2f2', emoji: '📈' },
  'project-launch': { label: 'Project Launch', color: '#16a34a', bg: '#f0fdf4', emoji: '🏗️' },
  regulatory: { label: 'Regulatory', color: '#7c3aed', bg: '#faf5ff', emoji: '⚖️' },
  investment: { label: 'Investment', color: '#2563EB', bg: '#eff6ff', emoji: '💼' },
  'market-stats': { label: 'Market Stats', color: '#0891b2', bg: '#ecfeff', emoji: '📊' },
  macro: { label: 'Macro', color: '#d97706', bg: '#fffbeb', emoji: '🌍' },
  other: { label: 'General', color: '#6b7280', bg: '#f9fafb', emoji: '📰' },
}

export const signalMeta = (type: string | null) => SIGNAL_CONFIG[type ?? 'other'] ?? SIGNAL_CONFIG.other

export interface NewsItemRow {
  id: string
  sourceName: string
  sourceUrl: string
  headline: string
  publishedAt: string
  rawExcerpt: string
  aiSummary: string | null
  aiSignalType: string | null
  aiImpactArea: string | null
  aiSentiment: string | null
  aiKeyFigures: { value?: string | null; pct?: string | null; units?: string | null } | null
  aiProcessed?: boolean
}

export function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  if (Number.isNaN(diff)) return ''
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export default function NewsCard({ item }: { item: NewsItemRow }): JSX.Element {
  const signal = signalMeta(item.aiSignalType)
  const sentimentDot =
    item.aiSentiment === 'positive' ? '#16a34a' : item.aiSentiment === 'negative' ? '#dc2626' : '#94a3b8'
  const figures = item.aiKeyFigures
    ? [item.aiKeyFigures.value, item.aiKeyFigures.pct, item.aiKeyFigures.units].filter(Boolean)
    : []

  return (
    <article
      style={{
        background: 'var(--g1)',
        backdropFilter: 'var(--gblur)',
        WebkitBackdropFilter: 'var(--gblur)',
        borderRadius: 12,
        padding: 16,
        border: '1px solid var(--gb)',
      }}
    >
      {/* Wraps rather than truncates: on a phone this row has four chips and clipping
          the publisher would hide the one piece of provenance a reader checks. */}
      <div className="flex flex-wrap items-center gap-2 mb-2" style={{ fontSize: 12 }}>
        <span
          style={{
            background: signal.bg,
            color: signal.color,
            padding: '2px 8px',
            borderRadius: 12,
            fontWeight: 600,
            whiteSpace: 'nowrap',
          }}
        >
          {signal.emoji} {signal.label}
        </span>
        <span
          style={{ width: 8, height: 8, borderRadius: '50%', background: sentimentDot, display: 'inline-block' }}
          title={`Sentiment: ${item.aiSentiment ?? 'unscored'}`}
        />
        <span style={{ color: 'var(--ink-5)' }}>
          {item.sourceName} · {timeAgo(item.publishedAt)}
        </span>
        {item.aiImpactArea && (
          <span style={{ background: '#eff6ff', color: '#2563EB', padding: '2px 8px', borderRadius: 12 }}>
            📍 {item.aiImpactArea}
          </span>
        )}
      </div>

      <a
        href={item.sourceUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="hover:underline"
        style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)', display: 'block', marginBottom: 6, lineHeight: 1.4 }}
      >
        {item.headline}
      </a>

      {item.aiSummary ? (
        <p style={{ fontSize: 13, color: 'var(--ink-4, #475569)', margin: 0, lineHeight: 1.6 }}>{item.aiSummary}</p>
      ) : (
        <p style={{ fontSize: 13, color: 'var(--ink-5)', margin: 0, lineHeight: 1.6 }}>
          <span style={{ fontStyle: 'italic' }}>Publisher excerpt — not yet AI-analysed. </span>
          {item.rawExcerpt}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 mt-2">
        {figures.length > 0 && (
          <span
            style={{
              fontSize: 12,
              fontFamily: 'JetBrains Mono, ui-monospace, monospace',
              background: '#f8fafc',
              padding: '4px 8px',
              borderRadius: 6,
              color: 'var(--ink)',
            }}
          >
            {figures.join(' · ')}
          </span>
        )}
        <a
          href={item.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 12, color: '#2563EB' }}
          className="hover:underline"
        >
          Read original →
        </a>
      </div>
    </article>
  )
}
