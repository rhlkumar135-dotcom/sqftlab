/**
 * URL surface verification — every published SPA path, through the EDGE origin.
 *
 * Why this suite exists
 * ---------------------
 * Every other suite in this repo talks to the app's own Hono server on :3101, because
 * that is where the routes live. But :3101 is NOT what a browser hits. In deployment the
 * request passes through the host's edge proxy first, and that proxy routes by STRING
 * PREFIX `/api` — so `/api-keys` was answered by the API gateway with a bare
 * `404 Not Found` (text/plain, 9 bytes) before the SPA was ever consulted.
 *
 * The Day 17 suite asserted `/api-keys` and passed, because against :3101 the Hono server
 * does serve the shell for that path. Green suite, dead URL. Only the cold load was
 * affected — clicking the nav item switches page state in-place with no request, which is
 * why the page looked perfectly healthy in every screenshot.
 *
 * So this suite deliberately runs against the EDGE origin (:8080 / the public host) and
 * additionally encodes the constraint statically, so a future `/api…` path is caught even
 * where no edge is running.
 *
 * Run:
 *   bun run scripts/verify-urls.ts
 *   EDGE_BASE=https://<project>.preview.shogo.ai bun run scripts/verify-urls.ts
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const EDGE_BASE = process.env.EDGE_BASE ?? 'http://localhost:8080'

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

const app = readFileSync(resolve('src/App.tsx'), 'utf8')

// ── Static: the constraint that cost a page ────────────────────────────────
console.log('\n\u2500\u2500 Static \u2014 published paths vs the edge proxy')

const block = app.match(/const PAGE_PATHS[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? ''
const urls: Array<[string, string]> = []
for (const m of block.matchAll(/^\s*'?([\w-]+)'?:\s*'([^']+)'/gm)) {
  urls.push([m[1], m[2]])
}

check('PAGE_PATHS parsed from App.tsx', urls.length >= 10, `found ${urls.length}`)
for (const [key, url] of urls) console.log(`      ${key} \u2192 ${url}`)

// The edge routes the string prefix `/api` to the API gateway. Any SPA URL beginning
// with it is unreachable no matter how the app is written — there is no client-side fix,
// because the request never reaches the app.
for (const [key, url] of urls) {
  check(`'${key}' (${url}) does not start with the proxied /api prefix`, !url.startsWith('/api'))
}

// Relative asset base (`./assets/…`) means a nested path resolves its assets against the
// wrong directory — a blank page. Such paths are legal only when index.html rewrites them
// to root+hash, which it does for the two parameterised routes and nothing else.
const nested = urls.filter(([, u]) => u.split('/').filter(Boolean).length > 1)
check(
  'no unrewritten multi-segment path is published',
  nested.length === 0,
  nested.map(([k, u]) => `${k}${u}`).join(', '),
)

// ── Live: the edge actually serves them ────────────────────────────────────
console.log(`\n\u2500\u2500 Live \u2014 edge origin ${EDGE_BASE}`)

async function probe(path: string): Promise<{ status: number; type: string; body: string } | null> {
  try {
    const res = await fetch(`${EDGE_BASE}${path}`, { redirect: 'follow' })
    return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() }
  } catch (e) {
    return null
  }
}

const reachable = await probe('/')
if (!reachable) {
  // Not a pass. An unrunnable check must say so rather than look green.
  console.log(`  \u2717 edge origin ${EDGE_BASE} is unreachable — start the preview, or set EDGE_BASE`)
  console.log('\n  1 passed, 0 failed')
  process.exit(1)
}

for (const [key, url] of urls) {
  const r = await probe(url)
  if (!r) {
    check(`${url} served by the edge`, false, 'no response')
    continue
  }
  check(
    `${url} served by the edge`,
    r.status === 200 && r.type.includes('text/html') && r.body.includes('id="root"'),
    `HTTP ${r.status} ${r.type} ${r.body.slice(0, 40).replace(/\s+/g, ' ')}`,
  )
}

// The two parameterised routes are rewritten to root+hash by index.html, so the shell
// itself must still come back 200 for the pretty URL a user shares.
for (const path of ['/buildings/dubai-marina', '/deals/anything']) {
  const r = await probe(path)
  check(
    `${path} still returns the shell (index.html rewrites it)`,
    !!r && r.status === 200 && r.type.includes('text/html'),
    r ? `HTTP ${r.status} ${r.type}` : 'no response',
  )
}

// The bare API root must still be the gateway's JSON 404 — proof the prefix really is
// proxied, which is the premise of the static check above. If this ever stops holding,
// the constraint can be revisited.
{
  const r = await probe('/api')
  check(
    'the /api prefix is still answered by the API gateway',
    !!r && r.status === 404 && r.body.includes('No API route matches'),
    r ? `HTTP ${r.status} ${r.body.slice(0, 40)}` : 'no response',
  )
}

console.log(`\n  ${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
