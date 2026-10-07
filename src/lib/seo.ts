import { useEffect } from 'react'

/**
 * Page-level SEO for a single-page app, applied imperatively.
 *
 * Without this a deep link carries whatever title the previously-viewed page set, which
 * is what crawlers and link previews see. MarketPulsePage grew its own copy of this on
 * Day 13; this is that logic generalised so the pages cannot drift — the same reason
 * `EmptyState` and the denial notice live in one place.
 *
 * Titles are set per-route. Descriptions are length-capped because search engines
 * truncate around 160 characters, and a title is suffixed with the brand only when the
 * caller has not already included it.
 */

const MAX_DESCRIPTION = 160
const BRAND = 'sqftLab'

interface Meta {
  title: string
  description?: string
  /** Set on pages that publish a URL. */
  canonicalPath?: string
}

function upsertMeta(selector: string, attrs: Record<string, string>): HTMLMetaElement {
  let el = document.head.querySelector<HTMLMetaElement>(selector)
  if (!el) {
    el = document.createElement('meta')
    document.head.appendChild(el)
  }
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  return el
}

export function usePageMeta({ title, description, canonicalPath }: Meta): void {
  useEffect(() => {
    const fullTitle = title.includes(BRAND) ? title : `${title} | ${BRAND}`
    const prevTitle = document.title
    const descSelector = 'meta[name="description"]'
    const prevDesc = document.head.querySelector(descSelector)?.getAttribute('content') ?? null

    document.title = fullTitle
    if (description) {
      const trimmed =
        description.length > MAX_DESCRIPTION ? `${description.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…` : description
      upsertMeta(descSelector, { name: 'description', content: trimmed })
      // Open Graph so a shared link previews correctly. `og:title` has no 160-char limit
      // and is not brand-suffixed — the brand is already in the title tag.
      upsertMeta('meta[property="og:title"]', { property: 'og:title', content: fullTitle })
      upsertMeta('meta[property="og:description"]', { property: 'og:description', content: trimmed })
      upsertMeta('meta[property="og:type"]', { property: 'og:type', content: 'website' })
    }
    if (canonicalPath) {
      let link = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')
      if (!link) {
        link = document.createElement('link')
        link.setAttribute('rel', 'canonical')
        document.head.appendChild(link)
      }
      link.setAttribute('href', `${window.location.origin}${canonicalPath}`)
    }

    return () => {
      document.title = prevTitle
      if (prevDesc !== null) {
        const m = document.head.querySelector(descSelector)
        if (m) m.setAttribute('content', prevDesc)
      }
    }
    // Re-runs on content change so a community/building page updates its title when the
    // slug or the loaded name arrives.
  }, [title, description, canonicalPath])
}
