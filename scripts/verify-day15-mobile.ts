// Day 15 Task C verification — measure horizontal overflow at phone width on the real app.
//
// Run: bun run scripts/verify-day15-mobile.ts
//
// Measures at 390x844 (iPhone 14/15 logical width). A page "overflows" when
// documentElement.scrollWidth exceeds clientWidth, which is what makes a phone show a
// sideways scrollbar and lets content sit off-screen. For each offender it reports the
// element that actually sticks out, not just the page, so the fix is unambiguous.

import puppeteer, { type Page as PPage } from 'puppeteer-core'
import { resolve } from 'node:path'

// Point Prisma at THIS project's database explicitly (an inherited DATABASE_URL points at
// the workspace root, which is a different database).
process.env.DATABASE_URL = `file:${resolve('prisma/dev.db')}`
const { prisma } = await import('../src/lib/db')

// Merely loading a page ticks an onboarding step, so this suite would otherwise leave the
// demo account partway through its tour. Snapshot and restore.
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

const BASE = process.env.PREVIEW_URL ?? 'http://localhost:8080'
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/chromium'
const W = 390
const H = 844

interface Finding {
  page: string
  scrollWidth: number
  clientWidth: number
  offenders: string[]
}

async function measure(page: PPage, name: string): Promise<Finding> {
  const r = await page.evaluate((w: number) => {
    const doc = document.documentElement
    const out: string[] = []
    // Only report elements that stick out AND are not inside a scroll container that is
    // meant to clip them (tables inside `overflow-x-auto` are intentional and scroll).
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const b = el.getBoundingClientRect()
      if (b.width === 0 || b.height === 0) continue
      if (b.right <= w + 1) continue
      let scrollable = false
      let p: HTMLElement | null = el.parentElement
      while (p && p !== document.body) {
        const ox = getComputedStyle(p).overflowX
        if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') {
          scrollable = true
          break
        }
        p = p.parentElement
      }
      if (scrollable) continue
      const cls = typeof el.className === 'string' ? el.className.split(' ').slice(0, 4).join('.') : ''
      out.push(`${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} right=${Math.round(b.right)}`)
      if (out.length >= 6) break
    }
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, offenders: out }
  }, W)
  return { page: name, ...r }
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
})

const page = await browser.newPage()
await page.setViewport({ width: W, height: H, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })

// Published URLs — a cold load of each, which is also what a shared link does.
const routes: Array<[string, string]> = [
  ['landing (/)', '/'],
  ['pricing', '/pricing'],
  ['cma', '/cma'],
  ['portfolio', '/portfolio'],
  ['capital-flow', '/capital-flow'],
  ['buildings', '/buildings'],
  ['export', '/export'],
  ['mortgage', '/mortgage'],
  ['market-pulse', '/market-pulse'],
]

const findings: Finding[] = []
for (const [name, path] of routes) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle2', timeout: 30000 })
  await new Promise((r) => setTimeout(r, 900))
  findings.push(await measure(page, name))
}

// In-app pages have no URL, so reach them through the mobile nav the way a user would:
// open the hamburger, tap the entry, then close it.
const inApp: Array<[string, string]> = [
  ['dashboard (Heatmap)', 'Heatmap'],
  ['deals', 'Deals'],
  ['alerts', 'Alerts'],
  ['yield calc', 'Yield Calc'],
  ['markets', 'Markets'],
  ['analytics', 'Analytics'],
  ['predictions', 'Predictions'],
]
for (const [name, label] of inApp) {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 30000 })
  await new Promise((r) => setTimeout(r, 500))
  const opened = await page.evaluate(() => {
    const btn = document.querySelector<HTMLButtonElement>('button[aria-label="Open menu"]')
    if (!btn) return false
    btn.click()
    return true
  })
  if (!opened) {
    findings.push({ page: name, scrollWidth: -1, clientWidth: W, offenders: ['hamburger not found'] })
    continue
  }
  await new Promise((r) => setTimeout(r, 250))
  await page.evaluate((l: string) => {
    const b = Array.from(document.querySelectorAll<HTMLButtonElement>('nav button')).find(
      // Visible only: the desktop rail carries the same labels and is display:none here.
      (x) => x.textContent?.trim() === l && x.offsetParent !== null,
    )
    b?.click()
  }, label)
  await new Promise((r) => setTimeout(r, 1400))
  findings.push(await measure(page, name))
}

await browser.close()

let bad = 0
console.log(`\nMobile overflow audit @ ${W}x${H} — ${BASE}\n${'='.repeat(64)}`)
for (const f of findings) {
  const over = f.scrollWidth > f.clientWidth + 1
  if (over) bad++
  console.log(
    `${over ? 'OVERFLOW' : 'ok      '}  ${f.page.padEnd(22)} scrollWidth=${f.scrollWidth} clientWidth=${f.clientWidth}`,
  )
  for (const o of f.offenders) console.log(`            └─ ${o}`)
}
console.log(`${'='.repeat(64)}\n${bad} page(s) overflow horizontally\n`)
await restore()
process.exit(bad > 0 ? 1 : 0)
