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

- **Railway never auto-deploys.** The GitHub repo has **0 webhooks** and **0 Actions
  secrets**, so neither Railway's GitHub integration nor the `deploy.yml` workflow can
  fire. Pushing to `main` does NOT cause a deploy. Fix: Railway → service → Settings →
  Source → reconnect the repo (this installs Railway's own webhook), or add a
  `RAILWAY_TOKEN` repo secret so the workflow can deploy.
- **`www.sqftlab.com` was returning a persistent Cloudflare 522** (origin unreachable),
  verified from neutral IPs via a third-party proxy — not a caching artifact. The old
  origin `47edlwve.up.railway.app` returned Railway's own `404 Application not found`,
  so the Cloudflare CNAME target is likely stale. Check the service's current public
  domain in Railway against the Cloudflare DNS record.
- **Fixed a latent deploy-killer:** `railway.toml` pointed the healthcheck at
  `/api/sqftlab/stats`, which runs six Prisma queries. A DB hiccup returned 500, and with
  `restartPolicyMaxRetries = 5` Railway stopped the container → total outage. The
  healthcheck now uses `/health` (liveness, no DB); `/api/health/db` reports DB state.
- **Cloudflare serves an interactive "heavy traffic" challenge to every visitor** on the
  apex/www, which makes the site look broken even when the origin is healthy.

