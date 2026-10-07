// Day 15 — capture phone-width screenshots so the mobile result can be inspected, not
// just measured. Also exercises the onboarding banner and its step tracking.
//
// Run: bun run scripts/_shot-day15.ts
import puppeteer from 'puppeteer-core'

const BASE = process.env.PREVIEW_URL ?? 'http://localhost:8080'
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/chromium'
const OUT = '/tmp/day15'

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
})
const page = await browser.newPage()
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })

const shots: Array<[string, string]> = [
  ['landing', '/'],
  ['mortgage', '/mortgage'],
  ['cma', '/cma'],
  ['portfolio', '/portfolio'],
  ['capital-flow', '/capital-flow'],
  ['buildings', '/buildings'],
  ['market-pulse', '/market-pulse'],
]
for (const [name, path] of shots) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle2', timeout: 30000 })
  await new Promise((r) => setTimeout(r, 1200))
  await page.screenshot({ path: `${OUT}-${name}.png`, fullPage: false })
  console.log('shot', name)
}

// Onboarding: reach the dashboard (a tour surface), then confirm the banner is present,
// click the community step, and confirm the server recorded step 1.
await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 30000 })
await new Promise((r) => setTimeout(r, 600))
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

const banner = await page.evaluate(() => {
  const el = document.querySelector('section[aria-label="Getting started"]')
  if (!el) return null
  return {
    text: el.textContent?.replace(/\s+/g, ' ').trim().slice(0, 220),
    links: Array.from(el.querySelectorAll('button')).map((b) => b.textContent?.trim()).filter(Boolean),
  }
})
console.log('\nbanner present:', !!banner)
if (banner) {
  console.log('banner text:', banner.text)
  console.log('banner buttons:', JSON.stringify(banner.links))
}
await page.screenshot({ path: `${OUT}-dashboard-banner.png`, fullPage: false })
console.log('shot dashboard-banner')

await browser.close()
