/**
 * Day 19 — the source list behind the Market Intelligence Feed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEVIATION FROM THE BRIEF, and the largest one in this feature.
 *
 * The brief specifies nine publisher RSS feeds. I fetched all nine (plus their
 * stated fallbacks) before writing a line of this feature, and **every one is
 * gone**:
 *
 *   khaleejtimes.com/business/real-estate/rss  404
 *   khaleejtimes.com/rss                       404
 *   gulfnews.com/rss/property                  404
 *   gulfnews.com/rss                           404
 *   arabianbusiness.com/rss/real-estate        405  (bot-blocked)
 *   arabianbusiness.com/rss                    405
 *   zawya.com/en/rss/zm_realestate             200 but HTML, zero <item>
 *   zawya.com/en/rss/zm_uae                    200 but HTML, zero <item>
 *   thenationalnews.com/rss/property.xml       404
 *   thenationalnews.com/rss.xml                404
 *   tradearabia.com/RSS/PROP_RSS.xml           404
 *   tradearabia.com/RSS/BIZZ_RSS.xml           404
 *   feeds.reuters.com/reuters/businessNews     DNS ENOTFOUND (Reuters retired RSS)
 *   wam.ae/en/rss                              200 but HTML, zero <item>
 *
 * UAE publishers have largely withdrawn public RSS. Shipping the brief verbatim
 * would have produced a feed that ingests zero rows on every tick — a feature that
 * looks complete and is inert. Worse, the "8 sources active" indicator would have
 * reported eight healthy sources.
 *
 * So the transport is Google News RSS, which is live and returns ~100 items per
 * query, carrying the same publishers the brief names (`<source>` on each item is
 * the real masthead: The National, Arabian Business, Zawya, Bloomberg, Arab News…).
 * That keeps the INTENT — named UAE property and financial press — while sitting on
 * a transport that actually returns data.
 *
 * The consequence is recorded honestly rather than hidden: `sourceName` on a stored
 * item is the PUBLISHER, while `source` is the query that surfaced it. The UI lists
 * publishers, because that is what a reader recognises, and reports per-source counts
 * from what was really ingested rather than from this array's length.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface NewsFeed {
  id: string
  /** Human label for diagnostics. The UI shows publishers, not this. */
  name: string
  /** The news search query that defines this feed. */
  query: string
  region: 'dubai' | 'abudhabi' | 'uae' | 'global'
  category: 'property' | 'economy' | 'finance' | 'regulatory'
  /**
   * Every one of these must be considered on-topic. A broad news search also
   * returns celebrity house purchases and unrelated sport, so a feed with no
   * filter would dilute the digest with noise. Dropping an irrelevant item is
   * correct; inventing a real-estate angle for it is not.
   */
  filterKeywords: string[]
  /**
   * Names that count as a targeted publisher hit. Reported per-source so the
   * sidebar can distinguish "we queried Khaleej Times" from "we actually got
   * articles from Khaleej Times".
   */
  publisherFilter?: string[]
}

/** One shared on-topic vocabulary. Property/market terms only. */
const PROPERTY_TERMS = [
  'property', 'properties', 'real estate', 'realty', 'housing', 'homes', 'home sales',
  'villa', 'villas', 'apartment', 'apartments', 'penthouse', 'off-plan', 'offplan',
  'mortgage', 'mortgages', 'rent', 'rents', 'rental', 'rentals', 'landlord', 'tenant',
  'developer', 'developers', 'handover', 'handovers', 'sqft', 'sq ft', 'square feet',
  'price', 'prices', 'psf', 'transactions', 'sales', 'escrow', 'freehold',
  'rera', 'dld', 'ejari', 'adrec', 'broker', 'brokerage', 'commission',
  'construction', 'masterplan', 'master plan', 'tower', 'towers', 'units',
]

/** UAE-property relevance, for feeds whose query is broader than property. */
const UAE_TERMS = ['uae', 'dubai', 'abu dhabi', 'sharjah', 'emirates', 'gulf']

export const NEWS_FEEDS: NewsFeed[] = [
  {
    id: 'dubai-property',
    name: 'Dubai — Property & Real Estate',
    query: 'Dubai real estate',
    region: 'dubai',
    category: 'property',
    filterKeywords: PROPERTY_TERMS,
    publisherFilter: ['Khaleej Times', 'Gulf News', 'The National', 'Arabian Business', 'Zawya', 'Gulf Today'],
  },
  {
    id: 'dubai-offplan',
    name: 'Dubai — Off-plan & Launches',
    query: 'Dubai off-plan property launch',
    region: 'dubai',
    category: 'property',
    filterKeywords: PROPERTY_TERMS,
    publisherFilter: ['Khaleej Times', 'Gulf News', 'The National', 'Arabian Business'],
  },
  {
    id: 'dubai-rents',
    name: 'Dubai — Rents & Tenancy',
    query: 'Dubai rents rental market',
    region: 'dubai',
    category: 'property',
    filterKeywords: ['rent', 'rents', 'rental', 'rentals', 'tenant', 'tenancy', 'landlord', 'leasing', 'rjv', 'yield'],
  },
  {
    id: 'abudhabi-property',
    name: 'Abu Dhabi — Property & Real Estate',
    query: 'Abu Dhabi property real estate',
    region: 'abudhabi',
    category: 'property',
    filterKeywords: PROPERTY_TERMS,
    publisherFilter: ['The National', 'Gulf News', 'Arabian Business', 'Zawya'],
  },
  {
    id: 'abu-dhabi-development',
    name: 'Abu Dhabi — Development & Projects',
    query: 'Abu Dhabi development project Aldar',
    region: 'abudhabi',
    category: 'property',
    filterKeywords: PROPERTY_TERMS,
  },
  {
    id: 'uae-property-market',
    name: 'UAE — Property Market',
    query: 'UAE property market',
    region: 'uae',
    category: 'property',
    filterKeywords: PROPERTY_TERMS,
    publisherFilter: ['Khaleej Times', 'Gulf News', 'The National', 'Arabian Business', 'Zawya', 'Arab News'],
  },
  {
    id: 'uae-regulation',
    name: 'UAE — Regulation & Policy',
    query: 'UAE real estate regulation RERA law',
    region: 'uae',
    category: 'regulatory',
    filterKeywords: ['regulation', 'regulatory', 'law', 'rule', 'rules', 'rera', 'dld', 'policy', 'licence', 'license', 'licensing', 'escrow', 'compliance', 'ruling', 'decree', 'reform'],
  },
  {
    id: 'uae-finance-macro',
    name: 'UAE — Finance & Macro',
    query: 'UAE economy mortgage interest rates',
    region: 'uae',
    category: 'finance',
    filterKeywords: ['mortgage', 'mortgages', 'interest rate', 'interest rates', 'economy', 'economic', 'inflation', 'gdp', 'loan', 'lending', 'central bank', 'dirham', 'yield', 'market'],
  },
  {
    id: 'gulf-property-investment',
    name: 'Gulf — Investment & Capital Flows',
    query: 'Gulf real estate investment billion',
    region: 'global',
    category: 'finance',
    filterKeywords: [...UAE_TERMS, 'investment', 'investors', 'fund', 'capital', 'acquisition', 'portfolio', 'billion', 'million', 'reit'],
    publisherFilter: ['Bloomberg', 'Reuters', 'Arabian Business', 'Zawya', 'The National'],
  },
]

export type NewsFeedId = string

/**
 * Google News RSS endpoint. `hl`/`gl`/`ceid` pin it to the UAE English edition.
 *
 * `when:30d` is not decoration. Without it the query returns whatever Google considers
 * relevant, which measured at a 274-day span — and since the ingest discards anything
 * older than the retention window, the effect was that a "last 30 days" feed was really
 * a last-few-days feed. With it, the same query returned 67 items spanning 29 days.
 * The operator is what makes the 30-day window real rather than nominal.
 */
export function feedUrl(query: string): string {
  const withWindow = /\bwhen:\d+[dhmy]\b/.test(query) ? query : `${query} when:30d`
  const q = encodeURIComponent(withWindow)
  return `https://news.google.com/rss/search?q=${q}&hl=en-AE&gl=AE&ceid=AE:en`
}

/** How far back a feed is asked to reach, and how old a stored item may be. */
export const NEWS_WINDOW_DAYS = 30

// ─── emirate classification ──────────────────────────────────────────────────

export type Emirate = 'dubai' | 'abu_dhabi' | 'uae' | 'global'

export const EMIRATES: readonly Emirate[] = ['dubai', 'abu_dhabi', 'uae', 'global']

/**
 * Place and developer names that only appear when a story is about a specific emirate.
 *
 * Deliberately weighted toward names that are unambiguous. "Jumeirah" is excluded because
 * it exists in both emirates (Jumeirah Beach vs Jumeirah at Saadiyat); "Al Reem" is
 * included because the Abu Dhabi island is the only one that reaches property coverage.
 * A wrong tag is worse than a missing one here — it puts the story in the wrong tab and
 * the reader has no way to tell.
 */
const EMIRATE_SIGNALS: Record<'dubai' | 'abu_dhabi', string[]> = {
  abu_dhabi: [
    'abu dhabi', 'saadiyat', 'yas island', 'al reem', 'masdar', 'khalifa city',
    'al raha', 'al maryah', 'hudayriyat', 'aldar', 'adrec', 'al ain', 'reem island',
    'abudhabi',
  ],
  dubai: [
    'dubai', 'jvc', 'jlt', 'jumeirah village', 'dubai marina', 'downtown dubai',
    'business bay', 'palm jumeirah', 'difc', 'dubai hills', 'creek harbour',
    'meydan', 'damac', 'emaar', 'dld', 'rera', 'expo city', 'dubai south',
    'arabian ranches', 'town square', 'discovery gardens', 'sobha', 'dubailand',
    'world islands', 'the palm', 'deira', 'bur dubai', 'dubai creek', 'maritime city',
  ],
}

/**
 * Case-sensitive foreign markers. These are acronyms, so they are matched against the
 * original text with word boundaries rather than the lowercased text: "let us know" must
 * not read as the United States, and a substring test for 'us' would.
 */
const FOREIGN_ACRONYMS = ['US', 'U.S.', 'USA', 'UK', 'U.K.']

/**
 * Other markets. A story whose text names one of these — and names no emirate — is not UAE
 * news, however it reached us: the feed query is a net and it catches neighbouring markets
 * constantly.
 *
 * This list is driven by what actually appeared mislabelled in the corpus rather than by
 * geography in the abstract. The decisive entry is 'us': the "UAE economy mortgage" feed
 * matches on the word "mortgage" and was returning US mortgage-rate reports by the dozen,
 * which then fell through to the UAE-wide bucket because they name no emirate. Italy and
 * Türkiye turned up the same way.
 *
 * Terms are matched with word boundaries, so 'oman' does not fire inside "Romania" and
 * 'india' does not fire inside an unrelated longer word.
 */
const FOREIGN_MARKETS = [
  'saudi', 'saudi arabia', 'riyadh', 'jeddah', 'dammam', 'qatar', 'doha', 'kuwait',
  'bahrain', 'manama', 'oman', 'muscat', 'jordan', 'amman', 'lebanon', 'beirut', 'iraq',
  'baghdad', 'iran', 'tehran', 'israel', 'tel aviv', 'egypt', 'cairo', 'morocco',
  'tunisia', 'turkey', 'turkiye', 'istanbul', 'cyprus', 'georgia', 'azerbaijan',
  'armenia', 'kazakhstan',
  'britain', 'london', 'england', 'scotland', 'ireland', 'dublin', 'italy', 'rome',
  'milan', 'spain', 'madrid', 'barcelona', 'portugal', 'lisbon', 'greece', 'athens',
  'germany', 'berlin', 'france', 'paris', 'netherlands', 'amsterdam', 'belgium',
  'switzerland', 'zurich', 'sweden', 'norway', 'denmark', 'poland', 'warsaw', 'russia',
  'moscow', 'kyiv', 'ukraine', 'belarus',
  'america', 'american', 'new york', 'miami', 'chicago', 'boston', 'seattle', 'dallas',
  'houston', 'texas', 'california', 'los angeles', 'san francisco', 'washington',
  'atlanta', 'canada', 'toronto', 'vancouver', 'montreal', 'brazil', 'mexico',
  'india', 'mumbai', 'delhi', 'pakistan', 'karachi', 'bangladesh', 'sri lanka', 'nepal',
  'china', 'beijing', 'shanghai', 'hong kong', 'singapore', 'japan', 'tokyo', 'korea',
  'seoul', 'taiwan', 'vietnam', 'thailand', 'malaysia', 'indonesia', 'philippines',
  'manila', 'australia', 'sydney', 'melbourne', 'new zealand', 'africa', 'nigeria',
  'kenya', 'ghana', 'south africa', 'ethiopia', 'federal reserve', 'wall street',
]

/**
 * Evidence that a story is about the UAE at all. Required before an item may be filed as
 * UAE-wide — the bucket was previously the catch-all for anything that named no emirate,
 * which is exactly how US mortgage-rate reports ended up in a UAE property feed.
 */
const UAE_SIGNALS = [
  'uae', 'u.a.e', 'united arab emirates', 'emirates', 'gulf', 'sharjah', 'ajman',
  'ras al khaimah', 'fujairah', 'umm al quwain', 'umm al-quwain', 'al ain', 'jebel ali',
  'adgm', 'dirham', 'dirhams', 'aed', 'dhs', 'deira', 'jumeirah', 'khalifa',
]

/** Fold accents so "Türkiye" matches 'turkiye' — the corpus carries both spellings. */
function normalise(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

function hasWord(haystack: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack)
}

function namesForeignMarket(haystack: string): boolean {
  const norm = normalise(haystack)
  if (FOREIGN_MARKETS.some((m) => hasWord(norm, m))) return true
  // Acronyms are checked against the original casing, so "let us know" is not "US".
  return FOREIGN_ACRONYMS.some((a) => new RegExp(`(^|[^A-Za-z0-9])${a.replace(/\./g, '\\.')}([^A-Za-z0-9]|$)`).test(haystack))
}

function namesUae(haystack: string): boolean {
  const norm = normalise(haystack)
  return UAE_SIGNALS.some((s) => hasWord(norm, s))
}

function emirateMentions(haystack: string): { abuDhabi: number; dubai: number } {
  const norm = normalise(haystack)
  let abuDhabi = 0
  let dubai = 0
  for (const s of EMIRATE_SIGNALS.abu_dhabi) abuDhabi += norm.split(s).length - 1
  for (const s of EMIRATE_SIGNALS.dubai) dubai += norm.split(s).length - 1
  return { abuDhabi, dubai }
}

/**
 * Which emirate is this story about?
 *
 * The rule that matters: **a specific emirate is only claimed when the story names it, and
 * "UAE-wide" is only claimed when the story names the UAE.** Both halves are load-bearing.
 *
 * An earlier version fell back to the feed's declared region, and that was visible to
 * readers: 161 of 320 stored items name no emirate at all, so the fallback was filing
 * stories by *which query surfaced them* — "Al Othaim reveals US $4.3bn Saudi real estate
 * investment plans" landed in the Abu Dhabi tab, and an Africa capital-markets piece and a
 * Kyiv residential story landed in Dubai's.
 *
 * Removing that fallback fixed the emirate tabs but exposed the next hole: the UAE-wide
 * bucket became the catch-all, and a browser pass found it was 46% on-topic — dominated by
 * US mortgage-rate reports pulled in by the "UAE economy mortgage" feed, which matches on
 * the word "mortgage". So the same discipline now applies there: no UAE signal in the text
 * means the item is international, not UAE-wide.
 *
 * Headline mentions outweigh body mentions three to one, because a passing reference in an
 * excerpt should not decide where a story about somewhere else is filed. A body-only claim
 * needs at least two mentions.
 */
export function classifyEmirate(headline: string, body = ''): Emirate {
  const head = emirateMentions(headline)
  const text = emirateMentions(body)

  if (head.abuDhabi > 0 || head.dubai > 0) {
    const ad = head.abuDhabi * 3 + text.abuDhabi
    const dx = head.dubai * 3 + text.dubai
    if (ad === dx) return 'uae'
    return ad > dx ? 'abu_dhabi' : 'dubai'
  }

  if (text.abuDhabi >= 2 || text.dubai >= 2) {
    if (text.abuDhabi === text.dubai) return 'uae'
    return text.abuDhabi > text.dubai ? 'abu_dhabi' : 'dubai'
  }

  // Nothing named an emirate. The headline decides first, exactly as it does above: a
  // story whose headline says "UAE" is UAE news even if it mentions a foreign market in
  // passing, and only when the headline is silent does the body get a say. Getting this
  // order wrong sent "UAE Real Estate Is Back in the Spotlight" to International.
  if (namesUae(headline)) return 'uae'
  if (namesForeignMarket(headline)) return 'global'
  if (namesUae(body)) return 'uae'
  return 'global'
}

/**
 * Is this item on-topic for its feed?
 *
 * `filterKeywords` is a whitelist and is deliberately not empty for any feed above:
 * an unfiltered news search returns sport, celebrity property purchases and general
 * politics. A quick check found "Erling Haaland becoming an Abu Dhabi home owner"
 * as the top hit for Abu Dhabi property — technically a property purchase, and
 * useless in a market-intelligence digest.
 */
export function isRelevant(feed: NewsFeed, headline: string, excerpt: string): boolean {
  const haystack = `${headline} ${excerpt}`.toLowerCase()
  return feed.filterKeywords.some((kw) => haystack.includes(kw.toLowerCase()))
}

/** Publisher names we would like to see, exposed for the UI's source panel. */
export const NAMED_PUBLISHERS = [
  'Khaleej Times',
  'Gulf News',
  'The National',
  'Arabian Business',
  'Zawya',
  'Gulf Today',
  'Arab News',
  'Bloomberg',
] as const
