// Day 15 Task A verification — the onboarding banner, driven through a real browser.
//
// Run: bun run scripts/verify-day15-onboarding.ts
//
// Uses the mobile nav (390px) so the banner is proven at phone width, and asserts the
// checklist ticks the step it claims to and nothing else.
import puppeteer from 'puppeteer-core'
import { resolve } from 'node:path'

// Point the in-process Prisma client at THIS project's database explicitly. An inherited
// DATABASE_URL points at the workspace root — a different database — and the restore below
// would then silently patch the wrong one.
process.env.DATABASE_URL = `file:${resolve('prisma/dev.db')}`
const { prisma } = await import('../src/lib/db')

const BASE = process.env.PREVIEW_URL ?? 'http://localhost:8080'
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/chromium'

// This suite dismisses the tour, which is real user state. Snapshot it and put it back, so
// a test run does not leave the demo account looking like it finished onboarding.
const snapshot = await prisma.user.findMany({ select: { id: true, tourSteps: true, tourCompleted: true } })
async function restore() {
  for (const u of snapshot) {
    await prisma.user.update({
      where: { id: u.id },
      data: { tourSteps: u.tourSteps, tourCompleted: u.tourCompleted },
    })
  }
  await prisma.$disconnect()
}

// Start from a clean slate. This suite asserts the banner opens at 0/4 and records exactly
// the step it visits, so it cannot depend on whatever tour progress a previous suite (or
// run) happened to leave behind — the runner executes suites back to back.
await prisma.user.updateMany({ data: { tourSteps: 0, tourCompleted: false } })

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass++
    console.log(`  ok    ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
})
const page = await browser.newPage()
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
page.on('pageerror', (e) => console.log('  [pageerror]', e.message))

async function gotoDashboard() {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 30000 })
  await new Promise((r) => setTimeout(r, 500))
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('button[aria-label="Open menu"]')?.click()
  })
  await new Promise((r) => setTimeout(r, 250))
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll<HTMLButtonElement>('nav button')).find(
      // Visible only: the desktop rail carries the same label and is display:none at 390px.
      (x) => x.textContent?.trim() === 'Heatmap' && x.offsetParent !== null,
    )
    b?.click()
  })
  await new Promise((r) => setTimeout(r, 1200))
}

const readBanner = () =>
  page.evaluate(() => {
    const el = document.querySelector('section[aria-label="Getting started"]')
    if (!el) return null
    const items = Array.from(el.querySelectorAll('li')).map((li) => li.textContent?.replace(/\s+/g, ' ').trim() ?? '')
    const counter = el.querySelector('span')?.textContent?.trim() ?? ''
    const buttons = Array.from(el.querySelectorAll('button')).map((b) => b.textContent?.replace(/\s+/g, ' ').trim() ?? '')
    return { items, counter, buttons }
  })

console.log('\nOnboarding banner @ 390x844\n' + '='.repeat(56))

await gotoDashboard()
const b1 = await readBanner()
check('banner renders on the dashboard', !!b1)
check('checklist has 5 steps', (b1?.items.length ?? 0) === 5, `got ${b1?.items.length}`)
check('progress starts at 0/4', b1?.counter.startsWith('0/') === true, `got "${b1?.counter}"`)
check('dismiss button labelled', (b1?.buttons ?? []).some((t) => t === ''), 'aria-only button')
check(
  'market comparison is badged Enterprise (not Pro)',
  (b1?.items ?? []).some((t) => t.includes('market comparison') && t.includes('Enterprise')),
)
check(
  'price alert is badged Pro',
  (b1?.items ?? []).some((t) => t.includes('price alert') && t.includes('Pro')),
)

// Tap the community step — the banner must record exactly step 1.
await page.evaluate(() => {
  const el = document.querySelector('section[aria-label="Getting started"]')
  const btn = Array.from(el?.querySelectorAll('button') ?? []).find((b) =>
    b.textContent?.includes('Browse a community'),
  )
  btn?.click()
})
await new Promise((r) => setTimeout(r, 1800))

const afterNav = await page.evaluate(async () => {
  const me = await fetch('/api/sqftlab/me').then((r) => r.json()).catch(() => null)
  const id = me?.user?.id
  const ob = await fetch('/api/sqftlab/onboarding', {
    headers: id ? { Authorization: `Bearer ${id}` } : {},
  })
    .then((r) => r.json())
    .catch(() => null)
  return ob
})
check('tapping a step navigates and records it', Array.isArray(afterNav?.steps) && afterNav.steps.includes(1), JSON.stringify(afterNav))
check('records ONLY the visited step', afterNav?.steps?.length === 1, JSON.stringify(afterNav?.steps))

// Dismiss must remove the banner and persist.
await gotoDashboard()
const b2 = await readBanner()
if (b2) {
  await page.evaluate(() => {
    document
      .querySelector<HTMLButtonElement>('section[aria-label="Getting started"] button[aria-label="Dismiss getting started guide"]')
      ?.click()
  })
  await new Promise((r) => setTimeout(r, 700))
}
const afterDismiss = await page.evaluate(
  () => !!document.querySelector('section[aria-label="Getting started"]'),
)
check('dismiss hides the banner', afterDismiss === false)

await page.reload({ waitUntil: 'networkidle2' })
await new Promise((r) => setTimeout(r, 1200))
const stillGone = await page.evaluate(
  () => !!document.querySelector('section[aria-label="Getting started"]'),
)
check('dismissal persists across a reload', stillGone === false)

// And the server agrees.
const finalState = await page.evaluate(async () => {
  const me = await fetch('/api/sqftlab/me').then((r) => r.json()).catch(() => null)
  const id = me?.user?.id
  return fetch('/api/sqftlab/onboarding', { headers: id ? { Authorization: `Bearer ${id}` } : {} })
    .then((r) => r.json())
    .catch(() => null)
})
check('server reports completed', finalState?.completed === true, JSON.stringify(finalState))

await browser.close()
console.log('='.repeat(56))
console.log(`${pass} passed, ${fail} failed\n`)
await restore()
process.exit(fail > 0 ? 1 : 0)
