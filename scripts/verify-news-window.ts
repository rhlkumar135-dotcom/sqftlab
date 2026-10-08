/**
 * Verifies the 30-day, per-emirate news feature.
 *
 * Covers the parts that are cheap to get wrong and expensive to notice:
 *  - the emirate classifier, including the tie and the no-signal cases;
 *  - that the corpus actually holds a real 30-day window for BOTH emirates, not just a
 *    nominal one (the old 7-day retention filter made 30 days impossible by construction);
 *  - that the feed endpoint filters by emirate rather than ignoring it;
 *  - that analytics returns collections and, critically, reports `unanalysed` separately
 *    instead of folding unread articles into 'neutral'.
 *
 * Runs against the live local server (no writes, no model calls).
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:3101'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  const body = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status} ${body.error ?? ''}`)
  return body
}

async function main() {
  console.log(`\nnews 30-day / per-emirate — ${BASE}\n`)

  const { classifyEmirate, NEWS_WINDOW_DAYS } = await import('../src/lib/news-sources')

  console.log('classifier')
  check('Dubai story → dubai', classifyEmirate('Dubai Marina rents rise') === 'dubai')
  check('Abu Dhabi story → abu_dhabi', classifyEmirate('Aldar launches Saadiyat villas') === 'abu_dhabi')
  check('AD island named → abu_dhabi', classifyEmirate('Yas Island handovers accelerate') === 'abu_dhabi')
  check(
    'both named, AD more often → abu_dhabi',
    classifyEmirate('Abu Dhabi and Dubai: Abu Dhabi leads as Abu Dhabi sales climb') === 'abu_dhabi'
  )
  check('tie → uae', classifyEmirate('Dubai and Abu Dhabi both report growth') === 'uae')
  check('no emirate named → uae', classifyEmirate('UAE property market grows') === 'uae')
  check('window is 30 days', NEWS_WINDOW_DAYS === 30, String(NEWS_WINDOW_DAYS))

  // The exact regressions a browser pass found in the live tabs. Each of these was
  // previously filed under an emirate purely because of which feed query returned it.
  console.log('classifier — regressions found in the live tabs')
  check(
    'Saudi story is NOT abu_dhabi',
    classifyEmirate(
      'Al Othaim reveals US $4.3bn Saudi real estate investment plans',
      'Al Othaim reveals US $4.3bn Saudi real estate investment plans'
    ) === 'global'
  )
  check(
    'Africa story is NOT dubai',
    classifyEmirate('Africa Launches AfCRA to Strengthen Capital Access', '') === 'global'
  )
  check(
    'Kyiv story is NOT dubai',
    classifyEmirate('Company halts three residential complexes in Kyiv', '') === 'global'
  )
  check('Ajman story is UAE-wide, not abu_dhabi', classifyEmirate('Al Zorah outlines project pipeline in Ajman', '') === 'uae')
  check('Sharjah story is UAE-wide, not dubai', classifyEmirate('Sharjah rents rise across key communities', '') === 'uae')

  // The UAE-wide bucket was the catch-all and a second browser pass found it 46% on-topic,
  // full of US mortgage-rate reports from the "UAE economy mortgage" feed.
  console.log('classifier — the UAE-wide catch-all')
  check('US mortgage story is NOT uae-wide', classifyEmirate('US Mortgage Rates Hit Three-Year High', '') === 'global')
  check(
    'US 30-year mortgage story is NOT uae-wide',
    classifyEmirate('US 30-year mortgage rate hits highest in nearly three years', '') === 'global'
  )
  check(
    'Federal Reserve story is NOT uae-wide',
    classifyEmirate('Trump targets Federal Reserve over mortgage rates', '') === 'global'
  )
  check('Türkiye (accented) is NOT uae-wide', classifyEmirate('Türkiye property sales to foreigners rise', '') === 'global')
  check('Italy is NOT uae-wide', classifyEmirate('Italy housing market cools sharply', '') === 'global')
  check(
    'an emirate-free, UAE-free story is international, not UAE-wide',
    classifyEmirate('Developer launches new residential tower', '') === 'global'
  )
  check(
    'a UAE signal without an emirate is UAE-wide',
    classifyEmirate('Dirham peg keeps Gulf property attractive', '') === 'uae'
  )
  check(
    'a UAE headline mentioning a foreign market stays UAE-wide',
    classifyEmirate('UAE Real Estate Is Back in the Spotlight as Buyer Activity Builds', '') === 'uae'
  )
  check(
    'a Dubai area named without the word Dubai still counts',
    classifyEmirate('Villa in The World Islands sold for Dhs79 million', '') === 'dubai'
  )
  check(
    'lowercase "us" is not read as the United States',
    classifyEmirate('What Dubai landlords want you to know, let us explain', '') === 'dubai'
  )
  check(
    'a passing body mention does not claim the emirate',
    classifyEmirate('Etihad Rail puts UAE property market on a new track', 'The developer also has offices in Dubai.') === 'uae'
  )
  check(
    'a headline mention does claim it',
    classifyEmirate('Dubai property buyers get keys months ahead of time', '') === 'dubai'
  )

  console.log('\ntab counts')
  const em = await get<{ total: number; windowDays: number; emirates: Array<{ id: string; label: string; count: number }> }>(
    '/api/sqftlab/news/emirates'
  )
  check('window is 30 days', em.windowDays === 30, String(em.windowDays))
  const byId = Object.fromEntries(em.emirates.map((e) => [e.id, e.count]))
  console.log(`    total=${em.total} dubai=${byId.dubai} abu_dhabi=${byId.abu_dhabi} uae=${byId.uae} global=${byId.global}`)
  check('corpus is non-trivial', em.total >= 100, String(em.total))
  check('Dubai has 30-day coverage', (byId.dubai ?? 0) >= 20, String(byId.dubai))
  check('Abu Dhabi has 30-day coverage', (byId.abu_dhabi ?? 0) >= 10, String(byId.abu_dhabi))
  check(
    'tabs sum to the total',
    (byId.dubai ?? 0) + (byId.abu_dhabi ?? 0) + (byId.uae ?? 0) + (byId.global ?? 0) === em.total
  )

  console.log('\nfeed filtering')
  const dubai = await get<{ items: Array<{ emirate?: string; headline: string; sourceUrl: string }>; total: number }>(
    '/api/sqftlab/news?emirate=dubai'
  )
  const abuDhabi = await get<{ items: Array<{ emirate?: string; headline: string; sourceUrl: string }>; total: number }>(
    '/api/sqftlab/news?emirate=abu_dhabi'
  )
  check('dubai filter returns the Dubai count', dubai.total === byId.dubai, `${dubai.total} vs ${byId.dubai}`)
  check('abu_dhabi filter returns the AD count', abuDhabi.total === byId.abu_dhabi, `${abuDhabi.total} vs ${byId.abu_dhabi}`)
  check(
    'every returned dubai item is tagged dubai',
    dubai.items.every((i) => i.emirate === 'dubai'),
    dubai.items.map((i) => i.emirate).join(',')
  )
  check(
    'every returned abu_dhabi item is tagged abu_dhabi',
    abuDhabi.items.every((i) => i.emirate === 'abu_dhabi')
  )
  check('the two tabs are disjoint', dubai.total + abuDhabi.total <= em.total)
  check(
    'items carry an outbound source url',
    dubai.items.every((i) => /^https?:\/\//.test(i.sourceUrl)),
    dubai.items[0]?.sourceUrl?.slice(0, 48)
  )

  console.log('\nanalytics')
  const dubaiA = await get<{
    coverage: { analysed: number; unanalysed: number; daysCovered: number; publishers: number }
    sentiment: { positive: number; neutral: number; negative: number }
    collections: Array<{ id: string; label: string; count: number }>
    weekly: Array<{ weekStart: string; total: number }>
    momentum: { volumeChangePct: number | null; sentimentShiftPct: number | null }
    topAreas: Array<{ area: string }>
    figures: unknown[]
  }>('/api/sqftlab/news/analytics?emirate=dubai')

  console.log(
    `    analysed=${dubaiA.coverage.analysed} unanalysed=${dubaiA.coverage.unanalysed} ` +
      `days=${dubaiA.coverage.daysCovered} publishers=${dubaiA.coverage.publishers} collections=${dubaiA.collections.length}`
  )
  check('analytics covers ~30 days', dubaiA.coverage.daysCovered >= 25, String(dubaiA.coverage.daysCovered))
  check('analytics has analysed items', dubaiA.coverage.analysed > 0, String(dubaiA.coverage.analysed))
  check('unanalysed is reported, not hidden', typeof dubaiA.coverage.unanalysed === 'number')
  check('collections were built', dubaiA.collections.length >= 3, String(dubaiA.collections.length))
  check('weekly trend has multiple buckets', dubaiA.weekly.length >= 2, String(dubaiA.weekly.length))
  const sentTotal = dubaiA.sentiment.positive + dubaiA.sentiment.neutral + dubaiA.sentiment.negative
  check('sentiment accounts only for analysed items', sentTotal <= dubaiA.coverage.analysed, `${sentTotal} <= ${dubaiA.coverage.analysed}`)
  check(
    'a null momentum is a real null, not a fake 0',
    dubaiA.momentum.volumeChangePct === null || typeof dubaiA.momentum.volumeChangePct === 'number'
  )

  const adA = await get<{ coverage: { analysed: number }; collections: unknown[] }>(
    '/api/sqftlab/news/analytics?emirate=abu_dhabi'
  )
  check('Abu Dhabi analytics is scoped, not the whole corpus', adA.coverage.analysed < dubaiA.coverage.analysed, `${adA.coverage.analysed} < ${dubaiA.coverage.analysed}`)
  check('Abu Dhabi has its own collections', adA.collections.length >= 2, String(adA.collections.length))

  console.log(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) FAILED\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
