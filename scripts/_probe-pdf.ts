import puppeteer from 'puppeteer-core'

const CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter((p): p is string => Boolean(p))

let ok = false
for (const exe of CANDIDATES) {
  const t0 = Date.now()
  try {
    const browser = await puppeteer.launch({
      executablePath: exe,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage()
    await page.setContent('<h1 style="font-family:monospace">sqftLab probe</h1><p>AED 1,234,567</p>')
    const pdf = await page.pdf({ format: 'A4', printBackground: true })
    await browser.close()
    const buf = Buffer.from(pdf)
    console.log(`  OK  ${exe}  launch+pdf in ${Date.now() - t0}ms  ${buf.length} bytes  magic=${buf.subarray(0, 5).toString()}`)
    ok = true
    break
  } catch (err) {
    console.log(`  FAIL ${exe}  ${(err as Error).message.split('\n')[0].slice(0, 160)}`)
  }
}
console.log(ok ? 'RESULT: pdf generation works' : 'RESULT: no working chromium')
process.exit(ok ? 0 : 1)
