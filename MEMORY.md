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

## sqftLab — live hosting

- **The site IS live at https://sqftlab.shogo.one** (republished 2026-09-23, verified in a real browser:
  200 listing cards with images + external source links, 30 deal cards, Leaflet map with ~35-40
  markers, analytics charts, zero console errors). Re-publish with the `publish` tool, no subdomain.
- **That deployment has no backend** — every `/api/*` returns the SPA shell. So `src/data/snapshot.json`
  (built by `scripts/build-snapshot.py`) is baked into the bundle and `safeFetch` falls back to it,
  which is why the live site shows the real register instead of placeholders. **Regenerate the
  snapshot and re-publish whenever the data changes**, or the live data goes stale.
- `preview_project` errors for this project and reports no fallback URL — do not hand out a
  localhost link. The working local full-stack server is port 3101 (SPA + `/api` on one origin).

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



## 2026-09-23 — Post-redeploy verification (still down)

User reported redeploying. Verified from independent networks (this sandbox's IP is
Cloudflare-rate-limited, so checks were routed via codetabs/allorigins/jina proxies):

- `www.sqftlab.com/api/sqftlab/stats` → **522** on 4 probes over ~3 min (Cloudflare cannot
  reach the origin at all).
- `www.sqftlab.com/` via jina → Cloudflare Turnstile "heavy traffic" challenge page,
  response header `railway-hikari/ord1.x8wt`.
- `47edlwve.up.railway.app` → resolves 69.46.46.48, Railway edge alive, but
  **404 {"message":"Application not found"}** = no app bound to that hostname.
- `sqftlab-production.up.railway.app` → same 404. NOTE: `crudepulse-production.up.railway.app`
  ALSO 404s, so these `-production` hostnames are *guessed* from a naming pattern and are
  NOT evidence about deploy state. Do not cite them as proof.
- **`https://sqftlab.shogo.one` → 200**, serving the current bundle. `/api/*` there is 503
  (no API sidecar) and the SPA falls back to `src/data/snapshot.json`. This is the only
  verified-working public link.

Key deduction: a 522 means the origin did not respond at the TCP/TLS layer. If Cloudflare's
origin were the Railway host we probed — which answers 404 — visitors would see a 404, not a
522. So either the service has no running deployment, or Cloudflare points at a host that is
not answering. **Decisive 30-second test for the user: set the Cloudflare record to "DNS
only" (grey cloud) and load the origin directly** — that reveals which of the two it is.

### Deploy path verified green (clean clone of GitHub main)

Ran Railway's exact `scripts/railway-build.sh` on a fresh `git clone` with a
postgres-style `DATABASE_URL`: schema swap works, bundle builds (`✓ built in 4.5s`).
Only the `db push` step failed, and only because the test host was unreachable (P1001).
So the next deploy **will build** — the remaining blocker is Railway-side, not code.

Also confirmed: `src/generated/` is gitignored (`git ls-files src/generated` → 0) and
`server.tsx:47` imports it in a **silent** try/catch. A generate failure therefore yields a
booted, /health-passing container with the entire CRUD API missing — blank pages, no error.
Fixed by making `railway-build.sh` detect a missing `src/generated/index.ts` and say so
loudly (commit 703e7f7, both branches unit-tested).

### Credential state

- GitHub PAT (fine-grained, `admin:true`, contents+admin) stored in `~/.git-credentials`
  (chmod 600, gitignored). Auth verified `GET /user` → 200. Plain `git push` works.
  NOTE: this file is wiped whenever the runtime restarts — re-install it if pushes fail.
- The PAT lacks the `Webhooks` permission (`403 Resource not accessible by personal access
  token`), so webhook repair cannot be done from here.
- ALL Railway credentials remain dead (exhausted: CLI absent, no stored login, no env vars,
  session-record token `640cbfc7-…`, the pasted `6c9b84b8-…`, GraphQL on both
  backboard.railway.com/.app). Railway auth is a hard wall — need a fresh Account token.

## ⚠️ The blank-page bug — root cause and where the fix lives (2026-09-24)

**Symptom:** green build (`built in 4s`), `#root` empty, `<body>` height 0, page blank.
CSS loaded fine; no console error. Only visible by loading the app in a browser.

**Cause:** the preview proxy mounts this app under `/p/<projectId>/` and the Vite
watcher builds with `--base /p/<projectId>/`, so `index.html` references
`/p/<id>/assets/index-*.js`. That path matched no route in `server.tsx`, so it fell
through to the SPA catch-all (`app.get('*', serveStatic('./dist/index.html'))`) and
returned **HTML where a JS module was expected** — the module never executed.

Proof (before → after): `/p/<id>/assets/index-*.js` was `200 text/html`, now
`200 text/javascript`; `/p/<id>/api/*` was `200 text/html`, now `200 application/json`.

**Fix:** `server.tsx`, inside `// SHOGO:CUSTOM-START preview-prefix … END` — a
middleware that strips a leading `/p/<id>` before routing and re-enters `app.fetch`.
Do not remove it. If it ever regresses, that is the first place to look.

**To restart the project server** (it does NOT watch `server.tsx`): append a newline
to `custom-routes.ts`. The runtime watches that file and restarts within ~8s, which
re-imports `server.tsx`. `preview_project` errors for this project — no fallback URL.

## Local repo can be behind/rolled back — check the remote (2026-09-24)

This session the local repo was found at `739cd00` with a clean tree, while
`origin/main` was at `acac813` — **two commits ahead**. Work believed done was missing
from local. Always `git fetch` and compare before assuming state, then
`git rebase origin/main` (never force-push over remote commits).

## Features added per Master Document TASKS 8-12 (2026-09-24)

- **TASK 12 Deal Alert Engine:** `DealAlert` + `AlertMatch` models; `src/lib/alerts.ts`
  (`scanDealAlerts`, `notifyPendingMatches`, `recentMatches`); routes
  `GET/POST /api/alerts`, `DELETE /api/alerts/:id`, `/alerts/scan`, `/alerts/notify`,
  `/alerts/matches`. A deal = `pricePerSqft < district median × 0.85`. Scan is
  idempotent via the `(alertId, listingId)` unique constraint. Notify refuses with
  `transport: 'unconfigured'` when no mail transport exists — it must never mark a
  match notified without delivering it.
- Legacy rule-based `Alert` model moved to `/api/alert-rules` so it stops shadowing
  the new `/api/alerts` (same path, older route won).
- **TASK 10 forecast:** `GET /api/forecast?district=&months=` — least-squares
  regression, R², residual band widening by horizon. `src/components/ForecastChart.tsx`
  is pure SVG (solid blue actuals, dashed violet projection, 95% band), wired into the
  Analytics page and the district page.
- **TASK 8 /markets:** `GET /api/markets` + `MarketsPage` sortable table (District,
  Avg PSF, 3M, 12M, Volume, Listings, Momentum) with city/type filters. All aggregated;
  `3M` is measured (last 3 months vs prior 3) and shows "—" when there is no history
  rather than inventing a figure.
- **TASK 11** `Subscription` model. **`GET /api/sqftlab/me`** returns the demo user's
  tier; the `/alerts` Elite gate now resolves against it, so an entitled account sees a
  working page instead of a permanent "Coming soon" overlay.

## Second half of the blank-page bug: the published site (2026-09-24)

Fixing `server.tsx` fixed the **local** preview only. The **published** site was still
blank, for a related but distinct reason:

- The static publish host serves assets from the **site root**: `/assets/index-*.js`
  → `200 application/javascript`.
- But the runtime builds with `--base /p/<projectId>/`, so `index.html` shipped
  `/p/<id>/assets/index-*.js`. That path matches no file on the static host, so it
  falls through to the SPA fallback and returns **HTML for a JS module** → blank page.

`/assets/...` works on BOTH hosts (verified on the live site and locally), so the fix
is to make `index.html` reference root-absolute asset paths.

Two mechanisms, both committed:
1. **`vite.config.ts` → `relativeAssetBase()` plugin** (authoritative) rewrites the
   tags via `transformIndexHtml`. The runtime merges this config, so it applies on
   every build — **but only after the watcher restarts**: `vite build --watch` reads
   its config once at process start, so editing `vite.config.ts` does NOT take effect
   on a live watcher.
2. **`node scripts/fix-html-base.mjs`** rewrites `dist/index.html` in place. Run this
   after any rebuild and **before publishing** while the plugin is not yet active.
   Idempotent.

⚠️ Consequence to remember: any rebuild by the current watcher reverts
`dist/index.html` to the prefixed URLs. If a src change triggers a rebuild, re-run
`scripts/fix-html-base.mjs` before publishing, or restart the watcher so the plugin
takes over.

Verified live on 2026-09-24: `/assets/index-*.js` → `200 application/javascript`,
`#root` innerHTML 23,532 chars, height 1,962px, Markets table with 40 districts,
forecast chart (R² 0.04, projected Feb 2027 3,749 AED/sqft), Alerts form ungated,
zero console errors.
