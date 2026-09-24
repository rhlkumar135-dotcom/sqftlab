// Verifies the two routing fixes in server.tsx by booting the real app on a
// scratch port and issuing real requests. Hono dispatches middleware in
// registration order, so "the middleware exists" is not the same as "the
// middleware runs" — only an actual request can tell them apart.
//
// Run: bun run scripts/verify-server-routing.ts
import { readdirSync } from 'fs'

process.env.PORT = '4599'
await import('../server.tsx')

const BASE = 'http://localhost:4599'
const PROJECT = 'aa4e2d6a-fa02-4e02-98d0-9ac7590d28fc'

const bundle = readdirSync('dist/assets').find((f) => /^index-.*\.js$/.test(f))
if (!bundle) {
  console.error('FAIL: no bundle in dist/assets — run a build first')
  process.exit(1)
}

type Case = { name: string; url: string; expectType?: RegExp; expectCache?: RegExp; jsonOk?: boolean }
const cases: Case[] = [
  { name: 'prefixed asset (canvas preview)', url: `${BASE}/p/${PROJECT}/assets/${bundle}`, expectType: /javascript/, expectCache: /immutable/ },
  // Deliberately hits an unmatched /api path rather than a real endpoint: the
  // point is whether the prefixed request reaches the API layer at all. A real
  // endpoint would also fail if the database is down, which says nothing about
  // routing. Unmatched /api returns a JSON 404, so JSON here == prefix stripped.
  { name: 'prefixed API route', url: `${BASE}/p/${PROJECT}/api/__routing_probe`, expectType: /json/, jsonOk: true },
  { name: 'unprefixed asset', url: `${BASE}/assets/${bundle}`, expectType: /javascript/, expectCache: /immutable/ },
  { name: 'prefixed stylesheet path', url: `${BASE}/p/${PROJECT}/assets/`, expectType: /text\/html/ },
  { name: 'SPA shell', url: `${BASE}/`, expectType: /text\/html/, expectCache: /no-cache/ },
  { name: 'SPA deep link (client route)', url: `${BASE}/glossary`, expectType: /text\/html/, expectCache: /no-cache/ },
]

let failures = 0
let ran = 0

for (const c of cases) {
  let res: Response
  try {
    res = await fetch(c.url)
  } catch (e) {
    console.log(`  FAIL  ${c.name} — request threw: ${(e as Error).message}`)
    failures++
    continue
  }
  ran++
  const type = res.headers.get('content-type') || ''
  const cache = res.headers.get('cache-control') || ''
  const problems: string[] = []

  if (c.expectType && !c.expectType.test(type)) problems.push(`content-type "${type}" !~ ${c.expectType}`)
  if (c.expectCache && !c.expectCache.test(cache)) problems.push(`cache-control "${cache || '(none)'}" !~ ${c.expectCache}`)
  if (c.jsonOk) {
    const text = await res.text()
    if (!text.trimStart().startsWith('{')) problems.push(`body is not JSON: ${text.slice(0, 60)}`)
  }
  if (c.name === 'SPA shell') {
    const html = await res.text()
    if (!html.includes('id="root"')) problems.push('shell missing #root')
  }

  if (problems.length) {
    console.log(`  FAIL  ${c.name}`)
    for (const p of problems) console.log(`          ${p}`)
    failures++
  } else {
    console.log(`  ok    ${c.name}  [${res.status} ${type.split(';')[0]}${cache ? ` · ${cache.split(',')[0]}` : ''}]`)
  }
}

// API routes must not be given an HTML-caching directive.
const api = await fetch(`${BASE}/health`)
const apiCache = api.headers.get('cache-control') || ''
console.log(`  ${apiCache ? 'FAIL' : 'ok  '}  /health has no HTML cache directive${apiCache ? ` (got "${apiCache}")` : ''}`)
if (apiCache) failures++

console.log(`\n${ran - failures}/${ran} routing cases passed`)
process.exit(failures ? 1 : 0)
