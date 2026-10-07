// Day 2 verification — brand, CORS lockdown, exchange-rate contract.
//
// Boots the REAL app on a scratch port and issues real requests. For CORS that
// matters: "the middleware is in the file" and "the middleware runs before the
// SPA catch-all" are different questions, and only a request tells them apart.
//
// FIX-04's actual complaint ("the live site shows the wrong brand") is about what
// the browser RECEIVES, so the brand check reads the built bundle, not just source.
//
// NODE_ENV is forced to production so the CORS assertions describe the deployed
// behaviour rather than the developer's shell.
//
// Run: DATABASE_URL="file:$PWD/prisma/dev.db" bun run scripts/verify-day2.ts
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

process.env.PORT = '4601'
process.env.NODE_ENV = 'production'
await import('../server.tsx')

const { prisma } = await import('../src/lib/db')

const BASE = 'http://localhost:4601'

let pass = 0
let fail = 0
function check(ok: boolean, name: string, detail = '') {
  if (ok) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const WRONG_BRAND = /sqrtlab|khashn/i
// This file has to name the strings it forbids, so it would flag itself.
const SELF = join('scripts', 'verify-day2.ts')

// ─── FIX-04: brand ───────────────────────────────────────────────────────────
console.log('\nFIX-04  Brand rename')

// Only files that ship or describe the product. Deliberately excluded:
//   src/generated  — SDK output, regenerated
//   files/, memory/, MEMORY.md — the user's own uploaded specs and the agent's
//     historical log. They are the *input* record, not the product; rewriting
//     them would destroy provenance and change nothing a visitor sees.
//   sqftlab-next/  — a stale nested Next.js checkout recorded as a gitlink with
//     no .gitmodules (empty on a fresh clone), not built by the Dockerfile.
const ROOT_FILES = [
  'index.html', 'package.json', 'README.md', 'server.tsx', 'custom-routes.ts',
  'vite.config.ts', '.env.example', 'Dockerfile', 'nixpacks.toml', 'railway.toml',
  'shogo.config.json', 'config.json', 'tsconfig.json',
]
const SOURCE_EXT = /\.(ts|tsx|css|html|json|mjs|py|sh)$/

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'generated') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (SOURCE_EXT.test(entry)) out.push(full)
  }
  return out
}

const brandFiles = [
  ...walk('src'),
  ...walk('scripts'),
  ...ROOT_FILES.filter((f) => { try { return statSync(f).isFile() } catch { return false } }),
].filter((f) => f !== SELF)

const brandHits: string[] = []
for (const file of brandFiles) {
  const text = readFileSync(file, 'utf8')
  text.split('\n').forEach((line, i) => {
    if (WRONG_BRAND.test(line)) brandHits.push(`${file}:${i + 1}`)
  })
}
check(brandHits.length === 0, `product sources contain no wrong brand (${brandFiles.length} files scanned)`,
  brandHits.slice(0, 5).join(', '))

// The bundle the page ACTUALLY loads. dist/assets accumulates ~100 bundles from
// earlier builds (the watcher runs with --emptyOutDir false), so picking any file
// with a matching name can read a build from before the rename and report a false
// regression — which is exactly what it did on the first run.
let bundle: string | undefined
try {
  const html = readFileSync('dist/index.html', 'utf8')
  bundle = html.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/)?.[1]
} catch { /* no build yet */ }
if (bundle) {
  const js = readFileSync(join('dist/assets', bundle), 'utf8')
  check(!WRONG_BRAND.test(js), `live bundle ${bundle} has no wrong brand`)
  check(js.includes('sqftLab'), 'live bundle carries the sqftLab wordmark')
} else {
  check(false, 'dist/index.html references an index bundle', 'run a build first')
}

// ─── FIX-05: CORS ────────────────────────────────────────────────────────────
console.log('\nFIX-05  CORS lockdown')

const PROBE = `${BASE}/api/sqftlab/market-summary`

async function probe(origin?: string, method = 'GET') {
  const headers: Record<string, string> = {}
  if (origin) headers.Origin = origin
  if (method === 'OPTIONS') {
    headers['Access-Control-Request-Method'] = 'GET'
    headers['Access-Control-Request-Headers'] = 'content-type'
  }
  const res = await fetch(PROBE, { method, headers })
  return { status: res.status, acao: res.headers.get('access-control-allow-origin'), vary: res.headers.get('vary') }
}

for (const origin of ['https://sqftlab.com', 'https://www.sqftlab.com', 'https://app.sqftlab.com']) {
  const r = await probe(origin)
  check(r.acao === origin, `allowed origin is reflected: ${origin}`, `ACAO=${r.acao}`)
}

for (const origin of ['https://evil.com', 'https://sqftlab.com.evil.com', 'http://sqftlab.com']) {
  const r = await probe(origin)
  check(r.acao === null, `disallowed origin gets NO Access-Control-Allow-Origin: ${origin}`, `ACAO=${r.acao}`)
}

const noOrigin = await probe()
check(noOrigin.acao === null, 'no Origin header ⇒ no CORS header (same-origin/server-to-server)')

const preflightEvil = await probe('https://evil.com', 'OPTIONS')
check(preflightEvil.acao === null, 'OPTIONS preflight from a disallowed origin gets NO ACAO',
  `ACAO=${preflightEvil.acao}`)

const preflightOk = await probe('https://www.sqftlab.com', 'OPTIONS')
check(preflightOk.acao === 'https://www.sqftlab.com', 'OPTIONS preflight from an allowed origin is reflected')

const varied = await probe('https://www.sqftlab.com')
check(/origin/i.test(varied.vary ?? ''), 'responses carry Vary: Origin', `Vary=${varied.vary}`)

// Set to production above rather than inherited, so these assertions describe the
// deployed behaviour even when run from a developer shell.
console.log(`  (NODE_ENV forced to ${process.env.NODE_ENV})`)

// ─── FIX-06: exchange rates ──────────────────────────────────────────────────
console.log('\nFIX-06  Exchange rates')

const fxRes = await fetch(`${BASE}/api/sqftlab/exchange-rates`)
const fx = await fxRes.json().catch(() => ({}))
check(fxRes.status === 200, 'GET /api/sqftlab/exchange-rates returns 200', `status=${fxRes.status}`)
check(fx.base === 'AED', 'payload declares base AED', `base=${fx.base}`)

const rates: Record<string, number> = fx.rates ?? {}
check(typeof rates.INR === 'number' && rates.INR > 0, 'payload includes an INR rate', `INR=${rates.INR}`)
check(typeof rates.PKR === 'number' && rates.PKR > 0, 'payload includes a PKR rate', `PKR=${rates.PKR}`)
check(typeof rates.USD === 'number' && typeof rates.GBP === 'number' && typeof rates.EUR === 'number',
  'payload includes USD, GBP and EUR')
check(!Number.isNaN(Date.parse(fx.updatedAt ?? '')), 'updatedAt is a parseable timestamp', `updatedAt=${fx.updatedAt}`)
check(['open.er-api.com', 'fallback'].includes(fx.source), 'source names the upstream, or admits a fallback',
  `source=${fx.source}`)
check(fx.direction === 'AED per 1 unit of currency', 'direction is stated rather than implied', `direction=${fx.direction}`)
check(typeof fx.cached === 'boolean', 'payload says whether it was served from cache', `cached=${fx.cached}`)

// Only assert the currencies the row actually carried: a partially populated
// cache legitimately omits one instead of inventing a 0.
const expected = ['USD', 'GBP', 'EUR', 'INR', 'PKR', 'SAR', 'QAR', 'BHD', 'KWD']
const missing = expected.filter((c) => !(c in rates))
check(missing.length === 0, `all nine quoted currencies present (${Object.keys(rates).length} returned)`,
  `missing: ${missing.join(', ')}`)

// Direction guard: 1 INR really is ~0.038 AED, not 26. A silently un-inverted
// payload would still "include an INR rate" and pass everything above.
if (typeof rates.INR === 'number') {
  check(rates.INR < 1, 'INR is quoted as AED per rupee (inverted, not native)', `INR=${rates.INR}`)
}

const legacyRes = await fetch(`${BASE}/api/sqftlab/rates/exchange`)
const legacy = await legacyRes.json().catch(() => ({}))
check(legacyRes.status === 200, 'legacy /api/sqftlab/rates/exchange still returns 200')
check(typeof legacy.AED_INR === 'number' && typeof legacy.AED_PKR === 'number',
  'legacy payload still carries AED_INR and AED_PKR', JSON.stringify(legacy))
check(['cache', 'live', 'fallback'].includes(legacy.source), 'legacy source stays cache|live|fallback',
  `source=${legacy.source}`)

if (typeof legacy.AED_INR === 'number' && typeof rates.INR === 'number') {
  const roundTrip = Math.abs(1 / rates.INR - legacy.AED_INR) / legacy.AED_INR
  check(roundTrip < 0.01, 'the two directions describe the same rate', `drift=${(roundTrip * 100).toFixed(3)}%`)
}

// Proves the schema change, not just the endpoint: the four GCC columns must
// actually persist, or every request re-fetches and re-labels itself "live".
const row = await prisma.exchangeRate.findFirst({ orderBy: { fetchedAt: 'desc' } })
check(!!row, 'an ExchangeRate row was persisted')
check(!!row && [row.sar, row.qar, row.bhd, row.kwd].every((v) => typeof v === 'number' && v > 0),
  'persisted row carries sar/qar/bhd/kwd (schema migration effective)',
  row ? JSON.stringify({ sar: row.sar, qar: row.qar, bhd: row.bhd, kwd: row.kwd }) : 'no row')

console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
await prisma.$disconnect()
process.exit(fail === 0 ? 0 : 1)
