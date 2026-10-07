/**
 * Pins DATABASE_URL for the verification scripts that run the app IN-PROCESS.
 *
 * verify-cron / verify-intel / verify-stream import the real Hono app and call
 * `app.request()`, so they bind to whatever `DATABASE_URL` the shell happens to
 * carry. The agent shell exports a workspace-level default
 * (`file:/app/workspace/prisma/dev.db`) that silently wins over this project's
 * `.env` — and that file is a near-empty database which predates the project
 * schema. Against it, routes fail with `SQLITE_ERROR: no such column ...`, which
 * looks exactly like a broken handler: six "failures" that were really one wrong
 * path. Each script's header documented the right invocation, but nothing
 * enforced it, so the trap reopened on every fresh shell.
 *
 * These scripts can only ever legitimately run against THIS project's database,
 * so set it — loudly, so a real misconfiguration is still visible. A postgres
 * URL is a deliberate choice (Railway) and is left exactly as given.
 *
 * Import this FIRST, before any module that constructs the Prisma client:
 *   import './_env-guard'
 */
import { resolve } from 'node:path'

const projectDb = `file:${resolve(import.meta.dir, '..', 'prisma', 'dev.db')}`
const configured = process.env.DATABASE_URL

if (configured !== undefined && /^postgres(ql)?:/.test(configured)) {
  // A real server — the operator's choice stands.
} else if (configured !== projectDb) {
  process.env.DATABASE_URL = projectDb
  console.warn(
    `[verify] DATABASE_URL was ${configured ?? '<unset>'} — pinned to this project's database:\n` +
      `[verify]   ${projectDb}\n` +
      `[verify] Any other local file: URL is a different database, and results read against it are meaningless.`,
  )
}

export {}
