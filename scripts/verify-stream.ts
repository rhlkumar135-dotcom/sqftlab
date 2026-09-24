/**
 * Verifies the Part 16 SSE stream end-to-end:
 *   connect → receive `init` → publish → receive the pushed frame.
 *
 * Uses Hono's in-process app.request() with a live ReadableStream read, so it
 * exercises the real SSE writer and the real event bus without binding a port.
 *
 * Run: DATABASE_URL="file:./prisma/dev.db" bun run scripts/verify-stream.ts
 */

import app from '../custom-routes'
import { prisma } from '../src/lib/db'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail: string) => {
  if (ok) { pass++; console.log(`  ✓ ${name} — ${detail}`) }
  else { fail++; console.log(`  ✗ ${name} — ${detail}`) }
}

async function main() {
  console.log('\n═══ SSE stream ═══')

  const res = await app.request('/sqftlab/stream/market', { headers: { Accept: 'text/event-stream' } })
  check('status 200', res.status === 200, `got ${res.status}`)
  check(
    'content-type is event-stream',
    (res.headers.get('content-type') ?? '').includes('text/event-stream'),
    res.headers.get('content-type') ?? 'none',
  )

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const frames: { event: string; data: string }[] = []
  let buffer = ''

  const pump = (async () => {
    while (frames.length < 6) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // SSE frames are separated by a blank line.
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const event = /^event:\s*(.+)$/m.exec(raw)?.[1] ?? 'message'
        const data = /^data:\s*(.+)$/m.exec(raw)?.[1] ?? ''
        if (data) frames.push({ event, data })
      }
    }
  })()

  // Give the handler a moment to emit `init`, then publish.
  await new Promise((r) => setTimeout(r, 400))
  const pub = await app.request('/sqftlab/stream/test-publish', { method: 'POST' })
  check('test-publish 200', pub.status === 200, `got ${pub.status}`)

  await Promise.race([pump, new Promise((r) => setTimeout(r, 4000))])
  await reader.cancel().catch(() => {})

  check('received frames', frames.length > 0, `${frames.length} frames`)

  const init = frames.find((f) => f.data.includes('"init"'))
  check('first frame is init', !!init, init ? 'init present' : 'no init frame')
  if (init) {
    const parsed = JSON.parse(init.data) as { payload?: { summary?: unknown } }
    check('init carries a market summary', parsed.payload?.summary != null, 'summary present')
  }

  const types = frames.map((f) => { try { return JSON.parse(f.data).type } catch { return '?' } })
  check('market:update pushed', types.includes('market:update'), `types=${[...new Set(types)].join(',')}`)
  // district:update only fires when district metrics exist, which requires
  // registered transactions. Accept its absence when the pipeline is honest about
  // having no transaction data.
  // Status alone proves nothing here — the route answers 200 with an empty array
  // when there is nothing to publish. Check that the payload actually has rows.
  const districtsRaw = await (await app.request('/sqftlab/districts')).text()
  const hasDistrictData = /"districts"\s*:\s*\[\s*\{/.test(districtsRaw)
  check('district:update pushed (when district data exists)',
    types.includes('district:update') || !hasDistrictData,
    `types=${[...new Set(types)].join(',')}`)
  check('deal:new pushed', types.includes('deal:new'), `types=${[...new Set(types)].join(',')}`)

  const status = await app.request('/sqftlab/stream/status')
  const sj = await status.json() as { transport: string; channels: string[]; subscribers: number }
  check('status reports sse', sj.transport === 'sse', `transport=${sj.transport}`)
  check('5 channels declared', sj.channels.length === 5, `${sj.channels.length}: ${sj.channels.join(',')}`)
  check('cron:update channel declared', sj.channels.includes('cron:update'), sj.channels.join(','))
  check('subscriber released on cancel', sj.subscribers === 0, `subscribers=${sj.subscribers}`)

  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══\n`)
  if (fail) process.exitCode = 1
}

main()
  .catch((e) => { console.error('FATAL', e); process.exitCode = 1 })
  .finally(async () => {
    await prisma.$disconnect()
    // The SSE subscription keeps the event loop alive after the assertions
    // finish, so this script would otherwise never exit on its own.
    process.exit(process.exitCode ?? 0)
  })
