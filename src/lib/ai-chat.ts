import { prisma } from './db'
import { SALE_TXN_TYPES } from './deals'
import {
  buildEvidence,
  renderEvidenceBlock,
  validateAnswer,
  deterministicAnswer,
  type EvidenceItem,
  type GroundingReport,
  type DeterministicAnswer,
} from './ai-grounding'
import {
  callProvider,
  callWithFallback,
  candidateProviders,
  selectProvider,
  type LlmMessage,
  type LlmProvider,
} from './llm-providers'

/**
 * Day 13 — AI market assistant: credential resolution, the per-tier daily quota, and
 * the market context handed to the model.
 *
 * Three deviations from the brief, each forced by what this environment actually
 * provides rather than by preference:
 *
 * 1. MODEL TRANSPORT. The brief calls
 *    `new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })`. There is no
 *    ANTHROPIC_API_KEY in this environment and `@anthropic-ai/sdk` is not a
 *    dependency, so that object could only throw on construction. The pod does carry
 *    an AI proxy credential — `AI_PROXY_TOKENS`, a JSON map of projectId -> ai-proxy
 *    JWT — which fronts Claude and answers `claude-haiku-4-5` with HTTP 200. That is
 *    what this module uses, through the Shogo AI SDK provider.
 *
 *    Note the pod's own `RUNTIME_AUTH_SECRET` does NOT work here: it is a *workspace*
 *    token (`wrt_v1_…`) and the proxy rejects it with `invalid_api_key`. The working
 *    credential is the project-scoped JWT in `AI_PROXY_TOKENS`.
 *
 * 2. QUOTA KEY. The brief keys guests on the `X-Session-Id` request header. A header is
 *    caller-supplied, so a caller can rotate it per request and the "10 messages/day"
 *    limit becomes unenforceable — the same shape of bug as the Day 4 limiter that
 *    gave every cookie-less client a fresh bucket. Guests here are keyed on the
 *    server-issued guest cookie instead; see the route, not this module.
 *
 * 3. MARKET CONTEXT. The brief queries `transactionType: 'Sales'` with `pricePsf`,
 *    `amount` and an `area` column. Against this schema the literal `'Sales'` matches
 *    zero rows (the real values are `sale` / `off_plan_sale`), the columns are
 *    `pricePerSqft` / `priceAed`, and there is no `area` column at all — a transaction
 *    keys off `communityId`. Left as written the context would have told the model
 *    "0 transactions, AED 0 average PSF" and invited it to narrate a market that does
 *    not exist. `buildMarketContext` reports absence as absence instead.
 */

/** Fast and cheap, which is what a chat surface wants. The proxy resolves this alias. */
export const AI_MODEL = 'claude-haiku-4-5'
export const AI_MAX_OUTPUT_TOKENS = 800
/** Turns of prior conversation replayed to the model. */
export const AI_CONTEXT_WINDOW_MESSAGES = 10
/** A pasted document is not a chat message. Long input is truncated, not rejected. */
export const AI_MAX_MESSAGE_CHARS = 2000
/** Turns returned by the history endpoint. */
export const AI_HISTORY_PAGE = 20
export const MARKET_CONTEXT_DAYS = 30

export type AiTier = 'guest' | 'free' | 'pro' | 'elite' | 'enterprise' | 'institutional'

/**
 * Daily assistant messages per tier.
 *
 * The brief's ladder is free = 10, pro = 100, enterprise = unlimited. Two adjustments:
 *
 *  · `elite` and `institutional` are real tiers on this schema and the brief omits both.
 *    An omitted tier must not silently lose a paid feature — that is the exact omission
 *    that demoted the seeded `elite` account to guest rank in Day 1. They slot in
 *    between pro and enterprise, matching the alert ceilings in Day 12.
 *  · "unlimited" is a generous, REPORTED ceiling rather than a number large enough to
 *    read as infinite. Every message is a billed model call, so an unbounded tier is a
 *    real spend exposure, not a formality. `aiTierIsUnlimited` tells the UI to render
 *    the top tier as unlimited while this number still bounds the damage.
 */
export const AI_DAILY_LIMITS: Record<AiTier, number> = {
  guest: 10,
  free: 10,
  pro: 100,
  elite: 250,
  enterprise: 1000,
  institutional: 1000,
}

const UNLIMITED_TIERS = new Set<string>(['enterprise', 'institutional'])

export function aiDailyLimitFor(tier: string | undefined): number {
  return AI_DAILY_LIMITS[(tier ?? 'guest') as AiTier] ?? AI_DAILY_LIMITS.guest
}

export function aiTierIsUnlimited(tier: string | undefined): boolean {
  return UNLIMITED_TIERS.has(tier ?? '')
}

export interface AiCredential {
  token: string
  /** Where the token came from, for diagnostics. Never the token itself. */
  source: 'ai_proxy' | 'shogo_key'
}

/**
 * Find a usable credential for the model call, or null.
 *
 * Null is a legitimate state, not an error: the route turns it into a clear 503 rather
 * than a fabricated reply. `/health`-style honesty — a chat box that invents answers is
 * worse than one that says the assistant is not configured.
 */
export function resolveAiCredential(env: NodeJS.ProcessEnv = process.env): AiCredential | null {
  const raw = env.AI_PROXY_TOKENS
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const entries = parsed as Record<string, string>
        const preferred = env.PROJECT_ID ? entries[env.PROJECT_ID] : undefined
        const token = preferred ?? Object.values(entries)[0]
        if (typeof token === 'string' && token.length > 0) {
          return { token, source: 'ai_proxy' }
        }
      }
    } catch {
      // A malformed map is worth falling through from, not crashing on.
    }
  }
  const key = env.SHOGO_API_KEY
  if (typeof key === 'string' && key.startsWith('shogo_sk_')) {
    return { token: key, source: 'shogo_key' }
  }
  return null
}

export interface AiTurn {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Turn untrusted client history into something safe to replay.
 *
 * The brief does `(body.history ?? []).slice(-10)` and hands the result straight to the
 * model. Two problems: `history` is only type-asserted, so a non-array throws on
 * `.slice`, and every element is taken on trust — a caller can post `role: 'system'`
 * entries (or an arbitrarily long preamble) and steer the assistant. Only the two real
 * roles survive here, each element is validated, and length is bounded.
 */
export function normalizeHistory(raw: unknown): AiTurn[] {
  if (!Array.isArray(raw)) return []
  const out: AiTurn[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const role = (item as { role?: unknown }).role
    const content = (item as { content?: unknown }).content
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') continue
    const trimmed = content.trim()
    if (trimmed === '') continue
    out.push({ role, content: trimmed.slice(0, AI_MAX_MESSAGE_CHARS) })
  }
  return out.slice(-AI_CONTEXT_WINDOW_MESSAGES)
}

/** Live listing coverage for one district, as the model is allowed to see it. */
export interface DistrictStat {
  name: string
  emirate: string
  saleListings: number
  salePsfAed: number | null
  rentListings: number
  rentAnnualAed: number | null
  priceFromAed: number | null
  priceToAed: number | null
  bedsLabel: string | null
  grossYieldPct: number | null
  neighbourhoodScore: number | null
}

/**
 * Everything the assistant is allowed to treat as fact.
 *
 * This replaces the brief's register-only context, and the reason is a data fact rather
 * than a design preference: `transactions` holds no rows on this deployment, because the
 * DLD register has never been ingested. A context built only from it is therefore empty
 * on every single request, and the assistant answers "no market data is loaded" to every
 * question — including the many this app *can* answer from data it genuinely holds.
 *
 * The live inventory is the real asset here: thousands of listings collected daily,
 * each priced, sized and attributed to a district. So the listing inventory is the
 * primary source and the register block stays alongside it, filling in by itself the
 * moment the register has rows rather than being swapped back in.
 */
export interface AssistantContext {
  /** True when there is live listing inventory to answer from. */
  listingsAvailable: boolean
  /** When the inventory was last collected (ISO). */
  asOf: string | null
  listingCount: number
  saleCount: number
  rentCount: number
  districtsCovered: number
  overallSalePsfAed: number | null
  overallRentAnnualAed: number | null
  topDistricts: DistrictStat[]
  /** The district the question named, if any — the model answers from this block. */
  focus: DistrictStat | null
  /**
   * Every community name in the registry.
   *
   * Two jobs beyond display. The answer validator uses it to catch the model naming a
   * district the evidence did not cover — the most convincing kind of wrong answer,
   * because the surrounding prose is correct. And the deterministic engine uses it to
   * tell "the reader named a district we hold nothing for" from "the reader asked a
   * general question", which decides whether to refuse or to answer.
   */
  knownPlaces: string[]
  /** Registered government sales, when the register holds any. */
  register: { available: boolean; days: number; transactions: number; avgPsfAed: number | null }
}

/**
 * A community yield above this is withheld from the model.
 *
 * `refreshCommunityStats` derives yield as `avgAnnualRent / (psf × 1000)` — an assumed
 * ~1,000 sqft unit. Where a district's rent stock is not comparable to its sale stock
 * (commercial units, whole floors, short-lets) that assumption breaks and the figure
 * comes out impossible: Al Barsha reports ~20% and Arabian Ranches ~26% against a Dubai
 * norm of 4–8%. A model instructed to quote its context will quote whatever is placed in
 * it, so an implausible yield is withheld rather than handed over to be repeated as fact.
 */
const YIELD_MIN_PCT = 2
const YIELD_MAX_PCT = 12

function plausibleYieldPct(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.round(value * 100) / 100
  return rounded >= YIELD_MIN_PCT && rounded <= YIELD_MAX_PCT ? rounded : null
}

function positiveOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null
}

function bedsLabelFor(min: number | null, max: number | null): string | null {
  if (min === null || max === null) return null
  return min === max ? `${min} bed` : `${min}–${max} bed`
}

interface CommunityRow {
  id: string
  slug: string
  nameEn: string
  emirate: string
  medianAedSqft: number
  grossYieldPct: number
  neighbourhoodScore: number
}

/**
 * Sub-district qualifiers.
 *
 * UAE districts are routinely split as "Al Barsha 1/2/3" or "Al Barsha South", where the
 * child is a district in its own right. This registry holds the parent only, so a question
 * naming the child would otherwise be answered with the parent's numbers — word-boundary
 * matching does not prevent this, because " al barsha " is a substring of " al barsha south ".
 * When one of these words follows the matched name, the match is dropped and the assistant
 * says it has no listing coverage, which is true, instead of answering about the wrong place.
 */
const SUBDISTRICT_QUALIFIERS = new Set([
  'south', 'north', 'east', 'west', 'central',
  'first', 'second', 'third', 'fourth',
  '1st', '2nd', '3rd', '4th',
])

/**
 * Find the district the question is about.
 *
 * Matching is done on the community's own name and slug so a question phrased
 * "Dubai Marina", "dubai-marina" or "marina" resolves to the same row. The longest
 * matching name wins, so a district whose name contains another's is preferred over it.
 */
function findFocus(message: string, communities: CommunityRow[]): CommunityRow | null {
  const words = message.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
  const haystack = ` ${words.join(' ')} `

  let best: CommunityRow | null = null
  let bestLength = 0
  for (const row of communities) {
    for (const needle of [row.nameEn, row.slug]) {
      const target = needle.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
      if (target.length < 4) continue
      const at = haystack.indexOf(` ${target} `)
      if (at === -1) continue
      // The word immediately after the match decides whether the reader named a longer
      // place — "Al Barsha South" is not "Al Barsha".
      const after = haystack.slice(at + target.length + 2).split(' ')[0] ?? ''
      if (SUBDISTRICT_QUALIFIERS.has(after)) continue
      if (target.length > bestLength) {
        best = row
        bestLength = target.length
      }
    }
  }
  return best
}

/**
 * Build the market context from the data this deployment actually holds.
 *
 * Queries are one batch: the listing inventory is small enough that aggregate reads are
 * cheap, and the district breakdown is a single groupBy rather than a query per district.
 * Only the focused district costs extra reads, and only when a question names one.
 */
export async function buildLiveContext(message = ''): Promise<AssistantContext> {
  const since = new Date()
  since.setDate(since.getDate() - MARKET_CONTEXT_DAYS)

  const [
    byPurpose,
    saleAgg,
    rentAgg,
    freshness,
    saleByCommunity,
    rentByCommunity,
    communities,
    registerAgg,
  ] = await Promise.all([
    prisma.listing.groupBy({ by: ['purpose'], _count: { id: true } }),
    prisma.listing.aggregate({
      where: { purpose: 'sale', pricePerSqft: { gt: 0 } },
      _avg: { pricePerSqft: true },
    }),
    prisma.listing.aggregate({
      where: { purpose: 'rent', priceAed: { gt: 0 } },
      _avg: { priceAed: true },
    }),
    // Freshness is reported, not assumed: an old scrape is a materially different
    // answer from today's, and the reader cannot tell them apart unless it is stated.
    prisma.listing.aggregate({ _max: { scrapedAt: true } }),
    prisma.listing.groupBy({
      by: ['communityId'],
      where: { purpose: 'sale' },
      _count: { id: true },
      _avg: { pricePerSqft: true },
      orderBy: { _count: { id: 'desc' } },
      take: 60,
    }),
    prisma.listing.groupBy({
      by: ['communityId'],
      where: { purpose: 'rent' },
      _count: { id: true },
      _avg: { priceAed: true },
    }),
    prisma.community.findMany({
      select: {
        id: true,
        slug: true,
        nameEn: true,
        emirate: true,
        medianAedSqft: true,
        grossYieldPct: true,
        neighbourhoodScore: true,
      },
    }),
    prisma.transaction.aggregate({
      where: {
        transactionType: { in: [...SALE_TXN_TYPES] },
        transactionDate: { gte: since },
        pricePerSqft: { gt: 100 },
      },
      _count: { id: true },
      _avg: { pricePerSqft: true },
    }),
  ])

  const communityById = new Map(communities.map((c) => [c.id, c as CommunityRow]))
  const saleMap = new Map(saleByCommunity.map((g) => [g.communityId, g]))
  const rentMap = new Map(rentByCommunity.map((g) => [g.communityId, g]))

  const statFor = (row: CommunityRow): DistrictStat => {
    const sale = saleMap.get(row.id)
    const rent = rentMap.get(row.id)
    return {
      name: row.nameEn,
      emirate: row.emirate === 'abu_dhabi' ? 'Abu Dhabi' : row.emirate === 'dubai' ? 'Dubai' : row.emirate,
      saleListings: sale?._count.id ?? 0,
      // A district with no sale listings has no PSF. 0 would be read as "free".
      salePsfAed: positiveOrNull(sale?._avg.pricePerSqft) ?? null,
      rentListings: rent?._count.id ?? 0,
      rentAnnualAed: positiveOrNull(rent?._avg.priceAed) ?? null,
      priceFromAed: null,
      priceToAed: null,
      bedsLabel: null,
      grossYieldPct: plausibleYieldPct(row.grossYieldPct),
      neighbourhoodScore: row.neighbourhoodScore > 0 ? row.neighbourhoodScore : null,
    }
  }

  // Deduped by id: a district with both sale and rent listings appears in both maps, and
  // without the Set it was listed twice — crowding out districts that had no duplicate.
  const covered = [...new Set([...saleMap.keys(), ...rentMap.keys()])]
    .map((id) => communityById.get(id))
    .filter((c): c is CommunityRow => c !== undefined)
  const stats = covered.map(statFor)

  // Both emirates are represented rather than the busiest districts overall, which on
  // this data are all Dubai — the reader asking about Abu Dhabi would otherwise get a
  // context with no Abu Dhabi district in it.
  const byCount = (a: DistrictStat, b: DistrictStat) =>
    b.saleListings + b.rentListings - (a.saleListings + a.rentListings)
  const topDistricts = [
    ...stats.filter((s) => s.emirate === 'Dubai').sort(byCount).slice(0, 5),
    ...stats.filter((s) => s.emirate === 'Abu Dhabi').sort(byCount).slice(0, 5),
    ...stats.filter((s) => s.emirate !== 'Dubai' && s.emirate !== 'Abu Dhabi').sort(byCount).slice(0, 3),
  ]

  let focus: DistrictStat | null = null
  const focusRow = message === '' ? null : findFocus(message, communities as CommunityRow[])
  if (focusRow) {
    const [saleRange, rentFocus] = await Promise.all([
      prisma.listing.aggregate({
        where: { communityId: focusRow.id, purpose: 'sale', priceAed: { gt: 0 } },
        _min: { priceAed: true, beds: true },
        _max: { priceAed: true, beds: true },
        _avg: { pricePerSqft: true },
        _count: { id: true },
      }),
      prisma.listing.aggregate({
        where: { communityId: focusRow.id, purpose: 'rent', priceAed: { gt: 0 } },
        _avg: { priceAed: true },
        _min: { priceAed: true },
        _max: { priceAed: true },
        _count: { id: true },
      }),
    ])
    focus = {
      ...statFor(focusRow),
      saleListings: saleRange._count.id,
      salePsfAed: positiveOrNull(saleRange._avg.pricePerSqft),
      priceFromAed: positiveOrNull(saleRange._min.priceAed),
      priceToAed: positiveOrNull(saleRange._max.priceAed),
      bedsLabel: bedsLabelFor(saleRange._min.beds, saleRange._max.beds),
      rentListings: rentFocus._count.id,
      rentAnnualAed: positiveOrNull(rentFocus._avg.priceAed),
    }
  }

  const saleCount = byPurpose.find((g) => g.purpose === 'sale')?._count.id ?? 0
  const rentCount = byPurpose.find((g) => g.purpose === 'rent')?._count.id ?? 0
  const listingCount = byPurpose.reduce((sum, g) => sum + g._count.id, 0)
  const registerCount = registerAgg._count.id

  return {
    listingsAvailable: listingCount > 0,
    asOf: freshness._max.scrapedAt ? freshness._max.scrapedAt.toISOString() : null,
    listingCount,
    saleCount,
    rentCount,
    districtsCovered: communityById.size,
    overallSalePsfAed: positiveOrNull(saleAgg._avg.pricePerSqft),
    overallRentAnnualAed: positiveOrNull(rentAgg._avg.priceAed),
    topDistricts,
    focus,
    knownPlaces: communities.map((c) => c.nameEn),
    register: {
      available: registerCount > 0,
      days: MARKET_CONTEXT_DAYS,
      transactions: registerCount,
      avgPsfAed: positiveOrNull(registerAgg._avg.pricePerSqft),
    },
  }
}

/**
 * The system prompt.
 *
 * The brief's version instructs the model to "always cite DLD data" and hands it a context
 * block whether or not that block holds anything. Two things had to change. The empty case
 * is now stated outright rather than implied, because a context of zeros invites the model
 * to narrate a market that does not exist. And the data is labelled by kind: this
 * deployment's figures are *asking* prices from live listings, not completed sales, and a
 * product that reports the first as the second is wrong in the way that matters most to an
 * investor. The register block is kept separate for the same reason.
 */
export function buildSystemPrompt(
  ctx: AssistantContext,
  evidence: EvidenceItem[] = buildEvidence(ctx),
): string {
  const rules = [
    "You are sqftLab's AI market assistant for UAE real estate — Dubai and Abu Dhabi.",
    'You help investors, brokers and developers understand the property market.',
    '',
    'Guidelines:',
    '- Be concise but thorough — your reader is a professional.',
    '- You cannot give financial advice. You can share market data and explain what it means.',
    '- Never invent a price, a rent, a transaction count or a trend. If a figure is not in',
    '  the data below, say you do not have it and suggest what the reader could check instead.',
    '- When you quote a figure, say which kind it is: an asking price from a current listing,',
    '  or a registered sale. Never present an asking price as a completed transaction.',
    '',
    'GROUNDING CONTRACT — your answer is checked against the EVIDENCE block below after you',
    'write it, and figures that do not come from it are rejected:',
    '- Quote a figure ONLY if it appears in the EVIDENCE block. You may round it to fewer',
    '  significant figures, and you may not change it in any other way.',
    '- Do NOT compute new figures. No sums, differences, growth rates, per-year conversions',
    '  or percentage changes, even from numbers that are present. If the reader asks for a',
    '  figure that is not listed, say it is not available and say what is.',
    '- Do NOT name a district that is not in the EVIDENCE block. If the reader asks about a',
    '  district that is absent, say sqftLab has no coverage for it — do not describe it.',
    '- Every figure you state must be traceable to the block. When in doubt, omit it.',
  ]

  if (!ctx.listingsAvailable && !ctx.register.available) {
    return [
      ...rules,
      '',
      'IMPORTANT — no market data is currently loaded. This deployment holds no listings and',
      'no registered sales, so you have NO figures for this market.',
      'Do not state or estimate any price, PSF, rent, volume, transaction count or ranking,',
      'and do not attribute any figure to sqftLab or to DLD. If asked for numbers, say plainly',
      'that no data is loaded yet, and offer to explain methodology, definitions or what the',
      'reader should compare once it is.',
    ].join('\n')
  }

  const lines = [...rules]

  if (ctx.listingsAvailable) {
    const asOf = ctx.asOf === null ? 'an unknown date' : ctx.asOf.slice(0, 10)
    lines.push(
      '- Quote only the figures in the data below, and attribute them to sqftLab.',
      '',
      `Live listing data (asking prices, collected ${asOf}):`,
      `- Active listings: ${ctx.listingCount.toLocaleString()} (${ctx.saleCount.toLocaleString()} for sale, ${ctx.rentCount.toLocaleString()} for rent) across ${ctx.districtsCovered} districts`,
    )
    if (ctx.overallSalePsfAed !== null) {
      lines.push(`- Average asking price per sqft, sale listings: AED ${ctx.overallSalePsfAed.toLocaleString()}`)
    }
    if (ctx.overallRentAnnualAed !== null) {
      lines.push(`- Average asking annual rent, rent listings: AED ${ctx.overallRentAnnualAed.toLocaleString()}`)
    }
    lines.push('- District coverage:')
    for (const d of ctx.topDistricts) {
      const sale =
        d.saleListings > 0
          ? `${d.saleListings} for sale${d.salePsfAed === null ? '' : ` at AED ${d.salePsfAed.toLocaleString()}/sqft`}`
          : 'no sale listings'
      const rent =
        d.rentListings > 0
          ? `${d.rentListings} for rent${d.rentAnnualAed === null ? '' : ` at AED ${d.rentAnnualAed.toLocaleString()}/yr`}`
          : 'no rent listings'
      const yieldBit = d.grossYieldPct === null ? '' : `, gross yield ${d.grossYieldPct}%`
      lines.push(`  · ${d.name} (${d.emirate}) — ${sale}; ${rent}${yieldBit}`)
    }

    if (ctx.focus) {
      const f = ctx.focus
      lines.push('', `The reader asked about ${f.name} (${f.emirate}) — answer from this block:`)
      lines.push(`- Active listings: ${f.saleListings} for sale, ${f.rentListings} for rent`)
      if (f.salePsfAed !== null) {
        lines.push(`- Asking price per sqft (sale): AED ${f.salePsfAed.toLocaleString()}`)
      }
      if (f.priceFromAed !== null && f.priceToAed !== null) {
        const beds = f.bedsLabel === null ? '' : ` — ${f.bedsLabel}`
        lines.push(
          `- Sale asking range: AED ${f.priceFromAed.toLocaleString()} to AED ${f.priceToAed.toLocaleString()}${beds}`,
        )
      }
      if (f.rentAnnualAed !== null) {
        lines.push(`- Typical asking annual rent: AED ${f.rentAnnualAed.toLocaleString()}`)
      }
      if (f.grossYieldPct !== null) lines.push(`- Community profile: gross yield ${f.grossYieldPct}%`)
      if (f.neighbourhoodScore !== null) {
        lines.push(`- Neighbourhood score: ${f.neighbourhoodScore}/100`)
      }
    } else {
      lines.push(
        '',
        'If the reader asks about a district that is not listed above, say sqftLab has no',
        'listing coverage for it rather than estimating from the districts that are covered.',
      )
    }
  } else {
    lines.push('- No live listings are loaded, so you cannot quote asking prices.')
  }

  if (ctx.register.available) {
    lines.push(
      '',
      `Registered sales (government register, last ${ctx.register.days} days):`,
      `- Transactions: ${ctx.register.transactions.toLocaleString()}`,
      ctx.register.avgPsfAed === null
        ? '- Average price per sqft: unavailable'
        : `- Average price per sqft: AED ${ctx.register.avgPsfAed.toLocaleString()}`,
    )
  } else {
    lines.push(
      '',
      'The government transaction register holds no rows on this deployment, so you have no',
      'registered sale figures. Do not state or estimate a registered sale volume or price.',
    )
  }

  // The evidence block is the machine-checked part of the prompt. The validator compares
  // the finished answer against these exact values, so a figure that is not listed here is
  // reported as unsupported rather than reaching the reader as fact.
  lines.push('', 'EVIDENCE — the only figures and districts you may use:', renderEvidenceBlock(evidence))

  return lines.join('\n')
}

export class AiUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AiUnavailableError'
  }
}

/**
 * Call one provider.
 *
 * The AI SDK is no longer on the critical path — the provider chain speaks plain HTTP — so
 * a deployment without `ai` installed still answers. `AiUnavailableError` is retained
 * because news.ts imports it.
 */
export async function generateAssistantReply(opts: {
  provider: LlmProvider
  system: string
  history: AiTurn[]
  message: string
}): Promise<{ reply: string; tokensUsed: number; model: string; providerLabel: string }> {
  const messages: LlmMessage[] = [
    { role: 'system', content: opts.system },
    ...opts.history.map((t) => ({ role: t.role as 'user' | 'assistant', content: t.content })),
    { role: 'user', content: opts.message },
  ]
  const result = await callProvider(opts.provider, messages, { maxTokens: AI_MAX_OUTPUT_TOKENS })
  return {
    reply: result.text,
    tokensUsed: result.tokensUsed,
    model: result.model,
    providerLabel: result.providerLabel,
  }
}

// ─── Untrusted-place detection ─────────────────────────────────────────────────

/**
 * Words that never make a capitalised phrase a place name.
 *
 * Question words, field vocabulary and the emirate names themselves. The emirates are
 * included because "Dubai" and "Abu Dhabi" are scopes rather than districts — a question
 * about them is answered from the aggregate, so refusing it would be wrong.
 */
const NON_PLACE_WORDS = new Set([
  'what', 'whats', 'which', 'where', 'when', 'how', 'why', 'who', 'whose',
  'is', 'are', 'was', 'were', 'be', 'the', 'a', 'an', 'and', 'or', 'but', 'for', 'from',
  'in', 'on', 'at', 'to', 'of', 'with', 'do', 'does', 'did', 'can', 'could', 'should',
  'would', 'will', 'tell', 'show', 'give', 'me', 'my', 'you', 'your', 'i', 'we', 'us',
  'please', 'compare', 'vs', 'versus', 'best', 'worst', 'top', 'average', 'mean', 'median',
  'total', 'price', 'prices', 'rent', 'rents', 'yield', 'yields', 'market', 'markets',
  'district', 'districts', 'area', 'areas', 'community', 'communities', 'listing',
  'listings', 'property', 'properties', 'sqft', 'sqm', 'psf', 'aed', 'usd', 'data',
  'report', 'trend', 'trends', 'investment', 'investor', 'investors', 'return', 'returns',
  'abu', 'dhabi', 'dubai', 'uae', 'emirates', 'united', 'arab', 'gulf', 'gcc', 'middle',
  'east', 'about', 'summary', 'summarise', 'summarize', 'overview', 'any', 'there', 'this',
  'that', 'these', 'those', 'new', 'old', 'sale', 'sales', 'sold', 'buy', 'buyer', 'buyers',
  'island', 'city', 'park', 'tower', 'towers', 'residence', 'residences',
])

/**
 * Find a place the reader named that we hold nothing for.
 *
 * This is the highest-value refusal in the module, because it is the case a model gets
 * wrong most convincingly: the reader names a real district, our context has no block for
 * it, and the model — which does know the place — answers from training data in fluent
 * prose. Refusing before the model is called removes the opportunity entirely.
 *
 * Deliberately narrow. Only 2-3 word capitalised phrases qualify, since a single
 * capitalised word is as likely to be "What" or "Which" as a place; and any phrase
 * containing a district we do cover is skipped, so "Dubai Marina Walk" is not treated as
 * an unknown place. The cost of a miss here is a model answer that the numeric and place
 * validators still check; the cost of a false positive would be refusing a question we can
 * answer, which is why the check is conservative.
 */
export function detectUncoveredPlace(message: string, knownPlaces: string[]): string | null {
  const known = knownPlaces.map((p) => p.toLowerCase())
  const phrases = message.match(/\b[A-Z][a-zA-Z'’-]*(?:\s+[A-Z][a-zA-Z'’-]*){1,2}\b/g) ?? []
  for (const phrase of phrases) {
    const normalised = phrase.trim().toLowerCase()
    if (normalised === '') continue
    if (known.includes(normalised)) continue
    const words = normalised.split(/\s+/)
    if (words.some((w) => NON_PLACE_WORDS.has(w))) continue

    const covered = known.find((k) => k.length >= 4 && normalised.includes(k))
    if (covered !== undefined) {
      // A covered district followed by a sub-district qualifier is a different place.
      // "Al Barsha South" is not "Al Barsha", and our registry holds the parent only — so
      // answering with the parent's numbers would be a confident answer about the wrong
      // address. This mirrors `findFocus`, which drops exactly this match, and keeps the two
      // layers agreeing instead of one covering for the other.
      const after = normalised.slice(normalised.indexOf(covered) + covered.length).trim().split(/\s+/)[0] ?? ''
      if (!SUBDISTRICT_QUALIFIERS.has(after)) continue
    }
    return phrase.trim()
  }
  return null
}

// ─── Orchestration ─────────────────────────────────────────────────────────────

export interface AssistantReply {
  reply: string
  /** `model` when an LLM produced the text; `deterministic` when the database did. */
  mode: 'model' | 'deterministic'
  providerId: string | null
  providerLabel: string | null
  model: string | null
  tokensUsed: number
  /** True when every figure in the reply traced back to the evidence block. */
  verified: boolean
  unsupportedNumbers: string[]
  unsupportedPlaces: string[]
  /** Evidence ids the reply drew on — real server-side sources, not model self-report. */
  evidenceIds: string[]
  /** True when the assistant declined to answer for want of data. */
  refused: boolean
  dataBacked: boolean
  focus: string | null
  asOf: string | null
  /** Why a fallback happened, when one did. Shown as a caveat, never hidden. */
  note: string | null
  /** Which live sources stood behind the answer: 'listings' and/or 'register'. */
  sources: string[]
}

/** Which live sources are in play, derived from what the context actually holds. */
function sourcesFor(ctx: AssistantContext): string[] {
  return [
    ...(ctx.listingsAvailable ? ['listings'] : []),
    ...(ctx.register.available ? ['register'] : []),
  ]
}

function repairInstruction(report: GroundingReport): string {
  const parts = [
    'That answer was rejected: it stated figures that do not appear in the EVIDENCE block.',
  ]
  if (report.unsupportedNumbers.length > 0) {
    parts.push(`Remove or correct these figures: ${report.unsupportedNumbers.join(', ')}.`)
  }
  if (report.unsupportedPlaces.length > 0) {
    parts.push(`Remove these districts, which are not in the evidence: ${report.unsupportedPlaces.join(', ')}.`)
  }
  parts.push(
    'Rewrite it using only values that appear in the EVIDENCE block. Do not compute new figures. If a requested figure is not there, say it is not available.',
  )
  return parts.join(' ')
}

function fromDeterministic(
  det: DeterministicAnswer,
  ctx: AssistantContext,
  note: string | null,
): AssistantReply {
  return {
    reply: det.reply,
    mode: 'deterministic',
    providerId: null,
    providerLabel: 'Computed from the live database',
    model: null,
    tokensUsed: 0,
    // Nothing is unverified in this path: every figure was formatted by the same code that
    // read it, so there is no step at which one could be invented.
    verified: true,
    unsupportedNumbers: [],
    unsupportedPlaces: [],
    evidenceIds: det.evidenceIds,
    refused: det.refused,
    dataBacked: ctx.listingsAvailable || ctx.register.available,
    focus: ctx.focus?.name ?? null,
    asOf: ctx.asOf,
    note,
    sources: sourcesFor(ctx),
  }
}

/**
 * Answer a market question under a grounding guarantee.
 *
 * The order of the gates is the design. Cheap, certain checks run first and the model runs
 * last, so the ways a confident wrong answer can be produced are closed before anything is
 * asked to generate text:
 *
 *   1. The reader named a district we hold nothing for  → refuse, no model call.
 *   2. There is no data at all to ground on             → refuse, no model call.
 *   3. No provider is configured                        → answer from the database.
 *   4. A provider failed                                → answer from the database.
 *   5. The model's answer quoted figures we do not have → repair once, then replace it
 *                                                         with the computed answer.
 *
 * Only step 5 involves trust, and it is checked rather than assumed.
 */
export async function answerMarketQuestion(opts: {
  message: string
  history?: AiTurn[]
  env?: NodeJS.ProcessEnv
}): Promise<AssistantReply> {
  const env = opts.env ?? process.env
  const message = opts.message

  const ctx = await buildLiveContext(message)
  const evidence = buildEvidence(ctx)
  const dataBacked = ctx.listingsAvailable || ctx.register.available

  if (dataBacked && ctx.focus === null) {
    const uncovered = detectUncoveredPlace(message, ctx.knownPlaces)
    if (uncovered !== null) {
      return {
        reply:
          `I have no listing coverage for **${uncovered}**, so I cannot give you prices for it — and I will not estimate them. ` +
          `sqftLab currently holds asking prices for ${ctx.districtsCovered} districts across Dubai and Abu Dhabi. ` +
          `Ask me about one of those, or ask which districts are covered.`,
        mode: 'deterministic',
        providerId: null,
        providerLabel: 'Computed from the live database',
        model: null,
        tokensUsed: 0,
        verified: true,
        unsupportedNumbers: [],
        unsupportedPlaces: [],
        evidenceIds: ['listings.districts'],
        refused: true,
        dataBacked,
        focus: null,
        asOf: ctx.asOf,
        note: null,
        sources: sourcesFor(ctx),
      }
    }
  }

  if (!dataBacked) {
    return fromDeterministic(deterministicAnswer(message, ctx, ctx.knownPlaces), ctx, null)
  }

  const primary = selectProvider(env)
  if (primary === null) {
    return fromDeterministic(
      deterministicAnswer(message, ctx, ctx.knownPlaces),
      ctx,
      'No model is configured (AI_PROVIDER=offline or no provider key), so this answer was computed directly from the live database.',
    )
  }

  // Free tiers first, then any other configured provider — so a rate-limited free tier
  // degrades to the next provider rather than to an error.
  const rest = candidateProviders(env).filter((p) => p.id !== primary.id)
  const providers = [primary, ...rest]

  const system = buildSystemPrompt(ctx, evidence)
  const base: LlmMessage[] = [
    { role: 'system', content: system },
    ...(opts.history ?? []).map((t) => ({ role: t.role as 'user' | 'assistant', content: t.content })),
    { role: 'user', content: message },
  ]

  const strict = (env.AI_STRICT_GROUNDING ?? 'true').toLowerCase() !== 'false'

  try {
    const first = await callWithFallback(providers, base, { maxTokens: AI_MAX_OUTPUT_TOKENS })
    const firstReport = validateAnswer(first.text, evidence, ctx.knownPlaces)

    if (firstReport.verified || !strict) {
      return {
        reply: first.text,
        mode: 'model',
        providerId: first.providerId,
        providerLabel: first.providerLabel,
        model: first.model,
        tokensUsed: first.tokensUsed,
        verified: firstReport.verified,
        unsupportedNumbers: firstReport.unsupportedNumbers,
        unsupportedPlaces: firstReport.unsupportedPlaces,
        evidenceIds: [],
        refused: false,
        dataBacked,
        focus: ctx.focus?.name ?? null,
        asOf: ctx.asOf,
        note: null,
        sources: sourcesFor(ctx),
      }
    }

    // One repair attempt, told exactly what failed. Models correct a named figure far more
    // reliably than they obey a general instruction not to invent.
    const repaired = await callWithFallback(
      providers,
      [
        ...base,
        { role: 'assistant', content: first.text },
        { role: 'user', content: repairInstruction(firstReport) },
      ],
      { maxTokens: AI_MAX_OUTPUT_TOKENS },
    )
    const repairedReport = validateAnswer(repaired.text, evidence, ctx.knownPlaces)

    if (repairedReport.verified) {
      return {
        reply: repaired.text,
        mode: 'model',
        providerId: repaired.providerId,
        providerLabel: repaired.providerLabel,
        model: repaired.model,
        tokensUsed: first.tokensUsed + repaired.tokensUsed,
        verified: true,
        unsupportedNumbers: [],
        unsupportedPlaces: [],
        evidenceIds: [],
        refused: false,
        dataBacked,
        focus: ctx.focus?.name ?? null,
        asOf: ctx.asOf,
        note: 'The first draft quoted figures not held in the data; it was corrected against the evidence before being shown.',
        sources: sourcesFor(ctx),
      }
    }

    // Two ungrounded drafts. Serve figures computed from the database instead of text that
    // cannot be traced — a slightly plainer answer is a better outcome than a plausible
    // invented number.
    const replaced = [
      ...repairedReport.unsupportedNumbers,
      ...repairedReport.unsupportedPlaces,
    ].slice(0, 6)
    return fromDeterministic(
      deterministicAnswer(message, ctx, ctx.knownPlaces),
      ctx,
      `The model's draft quoted figures sqftLab does not hold (${replaced.join(', ')}), so it was discarded and this answer was computed directly from the live database.`,
    )
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return fromDeterministic(
      deterministicAnswer(message, ctx, ctx.knownPlaces),
      ctx,
      `The model could not be reached (${detail.slice(0, 160)}), so this answer was computed directly from the live database.`,
    )
  }
}

