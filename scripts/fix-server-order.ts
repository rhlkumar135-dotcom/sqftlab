// Restore the required ORDER of server.tsx after a regeneration.
//
//   bun run scripts/fix-server-order.ts
//
// WHY THIS EXISTS
//
// server.tsx is auto-generated, but the region between its SHOGO:CUSTOM markers
// is preserved verbatim across regeneration — its POSITION is not. `shogo
// generate` consistently relocates that region to the bottom of the file, below
// the SPA catch-all:
//
//     app.use('/*', serveStatic({ root: './dist' }))
//     app.get('*', serveStatic({ path: './dist/index.html' }))
//
// Hono dispatches in registration order, so anything mounted after that
// catch-all is unreachable — the catch-all answers *every* unmatched path with
// index.html before the later middleware ever runs. The custom region holds the
// asset-path rewrite that the preview needs (without it the client bundle is
// requested as HTML and the page renders blank), so losing the ordering breaks
// the preview silently: the markers survive, so nothing looks wrong in the diff.
//
// Editing prisma/schema.prisma is enough to trigger a regeneration, which makes
// this a recurring tax on every schema change rather than a one-off mistake.
// scripts/verify-server-routing.ts catches it (it drops from 8 to 1 checks), but
// only if it is run. This script makes the repair a single command instead of a
// hand-move that has to be redone from scratch each time.
//
// Idempotent: running it on an already-correct file changes nothing.
//
// NOT AUTOMATIC — measured, don't re-litigate it. A `postgenerate` npm hook was
// added to package.json and a schema edit was made to trigger a regeneration. The
// block was relocated again and the hook did not run, because the in-editor
// regeneration invokes the SDK CLI directly rather than going through
// `bun run generate`. So there is no hook to hang this off; the detection is
// `scripts/verify-server-routing.ts` (it drops 8 → 1) and the repair is this
// command. The `postgenerate` entry is kept only because a *manual*
// `bun run generate` (fresh clone, Railway build) does go through npm and would
// benefit from it.
const FILE = 'server.tsx'
const START = '// SHOGO:CUSTOM-START'
const END = '// SHOGO:CUSTOM-END'
const ANCHOR = '// Serve static files in production'

const src = await Bun.file(FILE).text()

const s = src.indexOf(START)
const e = src.indexOf(END)
if (s === -1 || e === -1) {
  console.error(`✗ ${FILE}: SHOGO:CUSTOM markers not found — refusing to touch it.`)
  process.exit(1)
}

const anchorAt = src.indexOf(ANCHOR)
if (anchorAt === -1) {
  console.error(`✗ ${FILE}: anchor "${ANCHOR}" not found — the generator's shape changed, fix by hand.`)
  process.exit(1)
}

if (s < anchorAt) {
  console.log(`✓ ${FILE}: custom region already above the SPA catch-all (line ${src.slice(0, s).split('\n').length}). Nothing to do.`)
  process.exit(0)
}

const block = src.slice(s, e + END.length)
// Remove the region, then collapse the blank run it leaves behind.
const rest = (src.slice(0, s) + src.slice(e + END.length)).replace(/\n{3,}/g, '\n\n')

const at = rest.indexOf(ANCHOR)
const out = `${rest.slice(0, at)}${block}\n\n${rest.slice(at)}`

await Bun.write(FILE, out)

const line = out.slice(0, out.indexOf(START)).split('\n').length
const anchorLine = out.slice(0, out.indexOf(ANCHOR)).split('\n').length
console.log(`✓ ${FILE}: moved custom region to line ${line}, above the catch-all at line ${anchorLine}.`)
console.log('  Now run: bun run scripts/verify-server-routing.ts')
