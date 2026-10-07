/**
 * White-label PDF property report (Day 7).
 *
 * Rendering is Chromium driving print CSS, so the report reuses the app's visual
 * language without a second layout implementation to keep in sync.
 *
 * Four things here are deliberate, each because the obvious version breaks:
 *
 *   1. **It never touches the network.** The natural `@import` of a webfont makes
 *      every report depend on fonts.googleapis.com answering. A slow or blocked fetch
 *      stalls the render until the wait expires, and the user gets an error instead of
 *      a report. The stacks below are local-or-generic, so a report renders the same
 *      offline and on a locked-down host.
 *   2. **Every interpolated value is escaped.** Addresses, community names and broker
 *      details are caller-supplied strings that end up inside a document Chromium then
 *      renders. Unescaped, a crafted address can inject markup or pull a `file://`
 *      subresource into the renderer.
 *   3. **The Chromium path is probed, not assumed.** The documented default
 *      `/usr/bin/chromium-browser` does not exist on Debian trixie, where the package
 *      installs `/usr/bin/chromium`. Assuming the wrong path makes every report throw.
 *   4. **A missing score is reported as missing.** `ReportData.investmentScore` is
 *      nullable on purpose: substituting a placeholder like 50 would print a number
 *      that looks measured and is not, which is the one thing this product cannot do.
 */

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
import type { Browser, Page } from 'puppeteer-core'

export interface ReportComp {
  date: string
  pricePsf: number
  totalAed: number
  sizeSqft: number
  building: string | null
}

export interface ReportData {
  propertyAddress: string
  community: string
  bedrooms: number
  sizeSqft: number
  listingPriceAed?: number | null
  estimatedValueAed: number
  medianPsf: number
  /** `null` when no score exists for the community — never a stand-in value. */
  investmentScore: number | null
  /** 0–1 share of the score's inputs backed by real data. `null` when unknown. */
  investmentScoreCoverage?: number | null
  verdict: string
  /** Which comp set the estimate came from; it materially changes how to read it. */
  compBasis: 'building' | 'community'
  compsUsed: number
  windowDays: number
  recentComps: ReportComp[]
  brokerLogo?: string | null
  brokerName?: string | null
  preparedBy?: string | null
  preparedFor?: string | null
  /** Injectable so a report's date is testable rather than implicitly "today". */
  generatedAt?: Date
}

/** Raised when no Chromium binary is usable, so the route can answer 503 not 500. */
export class PdfUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PdfUnavailableError'
  }
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch])
}

/** Thousands separators without depending on ICU locale data being present. */
function group(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Deterministic and UTC-based: `toLocaleDateString` needs ICU data at runtime. */
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function formatDate(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`
}

/**
 * A broker logo is only accepted as an inline base64 image. The value lands in an
 * `src` attribute, so an http URL, a `file://` path or a `javascript:` payload would
 * be a request to fetch or execute caller-chosen content inside the renderer.
 * Anything unrecognised is dropped outright rather than sanitised.
 */
const LOGO_DATA_URI = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/

/** ~2 MB of base64, past which a "logo" is a payload rather than a logo. */
const MAX_LOGO_CHARS = 2_800_000

function safeLogo(logo: string | null | undefined): string | null {
  if (!logo || logo.length > MAX_LOGO_CHARS) return null
  return LOGO_DATA_URI.test(logo) ? logo : null
}

/**
 * Build the report document.
 *
 * Exported so the report's *content* can be asserted directly — a test can prove the
 * estimate, the comps and the provenance are on the page without paying for a
 * Chromium launch on every check.
 */
export function buildReportHtml(data: ReportData): string {
  const generatedAt = data.generatedAt ?? new Date()

  const compsRows = data.recentComps.length
    ? data.recentComps
        .slice(0, 10)
        .map(
          (c) => `
      <tr>
        <td>${escapeHtml(c.date)}</td>
        <td>${escapeHtml(c.building ?? '—')}</td>
        <td class="num">AED ${group(c.pricePsf)}/sqft</td>
        <td class="num">AED ${group(c.totalAed)}</td>
        <td class="num">${group(c.sizeSqft)} sqft</td>
      </tr>`,
        )
        .join('')
    : `<tr><td colspan="5" class="empty">No comparable sales were available for this property, so no estimate is shown.</td></tr>`

  const listingPrice = data.listingPriceAed ?? null
  const premiumPct =
    listingPrice !== null && data.estimatedValueAed > 0
      ? ((listingPrice - data.estimatedValueAed) / data.estimatedValueAed) * 100
      : null

  const askingCard =
    listingPrice === null
      ? ''
      : `<div class="card">
      <div class="card-label">Asking Price</div>
      <div class="card-value num">AED ${group(listingPrice)}</div>
      <div class="card-sub">${
        premiumPct === null ? 'No comparison available' : `${premiumPct.toFixed(1)}% vs market`
      }</div>
    </div>`

  // A score that has never been computed is stated as such. Printing a neutral 50
  // here would read as a measured average and is exactly the fabrication this product
  // refuses; the coverage line exists for the same reason, since a score built mostly
  // from stand-in inputs is arithmetically valid and evidentially worthless.
  const scoreCard =
    data.investmentScore === null
      ? `<div class="card">
      <div class="card-label">Investment Score</div>
      <div class="card-value muted">Not yet computed</div>
      <div class="card-sub">No score has been calculated for this area</div>
    </div>`
      : `<div class="card">
      <div class="card-label">Investment Score</div>
      <div class="card-value num">${Math.round(data.investmentScore)}/100</div>
      <div class="card-sub">${
        typeof data.investmentScoreCoverage === 'number'
          ? `${Math.round(data.investmentScoreCoverage * 100)}% data coverage`
          : 'Community composite'
      }</div>
    </div>`

  const basisNote =
    `Based on ${data.compsUsed} comparable sale${data.compsUsed === 1 ? '' : 's'} from ` +
    `${data.compBasis === 'building' ? 'the same building' : `the wider ${escapeHtml(data.community)} area`} ` +
    `recorded in the last ${data.windowDays} days.`

  const brokerLogo = safeLogo(data.brokerLogo)
  const brokerBlock = brokerLogo
    ? `<img class="broker-logo" src="${brokerLogo}" alt="${escapeHtml(data.brokerName ?? 'Broker')}">`
    : data.brokerName
      ? `<div class="broker-name">${escapeHtml(data.brokerName)}</div>`
      : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Plus Jakarta Sans', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; background: #fff; color: #1a1a2e; padding: 40px; }
    .num { font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace; }
    .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #2563EB; padding-bottom: 20px; margin-bottom: 30px; }
    .logo-text { font-size: 22px; font-weight: 700; color: #2563EB; }
    .broker-logo { max-height: 50px; max-width: 150px; }
    .broker-name { font-size: 13px; font-weight: 600; color: #1a1a2e; }
    h1 { font-size: 20px; font-weight: 700; margin-bottom: 6px; }
    .subtitle { color: #64748b; font-size: 13px; }
    .cards { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin: 24px 0; }
    .card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; }
    .card-label { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; }
    .card-value { font-size: 22px; font-weight: 700; color: #1a1a2e; margin-top: 4px; }
    .card-value.muted { font-size: 15px; color: #94a3b8; }
    .card-sub { font-size: 12px; color: #94a3b8; margin-top: 2px; }
    .verdict { background: #f0fdf4; border: 1px solid #86efac; border-radius: 8px; padding: 16px; margin: 16px 0; }
    .verdict-label { font-size: 12px; color: #166534; font-weight: 600; }
    .verdict-text { font-size: 14px; color: #166534; margin-top: 4px; }
    .basis { font-size: 11px; color: #64748b; margin-top: 12px; }
    h2 { font-size: 14px; font-weight: 600; margin-top: 24px; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 12px; }
    th { background: #2563EB; color: white; padding: 8px 10px; text-align: left; }
    td { padding: 7px 10px; border-bottom: 1px solid #f1f5f9; }
    td.empty { color: #64748b; font-style: italic; text-align: center; padding: 18px 10px; }
    tr:nth-child(even) td { background: #f8fafc; }
    .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; display: flex; justify-content: space-between; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="logo-text">sqftLab</div>
      <div class="subtitle">UAE Property Intelligence · sqftlab.com</div>
    </div>
    ${brokerBlock}
  </div>

  <h1>${escapeHtml(data.propertyAddress)}</h1>
  <div class="subtitle">${escapeHtml(data.community)} · ${Math.round(data.bedrooms)}BR · ${group(data.sizeSqft)} sqft · Generated ${formatDate(generatedAt)}</div>
  ${data.preparedFor ? `<div class="subtitle" style="margin-top:4px">Prepared for: ${escapeHtml(data.preparedFor)}</div>` : ''}

  <div class="cards">
    <div class="card">
      <div class="card-label">Estimated Market Value</div>
      <div class="card-value num">AED ${group(data.estimatedValueAed)}</div>
      <div class="card-sub">AED ${group(data.medianPsf)}/sqft median</div>
    </div>
    ${askingCard}
    ${scoreCard}
  </div>

  <div class="verdict">
    <div class="verdict-label">Analyst Verdict</div>
    <div class="verdict-text">${escapeHtml(data.verdict)}</div>
  </div>
  <div class="basis">${basisNote}</div>

  <h2>Recent Comparable Transactions</h2>
  <table>
    <thead><tr><th>Date</th><th>Building</th><th>PSF</th><th>Total</th><th>Size</th></tr></thead>
    <tbody>${compsRows}</tbody>
  </table>

  <div class="footer">
    <span>Valuation derived from recorded comparable sales. Not investment advice.</span>
    <span>sqftlab.com · Confidential</span>
  </div>
</body>
</html>`
}

// ─── Chromium lifecycle ───────────────────────────────────────────────────────

const CHROMIUM_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
].filter((p): p is string => Boolean(p))

function resolveChromium(): string | null {
  return CHROMIUM_CANDIDATES.find((p) => existsSync(p)) ?? null
}

/**
 * One browser serves every report. Launching costs ~670ms and tens of megabytes, so a
 * per-request launch would make the endpoint needlessly slow and let a handful of
 * concurrent exports exhaust the container. The instance is cached and dropped when
 * Chromium disconnects, so a crashed browser is replaced rather than reused.
 */
let browserPromise: Promise<Browser> | null = null

async function getBrowser(executablePath: string): Promise<Browser> {
  if (browserPromise) {
    const existing = await browserPromise.catch(() => null)
    if (existing?.connected) return existing
    browserPromise = null
  }

  browserPromise = puppeteer
    .launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })
    .then((browser) => {
      browser.on('disconnected', () => {
        browserPromise = null
      })
      return browser
    })
    .catch((err: unknown) => {
      browserPromise = null
      throw err
    })

  return browserPromise
}

/**
 * Renders are capped. Each one is a Chromium page holding a full layout, so an
 * unbounded burst of export clicks is what turns a slow endpoint into a dead one.
 * Excess calls queue rather than fail.
 */
const MAX_CONCURRENT_RENDERS = 2
let activeRenders = 0
const renderWaiters: Array<() => void> = []

async function acquireRenderSlot(): Promise<void> {
  if (activeRenders < MAX_CONCURRENT_RENDERS) {
    activeRenders += 1
    return
  }
  await new Promise<void>((resolve) => renderWaiters.push(resolve))
  activeRenders += 1
}

function releaseRenderSlot(): void {
  activeRenders -= 1
  const next = renderWaiters.shift()
  if (next) next()
}

/** Render a report to PDF bytes. Throws `PdfUnavailableError` when unusable. */
export async function generatePropertyReport(data: ReportData): Promise<Buffer> {
  const executablePath = resolveChromium()
  if (!executablePath) {
    throw new PdfUnavailableError(
      'No Chromium binary available on this host, so PDF reports cannot be rendered. ' +
        'Set PUPPETEER_EXECUTABLE_PATH to a Chrome/Chromium binary to enable them.',
    )
  }

  const html = buildReportHtml(data)

  await acquireRenderSlot()
  let page: Page | null = null
  try {
    const browser = await getBrowser(executablePath)
    page = await browser.newPage()
    // `load` rather than `networkidle0`: the document references nothing remote, so
    // waiting for network silence only adds a fixed delay and a timeout to hit.
    await page.setContent(html, { waitUntil: 'load' })
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
    })
    return Buffer.from(pdf)
  } finally {
    // The page must close even when rendering throws, otherwise a failed export leaks
    // a Chromium page per attempt until the container runs out of memory.
    if (page) await page.close().catch(() => undefined)
    releaseRenderSlot()
  }
}
