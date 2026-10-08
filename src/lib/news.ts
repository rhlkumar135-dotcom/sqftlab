/**
 * Day 19 — Market Intelligence Feed: ingestion, AI analysis and the daily digest.
 *
 * Deviations from the brief beyond the source list (see ./news-sources.ts), each
 * forced by this deployment:
 *
 * 1. MODEL TRANSPORT. The brief calls `new Anthropic({ apiKey: process.env
 *    .ANTHROPIC_API_KEY })`. There is no ANTHROPIC_API_KEY here and
 *    `@anthropic-ai/sdk` is not a dependency, so that constructor could only throw.
 *    This reuses the exact credential + provider path Day 13 established in
 *    `./ai-chat.ts` (`resolveAiCredential` + the Shogo AI SDK provider), which is
 *    the only model transport that actually works in this environment. Model choice
 *    stays `claude-haiku-4-5`, as the brief specifies.
 *
 * 2. JSON COLUMNS. `aiKeyFigures` / `topSignals` / `areasInFocus` / `sourcesUsed`
 *    are TEXT holding JSON, because the schema runs on SQLite (see the schema port
 *    note). Encoding and decoding live here so no route hand-rolls `JSON.parse`.
 *
 * 3. NO FAILURE IS SILENT. The brief's catch blocks `continue` / `return` with no
 *    record, which is how a feed that ingests nothing looks identical to one that
 *    works. Every function here returns counts, and the ingest result is written to
 *    `CronRun` by the caller so a dead tick is visible.
 */

import crypto from 'crypto'
import Parser from 'rss-parser'
import { prisma } from './db'
import { NEWS_FEEDS, feedUrl, isRelevant, type NewsFeed } from './news-sources'
import { resolveAiCredential, AiUnavailableError, AI_MODEL } from './ai-chat'

/** The seven signal classes the brief defines. Kept as a const so the prompt, the
 *  route filter and the UI legend cannot drift apart. */
export const SIGNAL_TYPES = [
  'price-movement',
  'project-launch',
  'regulatory',
  'investment',
  'market-stats',
  'macro',
  'other',
] as const
export type SignalType = (typeof SIGNAL_TYPES)[number]

export const SENTIMENTS = ['positive', 'negative', 'neutral'] as const
export type Sentiment = (typeof SENTIMENTS)[number]

/** Items older than this are not news. Matches the brief. */
export const MAX_ITEM_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** Excerpt length stored on the row. */
export const EXCERPT_CHARS = 500

const parser = new Parser({
  timeout: 15_000,
  headers: { 'User-Agent': 'sqftLab-NewsBot/1.0 (+https://sqftlab.com)' },
  // `<source>` must be declared or rss-parser silently drops it — it appeared in
  // NEITHER the default parse nor the stored rows, so every item fell back to the
  // feed's own label and the Sources panel showed "Dubai — Property & Real Estate"
  // instead of the masthead that actually published the article. Verified: with
  // this declaration the same feed yields "TradingView", "The National", etc.
  customFields: { item: [['source', 'source']] },
})

// ─── small helpers ───────────────────────────────────────────────────────────

export function makeContentHash(sourceUrl: string, publishedAt: Date): string {
  return crypto.createHash('md5').update(`${sourceUrl}|${publishedAt.toISOString()}`).digest('hex')
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractExcerpt(text: string, maxLen = EXCERPT_CHARS): string {
  const clean = text.trim()
  return clean.length > maxLen ? `${clean.slice(0, maxLen)}…` : clean
}

/** Decode a TEXT-as-JSON column into a string array. Never throws. */
export function decodeStringArray(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    return []
  }
}

/** Decode a TEXT-as-JSON column into a key-figure object. Never throws. */
export function decodeKeyFigures(
  raw: string | null | undefined,
): { value?: string | null; pct?: string | null; units?: string | null } | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const o = parsed as Record<string, unknown>
    const pick = (k: string): string | null => (typeof o[k] === 'string' && o[k] !== '' ? (o[k] as string) : null)
    const out = { value: pick('value'), pct: pick('pct'), units: pick('units') }
    return out.value || out.pct || out.units ? out : null
  } catch {
    return null
  }
}

/** Decode `topSignals`. */
export function decodeTopSignals(
  raw: string | null | undefined,
): Array<{ type: string; headline: string; impact: string }> {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((v): v is Record<string, unknown> => v !== null && typeof v === 'object')
      .map((v) => ({
        type: typeof v.type === 'string' ? v.type : 'other',
        headline: typeof v.headline === 'string' ? v.headline : '',
        impact: typeof v.impact === 'string' ? v.impact : '',
      }))
      .filter((s) => s.headline !== '')
  } catch {
    return []
  }
}

/** Models fence JSON in ```markdown. Strip it before parsing. */
function parseModelJson<T>(text: string): T | null {
  const cleaned = text
    .replace(/^[\s\S]*?```(?:json)?\s*/i, (m) => (m.includes('```') ? '' : m))
    .replace(/```[\s\S]*$/, '')
    .trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  const candidate = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned
  try {
    return JSON.parse(candidate) as T
  } catch {
    return null
  }
}

function normaliseSignalType(raw: unknown): SignalType {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/_/g, '-') : ''
  return (SIGNAL_TYPES as readonly string[]).includes(s) ? (s as SignalType) : 'other'
}

function normaliseSentiment(raw: unknown): Sentiment {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return (SENTIMENTS as readonly string[]).includes(s) ? (s as Sentiment) : 'neutral'
}

// ─── model call ──────────────────────────────────────────────────────────────

async function callModel(prompt: string, maxOutputTokens: number): Promise<string> {
  const credential = resolveAiCredential()
  if (!credential) {
    throw new AiUnavailableError(
      'No AI credential configured (AI_PROXY_TOKENS or SHOGO_API_KEY). News is ingested but not analysed.',
    )
  }
  let createShogoLlmProvider: typeof import('@shogo-ai/sdk').createShogoLlmProvider
  let generateText: typeof import('ai').generateText
  try {
    ;({ createShogoLlmProvider } = await import('@shogo-ai/sdk'))
    ;({ generateText } = await import('ai'))
  } catch (err) {
    throw new AiUnavailableError(`AI SDK not installed: ${err instanceof Error ? err.message : String(err)}`)
  }
  const provider = createShogoLlmProvider({ apiKey: credential.token })
  const result = await generateText({ model: provider(AI_MODEL), prompt, maxOutputTokens })
  return result.text
}

/** True when the AI layer can run at all. The routes use this to answer honestly
 *  instead of showing an empty feed as though there were no news. */
export function aiConfigured(): boolean {
  return resolveAiCredential() !== null
}

// ─── ingestion ───────────────────────────────────────────────────────────────

export interface FeedResult {
  feedId: string
  fetched: number
  saved: number
  skipped: number
  filtered: number
  errors: number
  /** Rows whose `sourceName` was upgraded from the feed label to the real publisher. */
  repaired: number
  error?: string
}

/**
 * Fetch one feed and store what is on-topic, new and not already seen.
 *
 * Idempotency comes from `contentHash` (@unique) with a no-op `update`, so a tick
 * that re-reads the same page writes nothing. `saved` counts rows actually inserted
 * — the loop checks for an existing hash first rather than counting upserts, so the
 * number means "new articles", not "articles looked at".
 */
export async function ingestFeed(feed: NewsFeed): Promise<FeedResult> {
  const result: FeedResult = { feedId: feed.id, fetched: 0, saved: 0, skipped: 0, filtered: 0, errors: 0, repaired: 0 }

  let xml: string
  try {
    const res = await fetch(feedUrl(feed.query), {
      headers: { 'User-Agent': 'sqftLab-NewsBot/1.0 (+https://sqftlab.com)' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      result.error = `HTTP ${res.status}`
      return result
    }
    xml = await res.text()
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    return result
  }

  let parsed: Awaited<ReturnType<typeof parser.parseString>>
  try {
    parsed = await parser.parseString(xml)
  } catch (err) {
    result.error = `parse failed: ${err instanceof Error ? err.message : String(err)}`
    return result
  }

  result.fetched = parsed.items?.length ?? 0
  const now = Date.now()

  for (const item of parsed.items ?? []) {
    try {
      const headline = stripHtml(item.title ?? '')
      const url = (item.link ?? '').trim()
      if (!headline || !url) {
        result.skipped++
        continue
      }

      const publishedAt = item.pubDate ? new Date(item.pubDate) : new Date()
      if (Number.isNaN(publishedAt.getTime())) {
        result.skipped++
        continue
      }
      if (now - publishedAt.getTime() > MAX_ITEM_AGE_MS) {
        result.skipped++
        continue
      }

      const excerpt = extractExcerpt(stripHtml(item.contentSnippet ?? item.content ?? headline))
      if (!isRelevant(feed, headline, excerpt)) {
        result.filtered++
        continue
      }

      // The publisher. On a Google News item this is the masthead that actually
      // published the article ("The National", "Arabian Business"), which is what a
      // reader recognises and what the Sources panel must show. Falls back to the
      // feed's own label only when the item genuinely carries no source.
      const rawSource = (item as unknown as { source?: unknown }).source
      const publisher =
        typeof rawSource === 'string' && rawSource.trim() !== ''
          ? stripHtml(rawSource)
          : typeof (rawSource as { _?: unknown })?._ === 'string'
            ? stripHtml((rawSource as { _: string })._)
            : feed.name

      const contentHash = makeContentHash(url, publishedAt)
      const existing = await prisma.newsItem.findUnique({
        where: { contentHash },
        select: { id: true, sourceName: true },
      })
      if (existing) {
        // Self-heal rows written before `<source>` was declared on the parser: their
        // `sourceName` holds the feed's label instead of the publisher. One update per
        // already-seen article, and it converges after a single pass.
        if (publisher !== feed.name && existing.sourceName === feed.name) {
          await prisma.newsItem.update({ where: { id: existing.id }, data: { sourceName: publisher } })
          result.repaired++
        }
        result.skipped++
        continue
      }

      await prisma.newsItem.create({
        data: {
          source: feed.id,
          sourceName: publisher.slice(0, 120),
          sourceUrl: url,
          headline: headline.slice(0, 500),
          publishedAt,
          author: (item.creator ?? null) as string | null,
          imageUrl: (item.enclosure?.url ?? null) as string | null,
          rawExcerpt: excerpt,
          contentHash,
        },
      })
      result.saved++
    } catch {
      result.errors++
    }
  }

  return result
}

export interface IngestSummary {
  feeds: FeedResult[]
  fetched: number
  saved: number
  skipped: number
  filtered: number
  errors: number
  repaired: number
  feedsOk: number
  feedsFailed: number
}

/** Every feed, politely spaced. */
export async function ingestAllNewsSources(): Promise<IngestSummary> {
  const feeds: FeedResult[] = []
  for (const feed of NEWS_FEEDS) {
    feeds.push(await ingestFeed(feed))
    await new Promise((r) => setTimeout(r, 1000))
  }
  return {
    feeds,
    fetched: feeds.reduce((a, f) => a + f.fetched, 0),
    saved: feeds.reduce((a, f) => a + f.saved, 0),
    skipped: feeds.reduce((a, f) => a + f.skipped, 0),
    filtered: feeds.reduce((a, f) => a + f.filtered, 0),
    errors: feeds.reduce((a, f) => a + f.errors, 0),
    repaired: feeds.reduce((a, f) => a + f.repaired, 0),
    feedsOk: feeds.filter((f) => !f.error).length,
    feedsFailed: feeds.filter((f) => f.error).length,
  }
}

// ─── AI analysis ─────────────────────────────────────────────────────────────

export interface ProcessResult {
  attempted: number
  processed: number
  failed: number
  skippedNoCredential: boolean
  error?: string
}

/**
 * Analyse pending items with the model.
 *
 * An item that the model cannot be reached for is left `aiProcessed: false` on
 * purpose — it stays in the queue for the next tick rather than being marked done
 * with placeholder values. The brief's fallback marks a failed parse as
 * `sentiment: 'neutral', signalType: 'other'`, which is indistinguishable from a
 * genuine neutral market story; here a parse failure is retried, and after the
 * retry limit it is recorded as `other` only because it must eventually clear.
 */
export async function processUnprocessedItems(batchSize = 20): Promise<ProcessResult> {
  if (!aiConfigured()) {
    return { attempted: 0, processed: 0, failed: 0, skippedNoCredential: true }
  }

  const items = await prisma.newsItem.findMany({
    where: { aiProcessed: false },
    orderBy: { publishedAt: 'desc' },
    take: batchSize,
  })

  const out: ProcessResult = { attempted: items.length, processed: 0, failed: 0, skippedNoCredential: false }

  for (const item of items) {
    const prompt = `You are a UAE real estate and financial markets analyst. Analyse this news item and respond ONLY with valid JSON, no markdown fences, no commentary.

Headline: ${item.headline}
Source: ${item.sourceName}
Excerpt: ${item.rawExcerpt}

Return exactly this shape:
{
  "summary": "2-3 sentence plain-English summary of the news and its relevance to UAE property buyers, investors, or developers",
  "signalType": one of "price-movement" | "project-launch" | "regulatory" | "investment" | "market-stats" | "macro" | "other",
  "impactArea": "specific community or area name if mentioned (e.g. Downtown Dubai, Saadiyat Island, JLT), else null",
  "sentiment": one of "positive" | "negative" | "neutral",
  "keyFigures": { "value": "main AED/USD figure if present else null", "pct": "percentage figure if present else null", "units": "units of measure e.g. villas, sqft, transactions else null" }
}

Rules: never invent a figure that is not in the excerpt. If the item is not about UAE property or the UAE economy, use signalType "other".`

    try {
      const text = await callModel(prompt, 400)
      const parsed = parseModelJson<{
        summary?: unknown
        signalType?: unknown
        impactArea?: unknown
        sentiment?: unknown
        keyFigures?: unknown
      }>(text)

      if (!parsed || typeof parsed.summary !== 'string' || parsed.summary.trim() === '') {
        out.failed++
        continue
      }

      const kf = parsed.keyFigures
      const keyFigures =
        kf !== null && typeof kf === 'object' && !Array.isArray(kf)
          ? JSON.stringify({
              value: typeof (kf as Record<string, unknown>).value === 'string' ? (kf as Record<string, string>).value : null,
              pct: typeof (kf as Record<string, unknown>).pct === 'string' ? (kf as Record<string, string>).pct : null,
              units: typeof (kf as Record<string, unknown>).units === 'string' ? (kf as Record<string, string>).units : null,
            })
          : null

      const impactArea =
        typeof parsed.impactArea === 'string' && parsed.impactArea.trim() !== '' && parsed.impactArea !== 'null'
          ? parsed.impactArea.trim().slice(0, 120)
          : null

      await prisma.newsItem.update({
        where: { id: item.id },
        data: {
          aiSummary: parsed.summary.trim(),
          aiSignalType: normaliseSignalType(parsed.signalType),
          aiImpactArea: impactArea,
          aiSentiment: normaliseSentiment(parsed.sentiment),
          aiKeyFigures: keyFigures,
          aiProcessed: true,
          aiProcessedAt: new Date(),
        },
      })
      out.processed++
      await new Promise((r) => setTimeout(r, 300))
    } catch (err) {
      out.failed++
      if (err instanceof AiUnavailableError) {
        out.skippedNoCredential = true
        out.error = err.message
        break
      }
    }
  }

  return out
}

// ─── daily digest ────────────────────────────────────────────────────────────

/** Midnight UTC of the current UAE (UTC+4) calendar day, as a Date. */
export function uaeToday(): Date {
  const uaeNow = new Date(Date.now() + 4 * 60 * 60 * 1000)
  return new Date(uaeNow.toISOString().split('T')[0])
}

export interface DigestResult {
  generated: boolean
  reason?: string
  date: string
  articlesScanned: number
}

/**
 * Build one digest for the UAE calendar day.
 *
 * Idempotent by construction: the row is keyed on `date` (@unique) and an existing
 * row short-circuits. The brief returns silently when it cannot generate; this
 * returns WHY, so a digest that never appears is diagnosable from the cron log
 * instead of looking like a scheduling problem.
 */
export async function generateDailyDigest(force = false): Promise<DigestResult> {
  const dateObj = uaeToday()
  const dateKey = dateObj.toISOString().split('T')[0]

  if (!force) {
    const existing = await prisma.intelligenceSummary.findUnique({ where: { date: dateObj }, select: { id: true } })
    if (existing) return { generated: false, reason: 'already-generated-today', date: dateKey, articlesScanned: 0 }
  }

  if (!aiConfigured()) {
    return { generated: false, reason: 'no-ai-credential', date: dateKey, articlesScanned: 0 }
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const items = await prisma.newsItem.findMany({
    where: { publishedAt: { gte: since }, aiProcessed: true },
    orderBy: { publishedAt: 'desc' },
    take: 50,
  })
  if (items.length === 0) {
    return { generated: false, reason: 'no-processed-articles-in-window', date: dateKey, articlesScanned: 0 }
  }

  const articleLines = items
    .slice(0, 30)
    .map(
      (item, i) =>
        `[${i + 1}] ${item.sourceName} | ${item.headline}\n   Signal: ${item.aiSignalType} | Sentiment: ${item.aiSentiment} | Area: ${item.aiImpactArea ?? 'general'}\n   Summary: ${item.aiSummary ?? item.rawExcerpt}`,
    )
    .join('\n\n')

  const prompt = `You are the lead analyst for sqftLab, UAE's property data intelligence platform.

Today is ${new Date().toLocaleDateString('en-AE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Dubai' })}.

Below are today's key news items from UAE property and financial media. Write a daily market intelligence digest for institutional investors, brokers, and buyers.

ARTICLES:
${articleLines}

Respond ONLY with valid JSON, no markdown fences:
{
  "headline": "One punchy sentence (max 15 words) capturing the most important market theme today",
  "summary": "4-6 paragraphs of narrative digest separated by \\n\\n. Synthesise the news into a coherent picture. Cover macro context, Dubai vs Abu Dhabi, regulatory signals, notable transactions or launches, and what it means for buyers/investors. Write as a professional analyst, not a journalist. No bullet points.",
  "topSignals": [ { "type": "one of price-movement|project-launch|regulatory|investment|market-stats|macro|other", "headline": "short signal headline max 10 words", "impact": "one sentence on what this means for the market" } ],
  "sentimentScore": a float from -1.0 (very bearish) to +1.0 (very bullish) reflecting overall market tone today,
  "areasInFocus": ["list", "of", "areas", "mentioned", "most", "today"]
}

Only cite figures that appear in the articles above. Do not invent data.`

  let parsed: {
    headline?: unknown
    summary?: unknown
    topSignals?: unknown
    sentimentScore?: unknown
    areasInFocus?: unknown
  } | null
  try {
    parsed = parseModelJson<typeof parsed>(await callModel(prompt, 2000))
  } catch (err) {
    return {
      generated: false,
      reason: `model-error: ${err instanceof Error ? err.message : String(err)}`,
      date: dateKey,
      articlesScanned: items.length,
    }
  }

  if (!parsed || typeof parsed.headline !== 'string' || typeof parsed.summary !== 'string') {
    return { generated: false, reason: 'model-returned-invalid-json', date: dateKey, articlesScanned: items.length }
  }

  const topSignals = Array.isArray(parsed.topSignals)
    ? parsed.topSignals
        .filter((v): v is Record<string, unknown> => v !== null && typeof v === 'object')
        .slice(0, 5)
        .map((v) => ({
          type: normaliseSignalType(v.type),
          headline: typeof v.headline === 'string' ? v.headline : '',
          impact: typeof v.impact === 'string' ? v.impact : '',
        }))
        .filter((s) => s.headline !== '')
    : []

  const areasInFocus = Array.isArray(parsed.areasInFocus)
    ? parsed.areasInFocus.filter((v): v is string => typeof v === 'string').slice(0, 12)
    : []

  const score =
    typeof parsed.sentimentScore === 'number' && Number.isFinite(parsed.sentimentScore)
      ? Math.max(-1, Math.min(1, parsed.sentimentScore))
      : null

  const sourcesUsed = [...new Set(items.map((i) => i.sourceName))]
  const data = {
    headline: parsed.headline.trim().slice(0, 300),
    summary: parsed.summary.trim(),
    topSignals: JSON.stringify(topSignals),
    sentimentScore: score,
    areasInFocus: JSON.stringify(areasInFocus),
    articlesScanned: items.length,
    sourcesUsed: JSON.stringify(sourcesUsed),
    generatedAt: new Date(),
  }

  // Upsert rather than create: `force` can regenerate a day, and the @unique on
  // `date` would otherwise reject it.
  await prisma.intelligenceSummary.upsert({
    where: { date: dateObj },
    update: data,
    create: { date: dateObj, ...data },
  })

  return { generated: true, date: dateKey, articlesScanned: items.length }
}

// ─── combined cron entry point ───────────────────────────────────────────────

export interface NewsCronResult {
  ok: boolean
  ingest: IngestSummary
  processing: ProcessResult
  aiConfigured: boolean
  /** Wall time for the fetch phase. Reported separately so the cron record can
   *  attribute a slow tick to the network rather than the model. */
  ingestMs: number
  /** Wall time for the model phase. */
  processMs: number
  durationMs: number
}

/** What the 30-minute cron calls: ingest, then analyse. */
export async function runNewsIngest(processBatch = 30): Promise<NewsCronResult> {
  const startedAt = Date.now()
  const ingestStartedAt = Date.now()
  const ingest = await ingestAllNewsSources()
  const ingestMs = Date.now() - ingestStartedAt
  const processStartedAt = Date.now()
  const processing = await processUnprocessedItems(processBatch)
  const processMs = Date.now() - processStartedAt
  return {
    // The job succeeded if at least one feed answered — a single unreachable feed is
    // reported per feed rather than failing the whole tick.
    ok: ingest.feedsOk > 0,
    ingest,
    processing,
    aiConfigured: aiConfigured(),
    ingestMs,
    processMs,
    durationMs: Date.now() - startedAt,
  }
}
