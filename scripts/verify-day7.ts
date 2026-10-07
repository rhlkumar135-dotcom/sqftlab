// Day 7 verification — white-label PDF report (Part 1: the document's content rules).
//
// Run: bun run scripts/verify-day7.ts
//
// These checks exercise the HTML that the PDF is rendered FROM. They are kept separate
// from the end-to-end run on purpose: a Chromium launch costs a browser binary and
// ~700ms, so the rules that matter most — output escaping, the ban on stand-in scores,
// the empty-comparables case — must be provable without either.
//
// The two rules being defended here are the ones that would be silent if broken:
// a report that prints a placeholder score looks exactly like a report that printed a
// measured one, and an unescaped address is only visible as injected markup.

import { buildReportHtml, type ReportData } from '../src/lib/pdf-generator'

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

const comps = [
  { date: '2026-09-01', pricePsf: 1200, totalAed: 1_200_000, sizeSqft: 1000, building: 'Marina Gate' },
  { date: '2026-08-20', pricePsf: 1150, totalAed: 1_150_000, sizeSqft: 1000, building: 'Marina Gate' },
  { date: '2026-08-05', pricePsf: 1100, totalAed: 1_100_000, sizeSqft: 1000, building: null },
]

function report(over: Partial<ReportData> = {}): ReportData {
  return {
    propertyAddress: 'Marina Gate 2, Dubai Marina',
    community: 'Dubai Marina',
    bedrooms: 2,
    sizeSqft: 1000,
    estimatedValueAed: 1_000_000,
    medianPsf: 1150,
    investmentScore: 72,
    investmentScoreCoverage: 0.64,
    verdict: 'At market — within normal range',
    compBasis: 'building',
    compsUsed: 3,
    windowDays: 180,
    recentComps: comps,
    generatedAt: new Date(Date.UTC(2026, 2, 9)),
    ...over,
  }
}

// ── Structure ────────────────────────────────────────────────────────────────
console.log('\n── the document is well formed ──')
const base = buildReportHtml(report())
check('is a complete HTML document', base.startsWith('<!DOCTYPE html>') && base.trimEnd().endsWith('</html>'))
check('carries the address', base.includes('Marina Gate 2, Dubai Marina'))
check('carries the community and spec line', base.includes('Dubai Marina · 2BR · 1,000 sqft'))
check('carries the estimate', base.includes('AED 1,000,000'))
check('carries the median psf', base.includes('AED 1,150/sqft median'))
check('carries the verdict', base.includes('At market — within normal range'))
check('uses the report date it was given, not today', base.includes('9 March 2026'), base.match(/Generated [^<]*/)?.[0])
check('does not reference a remote font', !base.includes('fonts.googleapis.com') && !base.includes('@import'))

// ── Output escaping ──────────────────────────────────────────────────────────
// Every caller-supplied string is interpolated into a document Chromium renders, so an
// unescaped value is an injection into the renderer, not just a cosmetic bug.
console.log('\n── caller-supplied strings are escaped ──')
const hostile = buildReportHtml(report({
  propertyAddress: '<script>alert(1)</script>',
  community: '"><img src=x onerror=y>',
  brokerName: "O'Brien & Sons",
  preparedFor: 'A <b>client</b>',
  brokerLogo: 'javascript:alert(1)',
}))
check('a <script> in the address does not survive', !hostile.includes('<script>'), hostile.slice(hostile.indexOf('<h1>'), hostile.indexOf('<h1>') + 60))
check('it is escaped, not stripped', hostile.includes('&lt;script&gt;'))
check('a quote-break in the community does not survive', !hostile.includes('onerror=y') || hostile.includes('&quot;&gt;&lt;img'))
check('an apostrophe in the broker name is escaped', hostile.includes('&#39;'))
check('markup in preparedFor is escaped', hostile.includes('&lt;b&gt;client&lt;/b&gt;'))
check('a javascript: logo is rejected', !hostile.includes('javascript:'))

// ── The logo is only ever an inline image ────────────────────────────────────
console.log('\n── the broker logo is restricted to an inline image ──')
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
check('a valid base64 PNG is included', buildReportHtml(report({ brokerLogo: png })).includes(png))
check('an http logo URL is rejected', !buildReportHtml(report({ brokerLogo: 'http://evil.test/logo.png' })).includes('evil.test'))
check('a file:// path is rejected', !buildReportHtml(report({ brokerLogo: 'file:///etc/passwd' })).includes('/etc/passwd'))
check('a non-image data URI is rejected', !buildReportHtml(report({ brokerLogo: 'data:text/html;base64,PHNjcmlwdD4=' })).includes('data:text/html'))
check('an oversized logo is dropped', !buildReportHtml(report({ brokerLogo: `data:image/png;base64,${'A'.repeat(3_000_000)}` })).includes('data:image/png'))
check('no logo leaves no broken image tag', !buildReportHtml(report({ brokerLogo: null })).includes('class="broker-logo"'))

// ── The stand-in-score ban ───────────────────────────────────────────────────
// A substitute value here would be indistinguishable from a measured one, which is the
// single thing this product cannot ship.
console.log('\n── a missing score is reported as missing, never substituted ──')
const noScore = buildReportHtml(report({ investmentScore: null, investmentScoreCoverage: null }))
check('a null score renders as "Not yet computed"', noScore.includes('Not yet computed'))
check('a null score prints no number out of 100', !/\d+\/100/.test(noScore), noScore.match(/[^>]*\/100/)?.[0])
check('a null score does not print a placeholder 50', !noScore.includes('>50/100'))
const scored = buildReportHtml(report())
check('a real score is rendered', scored.includes('72/100'))
check('the score carries its data coverage', scored.includes('64% data coverage'))
check('missing coverage is not invented', !buildReportHtml(report({ investmentScore: 72, investmentScoreCoverage: null })).includes('% data coverage'))

// ── Provenance and the comps table ───────────────────────────────────────────
console.log('\n── the report states where the estimate came from ──')
check('same-building basis is stated', base.includes('the same building'))
check('community basis is stated when that is what was used',
  buildReportHtml(report({ compBasis: 'community' })).includes('the wider Dubai Marina area'))
check('the comp count is stated', base.includes('Based on 3 comparable sales'))
check('the window is stated', base.includes('last 180 days'))
check('singular comp count reads correctly', buildReportHtml(report({ compsUsed: 1 })).includes('1 comparable sale from'))

console.log('\n── the comparables table ──')
check('a comp row is rendered', base.includes('Marina Gate') && base.includes('AED 1,200/sqft'))
check('an unknown building renders as a dash, not "null"', base.includes('<td>—</td>'))
check('the table is capped at 10 rows', (buildReportHtml(report({
  recentComps: Array.from({ length: 12 }, (_, i) => ({ ...comps[0], date: `2026-09-${String(i + 1).padStart(2, '0')}` })),
})).match(/\/sqft<\/td>/g) ?? []).length === 10)
const empty = buildReportHtml(report({ recentComps: [], compsUsed: 0, estimatedValueAed: 0 }))
check('no comparables renders an honest empty row', empty.includes('No comparable sales were available'))
check('no comparables leaves no empty tbody', !empty.includes('<tbody></tbody>'))

// ── Asking-price maths ───────────────────────────────────────────────────────
console.log('\n── asking price comparison ──')
check('below-market asking price is labelled', buildReportHtml(report({ listingPriceAed: 900_000 })).includes('-10.0% vs market'))
check('above-market asking price is labelled', buildReportHtml(report({ listingPriceAed: 1_250_000 })).includes('25.0% vs market'))
check('no asking price omits the card', !buildReportHtml(report({ listingPriceAed: null })).includes('Asking Price'))

// ── Nothing non-finite or undefined may reach the page ───────────────────────
console.log('\n── no undefined, null or NaN leaks into the document ──')
const flat = buildReportHtml(report({ listingPriceAed: null, brokerName: null, brokerLogo: null, preparedFor: null }))
for (const token of ['undefined', 'NaN', '[object Object]', '&lt;img src=x']) {
  check(`the page never prints ${token}`, !flat.includes(token))
}

console.log(`\n${'─'.repeat(60)}`)
console.log(`  ${passed} passed, ${failed} failed`)
if (failures.length) {
  console.log('\n  Failures:')
  for (const f of failures) console.log(`    ✗ ${f}`)
}
console.log(`${'─'.repeat(60)}\n`)
process.exit(failed === 0 ? 0 : 1)
