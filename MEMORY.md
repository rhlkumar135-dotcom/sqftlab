# Memory

Long-lived facts and learnings are stored here.

## sqftLab — project facts

- **Repo:** `github.com/rhlkumar135-dotcom/sqftlab` (remotes `origin` and `sqftlab` both point here).
  A working fine-grained PAT lives in `~/.git-credentials` (`credential.helper store`), so
  `git push origin main` works without inline credentials. Tokens pasted into chat get
  revoked — never assume a pasted token still works, and never re-ask if one is on disk.
- **Stack is Vite + React + Hono + Prisma (SQLite dev / Postgres prod)** — NOT Next.js.
  Spec docs in `files/` were written for Next.js 14 App Router, so their `src/app/**`
  paths cannot map 1:1. Behaviour is implemented; file paths differ.
- **Spec sources:** `files/Pasted_text.txt` (Full Product Spec v3.0, Parts 1–11),
  `files/Pasted_text__2_.txt` (Agent Action Guide v2.0), `files/Pasted_markdown.md`,
  `files/Khashn_UAE_PropTech_Documentation_v1.docx`. These survive runtime restarts
  (a *new* attachment does not — re-request it if it is missing).
- **Local full-stack server:** port 3101 serves the SPA *and* `/api/*` on one origin
  (`curl localhost:3101/api/health/db`). Port 3001 is the SDK-generated server; port 8080
  is static-only (no API) — don't use it to test data.

## sqftLab — deploy state (as of 2026-09-23)

**Railway identifiers (recovered from the session record):**
- Project **`Property analytics`** — `5923bb05-5109-4262-a62c-3976dbc39ea6`
- Environment **`production`** — `0269eab3-675f-4fa2-813b-f4c8bb7789bb`
- Service **`sqftlab`** — `a992bc5a-4bd3-47c9-b4c5-a4f768941a88`
  (domain seen: `sqftlab-production.up.railway.app`)
- Service **`crudepulse`** — `0ecd7203-f1a8-4f69-847b-66b0a9365c5c` (domain `www.crudepulses.com`).
  **Never touch this service** — the user asked for sqftlab-only changes.
- Last sqftlab deployment `20214406-2f74-4c1d-8e9c-f16d79391c3f` → **status FAILED, stopped: true**.
  Build logs: `https://railway.com/project/5923bb05-5109-4262-a62c-3976dbc39ea6/service/a992bc5a-4bd3-47c9-b4c5-a4f768941a88`
- **No Railway credential works.** Every token on disk is expired: `640cbfc7-…` (the only
  `RAILWAY_TOKEN` value in the session record) returns `Not Authorized`; the UUID the user
  pasted fails as both account and project token; GraphQL on both `backboard.railway.com`
  and `backboard.railway.app` rejects all of them. Do not burn more turns hunting.

**Why the site is down (514/522 chain, fully diagnosed):**
1. The sqftlab deployment FAILED and Railway stopped the container.
2. With no running deployment, Railway's edge returns `404 {"message":"Application not found"}`
   for *both* `sqftlab-production.up.railway.app` and `47edlwve.up.railway.app`.
3. Cloudflare therefore cannot reach an origin → **persistent 522** on `www.sqftlab.com`.
   This is NOT a stale-code problem; pushing more commits changes nothing.

**Bugs fixed that would block any redeploy:**
- `railway.toml` healthcheck pointed at `/api/sqftlab/stats` (six Prisma queries). With
  `restartPolicyMaxRetries = 5` a DB error fails the healthcheck → Railway stops the service
  → total outage. Now uses `/health` (liveness, no DB); `/api/health/db` reports DB state.
- `railway-build.sh` / `railway-setup.sh` swapped the schema to postgresql whenever
  `DATABASE_URL` was merely *non-empty* — so a SQLite path or a literal `${{...}}` placeholder
  produced `provider = "postgresql"` against a non-postgres URL, killing every Prisma call
  with **P1013**. Both now test for an actual `postgres://` / `postgresql://` URL.
- Unmatched `/api/*` returned the SPA shell with a 200; now a JSON 404.
- `/api/checkout`, `/api/subscribe`, `/api/create-payment-intent` were 404 (spec Part 5.5 /
  Part 11 require 503 + message); Stripe webhooks now log-and-ignore.

**Verified fact about building from GitHub:** `src/generated/` is **gitignored (0 files tracked)**
and `server.tsx:45` imports `./src/generated` inside a **silent `try/catch`**. A clean clone has
no `src/generated`, so if the build's generate step ever fails the CRUD API silently disappears
and the server still boots — a failure mode that looks like "empty pages", not a crash.
`railway-build.sh` regenerates it (`bun run generate`), verified on a clean clone: `index.ts`
and `routes.ts` are produced and `vite build` succeeds.

- **Railway never auto-deploys.** The GitHub repo has **0 webhooks** and **0 Actions secrets**,
  so neither Railway's GitHub integration nor the `deploy.yml` workflow can fire. Pushing to
  `main` does NOT cause a deploy. Fix: Railway → sqftlab service → Settings → Source →
  reconnect the repo (this installs Railway's own webhook), or add a `RAILWAY_TOKEN` secret.
- **Cloudflare serves an interactive "heavy traffic" challenge to every visitor** on the
  apex/www, which makes the site look broken even when the origin is healthy.


