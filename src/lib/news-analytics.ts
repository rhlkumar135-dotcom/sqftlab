import { prisma } from './db'
import { decodeKeyFigures } from './news'
import type { Emirate } from './news-sources'

/**
 * Collection and semantic analytics over the news corpus.
 *
 * Two levels, because "analytics" over a feed means nothing on its own:
 *
 *  1. COLLECTIONS — the corpus grouped into the themes a reader actually navigates by
 *     (off-plan launches, rents, regulation, capital flows…). Assignment is a keyword
 *     rule set, not a model call, for three reasons: it runs with no AI credential, it is
 *     auditable (you can read the rule that put a story in a collection), and it is stable
 *     — a story does not silently migrate between collections when a prompt is re-tuned.
 *     A story may belong to more than one collection, which is correct: a new rental
 *     regulation is genuinely both.
 *
 *  2. SEMANTIC ANALYTICS — what the corpus means in aggregate: sentiment mix, signal
 *     types, the communities and developers named, the publishers carrying the coverage,
 *     how volume and tone moved week by week, and what the last 7 days did against the
 *     preceding 23. That last comparison is the part that answers "what changed?", which
 *     a static breakdown cannot.
 *
 * Everything is computed from `ai*` columns already on the row, so this adds no model
 * calls. Items that have not been analysed are counted separately and reported as
 * `unanalysed` rather than being folded into 'neutral' — an unread article is not a
 * neutral one, and hiding that would quietly bias every sentiment figure here.
 */

export interface NewsCollection {
  id: string
  label: string
  description: string
  count: number
  /** Share of the analysed corpus in this collection, as a percentage. */
  share: number
  sentiment: { positive: number; neutral: number; negative: number }
  topAreas: string[]
  samples: Array<{ id: string; headline: string; sourceName: string; publishedAt: string; sourceUrl: string }>
}

interface CollectionRule {
  id: string
  label: string
  description: string
  keywords: string[]
}

/**
 * The theme taxonomy. Keywords are matched against headline + excerpt + AI summary, so a
 * story that never says "off-plan" in its headline but is described that way by the
 * summary still lands correctly.
 */
const COLLECTION_RULES: CollectionRule[] = [
  {
    id: 'off-plan',
    label: 'Off-plan & Launches',
    description: 'New project launches, launches, sales, and off-plan supply.',
    keywords: ['off-plan', 'offplan', 'launch', 'launches', 'launched', 'new project', 'phase', 'presale', 'pre-sale', 'units released', 'sold out'],
  },
  {
    id: 'rents',
    label: 'Rents & Tenancy',
    description: 'Rental market, tenancy rules, and landlord/tenant issues.',
    keywords: ['rent', 'rents', 'rental', 'rentals', 'tenant', 'tenancy', 'landlord', 'leasing', 'eviction', 'rjv', 'rent increase', 'yield'],
  },
  {
    id: 'regulation',
    label: 'Regulation & Policy',
    description: 'Laws, regulators, escrow, licensing, and policy changes.',
    keywords: ['regulation', 'regulatory', 'law', 'laws', 'rule', 'rules', 'rera', 'dld', 'policy', 'licence', 'license', 'licensing', 'escrow', 'compliance', 'decree', 'reform', 'ban', 'fine', 'adrec'],
  },
  {
    id: 'prices',
    label: 'Prices & Market Stats',
    description: 'Price movement, indices, transaction volumes, and market data.',
    keywords: ['price', 'prices', 'pricing', 'index', 'psf', 'per square foot', 'sqft', 'transactions', 'sales volume', 'market report', 'growth', 'decline', 'drop', 'rise', 'surge'],
  },
  {
    id: 'investment',
    label: 'Investment & Capital Flows',
    description: 'Institutional money, funds, acquisitions, and foreign demand.',
    keywords: ['investment', 'investor', 'investors', 'fund', 'capital', 'acquisition', 'acquires', 'portfolio', 'billion', 'million', 'reit', 'foreign', 'golden visa', 'institutional', 'stake'],
  },
  {
    id: 'development',
    label: 'Development & Construction',
    description: 'Masterplans, construction progress, contractors, and handovers.',
    keywords: ['development', 'developer', 'masterplan', 'master plan', 'construction', 'contractor', 'handover', 'handovers', 'delivery', 'tower', 'towers', 'infrastructure', 'completion', 'built'],
  },
  {
    id: 'mortgage',
    label: 'Mortgage & Finance',
    description: 'Home finance, interest rates, and lending conditions.',
    keywords: ['mortgage', 'mortgages', 'interest rate', 'interest rates', 'loan', 'lending', 'finance', 'refinance', 'down payment', 'bank'],
  },
  {
    id: 'economy',
    label: 'Economy & Macro',
    description: 'GDP, inflation, population, and the wider UAE economy.',
    keywords: ['economy', 'economic', 'gdp', 'inflation', 'population', 'macro', 'central bank', 'dirham', 'growth forecast', 'oil', 'non-oil'],
  },
]

export interface NewsAnalytics {
  emirate: Emirate | 'all'
  windowDays: number
  generatedAt: string
  coverage: {
    total: number
    analysed: number
    unanalysed: number
    oldest: string | null
    newest: string | null
    daysCovered: number
    publishers: number
  }
  sentiment: { positive: number; neutral: number; negative: number; positiveShare: number; negativeShare: number }
  signals: Array<{ signal: string; count: number; share: number }>
  collections: NewsCollection[]
  topAreas: Array<{ area: string; count: number; sentiment: { positive: number; neutral: number; negative: number } }>
  publishers: Array<{ name: string; count: number }>
  weekly: Array<{ weekStart: string; total: number; positive: number; neutral: number; negative: number }>
  momentum: {
    recentDays: number
    recentVolume: number
    priorVolume: number
    volumeChangePct: number | null
    recentPositiveShare: number | null
    priorPositiveShare: number | null
    sentimentShiftPct: number | null
  }
  figures: Array<{ value: string | null; pct: string | null; units: string | null; headline: string; sourceName: string; sourceUrl: string; publishedAt: string }>
}

interface Row {
  id: string
  headline: string
  rawExcerpt: string
  sourceName: string
  sourceUrl: string
  publishedAt: Date
  emirate: string
  aiSummary: string | null
  aiSignalType: string | null
  aiImpactArea: string | null
  aiSentiment: string | null
  aiKeyFigures: string | null
  aiProcessed: boolean
}

const pct = (n: number, of: number): number => (of === 0 ? 0 : Math.round((n / of) * 1000) / 10)

/** Monday-based week start (UAE weeks run Sun–Thu, but Monday gives stable 7-day buckets). */
function weekStart(d: Date): string {
  const x = new Date(d)
  const day = (x.getUTCDay() + 6) % 7
  x.setUTCDate(x.getUTCDate() - day)
  return x.toISOString().slice(0, 10)
}

function sentimentBucket(rows: Row[]) {
  let positive = 0
  let neutral = 0
  let negative = 0
  for (const r of rows) {
    if (r.aiSentiment === 'positive') positive++
    else if (r.aiSentiment === 'negative') negative++
    else if (r.aiSentiment === 'neutral') neutral++
  }
  return { positive, neutral, negative }
}

export async function buildNewsAnalytics(opts: {
  emirate?: Emirate | 'all'
  days?: number
  sampleSize?: number
} = {}): Promise<NewsAnalytics> {
  const days = Math.min(Math.max(opts.days ?? 30, 1), 120)
  const emirate = opts.emirate ?? 'all'
  const sampleSize = opts.sampleSize ?? 4
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const rows = (await prisma.newsItem.findMany({
    where: {
      publishedAt: { gte: since },
      ...(emirate !== 'all' ? { emirate } : {}),
    },
    orderBy: { publishedAt: 'desc' },
    select: {
      id: true, headline: true, rawExcerpt: true, sourceName: true, sourceUrl: true,
      publishedAt: true, emirate: true, aiSummary: true, aiSignalType: true,
      aiImpactArea: true, aiSentiment: true, aiKeyFigures: true, aiProcessed: true,
    },
  })) as Row[]

  const analysedRows = rows.filter((r) => r.aiProcessed)
  const analysed = analysedRows.length
  const unanalysed = rows.length - analysed

  const sent = sentimentBucket(analysedRows)

  // ── collections ─────────────────────────────────────────────────────────────
  const collections: NewsCollection[] = COLLECTION_RULES.map((rule) => {
    const members = analysedRows.filter((r) => {
      const hay = `${r.headline} ${r.rawExcerpt} ${r.aiSummary ?? ''}`.toLowerCase()
      return rule.keywords.some((k) => hay.includes(k))
    })
    const areas = new Map<string, number>()
    for (const m of members) {
      if (m.aiImpactArea) areas.set(m.aiImpactArea, (areas.get(m.aiImpactArea) ?? 0) + 1)
    }
    return {
      id: rule.id,
      label: rule.label,
      description: rule.description,
      count: members.length,
      share: pct(members.length, analysed),
      sentiment: sentimentBucket(members),
      topAreas: [...areas.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([a]) => a),
      samples: members.slice(0, sampleSize).map((m) => ({
        id: m.id,
        headline: m.headline,
        sourceName: m.sourceName,
        publishedAt: m.publishedAt.toISOString(),
        sourceUrl: m.sourceUrl,
      })),
    }
  })
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count)

  // ── signals ─────────────────────────────────────────────────────────────────
  const signalMap = new Map<string, number>()
  for (const r of analysedRows) {
    const s = r.aiSignalType ?? 'other'
    signalMap.set(s, (signalMap.get(s) ?? 0) + 1)
  }
  const signals = [...signalMap.entries()]
    .map(([signal, count]) => ({ signal, count, share: pct(count, analysed) }))
    .sort((a, b) => b.count - a.count)

  // ── areas ───────────────────────────────────────────────────────────────────
  const areaMap = new Map<string, Row[]>()
  for (const r of analysedRows) {
    if (!r.aiImpactArea) continue
    const list = areaMap.get(r.aiImpactArea) ?? []
    list.push(r)
    areaMap.set(r.aiImpactArea, list)
  }
  const topAreas = [...areaMap.entries()]
    .map(([area, list]) => ({ area, count: list.length, sentiment: sentimentBucket(list) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12)

  // ── publishers ──────────────────────────────────────────────────────────────
  const pubMap = new Map<string, number>()
  for (const r of rows) pubMap.set(r.sourceName, (pubMap.get(r.sourceName) ?? 0) + 1)
  const publishers = [...pubMap.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12)

  // ── weekly trend ────────────────────────────────────────────────────────────
  const weekMap = new Map<string, Row[]>()
  for (const r of analysedRows) {
    const w = weekStart(r.publishedAt)
    const list = weekMap.get(w) ?? []
    list.push(r)
    weekMap.set(w, list)
  }
  const weekly = [...weekMap.entries()]
    .map(([w, list]) => ({ weekStart: w, total: list.length, ...sentimentBucket(list) }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart))

  // ── momentum: last 7 days vs the preceding stretch ──────────────────────────
  const recentCut = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const recent = analysedRows.filter((r) => r.publishedAt >= recentCut)
  const prior = analysedRows.filter((r) => r.publishedAt < recentCut)
  const recentSent = sentimentBucket(recent)
  const priorSent = sentimentBucket(prior)
  const recentTotal = recent.length
  const priorTotal = prior.length
  const recentPosShare = recentTotal > 0 ? pct(recentSent.positive, recentTotal) : null
  const priorPosShare = priorTotal > 0 ? pct(priorSent.positive, priorTotal) : null

  // Null rather than 0 when there is no baseline: "no prior coverage to compare against"
  // is a different statement from "flat", and a 0 would read as the latter.
  const volumeChangePct =
    priorTotal > 0 ? Math.round(((recentTotal - priorTotal) / priorTotal) * 1000) / 10 : null
  const sentimentShiftPct =
    recentPosShare !== null && priorPosShare !== null
      ? Math.round((recentPosShare - priorPosShare) * 10) / 10
      : null

  // ── extracted figures ───────────────────────────────────────────────────────
  const figures = analysedRows
    .map((r) => {
      const kf = decodeKeyFigures(r.aiKeyFigures)
      if (!kf || (!kf.value && !kf.pct && !kf.units)) return null
      return {
        value: kf.value ?? null,
        pct: kf.pct ?? null,
        units: kf.units ?? null,
        headline: r.headline,
        sourceName: r.sourceName,
        sourceUrl: r.sourceUrl,
        publishedAt: r.publishedAt.toISOString(),
      }
    })
    .filter((f): f is NonNullable<typeof f> => f !== null)
    .slice(0, 20)

  const times = rows.map((r) => r.publishedAt.getTime())
  const oldest = times.length > 0 ? new Date(Math.min(...times)).toISOString() : null
  const newest = times.length > 0 ? new Date(Math.max(...times)).toISOString() : null

  return {
    emirate,
    windowDays: days,
    generatedAt: new Date().toISOString(),
    coverage: {
      total: rows.length,
      analysed,
      unanalysed,
      oldest,
      newest,
      daysCovered:
        times.length > 0
          ? Math.max(1, Math.round((Math.max(...times) - Math.min(...times)) / 86400000))
          : 0,
      publishers: pubMap.size,
    },
    sentiment: {
      ...sent,
      positiveShare: pct(sent.positive, analysed),
      negativeShare: pct(sent.negative, analysed),
    },
    signals,
    collections,
    topAreas,
    publishers,
    weekly,
    momentum: {
      recentDays: 7,
      recentVolume: recentTotal,
      priorVolume: priorTotal,
      volumeChangePct,
      recentPositiveShare: recentPosShare,
      priorPositiveShare: priorPosShare,
      sentimentShiftPct,
    },
    figures,
  }
}
