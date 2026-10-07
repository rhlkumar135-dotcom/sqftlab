import puppeteer from 'puppeteer-core'
const BASE = process.env.PREVIEW_URL!
const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] })
const p = await b.newPage()
await p.setViewport({ width: 390, height: 844, isMobile: true })
const seen: string[] = []
p.on('response', (r) => { const u = r.url(); if (u.includes('/api/sqftlab/')) seen.push(`${r.status()} ${u.replace(BASE,'')}`) })
await p.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 45000 })
await new Promise(r => setTimeout(r, 1500))
// navigate to a tour surface
await p.evaluate(() => document.querySelector<HTMLButtonElement>('button[aria-label="Open menu"]')?.click())
await new Promise(r => setTimeout(r, 300))
await p.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>('nav button')).find(x => x.textContent?.trim()==='Heatmap' && x.offsetParent!==null)?.click())
await new Promise(r => setTimeout(r, 1800))
const banner = await p.evaluate(() => !!document.querySelector('section[aria-label="Getting started"]'))
const ob = await p.evaluate(async () => {
  const me = await fetch('/api/sqftlab/me').then(r=>r.json()).catch(()=>null)
  const id = me?.user?.id
  const r = await fetch('/api/sqftlab/onboarding', { headers: id ? { Authorization: `Bearer ${id}` } : {} })
  return { status: r.status, body: await r.text() }
})
console.log('api calls seen:'); seen.slice(-8).forEach(s => console.log('  ', s))
console.log('banner rendered:', banner)
console.log('in-page /onboarding:', ob.status, ob.body.slice(0,120))
await b.close()
