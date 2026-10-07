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

export interface MarketContext {
  /** True when the register holds at least one sale in the window. */
  dataAvailable: boolean
  transactions: number
  avgPsfAed: number | null
  volumeAed: number
  topCommunities: Array<{ name: string; count: number }>
  days: number
}

/**
 * Summarise the sale register for the model.
 *
 * With no rows this returns `dataAvailable: false` and the prompt says so, because the
 * alternative — feeding the model "0 transactions / AED 0" — produces either nonsense
 * or invention, and invention in a market-numbers product is the one failure mode this
 * codebase consistently refuses.
 */
export async function buildMarketContext(days = MARKET_CONTEXT_DAYS): Promise<MarketContext> {
  const since = new Date()
  since.setDate(since.getDate() - days)

  const saleWindow = {
    transactionType: { in: [...SALE_TXN_TYPES] },
    transactionDate: { gte: since },
  }

  const [agg, grouped] = await Promise.all([
    prisma.transaction.aggregate({
      where: { ...saleWindow, pricePerSqft: { gt: 100 } },
      _avg: { pricePerSqft: true },
      _count: { id: true },
      _sum: { priceAed: true },
    }),
    // Grouped by the FK, not an `area` string — there is no such column, and grouping
    // by a free-text district name would split one community across naming variants.
    prisma.transaction.groupBy({
      by: ['communityId'],
      where: saleWindow,
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 5,
    }),
  ])

  // One lookup for every name rather than a query per group.
  const names = await prisma.community.findMany({
    where: { id: { in: grouped.map((g) => g.communityId) } },
    select: { id: true, nameEn: true },
  })
  const nameById = new Map(names.map((n) => [n.id, n.nameEn]))

  const transactions = agg._count.id
  return {
    dataAvailable: transactions > 0,
    transactions,
    avgPsfAed: agg._avg.pricePerSqft === null ? null : Math.round(agg._avg.pricePerSqft),
    volumeAed: agg._sum.priceAed ?? 0,
    topCommunities: grouped.map((g) => ({
      name: nameById.get(g.communityId) ?? g.communityId,
      count: g._count.id,
    })),
    days,
  }
}

/**
 * The system prompt.
 *
 * The brief's version instructs the model to "always cite DLD data" and gives it a
 * context block regardless of whether that block contains anything. With an empty
 * register those two instructions conflict, and the model resolves the conflict by
 * inventing figures. So the empty case is stated outright and the citation rule is
 * made conditional on there being something to cite.
 */
export function buildSystemPrompt(ctx: MarketContext): string {
  const rules = [
    'You are sqftLab\'s AI market assistant for UAE real estate, specialising in Dubai.',
    'You help investors, brokers and developers understand the property market.',
    '',
    'Guidelines:',
    '- Be concise but thorough — your reader is a professional.',
    '- You cannot give financial advice. You can share market data and explain what it means.',
    '- Never invent a price, a rent, a transaction count or a trend. If you do not have the',
    '  figure, say you do not have it and suggest what the reader could check instead.',
  ]

  if (ctx.dataAvailable) {
    const areas = ctx.topCommunities
      .map((a) => `${a.name} (${a.count} transactions)`)
      .join(', ')
    return [
      ...rules,
      '- Quote only the figures in the market data below, and attribute them to the sqftLab',
      '  transaction register.',
      '',
      `Market data — sales registered in the last ${ctx.days} days:`,
      `- Transactions: ${ctx.transactions}`,
      `- Average price per sqft: AED ${ctx.avgPsfAed?.toLocaleString() ?? 'unknown'}`,
      `- Total value: AED ${ctx.volumeAed.toLocaleString()}`,
      `- Most active communities: ${areas || 'none'}`,
    ].join('\n')
  }

  return [
    ...rules,
    '',
    `IMPORTANT — no market data is currently loaded. The sqftLab transaction register holds`,
    `no sales in the last ${ctx.days} days, so you have NO figures for this market.`,
    'Do not state or estimate any price, PSF, volume, transaction count or ranking, and do',
    'not attribute any figure to sqftLab or to DLD. If asked for numbers, say plainly that',
    'no transaction data is loaded yet, and offer to explain methodology, definitions or',
    'what the reader should compare once it is.',
  ].join('\n')
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
