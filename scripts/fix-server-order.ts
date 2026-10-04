/**
 * Repair server.tsx ordering after `shogo generate` rewrites it.
 *
 * The generated file registers the static handlers and `Bun.serve()` immediately
 * after the API routes, then re-emits the `SHOGO:CUSTOM asset-routing` region at
 * the very bottom — *after* the SPA catch-all. Hono dispatches in registration
 * order, and that catch-all answers every unmatched path with index.html, so the
 * region never executes:
 *
 *   - the /p/<projectId>/ rewrite is dead, so the preview serves index.html
 *     where the browser expects a JS module → blank page
 *   - the cache headers are dead, so a stale shell can hide a fresh deploy
 *
 * The generated file's own header claims it "will not be overwritten if it
 * exists". It is. So this script moves the static block back below
 * `SHOGO:CUSTOM-END`, where it belongs.
 *
 * Idempotent. Run after any schema change:
 *   bun run scripts/fix-server-order.ts
 *
 * `scripts/verify-server-routing.ts` asserts the *behaviour* (that the middleware
 * runs), which is the check that actually matters — this script only repairs.
 */
import { readFileSync, writeFileSync } from 'fs'

const FILE = 'server.tsx'

const STATIC_BLOCK_RE =
  /\/\/ Serve static files in production\napp\.use\('\/\*', serveStatic\(\{ root: '\.\/dist' \}\)\)\napp\.get\('\*', serveStatic\(\{ path: '\.\/dist\/index\.html' \}\)\)\n\nconst port = Number\(process\.env\.PORT\) \|\| 3001\nconsole\.log\(`🚀 Server running on http:\/\/localhost:\$\{port\}`\)\n\nBun\.serve\(\{ port, fetch: app\.fetch \}\)\n/

const TAIL_BLOCK = `// ─── Static files + SPA fallback ─────────────────────────────────────────────
// Deliberately LAST. Hono dispatches in registration order, so the SPA catch-all
// below answers every unmatched path with index.html — anything registered after
// it never runs. \`shogo generate\` moves these back above the custom region on
// every schema change, which silently turns the asset-routing middleware above
// into dead code and blanks the preview. \`scripts/fix-server-order.ts\` repairs
// the ordering; \`scripts/verify-server-routing.ts\` detects the regression.
app.use('/*', serveStatic({ root: './dist' }))
app.get('*', serveStatic({ path: './dist/index.html' }))

const port = Number(process.env.PORT) || 3001
console.log(\`🚀 Server running on http://localhost:\${port}\`)
Bun.serve({ port, fetch: app.fetch })`

let src = readFileSync(FILE, 'utf8')

const routingAt = src.indexOf('// SHOGO:CUSTOM-START asset-routing')
if (routingAt === -1) {
  console.log('✗ server.tsx has no SHOGO:CUSTOM asset-routing region — nothing to reorder.')
  console.log('  Re-add it from git history; without it prefixed asset requests 404 into index.html.')
  process.exit(1)
}

const staticAt = src.search(/\/\/ Serve static files in production|app\.use\('\/\*', serveStatic/)

if (staticAt === -1) {
  console.log('✓ server.tsx already in the correct order (static handlers are last).')
  process.exit(0)
}

if (staticAt > routingAt) {
  console.log('✓ server.tsx already in the correct order (static handlers are last).')
  process.exit(0)
}

// The generated head block — remove it verbatim.
const headBlock = `// Serve static files in production
app.use('/*', serveStatic({ root: './dist' }))
app.get('*', serveStatic({ path: './dist/index.html' }))

const port = Number(process.env.PORT) || 3001
console.log(\`🚀 Server running on http://localhost:\${port}\`)

Bun.serve({ port, fetch: app.fetch })
`

if (!src.includes(headBlock)) {
  console.log('✗ Could not find the generated static block verbatim — server.tsx changed shape.')
  console.log('  Inspect it by hand: static handlers must come after SHOGO:CUSTOM-END.')
  process.exit(1)
}

if (!src.includes('// SHOGO:CUSTOM-END')) {
  console.log('✗ No SHOGO:CUSTOM-END marker to anchor against.')
  process.exit(1)
}

if (!STATIC_BLOCK_RE.test(src)) {
  console.log('✗ Static block did not match the expected generated form.')
  process.exit(1)
}

src = src.replace(headBlock, '')
// Collapse the blank lines the removal leaves behind.
src = src.replace(/\n{3,}/g, '\n\n')
src = src.replace('// SHOGO:CUSTOM-END', `// SHOGO:CUSTOM-END\n\n${TAIL_BLOCK}\n`)

writeFileSync(FILE, src)
console.log('✓ Reordered server.tsx — static handlers + Bun.serve now come after SHOGO:CUSTOM-END.')
console.log('  Verify with: bun run scripts/verify-server-routing.ts')
