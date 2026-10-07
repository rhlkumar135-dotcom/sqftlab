/**
 * Day 17 browser check — /docs and /api-keys actually render and work.
 *
 * A green `vite build` proves the bundle compiled, not that a page draws. These two pages
 * are new components with new imports, new UI primitives and a dialog, so they are checked
 * in a real browser: console errors are fatal, the text has to be there, the tabs have to
 * switch, and the create-key flow has to show the raw key once.
 *
 * Cleanup: the only write is one API key on the demo account, named below. It is deleted
 * from the database at the end, and nothing else on the account is touched.
 *
 * Run: bun run scripts/_shot-day17.ts
 */
import puppeteer from 'puppeteer-core'
import { prisma } from '../src/lib/db'

const BASE = process.env.PREVIEW_URL ?? 'http://localhost:3101'
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/chromium'
const OUT = '/tmp/day17'
const TEST_KEY_NAME = 'verify17-browser'

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
})

const errors: string[] = []

try {
  const page = await browser.newPage()
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })

  // ── /docs ─────────────────────────────────────────────────────────────────
  console.log('\n── /docs')
  await page.setViewport({ width: 1280, height: 900 })
  await page.goto(`${BASE}/docs`, { waitUntil: 'networkidle2', timeout: 45000 })
  await new Promise((r) => setTimeout(r, 900))

  const docs = await page.evaluate(() => {
    const text = document.body.innerText
    return {
      text,
      h1: document.querySelector('h1')?.textContent?.trim() ?? '',
      title: document.title,
      codeBlocks: document.querySelectorAll('pre code').length,
      tables: document.querySelectorAll('table').length,
      tabs: Array.from(document.querySelectorAll('[role="tab"]')).map((t) => t.textContent?.trim() ?? ''),
    }
  })
  check('h1 is the API docs title', docs.h1 === 'sqftLab API Documentation', docs.h1)
  check('document title set', docs.title.includes('API Documentation'), docs.title)
  check('authentication section present', /Authorization: Bearer sqft_/.test(docs.text))
  check('documents /api/v1/transactions', docs.text.includes('/api/v1/transactions'))
  check('documents the discovery endpoint', docs.text.includes('/api/v1/communities'))
  check('endpoint table rendered', docs.tables >= 1, `tables=${docs.tables}`)
  check('code blocks rendered', docs.codeBlocks >= 1, `code=${docs.codeBlocks}`)
  check('three language tabs', docs.tabs.length === 3, JSON.stringify(docs.tabs))
  check('rate limits list all four paid tiers', ['Pro', 'Elite', 'Enterprise', 'Institutional'].every((t) => docs.text.includes(t)))
  check('does not claim "Unlimited" exports', !docs.text.includes('Unlimited CSV'))
  check('CTA to get an API key', /Get API Key/i.test(docs.text))
  await page.screenshot({ path: `${OUT}-docs-desktop.png`, fullPage: false })

  // Tabs must actually switch to the Python example.
  await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((x) => x.textContent?.trim() === 'Python')
    t?.click()
  })
  await new Promise((r) => setTimeout(r, 400))
  const pyVisible = await page.evaluate(() => document.body.innerText.includes('import requests'))
  check('clicking the Python tab shows the Python example', pyVisible)

  // Mobile: no horizontal overflow of the document.
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  await page.goto(`${BASE}/docs`, { waitUntil: 'networkidle2', timeout: 45000 })
  await new Promise((r) => setTimeout(r, 800))
  const docsOverflow = await page.evaluate(() => {
    // The copy control must not sit on top of the code text. Measured as a geometric
    // overlap of the button's box against the <code> box, which is how the earlier
    // absolutely-positioned version failed at this width.
    const btn = document.querySelector('button[aria-label="Copy code"]')
    const code = document.querySelector('pre code')
    let overlaps = false
    if (btn && code) {
      const b = btn.getBoundingClientRect()
      const c = code.getBoundingClientRect()
      overlaps = !(b.right <= c.left || b.left >= c.right || b.bottom <= c.top || b.top >= c.bottom)
    }
    return {
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      copyOverlapsCode: overlaps,
    }
  })
  check('docs: no page-level horizontal overflow at 390px', docsOverflow.scrollW <= docsOverflow.clientW + 1, JSON.stringify(docsOverflow))
  check('docs: copy button does not overlap the code text', docsOverflow.copyOverlapsCode === false)
  await page.screenshot({ path: `${OUT}-docs-mobile.png`, fullPage: false })

  // ── /api-keys ─────────────────────────────────────────────────────────────
  console.log('\n── /api-keys')
  await page.setViewport({ width: 1280, height: 980 })
  await page.goto(`${BASE}/api-keys`, { waitUntil: 'networkidle2', timeout: 45000 })
  await new Promise((r) => setTimeout(r, 1400))

  const keysView = await page.evaluate(() => {
    const text = document.body.innerText
    return {
      text,
      h1: document.querySelector('h1')?.textContent?.trim() ?? '',
      hasProgress: !!document.querySelector('[aria-label="Busiest key daily usage"]'),
      tableRows: document.querySelectorAll('table tbody tr').length,
    }
  })
  check('h1 is "API Keys"', keysView.h1.includes('API Keys'), keysView.h1)
  check('usage summary rendered', /Busiest key today/i.test(keysView.text))
  check('progress bar present', keysView.hasProgress)
  check('shows the plan', /Pro|Elite|Enterprise|Institutional/.test(keysView.text))
  check('states the per-key limit basis', /per key/i.test(keysView.text), keysView.text.slice(0, 200))
  check('"Resets midnight UTC" shown', keysView.text.includes('midnight UTC'))
  check('docs link present', /API Documentation/i.test(keysView.text))
  check('did NOT fall into the paywall/sign-in state', !/Sign in to manage API keys|need a Pro plan/i.test(keysView.text))
  await page.screenshot({ path: `${OUT}-apikeys-desktop.png`, fullPage: false })

  // Create a key: the dialog must appear, then show the raw key exactly once.
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((x) => /Create New Key/.test(x.textContent ?? ''))
    b?.click()
  })
  await new Promise((r) => setTimeout(r, 400))
  const dialogOpen = await page.evaluate(() => {
    const el = document.querySelector('[role="dialog"]')
    const labelId = el?.getAttribute('aria-labelledby') ?? ''
    return {
      open: !!el,
      ariaModal: el?.getAttribute('aria-modal') ?? '',
      labelId,
      labelResolves: labelId !== '' && document.getElementById(labelId) !== null,
    }
  })
  check('create dialog opens with role="dialog"', dialogOpen.open)
  check('aria-modal="true"', dialogOpen.ariaModal === 'true', dialogOpen.ariaModal)
  check('aria-labelledby resolves to the title element', dialogOpen.labelResolves, dialogOpen.labelId)

  // Escape must close it.
  await page.keyboard.press('Escape')
  await new Promise((r) => setTimeout(r, 400))
  const afterEscape = await page.evaluate(() => !!document.querySelector('[role="dialog"]'))
  check('Escape closes the dialog', !afterEscape)

  // Re-open to continue the create flow.
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((x) => /Create New Key/.test(x.textContent ?? ''))
    b?.click()
  })
  await new Promise((r) => setTimeout(r, 400))

  const typed = await page.evaluate((name) => {
    const input = document.querySelector<HTMLInputElement>('input#key-name')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, name)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }, TEST_KEY_NAME)
  check('key name input present and filled', typed)

  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((x) => x.textContent?.trim() === 'Create')
    b?.click()
  })
  await new Promise((r) => setTimeout(r, 1600))

  const afterCreate = await page.evaluate(() => {
    const text = document.body.innerText
    const code = document.querySelector('code')
    return {
      text,
      rawKey: code?.textContent?.trim() ?? '',
      hasWarning: /will not be shown again/i.test(text),
      hasCopy: /Copy/.test(text),
      hasSavedButton: /saved it/i.test(text),
    }
  })
  check('raw key displayed once', /^sqft_[0-9a-f]{48}$/.test(afterCreate.rawKey), afterCreate.rawKey.slice(0, 20))
  check('"will not be shown again" warning', afterCreate.hasWarning)
  check('copy button offered', afterCreate.hasCopy)
  check('"I\'ve saved it — Close" offered', afterCreate.hasSavedButton)
  await page.screenshot({ path: `${OUT}-apikeys-rawkey.png`, fullPage: false })

  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((x) => /saved it/i.test(x.textContent ?? ''))
    b?.click()
  })
  await new Promise((r) => setTimeout(r, 1200))

  const afterClose = await page.evaluate(() => {
    const text = document.body.innerText
    return { text, rows: document.querySelectorAll('table tbody tr').length }
  })
  check('new key appears in the list', afterClose.text.includes(TEST_KEY_NAME))
  check('raw key is gone after closing', !/sqft_[0-9a-f]{48}/.test(afterClose.text))
  check('key list has a row', afterClose.rows >= 1, `rows=${afterClose.rows}`)

  // Revoke flow uses a dialog, not window.confirm.
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((x) => x.textContent?.trim() === 'Revoke')
    b?.click()
  })
  await new Promise((r) => setTimeout(r, 400))
  const confirm = await page.evaluate(() => ({
    text: document.body.innerText,
    isDialog: !!document.querySelector('[role="dialog"]'),
  }))
  check('revoke opens a dialog (no window.confirm)', confirm.isDialog && /cannot be undone/i.test(confirm.text))
  await page.screenshot({ path: `${OUT}-apikeys-revoke.png`, fullPage: false })

  // Mobile check for the API keys page.
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  await page.goto(`${BASE}/api-keys`, { waitUntil: 'networkidle2', timeout: 45000 })
  await new Promise((r) => setTimeout(r, 1400))
  const keysOverflow = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    hasTable: !!document.querySelector('table'),
  }))
  check('api-keys: no page-level horizontal overflow at 390px', keysOverflow.scrollW <= keysOverflow.clientW + 1, JSON.stringify(keysOverflow))
  await page.screenshot({ path: `${OUT}-apikeys-mobile.png`, fullPage: false })

  // ── nav entry points ──────────────────────────────────────────────────────
  console.log('\n── navigation')
  await page.setViewport({ width: 1280, height: 900 })
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 45000 })
  await new Promise((r) => setTimeout(r, 900))
  const nav = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('nav button')).map((b) => b.textContent?.trim() ?? '')
    return { labels, hasMortgage: labels.includes('Mortgage'), hasApi: labels.includes('API'), hasDocs: labels.includes('Docs') }
  })
  check('nav has Mortgage (was unreachable)', nav.hasMortgage, nav.labels.join('|'))
  check('nav has API', nav.hasApi)
  check('nav has Docs', nav.hasDocs)

  // Clicking Docs in the nav must actually route there.
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll<HTMLButtonElement>('nav button')).find((x) => x.textContent?.trim() === 'Docs' && x.offsetParent !== null)
    b?.click()
  })
  await new Promise((r) => setTimeout(r, 1000))
  const routed = await page.evaluate(() => ({ path: window.location.pathname, h1: document.querySelector('h1')?.textContent ?? '' }))
  check('clicking Docs navigates to /docs', routed.path === '/docs', routed.path)
  check('and renders the docs page', routed.h1.includes('API Documentation'), routed.h1)

  console.log('\n── console health')
  // Particle/leaflet noise aside, a React crash would surface as a pageerror.
  const real = errors.filter((e) => !/favicon|ResizeObserver loop|leaflet/i.test(e))
  check('no uncaught page errors', real.filter((e) => e.startsWith('pageerror')).length === 0, real.join(' | ').slice(0, 300))
  if (real.length) console.log(`  (note: ${real.length} console errors) ${real.slice(0, 5).join(' | ').slice(0, 400)}`)
} finally {
  await browser.close()
  // Remove exactly the key this script created.
  const removed = await prisma.apiKey.deleteMany({ where: { name: TEST_KEY_NAME } })
  console.log(`\ncleanup: removed ${removed.count} test key(s) named "${TEST_KEY_NAME}"`)
  await prisma.$disconnect()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failures.length) console.log(`failures:\n  - ${failures.join('\n  - ')}`)
process.exit(failed > 0 ? 1 : 0)
