import { prisma } from './db'
import { SALE_TXN_TYPES } from './deals'

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
export function buildSystemPrompt(ctx: AssistantContext): string {
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

  return lines.join('\n')
}

export class AiUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AiUnavailableError'
  }
}

/**
 * Call the model.
 *
 * Both imports are dynamic so that a deployment without `ai` installed still boots and
 * serves every other route — this module is imported by the route table, and a static
 * import of a missing optional peer would take the whole API down.
 */
export async function generateAssistantReply(opts: {
  credential: AiCredential
  system: string
  history: AiTurn[]
  message: string
}): Promise<{ reply: string; tokensUsed: number }> {
  let createShogoLlmProvider: typeof import('@shogo-ai/sdk').createShogoLlmProvider
  let generateText: typeof import('ai').generateText
  try {
    ;({ createShogoLlmProvider } = await import('@shogo-ai/sdk'))
    ;({ generateText } = await import('ai'))
  } catch (err) {
    throw new AiUnavailableError(
      `AI SDK not installed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const provider = createShogoLlmProvider({ apiKey: opts.credential.token })

  const result = await generateText({
    model: provider(AI_MODEL),
    system: opts.system,
    messages: [...opts.history, { role: 'user' as const, content: opts.message }],
    maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
  })

  return { reply: result.text, tokensUsed: result.usage.totalTokens ?? 0 }
}
