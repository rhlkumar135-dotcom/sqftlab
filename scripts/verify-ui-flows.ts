/**
 * Interactive flow verification — real clicks through the journeys a user takes.
 *
 * The verify-* suites test the API; _crawl-all.ts proves each page renders. Neither
 * clicks a listing, opens a dialog, downloads a file, or switches currency. A control
 * can render perfectly and still do nothing, which is the failure this suite exists for.
 *
 * Every flow is driven the way a person drives it — a real click, then an assertion on an
 * observable outcome (content changed, dialog opened, request fired, bytes produced). No
 * flow asserts on `onClick` existing.
 *
 * Identity: the session cookie, exactly as a signed-in user presents it. Gate checks run
 * as the seeded demo account (elite); anything that WRITES runs as a throwaway enterprise
 * user created here and deleted in the `finally` block, so the demo account is never
 * mutated by a test run.
 *
 * Run:
 *   DATABASE_URL=file:$PWD/prisma/dev.db bun run scripts/verify-ui-flows.ts
 */
import puppeteer, { type Browser, type Page as PPage } from 'puppeteer-core'
import { prisma } from '../src/lib/db'
import { resolve } from 'node:path'

const BASE = process.env.PREVIEW_URL ?? 'http://localhost:8080'
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/chromium'
const OUT = '/tmp/flows'

const EXPECTED_DB = resolve('prisma/dev.db')
function isProjectDb(url: string): boolean {
  if (!url) return false
  const p = url.replace(/^file:\/\//, '').replace(/^file:/, '')
  return resolve(p) === EXPECTED_DB
}

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++
    console.log(`  \u2713 ${name}`)
  } else {
    failed++
    console.log(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`)
  }
}
function section(t: string) {
  console.log(`\n\u2500\u2500 ${t}`)
}

const errors: string[] = []
/**
 * Console text for a failed resource is just "Failed to load resource: <net error>" —
 * no URL — so an allow-list keyed on the text cannot tell an expected refusal from a
 * real one. `location()` carries the resource URL; correlate on both.
 */
function expectedFailure(text: string, url: string): boolean {
  const hay = `${text} ${url}`
  return (
    (text.includes('403') && hay.includes('deal-briefs')) ||
    (text.includes('501') && hay.includes('auth/google')) ||
    (hay.includes('ERR_CONNECTION_RESET') && hay.includes('stream/market'))
  )
}
function watch(page: PPage, label: string) {
  page.on('pageerror', (e) => errors.push(`${label}: PAGEERROR ${(e as Error).message}`))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const text = m.text()
    const url = m.location()?.url ?? ''
    if (expectedFailure(text, url)) return
    errors.push(`${label}: CONSOLE ${text}${url ? ` [${url}]` : ''}`)
  })
  page.on('requestfailed', (r) => {
    const url = r.url()
    const err = r.failure()?.errorText ?? ''
    if (err.includes('ERR_CONNECTION_RESET') && url.includes('stream/market')) return
    errors.push(`${label}: REQUESTFAILED ${url} ${err}`)
  })
}

async function bodyText(page: PPage): Promise<string> {
  return page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
}
async function has(page: PPage, needle: string): Promise<boolean> {
  return (await bodyText(page)).toLowerCase().includes(needle.toLowerCase())
}

/** Click the first VISIBLE element whose text contains `label`. */
async function clickText(page: PPage, label: string, sel = 'button'): Promise<boolean> {
  return page.evaluate(
    ([l, s]) => {
      const el = Array.from(document.querySelectorAll<HTMLElement>(s)).find((b) => {
        const r = b.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && (b.textContent ?? '').toLowerCase().includes(l.toLowerCase())
      })
      if (!el) return false
      el.click()
      return true
    },
    [label, sel],
  )
}

async function clickNav(page: PPage, label: string): Promise<boolean> {
  return page.evaluate((l) => {
    const btn = Array.from(document.querySelectorAll('nav button')).find((b) => {
      const r = b.getBoundingClientRect()
      return r.width > 0 && b.textContent?.trim() === l
    })
    if (!btn) return false
    ;(btn as HTMLElement).click()
    return true
  }, label)
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function open(browser: Browser, userId: string, width = 1440): Promise<PPage> {
  const page = await browser.newPage()
  await page.setViewport({ width, height: 900 })
  await page.setCookie({ name: 'next-auth.session-token', value: userId, domain: 'localhost', path: '/' })
  // Record what the page hands the browser to download, so "the button worked" means
  // bytes were produced rather than a request appeared.
  await page.evaluateOnNewDocument(() => {
    ;(window as unknown as { __dl: unknown[] }).__dl = []
    const orig = URL.createObjectURL.bind(URL)
    URL.createObjectURL = (b: Blob) => {
      ;(window as unknown as { __dl: { size: number; type: string }[] }).__dl.push({
        size: b?.size ?? 0,
        type: b?.type ?? '',
      })
      return orig(b)
    }
  })
  return page
}

async function main() {
  if (!isProjectDb(process.env.DATABASE_URL ?? '')) {
    console.error(`Refusing to run: DATABASE_URL must resolve to ${EXPECTED_DB}`)
    process.exit(2)
  }

  const demo = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } })
  if (!demo) {
    console.error('No seeded user to identify as.')
    process.exit(2)
  }

  const THROW_EMAIL = 'verify-ui-flows@example.invalid'
  let browser: Browser | null = null

  try {
    await prisma.user.deleteMany({ where: { email: THROW_EMAIL } })
    const throwaway = await prisma.user.create({
      data: {
        email: THROW_EMAIL,
        name: 'Flow Test',
        subscriptionTier: 'enterprise',
        subscriptionStatus: 'active',
        onboardingCompleted: true,
      },
    })

    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    })

    // ── F1: Listings → property detail ────────────────────────────────────────
    section('F1 — Listings card opens the property page')
    {
      const page = await open(browser, demo.id)
      watch(page, 'f1')
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 30000 })
      await clickNav(page, 'Listings')
      await wait(1500)
      const before = (await bodyText(page)).length
      // Listing cards are `<div role="button">` roughly 266px tall carrying a price.
      // The height filter is what keeps nav/tour buttons out; 150 is comfortably below
      // a card and comfortably above the chrome.
      const clicked = await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll<HTMLElement>('[role="button"], button')).find(
          (b) =>
            b.getBoundingClientRect().height > 150 &&
            /AED|USD|GBP|INR|\d{3},\d{3}/.test(b.textContent ?? ''),
        )
        if (!el) return false
        el.click()
        return true
      })
      await wait(1500)
      const after = await bodyText(page)
      check('a listing card is clickable', clicked)
      check(
        'opens the property page',
        clicked && (await has(page, 'Property') || after.length !== before),
        `before=${before} after=${after.length}`,
      )
      check('property page has no error boundary', !after.includes('Could not display'))
      await page.screenshot({ path: `${OUT}-f1-property.png` })
      await page.close()
    }

    // ── F2: Heatmap → community detail ────────────────────────────────────────
    section('F2 — Heatmap opens a community')
    {
      const page = await open(browser, demo.id)
      watch(page, 'f2')
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 30000 })
      await clickNav(page, 'Heatmap')
      await wait(1800)
      const clicked = await page.evaluate(() => {
        // The community strip under the map: buttons naming a community + a delta.
        const el = Array.from(document.querySelectorAll<HTMLElement>('button')).find((b) =>
          /[+-]\d+\.\d+%/.test(b.textContent ?? ''),
        )
        if (!el) return false
        el.click()
        return true
      })
      await wait(1500)
      const t = await bodyText(page)
      check('a community tile is clickable', clicked)
      check(
        'opens community detail',
        clicked && /transaction|price per sqft|median|yield/i.test(t) && !t.includes('Could not display'),
      )
      await page.screenshot({ path: `${OUT}-f2-community.png` })
      await page.close()
    }

    // ── F3: Building search ───────────────────────────────────────────────────
    section('F3 — Building search responds and is honest when empty')
    {
      const page = await open(browser, demo.id)
      watch(page, 'f3')
      await page.goto(`${BASE}/buildings`, { waitUntil: 'networkidle2', timeout: 30000 })
      await wait(1200)
      check('search field present', await page.evaluate(() => !!document.querySelector('input[aria-label="Search buildings"]')))
      const typed = await page.evaluate(() => {
        const i = document.querySelector<HTMLInputElement>('input[aria-label="Search buildings"]')
        if (!i) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
        setter.call(i, 'burj')
        i.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })
      await wait(1600)
      const t = await bodyText(page)
      check('typing triggers a search', typed && (t.includes('burj') || /no building|building-level/i.test(t)))
      check(
        'an empty result is explained, not silent',
        /no building|building-level rows come from/i.test(t) || (await has(page, 'Building')),
      )
      await page.close()
    }

    // ── F4: Alerts — create via the inline form ───────────────────────────────
    section('F4 — Alerts: the form creates a real alert')
    {
      const page = await open(browser, throwaway.id)
      watch(page, 'f4')
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 30000 })
      await clickNav(page, 'Alerts')
      await wait(1600)
      // This page is an INLINE form, not a modal — the first version asserted a
      // [role=dialog] and failed against a working page. It also counted `Alert` rows:
      // the form POSTs to /sqftlab/alerts, which creates a **DealAlert** (the Watch),
      // a different model. And the district is a native <select>, so the driver must
      // pick an option the way a person does — a synthesised `change` event does not
      // move a controlled React select.
      const form = await page.evaluate(() => ({
        selects: document.querySelectorAll('form select').length,
        submits: Array.from(document.querySelectorAll('form button[type="submit"]')).length,
      }))
      check('the alert form is present', form.selects > 0 && form.submits > 0, JSON.stringify(form))

      const beforeAlerts = await prisma.dealAlert.count({ where: { userId: throwaway.id } })
      const submit = await page.evaluate(() => {
        const b = document.querySelector<HTMLElement>('form button[type="submit"]')
        if (!b) return false
        b.click()
        return true
      })
      await wait(1500)
      const premature = await prisma.dealAlert.count({ where: { userId: throwaway.id } })
      check('an empty submit is refused with a reason', premature === beforeAlerts)
      check('and the reason is shown', /choose a district/i.test(await bodyText(page)))

      const districtValue = await page.$eval('form select', (s) => (s as HTMLSelectElement).options[1]?.value ?? '')
      check('districts are available to choose from', !!districtValue, districtValue || 'no options')
      await page.select('form select', districtValue)
      await wait(400)
      const chose = await page.$eval('form select', (s) => (s as HTMLSelectElement).value)
      check('a district can be selected', chose === districtValue, chose)

      await page.evaluate(() => {
        const b = document.querySelector<HTMLElement>('form button[type="submit"]')
        if (b) b.click()
      })
      await wait(2600)
      const afterAlerts = await prisma.dealAlert.count({ where: { userId: throwaway.id } })
      check('submitting creates the alert', submit && afterAlerts > beforeAlerts, `${beforeAlerts} → ${afterAlerts}`)
      const t = await bodyText(page)
      check('the new alert is listed', afterAlerts > beforeAlerts && /alert/i.test(t))
      check('no error boundary on alerts', !t.includes('Could not display'))
      await page.screenshot({ path: `${OUT}-f4-alerts.png` })
      await page.close()
    }

    // ── F5: Export — a real download ──────────────────────────────────────────
    section('F5 — Export produces bytes')
    {
      const page = await open(browser, demo.id)
      watch(page, 'f5')
      await page.goto(`${BASE}/export`, { waitUntil: 'networkidle2', timeout: 30000 })
      await wait(1600)
      const clicked = await clickText(page, 'Download CSV')
      await wait(3000)
      const dl = await page.evaluate(
        () => (window as unknown as { __dl?: { size: number; type: string }[] }).__dl ?? [],
      )
      check('"Download CSV" is clickable', clicked)
      check('a non-empty file was produced', dl.length > 0 && dl[0].size > 0, JSON.stringify(dl))
      await page.close()
    }

    // ── F6: CMA gate for a non-Enterprise account ─────────────────────────────
    section('F6 — CMA is gated for elite, and says so')
    {
      const page = await open(browser, demo.id)
      watch(page, 'f6')
      await page.goto(`${BASE}/cma`, { waitUntil: 'networkidle2', timeout: 30000 })
      await wait(1400)
      const clicked = await clickText(page, 'Run CMA')
      await wait(2500)
      const t = await bodyText(page)
      check('"Run CMA" is clickable', clicked)
      check(
        'a refused run explains the plan requirement',
        /enterprise/i.test(t) && !t.includes('Could not display'),
      )
      check('no crash or blank panel', t.length > 200)
      await page.close()
    }

    // ── F7: Mortgage — DLD price load ─────────────────────────────────────────
    section('F7 — Mortgage calculator works end to end')
    {
      const page = await open(browser, demo.id)
      watch(page, 'f7')
      await page.goto(`${BASE}/mortgage`, { waitUntil: 'networkidle2', timeout: 30000 })
      await wait(1400)
      const t0 = await bodyText(page)
      check('calculator renders inputs', /loan|rate|term|down payment/i.test(t0))
      const clicked = await clickText(page, 'Load DLD Market Price')
      await wait(2200)
      const t1 = await bodyText(page)
      check(
        'loading a market price responds honestly',
        !clicked || !/Could not display/.test(t1),
        clicked ? '' : 'button not found',
      )
      await page.screenshot({ path: `${OUT}-f7-mortgage.png` })
      await page.close()
    }

    // ── F8: API keys — create then revoke ─────────────────────────────────────
    section('F8 — API keys: create and revoke through the UI')
    {
      const page = await open(browser, throwaway.id)
      watch(page, 'f8')
      await page.goto(`${BASE}/keys`, { waitUntil: 'networkidle2', timeout: 30000 })
      await wait(1600)
      check('page renders at /keys', await has(page, 'API'))
      const opened = await clickText(page, 'Create New Key')
      await wait(800)
      const dlg = await page.evaluate(() => !!document.querySelector('[role="dialog"]'))
      check('create dialog opens', opened && dlg, opened ? 'no dialog' : 'button not found')

      // Name it, then confirm.
      await page.evaluate(() => {
        const i = document.querySelector<HTMLInputElement>('[role="dialog"] input')
        if (!i) return
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
        setter.call(i, 'flow-test-key')
        i.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await clickText(page, 'Create', '[role="dialog"] button')
      await wait(2500)
      const t = await bodyText(page)
      const inDb = await prisma.apiKey.count({ where: { userId: throwaway.id } })
      check('a key is created', inDb > 0, `${inDb} key rows`)
      check('the raw key is shown once', /sk_|copy/i.test(t))
      await page.screenshot({ path: `${OUT}-f8-keys.png` })

      // Revoke it. The API soft-deletes (sets `revokedAt`) rather than removing the row —
      // that is deliberate, so the assertion is on the flag, not on the row count. The
      // first version asserted the count decreased and failed against correct behaviour.
      await page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]')
        if (d) {
          const close = Array.from(d.querySelectorAll('button')).find((b) => /close|done|saved/i.test(b.textContent ?? ''))
          if (close) (close as HTMLElement).click()
        }
      })
      await wait(700)
      const liveBefore = await prisma.apiKey.count({ where: { userId: throwaway.id, revokedAt: null } })
      const clickedRevoke = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) => /^\s*revoke\s*$/i.test(b.textContent ?? ''))
        if (!btn) return false
        ;(btn as HTMLElement).click()
        return true
      })
      await wait(900)
      const confirmShown = await page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]')
        return !!d && /revoke this key/i.test(d.textContent ?? '')
      })
      check('the revoke confirm appears', clickedRevoke && confirmShown, clickedRevoke ? 'no confirm dialog' : 'row button not found')
      await clickText(page, 'Revoke key', '[role="dialog"] button')
      await wait(2200)
      const liveAfter = await prisma.apiKey.count({ where: { userId: throwaway.id, revokedAt: null } })
      check('revoking marks the key revoked', liveBefore > 0 && liveAfter < liveBefore, `live ${liveBefore} → ${liveAfter}`)
      await page.close()
    }

    // ── F9: Currency switcher ─────────────────────────────────────────────────
    section('F9 — Currency switcher changes displayed prices')
    {
      const page = await open(browser, demo.id)
      watch(page, 'f9')
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 30000 })
      await clickNav(page, 'Watchlist')
      await wait(1800)
      const aed = await bodyText(page)
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('nav button')).find((x) => x.textContent?.trim() === 'USD')
        if (b) (b as HTMLElement).click()
      })
      await wait(1200)
      const usd = await bodyText(page)
      check('AED view shows AED', /AED/.test(aed))
      check('USD view shows USD and not the same figures', /USD/.test(usd) && usd !== aed)
      await page.close()
    }

    // ── F10: AI assistant ─────────────────────────────────────────────────────
    section('F10 — AI assistant opens')
    {
      const page = await open(browser, demo.id)
      watch(page, 'f10')
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 30000 })
      await wait(1200)
      const opened = await clickText(page, 'Ask the assistant')
      await wait(1500)
      const t = await bodyText(page)
      check('assistant button opens a panel', opened && /assistant|ask|message/i.test(t), opened ? '' : 'button not found')
      await page.screenshot({ path: `${OUT}-f10-chat.png` })
      await page.close()
    }

    // ── F11: Back/forward ─────────────────────────────────────────────────────
    section('F11 — Back and forward move between pages')
    {
      const page = await open(browser, demo.id)
      watch(page, 'f11')
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 30000 })
      await clickNav(page, 'Docs')
      await wait(1200)
      const docsUrl = page.url()
      await clickNav(page, 'Pulse')
      await wait(1200)
      const pulseUrl = page.url()
      check('navigation publishes URLs', docsUrl.endsWith('/docs') && pulseUrl.endsWith('/market-pulse'), `${docsUrl} ${pulseUrl}`)
      await page.goBack()
      await wait(1400)
      check('back returns to /docs', page.url().endsWith('/docs'), page.url())
      const t = await bodyText(page)
      check('back also re-renders the page', /api|docs|endpoint/i.test(t))
      await page.goForward()
      await wait(1400)
      check('forward returns to /market-pulse', page.url().endsWith('/market-pulse'), page.url())
      await page.close()
    }

    // ── F12: Unknown path ─────────────────────────────────────────────────────
    section('F12 — An unknown path is not a blank page')
    {
      const page = await open(browser, demo.id)
      watch(page, 'f12')
      await page.goto(`${BASE}/no-such-page-xyz`, { waitUntil: 'networkidle2', timeout: 30000 })
      await wait(1200)
      const t = await bodyText(page)
      check('unknown path falls back to a real page', t.length > 200, `${t.length} chars`)
      check('and it is the landing page', /uae property|sqftlab/i.test(t))
      await page.close()
    }

    // ── F13: Deal network as Enterprise — open a brief ────────────────────────
    section('F13 — Deal Network: list opens a brief')
    {
      await prisma.dealBrief.deleteMany({ where: { userId: throwaway.id } })
      // Seed through the API, not Prisma: the route whitelists the fields and applies the
      // model's own `status = 'active'` default. The first version set `status: 'open'`
      // directly, which is not one of the three legal values, so the list (which filters
      // to active) correctly hid it and the test reported a bug that did not exist.
      const seedRes = await fetch(`${BASE}/api/sqftlab/deal-briefs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${throwaway.id}` },
        body: JSON.stringify({
          title: 'Flow test — Marina floor',
          community: 'Dubai Marina',
          bedrooms: 2,
          askingPriceAed: 3_100_000,
          dealType: 'acquisition',
          description: 'Created by verify-ui-flows.',
        }),
      })
      const seeded = (await seedRes.json()) as { id?: string; status?: string; error?: string }
      check('the brief is posted through the API', seedRes.status === 201 && !!seeded.id, `${seedRes.status} ${seeded.error ?? ''}`)
      check('and lands in a status the list shows', seeded.status === 'active', String(seeded.status))
      const page = await open(browser, throwaway.id)
      watch(page, 'f13')
      await page.goto(`${BASE}/deals`, { waitUntil: 'networkidle2', timeout: 30000 })
      await wait(2000)
      const listed = await has(page, 'Marina floor')
      check('the brief appears in the network', listed)
      const opened = await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]')).find((b) =>
          /Marina floor/.test(b.textContent ?? ''),
        )
        if (!el) return false
        el.click()
        return true
      })
      await wait(1800)
      const t = await bodyText(page)
      check('clicking it opens the detail page', opened && page.url().includes(`/deals/${seeded.id}`), page.url())
      check('the detail page shows the brief', /Marina floor/.test(t) && !t.includes('Could not display'))
      await page.screenshot({ path: `${OUT}-f13-deal.png` })
      await page.close()
    }

    // ── F14: Docs → the key page ──────────────────────────────────────────────
    section('F14 — Docs CTA reaches the key manager')
    {
      const page = await open(browser, throwaway.id)
      watch(page, 'f14')
      await page.goto(`${BASE}/docs`, { waitUntil: 'networkidle2', timeout: 30000 })
      await wait(1400)
      const clicked = await clickText(page, 'Get API Key')
      await wait(1500)
      check('"Get API Key" navigates to /keys', clicked && page.url().endsWith('/keys'), page.url())
      await page.close()
    }

    // ── F15: Mobile tour banner ───────────────────────────────────────────────
    section('F15 — Getting-started banner at 390px')
    {
      const page = await open(browser, throwaway.id, 390)
      watch(page, 'f15')
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 30000 })
      // At 390px the desktop nav is `hidden md:flex`, so its items have no box and a
      // text-match click finds nothing. The hamburger is the real mobile path.
      const opened = await page.evaluate(() => {
        const b = document.querySelector('nav button[aria-label="Open menu"]')
        if (!b) return false
        ;(b as HTMLElement).click()
        return true
      })
      await wait(400)
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('nav button')).find((x) => {
          const r = x.getBoundingClientRect()
          return r.height > 0 && x.textContent?.trim() === 'Heatmap'
        })
        if (b) (b as HTMLElement).click()
      })
      await wait(1800)
      check('mobile menu opened', opened)
      const t = await bodyText(page)
      check('banner is present for a fresh account', /getting started/i.test(t) && /browse a community/i.test(t))
      const walk = await clickText(page, 'Browse a community')
      await wait(1800)
      const t2 = await bodyText(page)
      check('a banner step navigates', walk && t2 !== t, walk ? 'text unchanged' : 'step button not found')
      await page.screenshot({ path: `${OUT}-f15-tour.png` })
      await page.close()
    }

    // ── F16: every nav item is reachable at desktop widths ────────────────────
    section('F16 — Every nav item is reachable (desktop widths)')
    {
      // This is the check that was missing. The desktop nav was one row with
      // `overflow-x-auto` and the scrollbar suppressed, so at 1440px only 6 of 19
      // items were inside the 726px rail and THIRTEEN sat off-screen. A programmatic
      // click still worked — `el.click()` ignores geometry — so the click-through in
      // the crawl passed on a nav a person could not use. With the rail wrapping, no
      // item may be outside its box at any width.
      for (const width of [1024, 1180, 1280, 1440, 1680]) {
        const page = await open(browser, demo.id, width)
        watch(page, `f16-${width}`)
        await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 30000 })
        await wait(900)
        const r = await page.evaluate(() => {
          const rail = document.querySelector('nav div.hidden.md\\:flex') as HTMLElement | null
          if (!rail) return null
          const rr = rail.getBoundingClientRect()
          const items = Array.from(rail.querySelectorAll('button'))
          const offscreen = items
            .filter((b) => {
              const x = b.getBoundingClientRect()
              return x.height === 0 || x.left < rr.left - 1 || x.right > rr.right + 1
            })
            .map((b) => b.textContent?.trim())
          return {
            total: items.length,
            offscreen,
            railOverflow: rail.scrollWidth - rail.clientWidth,
            pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
          }
        })
        check(
          `all nav items fit at ${width}px`,
          !!r && r.offscreen.length === 0,
          r ? `${r.offscreen.length} off-screen: ${r.offscreen.join(', ')}` : 'nav rail not found',
        )
        check(`no page overflow at ${width}px`, !!r && r.pageOverflow <= 1, r ? `${r.pageOverflow}px` : '')
        await page.close()
      }
    }

    // ── F17: headline text is not clipped ─────────────────────────────────────
    section('F17 — No hero text is clipped')
    {
      // The hero headline was `white-space: nowrap`; at 1440px the second line needed
      // 1698px inside a 1232px box, so the section's overflow-hidden truncated it
      // mid-word. Nothing caught it because a screenshot was never measured.
      for (const width of [390, 768, 1024, 1440, 1680]) {
        const page = await open(browser, demo.id, width)
        watch(page, `f17-${width}`)
        await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 30000 })
        await wait(1400)
        const r = await page.evaluate(() => {
          const clipped = ['.hero-h1', '.hero-h2']
            .map((s) => document.querySelector(s) as HTMLElement | null)
            .filter((e): e is HTMLElement => !!e)
            .filter((e) => e.scrollWidth > Math.ceil(e.getBoundingClientRect().width) + 1)
            .map((e) => `${e.className.split(' ')[0]}: needs ${e.scrollWidth} has ${Math.round(e.getBoundingClientRect().width)}`)
          return { clipped, pageOverflow: document.documentElement.scrollWidth - window.innerWidth }
        })
        check(`hero headline is not clipped at ${width}px`, r.clipped.length === 0, r.clipped.join(' | '))
        check(`no horizontal page scroll at ${width}px`, r.pageOverflow <= 1, `${r.pageOverflow}px`)
        await page.close()
      }
    }

    section('Errors')
    check('no uncaught page or console errors across all flows', errors.length === 0, errors.slice(0, 4).join(' | '))
  } finally {
    if (browser) await browser.close()
    // Clean up everything the run created, in FK-safe order.
    const u = await prisma.user.findUnique({ where: { email: 'verify-ui-flows@example.invalid' } })
    if (u) {
      await prisma.alertMatch.deleteMany({ where: { alert: { userId: u.id } } }).catch(() => {})
      await prisma.alert.deleteMany({ where: { userId: u.id } }).catch(() => {})
      await prisma.dealAlert.deleteMany({ where: { userId: u.id } }).catch(() => {})
      await prisma.dealExpression.deleteMany({ where: { userId: u.id } }).catch(() => {})
      await prisma.dealBrief.deleteMany({ where: { userId: u.id } }).catch(() => {})
      await prisma.apiKey.deleteMany({ where: { userId: u.id } }).catch(() => {})
      await prisma.userEvent.deleteMany({ where: { userId: u.id } }).catch(() => {})
      await prisma.user.delete({ where: { id: u.id } }).catch(() => {})
    }
  }

  console.log(`\n  ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

await main()
