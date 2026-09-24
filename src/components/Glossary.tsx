import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X, Printer } from 'lucide-react'
import { GLOSSARY, GLOSSARY_LETTERS, type GlossaryTerm } from '@/data/glossary'

const TIER_LABEL: Record<'pro' | 'elite', string> = {
  pro: 'Pro',
  elite: 'Elite',
}

function TermCard({ t }: { t: GlossaryTerm }) {
  return (
    <article
      id={`glossary-${t.slug}`}
      className="g2 glossary-term scroll-mt-[88px] p-5 sm:p-6"
    >
      <div className="flex items-start justify-between gap-3">
        <h3
          className="text-[15px] sm:text-base font-bold leading-snug"
          style={{ fontFamily: 'var(--font-ui)', color: 'var(--ink)' }}
        >
          {t.term}
        </h3>
        {t.tier && (
          <span
            className="g4 shrink-0 px-2.5 py-1 rounded-[var(--r-pill)] font-semibold"
            style={{
              fontFamily: 'var(--font-data)',
              fontSize: 9,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--b600)',
            }}
          >
            {TIER_LABEL[t.tier]}
          </span>
        )}
      </div>

      <p
        className="mt-2.5 leading-[1.75]"
        style={{ fontSize: 14, color: 'var(--ink-3)' }}
      >
        {t.definition}
      </p>

      {t.whyMatters && (
        <p
          className="mt-3 pl-3 italic leading-relaxed"
          style={{
            fontSize: 13,
            color: 'var(--ink-4)',
            borderLeft: '2px solid var(--b300)',
          }}
        >
          Why this matters: {t.whyMatters}
        </p>
      )}

      {t.example && (
        <div
          className="g3 mono mt-3 px-3.5 py-2.5"
          style={{ fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.6 }}
        >
          {t.example}
        </div>
      )}

      {t.source && (
        <span
          className="mt-3 inline-block px-2.5 py-1 rounded-[var(--r-pill)]"
          style={{
            fontFamily: 'var(--font-data)',
            fontSize: 9,
            letterSpacing: '0.06em',
            color: 'var(--b600)',
            background: 'var(--b50)',
            border: '1px solid var(--b100)',
          }}
        >
          Source: {t.source}
        </span>
      )}

      {!!t.seeAlso?.length && (
        <div
          className="mt-3"
          style={{ fontFamily: 'var(--font-data)', fontSize: 10, color: 'var(--ink-5)' }}
        >
          See also:{' '}
          {t.seeAlso.map((s, i) => (
            <span key={s}>
              {i > 0 && ', '}
              <a href={`#glossary-${s}`} className="underline decoration-dotted underline-offset-2 hover:text-[var(--b600)]">
                {GLOSSARY.find((x) => x.slug === s)?.term ?? s}
              </a>
            </span>
          ))}
        </div>
      )}
    </article>
  )
}

export function Glossary() {
  const [query, setQuery] = useState('')
  const [activeLetter, setActiveLetter] = useState<string>(GLOSSARY_LETTERS[0] ?? 'A')
  const inputRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return GLOSSARY
    return GLOSSARY.filter(
      (t) =>
        t.term.toLowerCase().includes(q) ||
        t.definition.toLowerCase().includes(q) ||
        t.slug.includes(q) ||
        (t.aliases ?? []).some((a) => a.toLowerCase().includes(q)),
    )
  }, [query])

  const grouped = useMemo(() => {
    const map = new Map<string, GlossaryTerm[]>()
    for (const t of filtered) {
      const arr = map.get(t.letter) ?? []
      arr.push(t)
      map.set(t.letter, arr)
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [filtered])

  const lettersWithResults = useMemo(
    () => new Set(grouped.map(([l]) => l)),
    [grouped],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setQuery('')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Deep-link: /glossary#glossary-psf → scroll to that term
  useEffect(() => {
    const hash = window.location.hash
    if (!hash.startsWith('#glossary-')) return
    const el = document.getElementById(hash.slice(1))
    if (el) requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }, [])

  // Track which letter section is in view
  useEffect(() => {
    const sections = Array.from(
      document.querySelectorAll<HTMLElement>('section[id^="glossary-sec-"]'),
    )
    if (!sections.length) return
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        if (visible) setActiveLetter(visible.target.id.replace('glossary-sec-', ''))
      },
      { rootMargin: '-88px 0px -70% 0px', threshold: 0 },
    )
    sections.forEach((s) => obs.observe(s))
    return () => obs.disconnect()
  }, [grouped])

  const total = GLOSSARY.length

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-10">
      <style>{`
        @media print {
          nav, .glossary-sidebar, .glossary-search, .glossary-tools { display: none !important; }
          .glossary-term { break-inside: avoid; border: 1px solid #ccc !important; box-shadow: none !important; background: #fff !important; }
          body { color: #000 !important; background: #fff !important; }
        }
      `}</style>

      {/* Header */}
      <header className="glossary-search mb-6">
        <div className="g2 p-5 sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p
                style={{
                  fontFamily: 'var(--font-data)',
                  fontSize: 9,
                  letterSpacing: '0.18em',
                  textTransform: 'uppercase',
                  color: 'var(--b600)',
                }}
              >
                Terminology Reference
              </p>
              <h1
                className="mt-1"
                style={{
                  fontFamily: 'var(--font-ui)',
                  fontWeight: 800,
                  fontSize: 'clamp(26px, 4vw, 40px)',
                  letterSpacing: '-0.024em',
                  color: 'var(--ink)',
                  lineHeight: 1.1,
                }}
              >
                sqftLab Glossary
              </h1>
              <p className="mt-2 max-w-[68ch]" style={{ fontSize: 14, color: 'var(--ink-4)', lineHeight: 1.7 }}>
                Every term, metric and data source used across the platform — defined, with the
                methodology and source behind it. No black boxes.
              </p>
            </div>
            <button
              onClick={() => window.print()}
              className="glossary-tools g4 hidden sm:inline-flex items-center gap-2 px-3 py-2 rounded-[var(--r-pill)] transition-colors hover:text-[var(--b600)]"
              style={{ fontFamily: 'var(--font-data)', fontSize: 10, color: 'var(--ink-4)' }}
            >
              <Printer size={12} /> Print
            </button>
          </div>

          {/* Search */}
          <div className="relative mt-5">
            <Search
              size={14}
              className="absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
              style={{ color: 'var(--ink-5)' }}
            />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search terms, e.g. 'yield' or 'DLD'…"
              aria-label="Search glossary terms"
              className="w-full pl-10 pr-10 py-3 rounded-[var(--r-pill)] outline-none transition-shadow focus:shadow-[0_0_0_3px_rgba(37,99,235,0.14)]"
              style={{
                background: 'var(--g2)',
                backdropFilter: 'var(--gblur)',
                WebkitBackdropFilter: 'var(--gblur)',
                border: '1px solid var(--gb)',
                fontFamily: 'var(--font-ui)',
                fontSize: 14,
                color: 'var(--ink)',
              }}
            />
            {query && (
              <button
                onClick={() => { setQuery(''); inputRef.current?.focus() }}
                aria-label="Clear search"
                className="absolute right-3.5 top-1/2 -translate-y-1/2 hover:text-[var(--b600)]"
                style={{ color: 'var(--ink-4)' }}
              >
                <X size={14} />
              </button>
            )}
          </div>

          <p
            className="mt-3"
            style={{ fontFamily: 'var(--font-data)', fontSize: 9, letterSpacing: '0.06em', color: 'var(--ink-5)' }}
          >
            Showing {filtered.length} of {total} terms
          </p>
        </div>
      </header>

      <div className="flex flex-col md:flex-row gap-8">
        {/* Alphabet sidebar — desktop only */}
        <aside className="glossary-sidebar hidden md:block md:w-[120px] shrink-0">
          <div className="g3 p-3 sticky top-[76px]">
            <p
              className="px-2 pb-2"
              style={{
                fontFamily: 'var(--font-data)',
                fontSize: 9,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: 'var(--ink-5)',
              }}
            >
              Jump to
            </p>
            <div className="grid grid-cols-4 md:grid-cols-2 gap-0.5">
              {GLOSSARY_LETTERS.map((l) => {
                const enabled = lettersWithResults.has(l)
                const active = activeLetter === l
                return (
                  <a
                    key={l}
                    href={`#glossary-sec-${l}`}
                    aria-disabled={!enabled}
                    className="block px-2 py-1 rounded-[var(--r-sm)] text-center transition-colors"
                    style={{
                      fontFamily: 'var(--font-data)',
                      fontSize: 12,
                      color: !enabled ? 'var(--ink-6)' : active ? 'var(--b600)' : 'var(--ink-4)',
                      background: active ? 'var(--b50)' : 'transparent',
                      pointerEvents: enabled ? 'auto' : 'none',
                      fontWeight: active ? 600 : 400,
                    }}
                  >
                    {l}
                  </a>
                )
              })}
            </div>
          </div>
        </aside>

        {/* Terms */}
        <main className="min-w-0 flex-1">
          {grouped.length === 0 && (
            <div className="g3 p-8 text-center">
              <p style={{ fontSize: 14, color: 'var(--ink-4)' }}>
                No terms found for “{query}”.
              </p>
              <button
                onClick={() => setQuery('')}
                className="mt-3 underline decoration-dotted underline-offset-2"
                style={{ fontFamily: 'var(--font-data)', fontSize: 11, color: 'var(--b600)' }}
              >
                Clear search
              </button>
            </div>
          )}

          {grouped.map(([letter, terms]) => (
            <section
              key={letter}
              id={`glossary-sec-${letter}`}
              className="scroll-mt-[88px] mb-8"
            >
              <div
                className="sticky top-[60px] z-10 flex items-baseline gap-2 py-2 mb-2"
                style={{
                  background: 'linear-gradient(180deg, var(--page) 62%, rgba(238,242,247,0.0) 100%)',
                }}
              >
                <h2
                  style={{
                    fontFamily: 'var(--font-data)',
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: '0.2em',
                    textTransform: 'uppercase',
                    color: 'var(--b600)',
                  }}
                >
                  {letter}
                </h2>
                <span
                  style={{
                    fontFamily: 'var(--font-data)',
                    fontSize: 9,
                    color: 'var(--ink-5)',
                  }}
                >
                  ({terms.length} {terms.length === 1 ? 'term' : 'terms'})
                </span>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                {terms.map((t) => (
                  <TermCard key={t.slug} t={t} />
                ))}
              </div>
            </section>
          ))}

          <p
            className="mt-10 pb-4 text-center"
            style={{ fontFamily: 'var(--font-data)', fontSize: 9, letterSpacing: '0.1em', color: 'var(--ink-5)' }}
          >
            {total} terms · every metric traces to a source · sqftLab
          </p>
        </main>
      </div>
    </div>
  )
}
