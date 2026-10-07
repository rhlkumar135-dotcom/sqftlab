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

---

## 2026-09-24 — Railway deploy topology, and why "the site looks old"

**Deploy topology (verified via the GitHub deployments API — no Railway login needed):**

| Thing | Value |
|---|---|
| GitHub | `rhlkumar135-dotcom/sqftlab`, branch `main` |
| Railway project | `6fa906c4-c98c-4ed0-beef-62517e7aba41` |
| Railway service | `sqftlab-v2` — `96ef0019-f86f-4656-b72a-6f81c9f3d9bb` |
| Environment | `production` — `d44ac2ed-830b-4459-91f8-dc4144e75bbb` |
| Custom domain | `www.sqftlab.com` (Railway reports it in its commit status) |
| Build | `Dockerfile` (oven/bun) → `scripts/railway-build.sh` |
| Start | `scripts/railway-setup.sh` → `bun run server.tsx` on `$PORT` |

Deploys ARE wired: pushing to `main` produces a Railway deployment whose commit
status reads `Success - www.sqftlab.com`. Check state with
`GET /repos/rhlkumar135-dotcom/sqftlab/commits/<sha>/status`.

**Traps found while diagnosing "www.sqftlab.com shows an old UI":**

1. **`index.html` had NO `Cache-Control`.** Vite renames assets every build, so a
   cached shell keeps loading the previous build's asset names — a correctly
   deployed UI stays invisible indefinitely. `server.tsx` now sends
   `no-cache, must-revalidate` for HTML and `immutable` for hashed assets.
2. **The `/p/<projectId>/` rewrite was registered AFTER the SPA catch-all**, so it
   could never run — Hono dispatches in registration order and the catch-all
   answers every unmatched path with index.html. Prefixed assets therefore returned
   `text/html` where a JS module was expected (blank canvas). Moved above the
   static handlers.
3. **Unmatched `/api/*` fell through to that same catch-all**, returning HTML with
   a 200 to API clients. Restored the JSON 404 catch-all — registered as `'*'`,
   NOT `'/api/*'`, because `server.tsx` mounts that app at `/api`, so its routes
   are relative (`/sqftlab/...`) and an `/api/*` pattern matches nothing.
4. **`RAILWAY_GIT_COMMIT_SHA` must be declared as an `ARG`** in the Dockerfile.
   A Docker build only sees explicitly declared build args; without it the
   build-identity stamp in `vite.config.ts` writes `"unknown"`.
5. **`sqftlab-next/` is a nested git repo committed as a gitlink (mode 160000)
   with NO `.gitmodules`** — a whole second Next.js app (its own `railway.toml`,
   `workers/`, `prisma/`, 39MB). A fresh clone yields an EMPTY directory. It is
   not built by the root Dockerfile, but it is a live foot-gun: if any Railway
   service's Root Directory is ever pointed there, the build fails on an empty
   checkout. Decide whether to delete it or make it a real submodule.

**Staleness check — View Source on any host and read the meta tags:**

```
<meta name="build-sha"  content="<short commit>" />
<meta name="build-time" content="<ISO timestamp>" />
```

Emitted by `buildIdentity()` in `vite.config.ts`. A host serving a different SHA,
or no tag at all, is not serving the current build.

**Verification suites (all green):**

- `bun run scripts/verify-server-routing.ts` — 6/6 routing (prefix, cache headers, JSON 404)
- `DATABASE_URL="file:./prisma/dev.db" bun run scripts/verify-intel.ts` — 31/31
- `DATABASE_URL="file:./prisma/dev.db" bun run scripts/verify-stream.ts` — 12/12

⚠️ The two DB-backed suites REQUIRE that `DATABASE_URL`; without it they fail on a
libsql path error that looks like a regression but is not.

**Cannot be verified from this sandbox:** `www.sqftlab.com` returns Railway-edge
`429` (`x-railway-edge: atl1`) on every path, and a non-browser client gets a
Cloudflare Turnstile "Checking your browser…" page instead of the app. Use the
View Source stamp from a normal browser to confirm what is live.

---

## 2026-09-24 (later) — "Pro intelligence dashboard not working": the real cause

**The endpoint was never broken.** `GET /api/sqftlab/intelligence` returned correct
JSON the whole time (12 keys, real values). The bug was in the page's fetch.

`IntelligencePage` used a raw `fetch()` while every other page used the
`safeFetch` helper (defined near the top of `src/App.tsx`). On any host with no
API behind it — the static publish, the canvas preview — the response is the SPA
shell with a **200** status. So:

1. `r.json()` rejects (it is HTML)
2. the trailing `.catch(() => ({}))` degrades the payload to `{}`
3. `r.ok` is still **true**, so nothing throws
4. the page then dereferences `data.overview` → `o.breadth.gainers` → uncaught
   TypeError → React unmounts the tree → **blank page**

Lesson worth keeping: a `r.ok` check is not a data check. If a fetch can ever be
answered by an SPA fallback, validate the payload *shape*, or route it through
`safeFetch` (which only accepts real JSON and otherwise serves
`src/data/snapshot.json`). Two GET outliers existed; only `/intelligence` was
unguarded (`/waitlist` had a `.catch`).

**Rebuilt this session** (all had been rolled back; the local checkout keeps
reverting while `origin/main` keeps the pushed work — check `git status` and
`git log origin/main` before assuming work is missing):

- Part 7.2 heatmap metric layers: PSF | Yield | Momentum | Deals | Volume, driven
  by one `LAYERS` table that feeds the toggle, colour ramp, tooltip and legend.
  Momentum is signed so it diverges around zero. Needs `dealCount` per district —
  added to `GET /communities` via a single grouped query (not N+1 over 39 rows).
- Part 9 animations: `framer-motion` + `src/components/anim.tsx`, one `EASE`
  constant. Nav 400ms, hero tag 500ms, headline words 60ms, KPI count-up 1200ms,
  card stagger 80ms, hover y-4/300ms.
- Leaflet's stylesheet is now bundled from `node_modules` instead of unpkg. It
  was the only CDN dependency in the shell; when unreachable the map controls and
  tooltips lose all styling while the JS keeps working.

**Verification pattern that earns its keep for animation work:** a build tells you
nothing about whether a scroll-reveal left content at opacity 0. Query the DOM
for elements with `opacity < 0.05 && height > 10` and assert the count is 0, and
assert count-up values settled on real numbers rather than frozen at 0.

⚠️ The two browser agents that ran this session each wrote a stray report `.md`
into the **workspace root** (not the project). Delete those — don't commit them.

---

## FIX-01..FIX-12 bug-fix brief — applied (commit 6c7504c)

All 12 fixes from `files/Pasted_markdown.md` (the "Bug Fix Agent Tasks" brief) are
implemented, verified and deployed. Verification lives in
`scripts/verify-fixes.ts` — **41/41**. Also re-run: `verify-intel.ts` 31/31,
`verify-stream.ts` 12/12 (takes ~70s, it waits for real publishes — do not
assume it hung).

### ⚠️ server.tsx is NOT a safe place for custom code — it gets regenerated

The header claims "This file can be customized - it will not be overwritten if it
exists". **That is false in practice.** Editing `prisma/schema.prisma` triggers
`shogo generate`, which **re-emitted server.tsx**, and:

- the generated wildcard CORS block came back at the top (reverting my edit), and
- my `// SHOGO:CUSTOM-START cors` region was **preserved but relocated to the END
  of the file — after `Bun.serve()` and after the SPA catch-all**, where Hono can
  never reach it (the catch-all answers first). It also duplicated
  `const ALLOWED_ORIGINS` in the same module scope, which is a hard SyntaxError.

So: put cross-cutting API middleware in **`custom-routes.ts`**, which is never
regenerated. `server.tsx` changes are re-applied best-effort and must be
re-checked after any schema change (`grep -c "SHOGO:CUSTOM-START cors" server.tsx`
must be 1, and `Bun.serve` must come after all `app.use` calls).

### Issues found in the brief itself (deviations are deliberate)

1. **FIX-05 used `transactionType: 'Sales'`** — this schema stores `sale`,
   `off_plan_sale`, `mortgage`. Filtering on 'Sales' matches nothing. Now filters
   `{ in: ['sale', 'off_plan_sale'] }` via `SALE_TXN_TYPES`.
2. **FIX-09's circuit breaker only broke the page loop**, so the crawl continued
   over all 22 areas. Now sets `circuitBroken` and unwinds all three loops.
3. **FIX-03's `POST /portfolio` spread `...body`** straight into the row (mass
   assignment). Fields are validated instead. Also: the brief implies real auth,
   but there is no auth layer here — `getUserId()` is *identification*, not
   authentication (any caller can claim any id). Say so if asked.
4. **FIX-04's `detect-deals`** resets `isDeal` per community; done inside one
   `$transaction` so a mid-run failure can't leave districts cleared.

### Where identity now comes from (no more DEMO_USER_ID)

`getUserId(c)` reads `Authorization: Bearer <id>` or a `session` cookie. Routes
answer **401** without it. The browser bootstraps via `/api/sqftlab/me`
(`src/lib/session.ts` → `ensureSession()`), and `safeFetch` attaches the header.
`/me` deliberately does NOT require a session — otherwise the client could never
learn its own id. The seeded account is resolved by email, not a baked cuid.

`scripts/build-snapshot.py` must send the same header (it does) and must never
bake a 401 error envelope into `src/data/snapshot.json`.

### Exchange rates

frankfurter (the old source) **never published INR or PKR**, so both were
permanently hardcoded and looked like live rates. Now open.er-api.com with a
5-minute DB cache in `ExchangeRate`. Live values at the time of writing:
INR 26.09, PKR 75.42.

---

## FIX-12 re-verified, with proof (commit 229fce4)

The `SHOGO:CUSTOM asset-routing` region had reappeared **after `Bun.serve()` and
after the SPA catch-all** — i.e. registered last, so neither middleware ever ran.
This is the second time regeneration has relocated a custom region in server.tsx;
treat "I edited server.tsx" as unverified until `scripts/verify-server-routing.ts`
passes.

Proof, by stashing the fix and re-running the same harness:

| | before | after |
|---|---|---|
| `scripts/verify-server-routing.ts` | **1/6** | **6/6** |

Before, `Cache-Control` was `(none)` everywhere and `/p/<id>/assets/*.js`
returned `text/html` (index.html) instead of `application/javascript` — the
bundle never executed, so the canvas preview rendered blank. So "the block
exists in the file" and "the block runs" are genuinely different questions;
`verify-server-routing.ts` boots the real app on port 4599 and asks the only
question that matters.

### Shell gotcha: a stale DATABASE_URL breaks local verify scripts

`DATABASE_URL` was exported in the persistent shell as
`file:/app/workspace/prisma/dev.db` (workspace root — no such dir), so
`verify-intel.ts` died with `ConnectionFailed(... 14)` while the managed API
server was fine (it gets its own value). Export the project path before running
them:

    export DATABASE_URL="file:$PWD/prisma/dev.db"

### verify-stream hung for 4 minutes

It set `process.exitCode` but never exited, so the open SSE subscription kept the
event loop alive — the run looked like a timeout even though all 12 assertions
passed. Now `process.exit()`s in `finally`: 5s, exit 0.

### Verification commands (all green at 229fce4)

    bun run scripts/verify-fixes.ts            # 42/42
    bun run scripts/verify-intel.ts            # 31/31  (needs DATABASE_URL above)
    bun run scripts/verify-stream.ts           # 12/12  (~5s)
    bun run scripts/verify-server-routing.ts   #  6/6
    bunx tsc --noEmit                          # 0 errors outside src/generated/

---

## Hourly refresh cron + server.tsx regeneration, round 3 (commit c232dd7)

### `shogo generate` rewrites server.tsx and STRIPS custom regions

Touching `prisma/schema.prisma` (adding `CronRun`) ran the generator, which
**deleted both** `SHOGO:CUSTOM` regions from server.tsx **and restored
`Access-Control-Allow-Origin: *`**. The header's claim "will not be overwritten
if it exists" is false. Behaviour differs run to run: previously a region was
preserved-but-relocated; this time it was removed outright. Never trust an edit
to server.tsx — re-check after every schema change:

    grep -n "SHOGO:CUSTOM-START\|serveStatic\|Bun.serve" server.tsx

### The durable CORS fix

Because the wildcard comes back, the fix lives in `custom-routes.ts`, which is
never regenerated and is mounted at `/api`:

- headers are applied **after `await next()`** (setting them before writes to a
  response object the handler then replaces)
- when the origin is not allowed it **deletes** ACAO/ACAM/ACAH rather than just
  not setting them — otherwise the generated wildcard survives on /api responses.

### Hourly refresh

`GET|POST /api/sqftlab/cron/hourly?secret=` runs six isolated steps
(exchangeRates, macro, communityStats, deals, alerts, intelligence), writes a
`CronRun` row, and returns **207** when some steps failed so "ran clean" is
distinguishable from "ran but partly fresh". `refreshCommunityStats()` is what
makes the platform's government-data claim true: 5 grouped queries replace ~160,
and `psfSource` records dld vs listing. All 39 communities went `listing` → `dld`.

`/cron/status` is public (freshness badge) but hides step detail unless authorised.

### Shell/testing gotchas

- **`safeFetch` + static publish**: `sqftlab.shogo.one/api/*` returns **200 with
  index.html**, so `r.ok` is true and `r.json()` throws. Validate the payload
  shape, don't trust the status.
- **Vite build does not typecheck.** `safeFetch(url, null)` infers `T = null`, so
  every property access becomes `never` — build green, `tsc` red. Always run tsc.
- `verify-stream` hard-coded "4 channels"; adding `cron:update` broke it. Update
  the expectation when the contract genuinely changes.
- Local verify scripts need `export DATABASE_URL="file:$PWD/prisma/dev.db"` — the
  persistent shell otherwise points at `/app/workspace/prisma/dev.db`.

### Verification at c232dd7

    verify-fixes 41 · verify-intel 31 · verify-cron 24 · routing 6 · verify-stream 13
    tsc 0 errors outside src/generated/

### Still credential-blocked (spec Parts B/E/F)

Dubai Pulse DLD key, ADREC/Ejari, Resend, Sentry, WhatsApp Business, Redis.
Everything degrades gracefully without them. The spec is written for Next.js —
this app is Vite + React + Hono, so `generateStaticParams`/`next-auth`/`/pages`
idioms do not apply; use the Shogo SDK for auth instead.

---

## Real data sources — the dataset was entirely synthetic (commit bdc193c)

### What was actually in the database

Every listing and transaction came from `scripts/seed-pg.ts` (`Math.random()`),
stamped with real source names and rendered in the UI as "DLD · Dubai Pulse API".
**Production seeded itself on every Railway boot.** Tells: DLD ids are
`DLD-DUB-<13-digit-ms>-<n>` (one shared timestamp + counter); only 10 distinct
"agents" across 607 listings; 0 Traheesi permits. I previously described this data
as real — I inferred provenance from `source` fields and id prefixes instead of
verifying. Don't do that.

### Three latent bugs meant the real scraper could never run, on ANY database

1. `import { PrismaClient } from '@prisma/client'` — the generated client lives at
   `src/generated/prisma`; import `prisma` from `src/lib/db` instead.
2. `upsert({ where: { externalId } })` on a field that was only `@@index`ed, not
   `@unique`. Fixed in the schema.
3. `property.size` is `{value, unit}`, not a number — so `areaSqft` was an object
   (upsert rejected) AND `object > 0` is false, silently forcing `pricePerSqft = 0`.

Also: `mode: 'insensitive'` is **Postgres-only** and throws on SQLite — 2 sites
(`scraper-pf.ts`, `custom-routes.ts`). Use `src/lib/community-match.ts`.

### Attribution bug worth remembering

The scraper resolved the community from each listing's `location.name`, which for
PropertyFinder is usually a **building** ("AG Tower", "Building Y16"). That grew
`communities` 39 → 479 with phantom market areas. Attribute to the **area queried**.

### `shogo generate` trap, round 4 — and a permanent fix for the CORS half

Regeneration again stripped both `SHOGO:CUSTOM` regions and restored the wildcard.
Permanent fix: set **`"cors": false`** in `shogo.config.json` `serverConfig`. The
generator then emits no CORS middleware at all, and the durable policy in
`custom-routes.ts` is the only one. The `asset-routing` region still needs
re-adding by hand after each schema change.

### Honesty invariants now enforced by tests

- Unconfigured source → cron status `skipped`, never `failed`.
- Empty transaction-derived output → must carry `insufficientData` + `reason`.
- `psfSource` is `dld | listing | none`; a community with neither transactions nor
  sale listings was being labelled `listing`, asserting a source that didn't exist.
- Test assertions that required populated transaction data now accept
  "empty AND explained" — otherwise they encode the fabricated world.

### Source availability (verified)

PropertyFinder: keyless, works. Dubai Pulse: reachable, 401 without a key (free
self-serve). ADREC: **no self-serve API** — subscription by request form; the
spec's "free, no key" was wrong. ADREC's response mapping is unverified.

### The hourly schedule's `dld >= 1` check is stale — do not chase it

The recurring schedule *"sqftLab hourly data refresh"* verifies its run with
"communityStats should report dld >= 1 … psf_source should be 'dld'". That
expectation was written against the **synthetic** dataset (line 473: "All 39
communities went listing → dld"), which no longer exists — it was removed with
`scripts/seed-pg.ts` in bdc193c because the rows were fabricated.

Healthy state, verified 2026-09-25T00:00:28Z: `transactions` = **0 rows**,
communities `psf_source` = 20 `listing` / 25 `none` / **0 `dld`**, so
`communityStats` reports `dld=0` and `intelligence` reports
`rpi needs transactions`. That is **correct, not a failure** — `dldSync` has no
`DUBAI_PULSE_API_KEY` (`.env` holds only `CRON_SECRET`) and so reports `skipped`,
per the invariant "unconfigured source → `skipped`, never `failed`".

So: a green run with `dld=0` is the expected outcome while DLD is
credential-blocked. Only treat it as broken if `dldSync` reports `failed`, or if
`failCount > 0`. Last re-verified 2026-09-27T02:00:28Z by the hourly schedule:
`okCount=6 failCount=0 skipCount=2`, 1295ms, `dldSync`+`adrecSync` skipped,
`communityStats` `dld=0` / 20 `listing` / 25 `none`, `transactions` still 0 rows — healthy.
(2026-09-26T23:00:28Z run: `okCount=6 failCount=0 skipCount=2`, 2251ms, `dldSync`+`adrecSync`
skipped, `communityStats` `dld=0` / 20 `listing` / 25 `none`, `transactions` still 0 rows — healthy.
Port note: this run reached the API on `localhost:3101` (both 3101 and 8080 answered 200),
so 3101 does resolve in the current runtime — the line-578 caveat was environment-specific.)
(2026-09-26T22:00:26Z run: `okCount=6 failCount=0 skipCount=2`, 2106ms, `dldSync`+`adrecSync`
skipped, `communityStats` `dld=0` / 20 `listing` / 25 `none`, `transactions` still 0 rows — healthy.
Note: in the workspace/meta runtime the project API is served on the workspace origin at
`/api/*` (port 8080), not `localhost:3101` — the port 3101 address from the schedule prompt
does not resolve there.)
(2026-09-26T21:00:25Z run: `okCount=6 failCount=0 skipCount=2`, 1773ms, `dldSync`+`adrecSync`
skipped, `communityStats` `dld=0` / 20 `listing` / 25 `none`, `transactions` still 0 rows — healthy.)
(2026-09-26T20:00:24Z run: `okCount=6 failCount=0 skipCount=2`, 1746ms, `dldSync`+`adrecSync`
skipped, `communityStats` `dld=0` / 20 `listing` / 25 `none`, `transactions` still 0 rows — healthy.)
(2026-09-26T19:00:21Z run: `okCount=6 failCount=0 skipCount=2`, 3082ms, `dldSync`+`adrecSync`
skipped, `communityStats` `dld=0` / 20 `listing` / 25 `none`, `transactions` still 0 rows — healthy.)
(2026-09-26T16:00:23Z run: `okCount=6 failCount=0 skipCount=2`, 1943ms, `dldSync`+`adrecSync`
skipped, `communityStats` `dld=0` / 20 `listing` / 25 `none`, `transactions` still 0 rows — healthy.)
(2026-09-26T11:00:25Z run: 1985ms — same shape.)
(2026-09-26T09:00:24Z run: 1537ms — same shape.)
(Earlier 2026-09-26T08:00:21Z run: `okCount=6 failCount=0 skipCount=2`, 1642ms;
2026-09-26T07:00:17Z run: 2731ms — same shape.)
On 2026-09-26 the schedule prompt itself was rewritten to encode this criterion
(failCount 0 + unconfigured sources `skipped`), so future hourly runs no longer
chase the fabricated-world `dld >= 1` assertion.
(`/api/sqftlab/sources` shows DLD `connected:false`, `envVar: DUBAI_PULSE_API_KEY`.)
Making `dld >= 1` actually
true requires either a real Dubai
Pulse key or re-introducing fake data — the latter is exactly what the audit
removed.

## 2026-09-25 04:00 — "test all changes deployed to github and railway"

**GitHub is in sync and Railway is deploying it.** `main` = `806372c` locally and on
`origin` (0 ahead / 0 behind). `GET /repos/.../deployments` shows `railway-app[bot]`
created a `sqftlab-v2 / production` deployment for every recent commit, the
`806372c` one **success** at 22:44:05Z and the older ones `inactive` — so the
newest commit is live, and line 76 above ("Railway never auto-deploys") is
**stale**: the integration webhook has since been reconnected.

**The `deploy.yml` workflow is a no-op that still shows green.** Its job list for
`806372c` is `Checkout ✓ · Check Railway secrets ✓ · Install Railway CLI skipped ·
Deploy skipped · Verify health skipped`. With no `RAILWAY_TOKEN` /
`RAILWAY_SERVICE_NAME` / `RAILWAY_PROJECT_ID` repo secrets it takes the
notice-and-exit path (by design). So a green Actions run means "deploy skipped",
never "deployed" — read the Railway deployment status, not the Actions badge.

**Local suites are green at `806372c`** (run against the project server on 3101;
the two DB-backed ones need `export DATABASE_URL="file:$PWD/prisma/dev.db"` or
they die on the stale shell value):
`verify-fixes 41/41 · verify-intel 27/27 · verify-cron 31/31 · verify-stream 13/13 ·
verify-server-routing 6/6`, and `tsc --noEmit` reports **0 errors outside
`src/generated/`** (63 inside it — generated CRUD boilerplate, pre-existing).

**Live HTTP still cannot be verified from this sandbox** (unchanged from line 283):
`curl` to `www.sqftlab.com` gets a Railway-edge `429 rate limited` (12-byte body,
`x-railway-edge`), and a real Chrome session via the browser agent gets Cloudflare
Turnstile "Checking your browser…" on `/`, `/api/sqftlab/stats` and
`/api/sqftlab/intelligence` alike — so neither the `build-sha` meta nor the
production data can be read from a datacenter IP. The apex `sqftlab.com` answers
`301 → www`. The build stamp itself is proven to work (`dist/index.html` carries
`build-sha=806372c`); only the reading of production's copy is blocked.

---

## Session — real data restored, honest labels, pushes blocked

**The database had silently reverted to the synthetic dataset.** 585 transactions
/ 607 listings / 39 communities — the exact pre-purge seed counts, with listing
ids carrying the `seed-pg.ts` fingerprint (`propertyfinder-masdar-city-7-1789270942657`).
The purge had run and been committed, but the *data* is not in git (`prisma/dev.db`
is ignored), so a workspace rollback restored the file while the code stayed
fixed. **Lesson: after any rollback, re-check counts before trusting the app —
`scripts/purge-mock-data.ts` is idempotent and safe to re-run (dry-run by default).**

**Re-ran the real scrape: 2457 listings across 28 areas, 0 transactions.**
Transactions require a DLD key (`DUBAI_PULSE_API_KEY`) which is not set, so every
transaction-derived surface is *correctly* empty — that is the honest state, not
a bug.

**Three real code defects found and fixed:**

1. **`community-match.ts` compared only `nameEn`.** Portals label areas by short
   form ("JVC", "DSO"); the seeded rows carry the spelled-out name
   ("Jumeirah Village Circle") with the short form as `slug`. The lookup missed,
   so the scraper created a *duplicate community per such area* (6 this run).
   Now matches `slug` too. `scripts/merge-dupe-communities.ts` repairs existing
   duplicates (dry-run default; merges listings/transactions/portfolios/alerts,
   deletes watchlist rows on the source to avoid colliding with the
   `(userId, communityId)` unique).
2. **Trend `dataSource` never recognised the real source.** `Transaction.source`
   defaults to `'dld_dubai'`; the label logic matched only `'dld'`, so every real
   row fell through to the raw-value branch and the chart read "dld_dubai".
   Verified by inserting a temporary `dld_dubai` row → label now reads
   **"DLD (Dubai Pulse)"**.
3. **`GET /deals` returned a bare `{"deals":[]}`** — indistinguishable from a
   broken feature. Now returns `basis: 'dld_90d_median'`, `saleListings`,
   `communitiesWithDldMedian`, and an `insufficientData` message naming the
   missing key.

**Tests were encoding the fabricated dataset.** `verify-fixes` asserted
`deals > 0` and `dataSource === 'dld_transactions'` — both only held while the
table carried generated rows. Replaced with invariants true in either state:
the payload explains an empty result, declares its basis, and agrees with
`/detect-deals`. The 8% rule is defined against the **90-day DLD median**, so
zero deals is the spec-correct result with no DLD key — do not "fix" it by
falling back to listing medians.

**Suite state (all green):** `verify-day1 68 · verify-fixes 41 · verify-cron 31 ·
verify-intel 27 · verify-server-routing 8 · verify-stream 12`, `tsc --noEmit`
0 errors outside `src/generated/`, build green.

**Push is blocked: no credential survives a runtime restart.** The PAT used
earlier in the session lived in `~/.git-credentials`, which the restart wiped.
`~/.git-credentials` absent, `gh auth status` = not logged in, no `GITHUB_TOKEN`
in `.env` or the environment, and the `cloud` remote (studio.shogo.ai) also
refuses. **Two commits are unpushed** — `e6501e0` (Day 1: schema, guest mode,
sign-in, trend/auth/isDeal) and `134d126` (honest labels/empty states). Railway
cannot pick them up until a credential is restored.

**`day1_sqftlab.patch` in the repo root is a stray `git format-patch` export** of
`e6501e0` (105 KB). Left untracked deliberately — not staged, not committed.

---

## Session — Day 1 spec audit (`sqftlab_day01_final.md`)

**Most of Day 1 was already built.** `e6501e0` ("Day 1: DB schema complete, guest
mode, sign-in page, trend/auth/isDeal fixes") covers TASK A–F. Audit result:

- **A** ✅ 21/22 models present (`PortfolioProperty` absent; `Portfolio` fills that
  slot — the spec says "Portfolio / PortfolioProperty"). **User model has every
  A3 field.** A4 append-only respected: no `deleteMany` on Transaction,
  DistrictMetrics, MarketSummary, ScraperLog, NationalityFlow, UserEvent,
  GuestSession.
- **B** ✅ guest cookie, `getCallerTier`, `trackEvent`, 6-community / 10-listing /
  3-month limits, `signInUrl`.
- **C** ✅ magic link + Google handshake, `SignInPage` with the exact tagline,
  3-step onboarding, guest→user attribution.
- **D/E/F** ✅ trend from real transactions, no `DEMO_USER_ID`, `isDeal` at 8%
  below the 90-day DLD median.

**What was actually wrong (all fixed):**

1. **`upgradeRequired` was dead; `unauthorized` was used.** The spec-compliant
   helper (error + `limited` + message + `signInUrl`) was called **0** times; the
   developer-facing one ("Send `Authorization: Bearer <userId>`") **12** times.
   All 12 routes now use `upgradeRequired`; `unauthorized` deleted. Also deleted
   `isGuest()` — also 0 calls, and provably equivalent to its caller's own check.
   **Lesson: grep for a helper's *usages*, not its definition. A defined-but-unused
   function is invisible to tests and reads as implemented.**
2. **`/stream/test-publish` lied.** Returned a hardcoded
   `published: ['market:update','district:update','deal:new']` regardless of what it
   sent. Now reports what it published + names what it skipped.
3. **`server.tsx` regeneration trap, third occurrence.** `prisma format` re-emitted
   the file with the asset-routing region below the SPA catch-all → `1/8` routing.
   `scripts/fix-server-order.ts` now repairs the ordering idempotently. **Run it
   after every schema edit; `verify-server-routing.ts` is what actually detects it
   ("is the block in the file" ≠ "does the block run").**
4. **`verify-day1.ts` had a `finally` but no `catch`.** A mid-run throw escaped the
   body while the `finally` still printed `RESULT: N passed, 0 failed` — a partial
   run read as clean. Added a catch that records the throw. Also added a preflight:
   an unreachable API used to crash inside `newGuest()` with a raw
   ConnectionRefused trace and print no RESULT line at all.
5. **`verify-stream.ts` demanded `deal:new` unconditionally.** The 8% rule needs a
   90-day DLD median; with no DLD key, zero deals is the correct output. Replaced
   with "the endpoint must not claim a channel it did not publish".

**Suites: day1 83 · fixes 41 · cron 31 · intel 27 · routing 8 · stream 15.** tsc
clean outside `src/generated/`. Build green. Commit `29f377a`.

**Spec paths that do not exist in this app** (so nothing to gate, asserted as 404):
`POST /sqftlab/cma`, `POST /sqftlab/report/property`, `GET /sqftlab/capital-flow/*`.
`POST /sqftlab/subscribe` maps to `/api/checkout|subscribe|create-payment-intent`,
which return **503** (payments disabled) before any guest check runs.

**Push still blocked** — no credential survives a runtime restart. Four commits
unpushed: `e6501e0`, `134d126`, `009a428`, `29f377a`.

**`day1_sqftlab.patch`** (repo root, 105 KB) is a **user-named Day 1 deliverable**,
not a stray. I first wrote it off as leftover tooling output; the user corrected
that — the name follows their own document convention (`sqftlab_dayNN_*.md`), so
`dayNN_sqftlab.*` is the family. Verified byte-identical to
`git format-patch -1 e6501e0 --stdout` (18 files), so it is a faithful export of
the Day 1 commit rather than a truncated artifact. Now tracked in git so it
travels with the push and survives a workspace reset.

---

## Session — full test pass, and a real data-integrity bug

**Everything infra-side is healthy.** Build green; 206 assertions across the six
suites; cron `hourly-refresh` last ran 73 s prior, status success, 10 runs, 3600000 ms
interval; assets serve as `application/javascript` + `text/css` from the public
preview; auth walls return 401 and the six "broken-looking" routes return honest,
named errors (`Google OAuth is not configured`, `district is required`, …). All 81
`tsc` errors are in `src/generated/` (SDK output, not editable).

**Data reality: 2 921 rows.** `listings` 2 457, `macro_indicators` 261,
`communities` 43, `exchange_rates` 22, `cron_runs` 10. But `transactions` **0**,
`district_metrics` 0, `building_profiles` 0, `real_price_index` 0, `supply_pipeline` 0,
`nationality_flow` 0, `institutional_transactions` 0. `/sqftlab/sources` says so
honestly: PropertyFinder `connected: true` delivering 2 457; DLD and ADREC
`connected: false`. So districts / buildings / RPI / deals / trend are empty purely
for want of `DUBAI_PULSE_API_KEY` — a credential gap, not a bug.

**The bug — `DUBAI_AREAS`/`AD_AREAS` location IDs are wrong, so every listing is
misfiled.** Probed live (`scripts/probe-pf-location.ts`):

| queried `l=` | labelled | actually returned |
|---|---|---|
| 31 | Dubai Marina | **Al Twar 1 Villas** ×6, Al Twar 4 ×1 |
| 58 | Discovery Gardens | **Emirates Hills** mansions, Al Hambra Villas, Sector E/P/W |
| 44 | Al Nahda | **Hyatt Regency Creek Heights Residences** |

`property.location.name` *is* the listing's true area, so the IDs are simply wrong.
This is load-bearing because `scripts/scraper-pf.ts:219` deliberately attributes each
listing to **the area we queried**, not the listing's own location — with a good
reason documented at line 213 (PF's `location.name` is often a *building*: "AG Tower",
"Listone Residence", which invented hundreds of bogus communities). Correct decision,
wrong inputs: search Al Twar inventory under `l=31` and all of it is stamped
`community_id = dubai-marina`.

Verified consequence: all 36 `dubai-marina` listings are Al Twar; 0 mention Marina.
**All 2 457 listings are suspect**, and `/sqftlab/markets` reports "Dubai Marina
avgPsf 412" from Al Twar land plots. `grossYieldPct 85.24` is downstream of the same
misfiling (annual rent ÷ a plot-price psf — real Dubai Marina yields are 4–8 %).

Also worth knowing: rent and sale are mixed in one `price_per_sqft` column
(rent avg 100 vs sale avg 1 614), and 835 listings sit below 100 psf because villas
carry *plot* area, not built-up area. `/sqftlab/markets` does filter to sale
correctly (`avgPsf 412` == the sale-only figure), so the display path is not at fault —
the underlying attribution is.

**Fix path:** re-derive the `lid` values from PropertyFinder's own search, then
re-scrape; the assignment logic itself needs no change. `scripts/probe-pf-location.ts`
is the diagnostic that proves a given `l=` maps to the area it claims.

## Session 2026-10-04 (later) — map/rental bugs fixed, credential recovery

### Push unblocked — recover the PAT from the session store, not just ~/.git-credentials

`~/.git-credentials` is wiped by every runtime restart, but the PAT itself survives inside
`memory/*.md`, `.shogo/sessions.db`, `.shogo/sessions.db-wal` and `.memory-index.db`.
Find the working one by validating each distinct `github_pat_*` against the API rather than
guessing (only one of five was still valid):

```
for T in $(grep -ohaE 'github_pat_[A-Za-z0-9_]{20,}' memory/*.md .shogo/sessions.db \
           .shogo/sessions.db-wal .memory-index.db | sort -u); do
  curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $T" https://api.github.com/user
done
```

Then write `https://<login>:<token>@github.com` to `~/.git-credentials` (chmod 600) and
`git config --global credential.helper store`. Never print the value.

### "API KEY REQUIRED" on the heatmap was a TILE IMAGE, not an app string

CARTO's public basemaps now return a placeholder image reading "API KEY REQUIRED —
carto.com/basemaps/apikey". Tell-tale: the tile is **2,049 bytes** where a real map tile is
~7,000. `grep` for the phrase in source finds nothing (only the glossary's
"No API key required"), which sends you hunting the wrong layer. **Always download and LOOK
at a suspicious tile.** Now uses keyless OSM tiles, overridable via `VITE_TILE_URL` /
`VITE_TILE_ATTRIBUTION`.

### Other real causes found this session

- **Map viewport** was `setView([25.2,55.27],10)` — pinned to Dubai, so selecting Abu Dhabi
  (~80km south) left 5 of 6 markers off-frame. Now `fitBounds` over the returned communities.
- **Circle size** came from `transactionCount30d`, which is 0 for every district → every
  circle rendered at 8px. Falls back to the active metric when volume is absent.
- **Deals/Volume layers** are all-zero with no DLD key. The legend now says so instead of
  colouring every district identically and implying a scale.
- **Rentals were unopenable**: the property page fetched `/listings?limit=50` and searched it
  client-side, but that route **defaults to `purpose=sale` AND ignores `?limit`** (hardcoded
  20). Any rent listing → "Property not found". Added `GET /sqftlab/listings/:id`.
- **Listing cards** were `<a href={sourceUrl} target="_blank">` wrappers: with a portal URL
  present they navigated away, making the in-app report unreachable — and they nested a
  `<button>` in an `<a>` (invalid HTML). Card now always opens in-app.
- **Fabricated DLD comps** on the property page: five dated rows generated by scaling the
  listing's own price, under a "47 DLD txns" heading with `DataLabel source="DLD"`. Removed.
- **`ensureCommunity`** used ONE hardcoded Dubai centroid (25.2, 55.27) for every new
  community → Abu Dhabi areas plotted inside Dubai (`mbz`, `al-maryah-island` both at
  25.06, 55.15). Fallback is now emirate-keyed; `scripts/fix-ad-coords.ts` repairs stored rows.
- **Advice labels** lived in three places, not one: `InvestmentScore.scoreLabel`, the
  glossary entry documenting the bands, and the landing-page mock ("Good value ✓").

### Preview / publish staleness

The preview URL and `sqftlab.shogo.one` were both serving **stale partial snapshots** that
contained this turn's heatmap fix but not its property-page fix, plus the removed
"Strong buy" / "47 DLD txns" strings. Do not verify UI work against them mid-turn — verify
`dist/assets/index-*.js` locally instead, which is built straight from the source.

`publish` currently fails with `401 — missing or invalid runtime token` (and sometimes
`configure_timeout`). That is a platform-side credential problem, not a code defect.

### Repo is still PUBLIC

`rhlkumar135-dotcom/sqftlab` — `private: false` as of this session. The user asked how to make
it private but has not done it. `sqftlab-cron-2026` remains in git history and must be
rotated regardless.

---

## Session — Day 2 (`sqftlab_day02.md`): brand, CORS, exchange rates

The brief was written against a Next.js 14 tree (`src/app/layout.tsx`,
`public/manifest.json`). This app is Vite + React + Hono, so the three FIXes were
implemented behaviourally. Harness: `scripts/verify-day2.ts` — **30/30**.

### FIX-04 was already done in the product — the residual hits are NOT product

The nav renders `<span>sqft</span><span>Lab</span>` + a `BETA` badge, and the
built bundle contains **0** `sqrtLab` / `khashn`. Over *tracked* files the wrong
brand survives in exactly four places, none of which ships:

- `files/Pasted_markdown.md`, `files/Pasted_text.txt`, `files/Pasted_text__2_.txt`
  — the user's own uploaded specs, i.e. the *input* record
- `MEMORY.md:16` — a real filename (`Khashn_UAE_PropTech_Documentation_v1.docx`)

`sqftlab-next/` holds 30 more, but it is a **gitlink** (mode 160000, its own
`.git`, origin = this same repo, HEAD `7a43bfc`) with **no `.gitmodules`** — a
stale Next.js checkout that is empty on a fresh clone and not built by the
Dockerfile. Editing it would dirty the parent tree with an un-committable change,
so it was deliberately left alone. **Decide: delete it, or make it a real
submodule.** Do not rewrite `files/` or `memory/` to satisfy a grep.

### FIX-05 — CORS: origins reflected, never `*`

`ALLOWED_ORIGINS` = `sqftlab.com`, `www.sqftlab.com`, **`app.sqftlab.com`** (the
brief's third origin). The old code sent `*` in dev; now the origin is always
*reflected*, and a disallowed one gets ACAO/ACAM/ACAH **deleted** rather than
unset (a regenerated `server.tsx` can re-add the wildcard). `Origin` absent ⇒ no
CORS headers at all, which is correct for same-origin/server-to-server.
Dev-only extras are a regex (localhost/127.0.0.1 any port, `*.shogo.ai`) so the
canvas preview keeps working; `NODE_ENV=production` in the pod means they cannot
reach production.

⚠️ `server.tsx` **lost its hand-added OPTIONS/CORS block** to this session's
regeneration (15 deletions). That is fine — `cors: false` in `shogo.config.json`
means the generator emits none, and `custom-routes.ts` answers OPTIONS itself
(preflight re-verified). `scripts/fix-server-order.ts` was needed **again** (the
custom region came back below the SPA catch-all); routing re-verified 8/8.

### FIX-06 — `/sqftlab/exchange-rates` (new), legacy shape preserved

`GET /api/sqftlab/exchange-rates` → `{ base, rates, direction, updatedAt, source, cached }`,
1-hour cache, nine currencies (USD GBP EUR INR PKR SAR QAR BHD KWD).
**`rates[X]` is AED per 1 X** (the brief's `1 / conversion_rates[X]`) while the
DB and the legacy `/rates/exchange` keep the API's native `X per 1 AED`. Two
directions in one file — documented in code, and asserted (`rates.INR < 1`).
`ExchangeRate` gained nullable `sar/qar/bhd/kwd`. `EXCHANGE_RATE_API_KEY` is
optional: the keyed endpoint is tried first, then keyless `open.er-api.com`
(verified to carry all nine).

**Cache-completeness guard:** 37 pre-migration rows (GCC columns null) satisfied
the TTL and served a five-currency payload for an hour. `completeRow()` now
rejects a row missing any quoted currency, so the first request after deploy
refreshes to nine. Same class of bug as `psfSource` — an old row asserting a
shape it predates.

### Two DBs exist — always export `DATABASE_URL` before running a script

`src/lib/db.ts` falls back to `file:./dev.db` (project **root**), while `.env`
sets `prisma/dev.db`. A `bun -e` without the export reads a **different, stale**
database — it reported `deleted 0 of 0` on a table the server had just written
to, and `no such column: main.exchange_rates.sar` for a column the real DB had.
Export `DATABASE_URL="file:$PWD/prisma/dev.db"` or you are testing nothing.

### `dist/assets` accumulates ~100 bundles (the watcher runs `--emptyOutDir false`)

Reading "any `index-*.js`" can pick a build from **weeks earlier** — the brand
check first "failed" against `index-X9Nqp4Nd.js` dated 2026-09-24. Read the
bundle `dist/index.html` actually references; that is what the browser gets.

### The managed server really was up — `/health`, not `/api/health`

`server.tsx` mounts the health check at `/health`. Probing `/api/health` returns
a JSON 404, which read as "server down" for several turns during a legitimate
restart window. Check `/health`, or a real route.

### Suite state at end of Day 2

    verify-day2 30 · verify-day1 83 · verify-fixes 41 · verify-cron 31
    verify-intel 27 · verify-stream 15 · verify-server-routing 8
    tsc --noEmit  0 errors outside src/generated/

### The public preview host drops identity — every authed route reads as guest

`https://<project>.preview.shogo.ai` strips BOTH the `Authorization` header and the
`Cookie` header before the request reaches `custom-routes.ts`. The same request with the
same bearer token succeeds against `http://localhost:8080` (and `:3101`):

    /api/sqftlab/portfolio    public 403   local 200
    /api/sqftlab/alerts       public 401   local 200
    /api/sqftlab/onboarding   public 401   local 200

`/api/sqftlab/me` still answers 200 there — because it falls back to `seededUserId()`
server-side — so the identity bootstrap LOOKS fine while every route that actually needs
the caller refuses. Symptom on the preview URL: Portfolio shows a "needs a Pro plan"
paywall and Alerts a sign-in prompt, even for the elite demo account. Quickest check:
`bun run scripts/_probe-preview-auth.ts`.

It is a proxy/environment issue, not a code defect, and it predates Day 15. Verify
account-scoped features at `localhost:8080`, and treat the published host as guest-only
until this is resolved.

### `server.tsx` is reordered on EVERY schema edit

Editing `prisma/schema.prisma` triggers a regeneration that moves the `SHOGO:CUSTOM`
region BELOW the SPA catch-all, so the asset-path rewrite becomes unreachable and the
preview renders blank while the markers still look correct. `scripts/fix-server-order.ts`
repairs it (idempotent) and `scripts/verify-server-routing.ts` detects it (8/8 → 1/8).
Both are needed on Day 15; there is no automatic hook.

### Suite state at end of Day 15

    verify-day15 39 · verify-day15-mobile (16 pages @390px) · verify-day15-onboarding 11
    all 27 suites · 1144 checks · 0 failed
    tsc --noEmit  0 errors outside src/generated/   ·   routing 8/8

### The shell's DATABASE_URL points at a DIFFERENT database than the server's

`process.env.DATABASE_URL` in the agent shell is `file:/app/workspace/prisma/dev.db` — the
**workspace-root stub** (0 users, 0 communities). The project's own `.env` says
`file:/app/workspace/<project>/prisma/dev.db`, and the running server uses THAT (44
communities, 7553 listings). Bun does not override an already-exported env var, so any
ad-hoc script inherits the stub and reports "no such table" for tables that plainly exist.

Symptom that fooled me: `prisma db push` created `white_label_configs` and a raw
`bun:sqlite` read of `prisma/dev.db` found it, while `prisma.whiteLabelConfig.count()` threw
`SQLITE_ERROR: no such table` — because the two probes were reading different files.

Consequences:
- Guard scripts with a RESOLVED-PATH comparison, not a substring. `/app/workspace/prisma/dev.db`
  also ends in `/prisma/dev.db`, so `url.includes('/prisma/dev.db')` passes against the stub.
  Day 17's suites compare `resolve(path) === resolve('prisma/dev.db')`.
- Suites that drive the running server over HTTP must be given the project DB explicitly;
  they cannot use a throwaway copy the way the older suites do. `scripts/_runall.sh` sets
  `url="file:$(pwd)/prisma/dev.db"` for `verify-day17` and `verify-day17-routing`.

### Two traps that make "did this route work?" unanswerable by status code

1. `custom-routes.ts` ends with a JSON catch-all (`app.all('*')` → 404
   `{ error: 'No API route matches …' }`). So "404 with a JSON body" does NOT mean a handler
   ran. A routing audit that only checks content-type reports every path as registered,
   including the Day 16 routes that were never built. Match the catch-all's body text.
2. Prisma validates the WHOLE argument to `upsert`, including the branch it will not take.
   `upsert({ update: partialWithoutRequiredField, create: { name: required } })` throws
   `Argument name is missing` on a valid UPDATE — so a partial update 500s only once the row
   already exists. Branch explicitly (`existing ? update : create`) instead.

### Day 17 suite state

    verify-day17 111 · verify-day17-routing 95   (both need the PROJECT db, see above)
    all 29 suites · 0 failed
    tsc --noEmit  0 errors outside src/generated/  ·  scripts/verify-server-routing.ts 8/8

### Day 16 (Deal Origination Network) was NEVER implemented

No commits, and 4 of its manifest routes are absent (`/deals/mine`, `POST /deals`,
`/deals/:id`, `/deals/:id/express`). `/sqftlab/deals` exists but is the older Day-8
"listings 8% below the area median" endpoint, not the deal network. The Day 17 brief's
closing summary asserts "Days 1–17 complete" — that is false until Day 16 is built.
