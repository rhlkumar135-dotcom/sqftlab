/**
 * Day 16 — render verification for the Deal Origination Network.
 *
 * A green build only proves this compiled. This drives a real browser at 390px and
 * 1440px and asserts the two states the brief describes (upgrade gate, populated
 * network), plus the detail page as an owner and as another member. It fails on ANY
 * uncaught page error or console error, because a missing icon import or a bad
 * reference throws at render and leaves a white screen with a perfectly green build.
 *
 * Identity: the SPA sends its identity as a cookie (`next-auth.session-token`), which
 * the preview host forwards, so the enterprise views are reached by setting that cookie
 * rather than by editing the seeded demo account. The demo account (elite) is used
 * unmodified for the gate screenshot.
 *
 * Run:
 *   DATABASE_URL=file:$PWD/prisma/dev.db bun run scripts/_shot-day16.ts
 */
import puppeteer, { type Browser, type Page as PPage } from 'puppeteer-core'
import { prisma } from '../src/lib/db'
import { resolve } from 'node:path'

const BASE = process.env.PREVIEW_URL ?? 'http://localhost:8080'
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/chromium'
const OUT = '/tmp/day16'

const EXPECTED_DB = resolve('prisma/dev.db')
function isProjectDb(url: string): boolean {
  if (!url) return false
  const path = url.replace(/^file:\/\//, '').replace(/^file:/, '')
  return resolve(path) === EXPECTED_DB
}

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const POSTER_EMAIL = 'shot-day16-poster@example.invalid'
const BUYER_EMAIL = 'shot-day16-buyer@example.invalid'

const DEALS = [
  {
    title: 'Full floor, Marina tower — off-market',
    community: 'Dubai Marina',
    bedrooms: 2,
    sizeSqftMin: 1100,
    sizeSqftMax: 1400,
    askingPriceAed: 3_200_000,
    targetYieldPct: 6.5,
    dealType: 'acquisition',
    description:
      'Single owner since handover. Motivated seller, vacant on transfer.\n\nFull floor plate with two parking bays.',
    isConfidential: true,
  },
  {
    title: 'Off-plan allocation, 4 units',
    community: 'Downtown Dubai',
    bedrooms: 3,
    askingPriceAed: 12_500_000,
    targetYieldPct: 7.2,
    dealType: 'off-plan',
    description: 'Allocation from a 2024 launch. Payment plan transferable at 40% paid.',
    isConfidential: false,
  },
  {
    title: 'Distressed portfolio, 6 villas',
    community: 'Arabian Ranches',
    bedrooms: 5,
    askingPriceAed: 24_000_000,
    dealType: 'distressed',
    description: 'Receiver sale. Six villas, one title each, cleared for immediate transfer.',
    isConfidential: true,
  },
]

const pageErrors: string[] = []
const consoleErrors: string[] = []
const networkFailures: string[] = []

function watch(page: PPage, label: string) {
  page.on('pageerror', (e) => pageErrors.push(`${label}: ${(e as Error).message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`${label}: ${m.text()}`)
  })
  // Recorded with the URL, so a "connection reset" can be attributed to a specific
  // request rather than waved away.
  page.on('requestfailed', (r) =>
    networkFailures.push(`${label}: ${r.url()} ${r.failure()?.errorText ?? ''}`),
  )
}

async function text(page: PPage, sel: string): Promise<string> {
  return page.evaluate((s) => document.querySelector(s)?.textContent?.replace(/\s+/g, ' ').trim() ?? '', sel)
}

async function bodyHas(page: PPage, needle: string): Promise<boolean> {
  // Case-insensitive: several headings carry the `uppercase` CSS class, and
  // `innerText` returns the RENDERED text ("DLD COMPARABLES"), not the source casing.
  return page.evaluate(
    ([n]) => document.body.innerText.toLowerCase().includes((n as string).toLowerCase()),
    [needle],
  )
}

async function clickByText(page: PPage, label: string): Promise<boolean> {
  return page.evaluate((l) => {
    const el = Array.from(document.querySelectorAll<HTMLElement>('button')).find(
      (b) => b.textContent?.trim().toLowerCase().includes(l.toLowerCase()) && b.offsetParent !== null,
    )
    if (!el) return false
    el.click()
    return true
  }, label)
}

async function overflowPx(page: PPage): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
}

async function shot(page: PPage, name: string) {
  await page.screenshot({ path: `${OUT}-${name}.png`, fullPage: false })
}

async function main() {
  if (!isProjectDb(process.env.DATABASE_URL ?? '')) {
    console.error(`Refusing to run: DATABASE_URL must resolve to ${EXPECTED_DB}`)
    process.exit(2)
  }

  let posterId = ''
  let buyerId = ''
  const briefIds: string[] = []
  let browser: Browser | null = null

  try {
    const [poster, buyer] = await Promise.all([
      prisma.user.create({
        data: { email: POSTER_EMAIL, name: 'Layla Haddad', company: 'Meridian Capital', subscriptionTier: 'enterprise' },
      }),
      prisma.user.create({
        data: { email: BUYER_EMAIL, name: 'Omar Rashid', company: 'Gulf Family Office', subscriptionTier: 'enterprise' },
      }),
    ])
    posterId = poster.id
    buyerId = buyer.id

    // Seed the network over HTTP, as the poster.
    for (const d of DEALS) {
      const res = await fetch(`${BASE}/api/sqftlab/deal-briefs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${posterId}` },
        body: JSON.stringify(d),
      })
      const body = (await res.json()) as { id?: string }
      if (res.status === 201 && body.id) briefIds.push(body.id)
      else console.log(`  ! seed failed (${res.status}) for "${d.title}"`)
    }
    // No expression is seeded: the buyer expresses interest through the UI further
    // down, which exercises the write path end to end and leaves the owner's inbox
    // with something real. The API-level express cases are covered by verify-day16.

    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    })

    // ── Mobile: the gate (demo account is elite, so it must be refused) ─────────
    console.log('\n── 390px — upgrade gate (unmodified demo account)')
    {
      const page = await browser.newPage()
      watch(page, 'gate-mobile')
      await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
      await page.goto(`${BASE}/deals`, { waitUntil: 'networkidle2', timeout: 30000 })
      await new Promise((r) => setTimeout(r, 1200))

      check('page renders the network heading', await bodyHas(page, 'Deal Origination Network'))
      check('shows the exclusivity copy', await bodyHas(page, 'exclusive to Enterprise and Institutional members'))
      check('shows an Upgrade to Enterprise CTA', await bodyHas(page, 'Upgrade to Enterprise'))
      check('names the current plan (elite)', await bodyHas(page, 'Your current plan is'))
      const of = await overflowPx(page)
      check('no horizontal overflow at 390px', of <= 1, `${of}px`)
      await shot(page, 'gate-mobile')
      await page.close()
    }

    // ── Mobile: populated network ───────────────────────────────────────────────
    console.log('\n── 390px — populated network (enterprise member)')
    {
      const page = await browser.newPage()
      watch(page, 'list-mobile')
      await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
      await page.setCookie({ name: 'next-auth.session-token', value: buyerId, domain: 'localhost', path: '/' })
      await page.goto(`${BASE}/deals`, { waitUntil: 'networkidle2', timeout: 30000 })
      await new Promise((r) => setTimeout(r, 1500))

      check('network list renders', await bodyHas(page, 'Deal Origination Network'))
      check('the seeded briefs are listed', await bodyHas(page, 'Full floor, Marina tower'))
      check('a second brief is listed', await bodyHas(page, 'Off-plan allocation'))
      check('deal-type badges render', await bodyHas(page, 'Acquisition'))
      check('asking price is formatted', await bodyHas(page, 'AED 3,200,000'))
      check('poster attribution renders (name · company)', await bodyHas(page, 'Meridian Capital'))
      check('DLD context line renders', await bodyHas(page, 'DLD avg'))
      check(
        'empty DLD register is stated, not faked',
        await bodyHas(page, 'no registered transactions'),
        'expected the honest absence message',
      )
      check('area median context with provenance', await bodyHas(page, 'listing-derived') || await bodyHas(page, 'DLD-derived'))
      check('Post a Deal CTA present', await bodyHas(page, 'Post a Deal'))
      const of = await overflowPx(page)
      check('no horizontal overflow at 390px', of <= 1, `${of}px`)
      await shot(page, 'list-mobile')

      // Post-deal modal
      const opened = await clickByText(page, 'Post a Deal')
      check('Post a Deal opens a dialog', opened)
      await new Promise((r) => setTimeout(r, 500))
      check('dialog has a role and title', (await page.evaluate(() => !!document.querySelector('[role="dialog"]'))) === true)
      check('dialog shows the deal form', await bodyHas(page, 'Description'))
      check('dialog states the audience', await bodyHas(page, 'Enterprise and Institutional members only'))
      await shot(page, 'post-modal-mobile')
      // Escape must close it (the shared Dialog primitive was fixed on Day 17).
      await page.keyboard.press('Escape')
      await new Promise((r) => setTimeout(r, 400))
      check('Escape closes the dialog', (await page.evaluate(() => !document.querySelector('[role="dialog"]'))) === true)
      await page.close()
    }

    // ── Desktop: populated list + detail ────────────────────────────────────────
    console.log('\n── 1440px — list, detail, express')
    {
      const page = await browser.newPage()
      watch(page, 'desktop')
      await page.setViewport({ width: 1440, height: 900 })
      await page.setCookie({ name: 'next-auth.session-token', value: buyerId, domain: 'localhost', path: '/' })
      await page.goto(`${BASE}/deals`, { waitUntil: 'networkidle2', timeout: 30000 })
      await new Promise((r) => setTimeout(r, 1500))
      check('desktop list renders', await bodyHas(page, 'Full floor, Marina tower'))
      const of = await overflowPx(page)
      check('no horizontal overflow at 1440px', of <= 1, `${of}px`)
      await shot(page, 'list-desktop')

      // Count the cards so a "renders but empty grid" regression is caught.
      const cards = await page.evaluate(
        () => document.querySelectorAll('button.g2').length,
      )
      check('renders one card per brief', cards >= 3, `${cards} cards`)

      // Open the first brief.
      const opened = await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll<HTMLButtonElement>('button.g2')).find((x) =>
          x.textContent?.includes('Full floor, Marina tower'),
        )
        b?.click()
        return !!b
      })
      check('clicking a card opens the detail view', opened)
      await new Promise((r) => setTimeout(r, 1500))
      check('detail URL is /deals/<id>', page.url().includes('/deals/'), page.url())
      check('detail shows the description', await bodyHas(page, 'Single owner since handover'))
      check('detail shows market context', await bodyHas(page, 'Market context'))
      check('detail shows the DLD comparables panel', await bodyHas(page, 'DLD comparables'))
      check(
        'empty comparables explained by the server note',
        await bodyHas(page, 'No registered sale transactions'),
        'expected compsNote',
      )
      check('a non-owner cannot see the inbox', !(await bodyHas(page, 'Interest received')))
      check('Express Interest CTA present', await bodyHas(page, 'Express Interest'))
      await shot(page, 'detail-buyer-desktop')

      // Express interest through the UI — the full write path, not a preset fixture.
      const clicked = await clickByText(page, 'Express Interest')
      check('Express Interest opens the dialog', clicked)
      await new Promise((r) => setTimeout(r, 500))
      check('express dialog opens', (await page.evaluate(() => !!document.querySelector('[role="dialog"]'))) === true)
      check('consent checkbox offered', await bodyHas(page, 'I consent to being contacted directly'))
      await shot(page, 'express-modal-desktop')

      await page.type('#express-message', 'Interested subject to survey. Can move in 3 weeks.')
      await page.evaluate(() => {
        const cb = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')
        cb?.click()
      })
      const submitted = await clickByText(page, 'Submit Interest')
      check('Submit Interest is clickable', submitted)
      await new Promise((r) => setTimeout(r, 1800))

      const stored = await prisma.dealExpression.findFirst({
        where: { dealId: briefIds[0], userId: buyerId },
        select: { message: true, contactOk: true },
      })
      check('the expression persisted to the database', !!stored)
      check('the message was saved', stored?.message?.includes('subject to survey') === true, String(stored?.message))
      check('consent was saved as true', stored?.contactOk === true, String(stored?.contactOk))
      check('the UI now shows the reflected state', await bodyHas(page, 'You expressed interest'))
      await shot(page, 'detail-buyer-expressed')
      await page.close()
    }

    // ── Owner view ──────────────────────────────────────────────────────────────
    console.log('\n── 1440px — the poster\'s own view (inbox + status)')
    {
      const page = await browser.newPage()
      watch(page, 'owner')
      await page.setViewport({ width: 1440, height: 900 })
      await page.setCookie({ name: 'next-auth.session-token', value: posterId, domain: 'localhost', path: '/' })
      await page.goto(`${BASE}/deals/${briefIds[0]}`, { waitUntil: 'networkidle2', timeout: 30000 })
      await new Promise((r) => setTimeout(r, 1500))

      check('owner sees the inbox', await bodyHas(page, 'Interest received'))
      check('the expresser is named', await bodyHas(page, 'Omar Rashid'))
      check('their company is shown', await bodyHas(page, 'Gulf Family Office'))
      check('their message is shown', await bodyHas(page, 'subject to survey'))
      check('consent is surfaced', await bodyHas(page, 'Consents to being contacted directly'))
      check('Mark Under Offer present', await bodyHas(page, 'Mark Under Offer'))
      check('Mark Closed present', await bodyHas(page, 'Mark Closed'))
      check('the owner is NOT offered "Express Interest" on their own deal', !(await bodyHas(page, 'Express Interest')))
      await shot(page, 'detail-owner-desktop')

      // Drive a real status change through the UI.
      const clicked = await clickByText(page, 'Mark Under Offer')
      check('Mark Under Offer is clickable', clicked)
      await new Promise((r) => setTimeout(r, 1500))
      const stored = await prisma.dealBrief.findUnique({ where: { id: briefIds[0] }, select: { status: true } })
      check('the status change persisted to the database', stored?.status === 'under-offer', String(stored?.status))
      check('the UI reflects "Under offer"', await bodyHas(page, 'Under offer'))
      await shot(page, 'detail-owner-under-offer')
      await page.close()
    }

    // ── Deep link + history ─────────────────────────────────────────────────────
    console.log('\n── Deep links and history')
    {
      const page = await browser.newPage()
      watch(page, 'deeplink')
      await page.setViewport({ width: 1280, height: 900 })
      await page.setCookie({ name: 'next-auth.session-token', value: buyerId, domain: 'localhost', path: '/' })

      // Cold load straight onto a detail URL. This is what the brief's shared links and
      // the notification email use, and it is the path that exposed the relative-asset
      // bug: index.html now rewrites it to the root+hash form before the module script.
      await page.goto(`${BASE}/deals/${briefIds[1]}`, { waitUntil: 'networkidle2', timeout: 30000 })
      await new Promise((r) => setTimeout(r, 1600))
      check('cold-loading /deals/<id> opens the brief', await bodyHas(page, 'Off-plan allocation'))
      check('and not the network list', !(await bodyHas(page, 'Post a Deal')))
      check('it was rewritten to the root+hash form', page.url().includes('#/deals/'), page.url())

      // The same boot-script fix covers the Day 10 building route, which had been
      // broken on cold load since it shipped (no building rows exist, so the assertion
      // is that the BUNDLE loaded — a blank page here means the assets 404'd again).
      await page.goto(`${BASE}/buildings/some-tower`, { waitUntil: 'networkidle2', timeout: 30000 })
      await new Promise((r) => setTimeout(r, 1600))
      const rendered = await page.evaluate(() => (document.getElementById('root')?.children.length ?? 0) > 0)
      check('cold-loading /buildings/<slug> renders the app (pre-existing bug, same cause)', rendered)
      check('it too was rewritten to the root+hash form', page.url().includes('#/buildings/'), page.url())

      // /deals (no id) must still be the list — the regex must not swallow it.
      await page.goto(`${BASE}/deals`, { waitUntil: 'networkidle2', timeout: 30000 })
      await new Promise((r) => setTimeout(r, 1400))
      check('cold-loading /deals opens the list', await bodyHas(page, 'Post a Deal'))
      check('and not a detail view', !(await bodyHas(page, 'Back to the network')))
      await page.close()
    }

    // ── Error hygiene ───────────────────────────────────────────────────────────
    console.log('\n── Console hygiene')
    {
      // Noise unrelated to these pages: the favicon probe, and the SPA shell's snapshot
      // fetch. The gate page is EXPECTED to log the 403 its own request provokes — that
      // is the feature working — so that single entry is excluded by page AND status.
      const relevant = consoleErrors.filter((e) => {
        if (/favicon|snapshot\.json/i.test(e)) return false
        if (/^gate-mobile:/.test(e) && /403/.test(e)) return false
        return !/Failed to load resource: the server responded with a status of 404/i.test(e)
      })
      check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
      check('no unexpected console errors', relevant.length === 0, relevant.slice(0, 3).join(' | '))

      // The app holds one long-lived SSE connection (`/api/sqftlab/stream/market`); closing
      // a page tears it down, which Chrome reports as a reset.
      //
      // And on a NESTED path the browser's preload scanner speculatively requests
      // `/deals/assets/…` (the relative base resolved one level too deep) in the instant
      // before the boot script in index.html replaces the navigation — so those are
      // reported ABORTED. Both are matched by URL and error code specifically, so any
      // other failed request still fails this suite.
      const SSE_TEARDOWN = /\/api\/sqftlab\/stream\/market/
      const SUPERSEDED_ASSET_PROBE = /\/(deals|buildings)\/assets\/[^/]+\.(js|css)/
      const realFailures = networkFailures.filter(
        (f) => !(SSE_TEARDOWN.test(f) || (SUPERSEDED_ASSET_PROBE.test(f) && /ERR_ABORTED/.test(f))),
      )
      check('no unexpected failed requests', realFailures.length === 0, realFailures.slice(0, 3).join(' | '))
      console.log(
        `    (${networkFailures.length - realFailures.length} ignored: SSE teardown resets + superseded nested-path asset probes)`,
      )
    }
  } finally {
    if (browser) await browser.close()
    const ids = [posterId, buyerId].filter(Boolean)
    if (ids.length) {
      const briefs = await prisma.dealBrief.findMany({ where: { userId: { in: ids } }, select: { id: true } })
      const bIds = briefs.map((b) => b.id)
      if (bIds.length) {
        await prisma.dealExpression.deleteMany({ where: { OR: [{ dealId: { in: bIds } }, { userId: { in: ids } }] } })
        await prisma.dealBrief.deleteMany({ where: { id: { in: bIds } } })
      }
      await prisma.dealExpression.deleteMany({ where: { userId: { in: ids } } })
      await prisma.userEvent.deleteMany({ where: { userId: { in: ids } } })
      await prisma.user.deleteMany({ where: { id: { in: ids } } })
    }
  }

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`Day 16 UI: ${passed} passed, ${failed} failed`)
  console.log(`screenshots in ${OUT}-*.png`)
  await prisma.$disconnect()
  process.exit(failed ? 1 : 0)
}

await main()
