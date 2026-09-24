#!/usr/bin/env node
/**
 * Rewrite the absolute preview base out of dist/index.html.
 *
 * The canvas runtime builds with `--base /p/<projectId>/`, so index.html ships
 * `/p/<id>/assets/index-*.js`. The static publish host serves assets from the
 * site root, and that prefixed path matches no file — it falls through to the
 * SPA fallback and returns index.html for a JS module, so the bundle never
 * executes and the page renders blank (a green build does not catch this).
 *
 * `/assets/...` works on both the publish host and the local full-stack server,
 * so rewriting to the root-absolute path is correct in both.
 *
 * vite.config.ts has the same rewrite as a build plugin. This script exists
 * because the watcher only reads its config at process start, so a config change
 * does not take effect until the watcher restarts. Idempotent.
 *
 *   node scripts/fix-html-base.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const file = resolve(process.cwd(), 'dist/index.html')

if (!existsSync(file)) {
  console.error('dist/index.html not found — build first')
  process.exit(1)
}

const before = readFileSync(file, 'utf8')
const after = before.replace(/(src|href)="\/p\/[^/]+\/assets\//g, '$1="/assets/')

if (after === before) {
  console.log('dist/index.html already root-relative — nothing to do')
} else {
  writeFileSync(file, after)
  const n = (before.match(/\/p\/[^/]+\/assets\//g) || []).length
  console.log(`rewrote ${n} asset reference(s) in dist/index.html to /assets/`)
}

for (const line of after.split('\n')) {
  if (/assets\//.test(line)) console.log('  ' + line.trim())
}
