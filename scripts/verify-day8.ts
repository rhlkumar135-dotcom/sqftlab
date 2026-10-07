// Day 8 verification — portfolio valuation (Part 1: derivation and summary rules).
//
// Run: bun run scripts/verify-day8.ts
//
// No database and no HTTP. These are the rules that decide whether a number reaches the
// screen at all, so they are asserted directly rather than through a route.
//
// The regression this suite exists for: three seeded holdings carrying
// `price * (1 + random*0.2)` summed to AED 10,941,214 and were rendered as DLD market
// value with zero transactions behind them. The first block re-creates those exact rows.

import {
  deriveHolding,
  summariseHoldings,
  propertyLimitFor,
  PRO_PROPERTY_LIMIT,
  type HoldingLike,
} from '../src/lib/portfolio'
import { readFileSync, readdirSync } from 'node:fs'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 200)}`}`)
  }
}

/** A holding whose current value was written without a valuation behind it. */
function unvalued(purchasePrice: number, currentValue: number): HoldingLike {
  return { purchasePrice, areaSqft: 1000, currentValue, valuedAt: null }
}

function valued(purchasePrice: number, currentValue: number, areaSqft = 1000): HoldingLike {
  return { purchasePrice, areaSqft, currentValue, valuedAt: new Date('2026-10-01T00:00:00Z') }
}

// ── The seeded portfolio that produced AED 10,941,214 ────────────────────────
console.log('\n── the seeded holdings can no longer be summed as market value ──')

const seeded: HoldingLike[] = [
  unvalued(4_800_000, 5_708_446),
  unvalued(2_100_000, 2_315_728),
  unvalued(2_450_000, 2_917_040),
]
check('the fixture still sums to the reported figure',
  seeded.reduce((s, r) => s + r.currentValue, 0) === 10_941_214)

const seededSummary = summariseHoldings(seeded)
check('none of the seeded holdings count as valued', seededSummary.valuedCount === 0, seededSummary.valuedCount)
check('all three count as unvalued', seededSummary.unvaluedCount === 3, seededSummary.unvaluedCount)
check('their value is excluded from the portfolio total', seededSummary.currentAed === 0, seededSummary.currentAed)
check('the gain is unknown, not 0 and not the 1,591,214 the rows imply',
  seededSummary.gainAed === null, seededSummary.gainAed)
check('the gain percentage is unknown rather than 0.0%',
  seededSummary.gainPct === null, seededSummary.gainPct)
check('what was paid is still reported', seededSummary.purchaseAed === 9_350_000, seededSummary.purchaseAed)
check('nothing is counted in the valued denominator', seededSummary.valuedPurchaseAed === 0)

// ── An unknown gain is never a zero gain ─────────────────────────────────────
console.log('\n── an unvalued holding reports unknown, never break-even ──')
const oneUnvalued = summariseHoldings([unvalued(1_000_000, 0)])
check('a portfolio with no valuations has a null gain', oneUnvalued.gainAed === null)
check('a portfolio with no valuations has a null gain percent', oneUnvalued.gainPct === null)
check('an empty portfolio is not a gain of zero either', summariseHoldings([]).gainAed === null)

const d = deriveHolding(unvalued(1_000_000, 0))
check('an unvalued holding has no current value', d.currentValueAed === null)
check('an unvalued holding has no gain', d.gainAed === null)
check('an unvalued holding has no gain percent', d.gainPct === null)
check('an unvalued holding is not flagged as valued', d.isValued === false)
check('purchase PSF is still reported — it needs no valuation',
  d.purchasePsf === 1000, d.purchasePsf)
check('current PSF is not invented', d.currentPsf === null)

// ── A legacy non-zero currentValue with no valuedAt is still unvalued ────────
console.log('\n── currentValue alone is not evidence of a valuation ──')
const legacy = deriveHolding({ purchasePrice: 4_800_000, currentValue: 5_708_446, areaSqft: 1000, valuedAt: null })
check('a non-zero currentValue with no valuedAt stays unvalued', legacy.isValued === false)
check('and reports no current value', legacy.currentValueAed === null)

// ── A real valuation is reported in full ────────────────────────────────────
console.log('\n── a valued holding reports value, gain and both PSFs ──')
const good = deriveHolding(valued(1_000_000, 1_150_000))
check('a valued holding is flagged valued', good.isValued === true)
check('it reports its current value', good.currentValueAed === 1_150_000, good.currentValueAed)
check('it reports the gain', good.gainAed === 150_000, good.gainAed)
check('it reports the gain percent', good.gainPct === 15, good.gainPct)
check('it reports the current PSF', good.currentPsf === 1150, good.currentPsf)
const loss = deriveHolding(valued(1_000_000, 900_000))
check('a loss is negative and correctly signed', loss.gainAed === -100_000 && loss.gainPct === -10, loss)

// ── Mixed portfolios: the totals cover valued holdings only ─────────────────
console.log('\n── a mixed portfolio totals only what is valued ──')
const mixed = summariseHoldings([valued(1_000_000, 1_200_000), valued(2_000_000, 1_800_000), unvalued(500_000, 0)])
check('valued and unvalued are counted separately',
  mixed.valuedCount === 2 && mixed.unvaluedCount === 1, mixed)
check('the current total covers valued holdings only', mixed.currentAed === 3_000_000, mixed.currentAed)
check('the gain covers valued holdings only', mixed.gainAed === 0, mixed.gainAed)
check('the gain percent uses the valued cost, not the full outlay',
  mixed.gainPct === 0 && mixed.valuedPurchaseAed === 3_000_000 && mixed.purchaseAed === 3_500_000, mixed)

// ── Division guards ─────────────────────────────────────────────────────────
console.log('\n── arithmetic never divides by zero or emits NaN ──')
const zeroArea = deriveHolding(valued(1_000_000, 1_100_000, 0))
check('zero area yields no purchase PSF rather than Infinity', zeroArea.purchasePsf === null)
check('zero area yields no current PSF rather than Infinity', zeroArea.currentPsf === null)
const zeroPaid = deriveHolding({ purchasePrice: 0, currentValue: 1_000, areaSqft: 100, valuedAt: new Date() })
check('a zero purchase price yields no gain percent rather than Infinity', zeroPaid.gainPct === null, zeroPaid)
const all = summariseHoldings([valued(1_000_000, 1_150_000), unvalued(2_000_000, 0)])
check('no figure in a summary is NaN', Object.values(all).every((v) => v === null || Number.isFinite(v)), all)
check('no figure in a derived holding is NaN',
  Object.values(deriveHolding(valued(1_000_000, 1_150_000))).every((v) => v === null || typeof v === 'boolean' || Number.isFinite(v)))

// ── The tier cap ────────────────────────────────────────────────────────────
console.log('\n── the plan cap ──')
check('pro is capped at five', propertyLimitFor('pro') === PRO_PROPERTY_LIMIT && PRO_PROPERTY_LIMIT === 5)
for (const tier of ['elite', 'enterprise', 'institutional']) {
  check(`${tier} is uncapped`, propertyLimitFor(tier) === null)
}
check('an unrecognised tier is uncapped rather than silently capped at 0',
  propertyLimitFor('nonsense') === null)

// ── Every account-scoped call must present an identity ──────────────────────
// Account-scoped routes resolve the caller from the request. A bare `fetch` arrives as
// a guest, so the page shows a paywall to the account that owns the data — the portfolio
// did exactly that, and an Enterprise user would have been refused by the PDF export.
// `authedFetch` from src/lib/session attaches the bearer; this asserts nobody regresses
// to a plain fetch.
console.log('\n── client calls present the caller identity ──')
{
  const offenders: string[] = []
  const seen = new Set<string>()
  for (const dir of ['src/components', 'src']) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.tsx') && !f.endsWith('.ts')) continue
      const path = `${dir}/${f}`
      if (seen.has(f) || path.includes('generated')) continue
      seen.add(f)
      const lines = readFileSync(path, 'utf8').split('\n')
      lines.forEach((line, i) => {
        // `authedFetch` is capital-F and cannot match this.
        if (!/fetch\(\s*[`'"]\/api\/sqftlab/.test(line)) return
        // Acceptable when the call presents the caller's identity itself, or when the
        // surrounding lines say why it must not. Anything else is a guest request to an
        // account-scoped route that will answer 401/403 — which is how the portfolio page
        // came to show a paywall to the account that owned the data.
        const around = lines.slice(Math.max(0, i - 3), i + 7).join('\n')
        if (around.includes('bare-fetch-ok') || around.includes('Authorization')) return
        offenders.push(`${path}:${i + 1}`)
      })
    }
  }
  check('every account-scoped call presents an identity, or states why it must not',
    offenders.length === 0, offenders)
  const session = readFileSync('src/lib/session.ts', 'utf8')
  check('authedFetch attaches the bearer', session.includes("headers.set('Authorization'"))
}

console.log(`\n${'─'.repeat(60)}`)
console.log(`  ${passed} passed, ${failed} failed`)
if (failures.length) {
  console.log('\n  Failures:')
  for (const f of failures) console.log(`    ✗ ${f}`)
}
console.log(`${'─'.repeat(60)}\n`)
process.exit(failed === 0 ? 0 : 1)
