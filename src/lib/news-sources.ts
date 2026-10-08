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

/** Google News RSS endpoint. `hl`/`gl`/`ceid` pin it to the UAE English edition. */
export function feedUrl(query: string): string {
  const q = encodeURIComponent(query)
  return `https://news.google.com/rss/search?q=${q}&hl=en-AE&gl=AE&ceid=AE:en`
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
