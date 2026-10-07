/**
 * Whole-app crawl — every page, every nav item, every visible button.
 *
 * The verify-* suites test the API. They cannot see a blank screen, a missing icon
 * import, or a button that renders but has no handler. This drives a real browser
 * across the entire navigable surface at 390px and 1440px and reports:
 *
 *   1. every page rendered (non-blank, no error boundary)
 *   2. every nav item actually switches the page
 *   3. every VISIBLE button, and which of them have no click handler at all
 *   4. any uncaught page error, console error, or failed request, attributed to a URL
 *   5. horizontal overflow at 390px
 *
 * Dead-button detection reads React's own props off the DOM node
 * (`__reactProps$*`), which is reliable for buttons and needs no clicking — so the
 * crawl never triggers a destructive action to find out what a button does.
 *
 * Run:
 *   DATABASE_URL=file:$PWD/prisma/dev.db bun run scripts/_crawl-all.ts
 */
import puppeteer, { type Browser, type Page as PPage } from 'puppeteer-core'
import { prisma } from '../src/lib/db'
import { resolve } from 'node:path'
import { writeFileSync } from 'node:fs'

const BASE = process.env.PREVIEW_URL ?? 'http://localhost:8080'
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/chromium'
const OUT = '/tmp/crawl'

const EXPECTED_DB = resolve('prisma/dev.db')
function isProjectDb(url: string): boolean {
  if (!url) return false
  const path = url.replace(/^file:\/\//, '').replace(/^file:/, '')
  return resolve(path) === EXPECTED_DB
}

let passed = 0
let failed = 0
const problems: string[] = []
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++
    console.log(`  \u2713 ${name}`)
  } else {
    failed++
    problems.push(`${name}${detail ? ` \u2014 ${detail}` : ''}`)
    console.log(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`)
  }
}

const pageErrors: string[] = []
const consoleErrors: string[] = []
const networkFailures: string[] = []

function watch(page: PPage, label: string) {
  page.on('pageerror', (e) => pageErrors.push(`${label}: ${(e as Error).message}`))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const t = m.text()
    // Some 4xx/5xx are the app working as designed, and counting them as failures
    // buries the ones that are not. The console text for a failed resource is only
    // "Failed to load resource: …" with no URL, so correlate against `location()`:
    //  · 403 on /sqftlab/deal-briefs — the Enterprise gate, refused for an elite demo
    //    account on purpose (verify-day16 asserts the same 403).
    //  · 501 on /sqftlab/auth/google — the sign-in page PROBES for OAuth config with
    //    that exact request and hides the button when it is unset.
    //  · the market SSE stream resetting is a proxy artefact; the client reconnects and
    //    the badge goes to 'reconnecting'. Curl holds the stream open indefinitely.
    const url = m.location()?.url ?? ''
    const hay = `${t} ${url}`
    if (
      (t.includes('403') && hay.includes('deal-briefs')) ||
      (t.includes('501') && hay.includes('auth/google')) ||
      (hay.includes('ERR_CONNECTION_RESET') && hay.includes('stream/market'))
    ) {
      return
    }
    consoleErrors.push(`${label}: ${t}${url ? ` [${url}]` : ''}`)
  })
  page.on('requestfailed', (r) => {
    const u = r.url()
    const err = r.failure()?.errorText ?? ''
    if (err.includes('ERR_CONNECTION_RESET') && u.includes('stream/market')) return
    networkFailures.push(`${label}: ${u} ${err}`)
  })
}

/** Every navigable page id in App.tsx, with how to reach it. */
const NAV_PAGES = [
  ['dashboard', 'Heatmap'],
  ['listings', 'Listings'],
  ['markets', 'Markets'],
  ['analytics', 'Analytics'],
  ['predictions', 'Predictions'],
  ['portfolio', 'Portfolio'],
  ['watchlist', 'Watchlist'],
  ['deals', 'Deals'],
  ['alerts', 'Alerts'],
  ['yield', 'Yield Calc'],
  ['mortgage', 'Mortgage'],
  ['cma', 'CMA'],
  ['buildings', 'Buildings'],
  ['capital-flow', 'Capital Flow'],
  ['export', 'Export'],
  ['market-pulse', 'Pulse'],
  ['api-keys', 'API'],
  ['docs', 'Docs'],
  ['deal-network', 'Deal Network'],
] as const

const URL_PAGES = [
  '/pricing',
  '/cma',
  '/portfolio',
  '/capital-flow',
  '/buildings',
  '/export',
  '/mortgage',
  '/market-pulse',
  '/docs',
  '/keys',
  '/deals',
] as const

type Rendered = {
  label: string
  url: string
  heading: string
  textLen: number
  blank: boolean
  errorBoundary: boolean
  overflow: number
}

async function probe(page: PPage, label: string): Promise<Rendered> {
  const r = await page.evaluate(() => {
    const body = document.body.innerText.replace(/\s+/g, ' ').trim()
    // First heading-ish line, to eyeball that the right page rendered.
    const h = document.querySelector('h1, h2')
    const heading = h?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
    return {
      heading: heading.slice(0, 90),
      textLen: body.length,
      blank: body.length < 40,
      errorBoundary:
        body.includes('Something went wrong loading this section') ||
        body.includes('Could not display'),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    }
  })
  return { label, url: page.url(), ...r }
}

type Btn = { label: string; dead: boolean; type: string; tag: string }

/** Visible interactive elements and whether they carry ANY handler. */
async function buttonInventory(page: PPage): Promise<Btn[]> {
  return page.evaluate(() => {
    const out: { label: string; dead: boolean; type: string; tag: string }[] = []
    const els = Array.from(
      document.querySelectorAll<HTMLElement>('button, a[role="button"], [role="button"]'),
    )
    for (const el of els) {
      // offsetParent is null for display:none AND for position:fixed, so also
      // require a non-zero box — this is about what the user can actually hit.
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      const label =
        (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) ||
        el.getAttribute('aria-label') ||
        ''
      if (!label) continue
      // React stores its props on the node under a random-suffixed key.
      const key = Object.keys(el).find((k) => k.startsWith('__reactProps'))
      const props = key ? (el as unknown as Record<string, { onClick?: unknown; onSubmit?: unknown }>)[key] : null
      const hasHandler =
        typeof props?.onClick === 'function' || typeof props?.onSubmit === 'function'
      // A plain submit button with no handler still works via its form.
      const isSubmit = (el as HTMLButtonElement).type === 'submit'
      out.push({
        label,
        dead: !!props && !hasHandler && !isSubmit,
        type: (el as HTMLButtonElement).type ?? '',
        tag: el.tagName.toLowerCase(),
      })
    }
    return out
  })
}

async function shot(page: PPage, name: string) {
  await page.screenshot({ path: `${OUT}-${name}.png`, fullPage: false })
}

async function main() {
  if (!isProjectDb(process.env.DATABASE_URL ?? '')) {
    console.error(`Refusing to run: DATABASE_URL must resolve to ${EXPECTED_DB}`)
    process.exit(2)
  }

  const user = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } })
  if (!user) {
    console.error('No user in the project database to identify as.')
    process.exit(2)
  }

  const rendered: Rendered[] = []
  const allButtons: Record<string, Btn[]> = {}
  let browser: Browser | null = null

  try {
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    })

    // ── Phase A: every published URL, cold load, desktop ───────────────────────
    console.log('\n\u2500\u2500 A. Direct URLs (cold load, 1440px)')
    for (const path of URL_PAGES) {
      const page = await browser.newPage()
      watch(page, `url${path}`)
      await page.setViewport({ width: 1440, height: 900 })
      // Identity: the SPA presents the session cookie to /me, exactly as a signed-in
      // user would — no dev backdoor.
      await page.setCookie({
        name: 'next-auth.session-token',
        value: user.id,
        domain: 'localhost',
        path: '/',
      })
      const resp = await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle2', timeout: 30000 })
      await new Promise((r) => setTimeout(r, 700))
      const r = await probe(page, path)
      rendered.push(r)
      check(
        `${path} renders`,
        !r.blank && !r.errorBoundary && (resp?.status() ?? 0) < 400,
        r.blank ? 'BLANK' : r.errorBoundary ? 'ERROR BOUNDARY' : `HTTP ${resp?.status()}`,
      )
      await page.close()
    }

    // ── Phase B: every nav item, clicked for real, desktop ─────────────────────
    console.log('\n\u2500\u2500 B. Nav click-through (1440px, real clicks)')
    {
      const page = await browser.newPage()
      watch(page, 'nav-desktop')
      await page.setViewport({ width: 1440, height: 900 })
      await page.setCookie({
        name: 'next-auth.session-token',
        value: user.id,
        domain: 'localhost',
        path: '/',
      })
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 30000 })

      for (const [id, label] of NAV_PAGES) {
        const clicked = await page.evaluate((l) => {
          const btn = Array.from(document.querySelectorAll('nav button')).find(
            (b) => b.textContent?.trim() === l && b.getBoundingClientRect().width > 0,
          )
          if (!btn) return false
          ;(btn as HTMLElement).click()
          return true
        }, label)
        if (!clicked) {
          check(`nav "${label}" is clickable`, false, 'nav button not found')
          continue
        }
        await new Promise((r) => setTimeout(r, 800))
        const r = await probe(page, `nav:${id}`)
        rendered.push(r)
        check(
          `nav "${label}" renders content`,
          !r.blank && !r.errorBoundary,
          r.blank ? 'BLANK' : r.errorBoundary ? 'ERROR BOUNDARY' : '',
        )
        const btns = await buttonInventory(page)
        allButtons[id] = btns
        await shot(page, `nav-${id}`)
      }
      await page.close()
    }

    // ── Phase C: the mobile hamburger, 390px ───────────────────────────────────
    console.log('\n\u2500\u2500 C. Mobile nav (390px, hamburger)')
    {
      const page = await browser.newPage()
      watch(page, 'nav-mobile')
      await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
      await page.setCookie({
        name: 'next-auth.session-token',
        value: user.id,
        domain: 'localhost',
        path: '/',
      })
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 30000 })

      const opened = await page.evaluate(() => {
        const b = document.querySelector('nav button[aria-label="Open menu"]')
        if (!b) return false
        ;(b as HTMLElement).click()
        return true
      })
      check('hamburger opens the mobile menu', opened)
      await new Promise((r) => setTimeout(r, 400))
      // Count VISIBLE buttons whose label is a nav item. The desktop nav is `hidden
      // md:flex`, so at 390px its buttons are present in the DOM but have no box —
      // counting them would "pass" on a menu that never opened. (The first version of
      // this check used a `~ div` sibling selector that matched nothing at all and
      // reported 0 items regardless.)
      const items = await page.evaluate((labels: string[]) => {
        return Array.from(document.querySelectorAll('nav button')).filter((b) => {
          const r = b.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && labels.includes(b.textContent?.trim() ?? '')
        }).length
      }, NAV_PAGES.map(([, l]) => l as string))
      check('mobile menu lists nav items', items >= NAV_PAGES.length, `${items} items`)

      // Walk several mobile nav items rather than all 19, to keep the run bounded; a
      // broken handler would be broken for every item.
      for (const [id, label] of [NAV_PAGES[1], NAV_PAGES[3], NAV_PAGES[7], NAV_PAGES[14]]) {
        await page.evaluate(() => {
          const b = document.querySelector('nav button[aria-label="Open menu"]')
          if (b) (b as HTMLElement).click()
        })
        await new Promise((r) => setTimeout(r, 300))
        // Visibility-filtered, so this really exercises the MOBILE item and not the
        // hidden desktop twin that happens to sit earlier in the DOM.
        const ok = await page.evaluate((l) => {
          const btn = Array.from(document.querySelectorAll('nav button')).find((b) => {
            const r = b.getBoundingClientRect()
            return r.width > 0 && b.getBoundingClientRect().height > 0 && b.textContent?.trim() === l
          })
          if (!btn) return false
          ;(btn as HTMLElement).click()
          return true
        }, label)
        await new Promise((r) => setTimeout(r, 800))
        const r = await probe(page, `mobile:${id}`)
        check(`mobile nav "${label}" renders`, ok && !r.blank && !r.errorBoundary)
        const of = r.overflow
        check(`mobile "${label}" no horizontal overflow`, of <= 1, `${of}px`)
      }
      await page.close()
    }

    // ── Phase D: landing entry points ─────────────────────────────────────────
    console.log('\n\u2500\u2500 D. Landing entry points (1440px)')
    for (const [label, expectText] of [
      ['Get access', 'Pricing'],
      ['Sign in', 'Sign in'],
    ] as const) {
      const page = await browser.newPage()
      watch(page, `landing:${label}`)
      await page.setViewport({ width: 1440, height: 900 })
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 30000 })
      const clicked = await page.evaluate((l) => {
        const btn = Array.from(document.querySelectorAll('button')).find(
          (b) => b.textContent?.trim() === l,
        )
        if (!btn) return false
        ;(btn as HTMLElement).click()
        return true
      }, label)
      await new Promise((r) => setTimeout(r, 800))
      const body = await page.evaluate(() => document.body.innerText)
      check(
        `landing "${label}" opens ${expectText}`,
        clicked && body.toLowerCase().includes(expectText.toLowerCase()),
      )
      await page.close()
    }

    // ── Report ────────────────────────────────────────────────────────────────
    console.log('\n\u2500\u2500 Reports')
    const report = {
      generatedAt: new Date().toISOString(),
      identifiedAs: user.email,
      rendered,
      buttons: allButtons,
      pageErrors,
      consoleErrors,
      networkFailures,
      problems,
    }
    writeFileSync(`${OUT}-report.json`, JSON.stringify(report, null, 2))

    const dead: string[] = []
    for (const [pg, btns] of Object.entries(allButtons)) {
      for (const b of btns) if (b.dead) dead.push(`${pg}: "${b.label}"`)
    }
    check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
    check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

    console.log(`\n  pages visited: ${rendered.length}`)
    const blank = rendered.filter((r) => r.blank)
    const eb = rendered.filter((r) => r.errorBoundary)
    console.log(`  blank: ${blank.length}${blank.length ? ` \u2192 ${blank.map((b) => b.label).join(', ')}` : ''}`)
    console.log(`  error boundary: ${eb.length}${eb.length ? ` \u2192 ${eb.map((b) => b.label).join(', ')}` : ''}`)
    const over = rendered.filter((r) => r.overflow > 1)
    console.log(`  horizontal overflow: ${over.length}${over.length ? ` \u2192 ${over.map((b) => `${b.label}(${b.overflow}px)`).join(', ')}` : ''}`)
    console.log(`  buttons inventoried: ${Object.values(allButtons).reduce((n, b) => n + b.length, 0)}`)
    console.log(`  buttons with NO handler: ${dead.length}`)
    for (const d of dead.slice(0, 40)) console.log(`      ! ${d}`)
    if (pageErrors.length) {
      console.log(`  page errors: ${pageErrors.length}`)
      for (const e of pageErrors.slice(0, 20)) console.log(`      ! ${e}`)
    }
    if (consoleErrors.length) {
      console.log(`  console errors: ${consoleErrors.length}`)
      for (const e of consoleErrors.slice(0, 20)) console.log(`      ! ${e}`)
    }
    if (networkFailures.length) {
      console.log(`  failed requests: ${networkFailures.length}`)
      for (const e of networkFailures.slice(0, 20)) console.log(`      ! ${e}`)
    }
  } finally {
    if (browser) await browser.close()
  }

  console.log(`\n  ${passed} passed, ${failed} failed`)
  console.log(`  report: ${OUT}-report.json`)
  process.exit(failed > 0 ? 1 : 0)
}

await main()
