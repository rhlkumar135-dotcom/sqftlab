/**
 * Grounding: the evidence the assistant is allowed to treat as fact, the check that its
 * answer actually came from that evidence, and a model-free engine for when there is no
 * model at all.
 *
 * WHY THIS IS A SEPARATE LAYER. A system prompt that says "never invent a figure" is a
 * request, not a guarantee. Three failures survive it:
 *
 *  1. The model quotes a number that is not in the context, and nothing checks.
 *  2. The question names a district the deployment has no coverage for, so the context is
 *     empty for that district — and the model fills the gap from its training data, which
 *     is the most convincing hallucination of all because the surrounding prose is right.
 *  3. No credential is configured, so the assistant is unavailable exactly when the
 *     operator stripped the paid model — the moment they most want it to still work.
 *
 * The three defences here line up with those three failures, in order: `validateAnswer`
 * checks the finished text against the evidence, `deterministicAnswer` answers the
 * no-coverage case without ever calling a model, and the same engine is the floor when
 * there is no provider configured.
 *
 * THE VALIDATOR'S CONTRACT. Every figure in an answer must correspond to a value in the
 * evidence. Derived arithmetic is therefore out of contract, and the system prompt says
 * so — a model told to quote exactly, and then checked on it, is a different proposition
 * from one asked politely not to make things up.
 */

import type { AssistantContext, DistrictStat } from './ai-chat'

export interface EvidenceItem {
  id: string
  label: string
  kind: 'count' | 'price' | 'psf' | 'rent' | 'percent' | 'score' | 'date'
  /** Numeric where the item carries a quantity; text for dates and labels. */
  value: number | string
  /** The unit the value is stated in, so the model labels it correctly. */
  unit: string
}

/**
 * Build the evidence list.
 *
 * IDs exist so a source list can be shown to the reader without the model's involvement —
 * what backs an answer is a server-side fact, not something the model reports about
 * itself.
 */
export function buildEvidence(ctx: AssistantContext): EvidenceItem[] {
  const items: EvidenceItem[] = []

  if (ctx.asOf) {
    items.push({ id: 'as_of', label: 'Listing data collected', value: ctx.asOf.slice(0, 10), kind: 'date', unit: '' })
  }
  if (ctx.listingsAvailable) {
    items.push(
      { id: 'listings.total', label: 'Active listings', value: ctx.listingCount, kind: 'count', unit: 'listings' },
      { id: 'listings.sale', label: 'Listings for sale', value: ctx.saleCount, kind: 'count', unit: 'listings' },
      { id: 'listings.rent', label: 'Listings for rent', value: ctx.rentCount, kind: 'count', unit: 'listings' },
      { id: 'listings.districts', label: 'Districts covered', value: ctx.districtsCovered, kind: 'count', unit: 'districts' },
    )
    if (ctx.overallSalePsfAed !== null) {
      items.push({ id: 'market.sale_psf', label: 'Average asking price, sale listings', value: ctx.overallSalePsfAed, kind: 'psf', unit: 'AED per sqft' })
    }
    if (ctx.overallRentAnnualAed !== null) {
      items.push({ id: 'market.rent_annual', label: 'Average asking annual rent', value: ctx.overallRentAnnualAed, kind: 'rent', unit: 'AED per year' })
    }
    for (const d of ctx.topDistricts) {
      items.push(...districtEvidence(d, `district.${slugify(d.name)}`))
    }
  }

  if (ctx.focus) {
    items.push(...districtEvidence(ctx.focus, 'focus'))
  }

  items.push({
    id: 'register.available',
    label: 'Registered government sales available',
    value: ctx.register.available ? 'yes' : 'no',
    kind: 'count',
    unit: '',
  })
  if (ctx.register.available) {
    items.push(
      { id: 'register.window', label: 'Register window', value: ctx.register.days, kind: 'count', unit: 'days' },
      { id: 'register.transactions', label: 'Registered sales in window', value: ctx.register.transactions, kind: 'count', unit: 'transactions' },
    )
    if (ctx.register.avgPsfAed !== null) {
      items.push({ id: 'register.avg_psf', label: 'Registered average price', value: ctx.register.avgPsfAed, kind: 'psf', unit: 'AED per sqft' })
    }
  }

  return items
}

function districtEvidence(d: DistrictStat, prefix: string): EvidenceItem[] {
  const out: EvidenceItem[] = [
    { id: `${prefix}.sale_count`, label: `${d.name} (${d.emirate}) — listings for sale`, value: d.saleListings, kind: 'count', unit: 'listings' },
    { id: `${prefix}.rent_count`, label: `${d.name} (${d.emirate}) — listings for rent`, value: d.rentListings, kind: 'count', unit: 'listings' },
  ]
  if (d.salePsfAed !== null) out.push({ id: `${prefix}.psf`, label: `${d.name} — asking price per sqft`, value: d.salePsfAed, kind: 'psf', unit: 'AED per sqft' })
  if (d.priceFromAed !== null) out.push({ id: `${prefix}.price_from`, label: `${d.name} — asking price from`, value: d.priceFromAed, kind: 'price', unit: 'AED' })
  if (d.priceToAed !== null) out.push({ id: `${prefix}.price_to`, label: `${d.name} — asking price to`, value: d.priceToAed, kind: 'price', unit: 'AED' })
  if (d.rentAnnualAed !== null) out.push({ id: `${prefix}.rent`, label: `${d.name} — asking annual rent`, value: d.rentAnnualAed, kind: 'rent', unit: 'AED per year' })
  if (d.grossYieldPct !== null) out.push({ id: `${prefix}.yield`, label: `${d.name} — gross yield`, value: d.grossYieldPct, kind: 'percent', unit: '%' })
  if (d.neighbourhoodScore !== null) out.push({ id: `${prefix}.score`, label: `${d.name} — neighbourhood score`, value: d.neighbourhoodScore, kind: 'score', unit: '/100' })
  return out
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

/** The evidence block handed to the model. IDs are carried through so they can be cited. */
export function renderEvidenceBlock(items: EvidenceItem[]): string {
  return items
    .map((i) => `[${i.id}] ${i.label}: ${formatValue(i)}`)
    .join('\n')
}

function formatValue(item: EvidenceItem): string {
  if (typeof item.value === 'string') return item.value
  const n = item.value
  if (item.kind === 'percent') return `${n}%`
  if (item.kind === 'score') return `${n}/100`
  return `${n.toLocaleString('en-US')}${item.unit === '' ? '' : ` ${item.unit}`}`
}

// ─── Validation ────────────────────────────────────────────────────────────────

export interface GroundingReport {
  verified: boolean
  /** Figures in the answer with no counterpart in the evidence. */
  unsupportedNumbers: string[]
  /** Districts named in the answer that the evidence did not cover. */
  unsupportedPlaces: string[]
  numbersChecked: number
}

/**
 * Small integers that are structural rather than factual: bedroom counts, month windows,
 * rankings, and the 1,000 sqft basis our own yield methodology discloses. Flagging these
 * would make the check fire on almost every correct answer, which is how a validator gets
 * turned off.
 */
const STRUCTURAL_NUMBERS = new Set([
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12',
  '24', '30', '36', '60', '90', '100', '365', '1000',
])

/** Normalise a value to digits so "1,850", "1850" and "1.85k" compare equal. */
function digitsOf(value: number, scale = 1): string {
  const scaled = Math.abs(value) * scale
  return Number.isInteger(scaled) ? String(scaled) : String(Math.round(scaled * 100) / 100).replace('.', '.')
}

/**
 * Every digit-string the evidence legitimises.
 *
 * Rounding variants are included on purpose: "about AED 1,900" is a fair rounding of an
 * evidence value of 1,850 and must not be reported as invented. What is excluded is any
 * figure with no nearby evidence value at all — that is the signature of a fabrication.
 */
function allowedNumbers(items: EvidenceItem[]): { exact: Set<string>; values: number[] } {
  const exact = new Set<string>()
  const values: number[] = []
  for (const item of items) {
    if (typeof item.value !== 'number' || !Number.isFinite(item.value)) continue
    const v = item.value
    values.push(v)
    for (const candidate of [
      v,
      Math.round(v),
      Math.floor(v),
      Math.ceil(v),
      Math.round(v / 10) * 10,
      Math.round(v / 100) * 100,
      Math.round(v / 1000) * 1000,
      Math.round(v / 10000) * 10000,
    ]) {
      if (Number.isFinite(candidate) && candidate !== 0) exact.add(digitsOf(candidate))
    }
    exact.add(digitsOf(v))
  }
  return { exact, values }
}

/**
 * A number, with a scale suffix only when it really is one.
 *
 * The trailing lookahead is load-bearing. Without it "3 bed" parses as the number 3 with a
 * `b` (billion) suffix, so every bedroom count in every answer was read as three billion
 * dinars and reported as an unsupported figure. Requiring a non-alphanumeric after the
 * suffix makes "3 bed" read as 3 and "AED 1.5m" still read as 1,500,000. `b` is
 * deliberately not accepted on its own for the same reason; billions are written `bn`.
 */
const NUMBER_PATTERN = /(?:AED|USD|\$)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m|bn|%)?(?![a-zA-Z0-9])/gi

/**
 * Check a finished answer against the evidence.
 *
 * Numbers are the primary signal: a hallucinated market figure is almost always a number,
 * and numbers are unambiguous to compare. Place names are checked the narrow way round —
 * any district we know of that the answer names must have been in the evidence block.
 * Unknown proper nouns are deliberately NOT flagged, because titles and headings produce
 * false alarms and a validator that cries wolf gets ignored.
 */
export function validateAnswer(
  answer: string,
  items: EvidenceItem[],
  knownPlaces: string[],
): GroundingReport {
  const { exact, values } = allowedNumbers(items)
  const unsupportedNumbers: string[] = []
  let numbersChecked = 0

  for (const match of answer.matchAll(NUMBER_PATTERN)) {
    const rawNumber = match[1]
    if (rawNumber === undefined) continue
    const suffix = (match[2] ?? '').toLowerCase()
    const parsed = Number.parseFloat(rawNumber.replace(/,/g, ''))
    if (!Number.isFinite(parsed)) continue

    // Percentages are compared as percentages; scaled ones as their full magnitude.
    let normalised = parsed
    if (suffix === 'k') normalised = parsed * 1_000
    else if (suffix === 'm') normalised = parsed * 1_000_000
    else if (suffix === 'bn') normalised = parsed * 1_000_000_000

    // A year, or a plainly structural small integer, is not a market claim.
    if (suffix === '' && Number.isInteger(parsed) && parsed >= 1900 && parsed <= 2100) continue
    const key = Number.isInteger(normalised) ? String(normalised) : String(normalised)
    if (suffix === '' && STRUCTURAL_NUMBERS.has(key)) continue

    numbersChecked += 1
    if (exact.has(key)) continue
    // Rounding tolerance: within 2% of any evidence value counts as the same figure.
    const near = values.some((v) => v !== 0 && Math.abs(normalised - v) / Math.abs(v) <= 0.02)
    if (near) continue
    unsupportedNumbers.push(match[0].trim())
  }

  const evidenceText = renderEvidenceBlock(items).toLowerCase()
  const unsupportedPlaces = knownPlaces.filter((place) => {
    const needle = place.toLowerCase()
    if (!needle || needle.length < 4) return false
    if (!answer.toLowerCase().includes(needle)) return false
    return !evidenceText.includes(needle)
  })

  return {
    verified: unsupportedNumbers.length === 0 && unsupportedPlaces.length === 0,
    unsupportedNumbers,
    unsupportedPlaces,
    numbersChecked,
  }
}

// ─── Model-free engine ─────────────────────────────────────────────────────────

export interface DeterministicAnswer {
  reply: string
  evidenceIds: string[]
  /** True when the question could not be answered from held data. */
  refused: boolean
}

const fmtAed = (n: number) => `AED ${n.toLocaleString('en-US')}`
const fmtPct = (n: number) => `${n}%`

function districtLine(d: DistrictStat): string {
  const bits: string[] = []
  if (d.saleListings > 0) {
    bits.push(`${d.saleListings} for sale${d.salePsfAed === null ? '' : `, asking ${fmtAed(d.salePsfAed)}/sqft`}`)
  } else {
    bits.push('no sale listings')
  }
  if (d.rentListings > 0) {
    bits.push(`${d.rentListings} for rent${d.rentAnnualAed === null ? '' : `, asking ${fmtAed(d.rentAnnualAed)}/yr`}`)
  } else {
    bits.push('no rent listings')
  }
  const yieldBit = d.grossYieldPct === null ? '' : ` · gross yield ${fmtPct(d.grossYieldPct)}`
  return `• **${d.name}** (${d.emirate}) — ${bits.join('; ')}${yieldBit}`
}

const PLACE_ASK = /\b(price|prices|psf|per sqft|per square foot|rent|rents|yield|cheap|expensive|cost|market|trend|worth|how much|average|median|listings?|inventory|return)\b/i
const REGISTER_ASK = /\b(register|registered|dld|transaction|transactions|recorded sale|government data|land department)\b/i
const YIELD_ASK = /\b(yield|return|rental return|roi)\b/i

/**
 * Answer without a model.
 *
 * This is the floor, and it is deliberately a real answer rather than an apology: every
 * figure here is computed by Prisma and formatted directly, so there is no step at which a
 * number can be invented. It runs when no provider is configured, when every provider
 * fails, and — most importantly — whenever the question names a district we hold nothing
 * for, which is the case where a model is most likely to improvise.
 */
export function deterministicAnswer(
  message: string,
  ctx: AssistantContext,
  knownPlaces: string[],
): DeterministicAnswer {
  const lower = message.toLowerCase()

  if (ctx.focus) {
    const d = ctx.focus
    const ids = [`focus.sale_count`, `focus.rent_count`]
    const lines = [`**${d.name}** (${d.emirate}) — live asking prices from sqftLab's collected listings.`]
    if (d.saleListings > 0) {
      lines.push(`• For sale: ${d.saleListings} listings`)
      if (d.salePsfAed !== null) {
        lines.push(`• Asking price per sqft: ${fmtAed(d.salePsfAed)}`)
        ids.push('focus.psf')
      }
      if (d.priceFromAed !== null && d.priceToAed !== null) {
        const beds = d.bedsLabel === null ? '' : ` (${d.bedsLabel})`
        lines.push(`• Asking range: ${fmtAed(d.priceFromAed)} to ${fmtAed(d.priceToAed)}${beds}`)
        ids.push('focus.price_from', 'focus.price_to')
      }
    } else {
      lines.push('• No sale listings collected for this district right now.')
    }
    if (d.rentListings > 0 && d.rentAnnualAed !== null) {
      lines.push(`• For rent: ${d.rentListings} listings, asking ${fmtAed(d.rentAnnualAed)}/yr on average`)
      ids.push('focus.rent')
    }
    if (d.grossYieldPct !== null) {
      lines.push(`• Gross yield: ${fmtPct(d.grossYieldPct)}`)
      ids.push('focus.yield')
    }
    if (d.neighbourhoodScore !== null) {
      lines.push(`• Neighbourhood score: ${d.neighbourhoodScore}/100`)
      ids.push('focus.score')
    }
    if (ctx.asOf) {
      lines.push('', `These are **asking** prices from listings collected ${ctx.asOf.slice(0, 10)} — not registered sales.`)
      ids.push('as_of')
    }
    return { reply: lines.join('\n'), evidenceIds: ids, refused: false }
  }

  // A place was named but did not resolve to a district we hold. Say so; do not improvise.
  const namedPlace = knownPlaces.find((p) => lower.includes(p.toLowerCase()))
  if (!namedPlace && PLACE_ASK.test(message) && !ctx.listingsAvailable) {
    return {
      reply:
        'I do not have live market data to answer that. This deployment holds no listings yet, so I have no figures to quote — and I will not estimate one. Once the collector has run, ask me again and I can give you asking prices by district.',
      evidenceIds: [],
      refused: true,
    }
  }

  if (ctx.listingsAvailable) {
    const ids = ['listings.total', 'listings.sale', 'listings.rent', 'listings.districts']
    const lines: string[] = []

    if (REGISTER_ASK.test(message) && !YIELD_ASK.test(message)) {
      if (ctx.register.available) {
        lines.push(
          `**Registered sales** (government register, last ${ctx.register.days} days):`,
          `• ${ctx.register.transactions.toLocaleString('en-US')} transactions`,
          ctx.register.avgPsfAed === null ? '• Average price: unavailable' : `• Average price per sqft: ${fmtAed(ctx.register.avgPsfAed)}`,
        )
        ids.push('register.window', 'register.transactions')
      } else {
        lines.push(
          'I have **no registered sales** for this market — the government transaction register holds no rows on this deployment.',
          'I will not state a registered volume or price I do not have. What I can quote is **asking** prices from live listings, which is a different thing:',
        )
      }
    }

    lines.push(
      `**Live listing coverage** (asking prices, collected ${ctx.asOf ? ctx.asOf.slice(0, 10) : 'recently'}):`,
      `• ${ctx.listingCount.toLocaleString('en-US')} active listings — ${ctx.saleCount.toLocaleString('en-US')} for sale, ${ctx.rentCount.toLocaleString('en-US')} for rent`,
      `• ${ctx.districtsCovered} districts covered across Dubai and Abu Dhabi`,
    )
    if (ctx.overallSalePsfAed !== null) {
      lines.push(`• Average asking price, sale listings: ${fmtAed(ctx.overallSalePsfAed)}/sqft`)
      ids.push('market.sale_psf')
    }
    if (ctx.overallRentAnnualAed !== null) {
      lines.push(`• Average asking annual rent: ${fmtAed(ctx.overallRentAnnualAed)}`)
      ids.push('market.rent_annual')
    }

    if (YIELD_ASK.test(message)) {
      const withYield = ctx.topDistricts.filter((d) => d.grossYieldPct !== null)
      if (withYield.length > 0) {
        const best = [...withYield].sort((a, b) => (b.grossYieldPct ?? 0) - (a.grossYieldPct ?? 0)).slice(0, 5)
        lines.push('', `**Gross yield, highest first** — among the ${withYield.length} districts in scope:`)
        for (const d of best) lines.push(`• ${d.name}: ${fmtPct(d.grossYieldPct ?? 0)}`)
        for (const d of best) if (d.grossYieldPct !== null) ids.push(`district.${slugify(d.name)}.yield`)
      }
    }

    lines.push('', '**Districts in scope:**')
    for (const d of ctx.topDistricts) {
      lines.push(districtLine(d))
      ids.push(`district.${slugify(d.name)}.sale_count`, `district.${slugify(d.name)}.rent_count`)
    }

    if (ctx.asOf) lines.push('', `Figures are **asking** prices from listings collected ${ctx.asOf.slice(0, 10)}.`)
    if (!ctx.register.available) {
      lines.push('Registered government sales are not loaded on this deployment, so I have no completed-sale figures.')
    }

    return { reply: lines.join('\n'), evidenceIds: ids, refused: false }
  }

  return {
    reply:
      'I do not have market data to answer that yet. This deployment holds no listings and no registered sales, so I have no figures for Dubai or Abu Dhabi — and I will not estimate any. Once data has been collected, ask me about a district and I can quote live asking prices.',
    evidenceIds: [],
    refused: true,
  }
}
