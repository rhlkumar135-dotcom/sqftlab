# 🚀 sqftLab — Deployment Guide

## Prerequisites

- GitHub repo: `rhlkumar135-dotcom/sqftlab` ✅
- Railway account ✅
- GoDaddy domain: `sqftlab.com` ✅

---

## Step 1: Deploy to Railway

1. Go to **https://railway.app/new**
2. Click **"Deploy from GitHub Repo"**
3. Select **`rhlkumar135-dotcom/sqftlab`**
4. Wait for initial build (~2-3 minutes)

## Step 2: Add PostgreSQL

1. In the project dashboard, click **"+ New"**
2. Select **"Database"** → **"PostgreSQL"**
3. Wait ~30 seconds for provisioning

## Step 3: Connect Database

1. Click on your **sqftLab** service
2. Go to **"Variables"** tab
3. Add: `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
4. Click **"Save"**

## Step 4: Configure Build

1. On the sqftLab service, go to **"Settings"** tab
2. **Build Command:** `bun install && bun run generate && bun run build`
3. **Start Command:** `bash scripts/railway-setup.sh`
4. Railway auto-redeploys

## Step 5: Add Custom Domain

1. In the sqftLab service, go to **"Settings"** → **"Networking"**
2. Click **"Generate Domain"** first
3. Click **"Custom Domain"** → enter `sqftlab.com`
4. Railway will show DNS records — copy them

## Step 6: Configure GoDaddy DNS

1. Go to **https://dcc.godaddy.com**
2. Find **sqftlab.com** → **"DNS / Manage DNS"**
3. Add the CNAME records Railway provided:
   - **Type:** CNAME | **Name:** `@` | **Value:** `<railway-url>` | **TTL:** 600
   - **Type:** CNAME | **Name:** `www` | **Value:** `<railway-url>` | **TTL:** 600
4. Save and wait 5-15 minutes for propagation

## Step 7: Verify

1. Visit **https://sqftlab.com**
2. Check all pages load correctly
3. Verify API endpoints:

```bash
curl https://sqftlab.com/api/sqftlab/stats
curl https://sqftlab.com/api/sqftlab/communities
curl https://sqftlab.com/api/sqftlab/deals
curl https://sqftlab.com/api/sqftlab/portfolio
```

---

## Troubleshooting

- **Build fails:** Check Railway build logs for Prisma errors
- **Database connection error:** Ensure `DATABASE_URL` is set correctly
- **DNS not resolving:** Wait up to 48 hours for full propagation
- **Seed data missing:** The startup script auto-seeds on first deploy

---

## Hourly data refresh

Nothing was scheduled before: data only moved when someone called `/sqftlab/scrape`
or `/sqftlab/intelligence/run` by hand, so the dashboard looked identical whether it
had refreshed a minute ago or never.

### What runs

`GET|POST /api/sqftlab/cron/hourly?secret=$CRON_SECRET` executes six steps, each
isolated so one dead upstream cannot freeze the whole dataset:

| Step | What it does |
|---|---|
| `exchangeRates` | Live AED rates (open.er-api.com), cached 5 min |
| `macro` | World Bank / IMF / oil indicators |
| `communityStats` | **Recomputes every community's PSF from DLD transactions** and sets `psfSource` |
| `deals` | Flags listings >12% below their community median |
| `alerts` | Scans deal alerts, notifies pending matches |
| `intelligence` | RPI, building profiles, supply pipeline, migration, district metrics, market summary |

Returns `200` when every step passed, `207` when some failed — so a monitor can tell
"ran clean" from "ran but the data is only partly fresh".

### Observability

Every run is written to `CronRun`. `GET /api/sqftlab/cron/status` is public and
reports freshness (the hero reads it to print "data refreshed N min ago" instead of
asserting a refresh interval); step detail is included only when authorised.

```bash
curl "$BASE/api/sqftlab/cron/status"           # { healthy, lastStatus, ageMs, ... }
curl "$BASE/api/sqftlab/cron/status?secret=$CRON_SECRET"   # + per-step history
```

### Scheduling it on Railway

The app does not schedule itself — something must call the endpoint. Either:

1. **Railway cron service** — add a service with schedule `0 * * * *` and
   `curl -fsS "$BASE/api/sqftlab/cron/hourly?secret=$CRON_SECRET"`.
2. **Any external cron** (GitHub Actions, cron-job.org) hitting the same URL hourly.

Set `CRON_SECRET` in the Railway environment first (see `.env.example`). Until it is
set the app accepts the legacy value that is committed in this public repo.

### Verify

```bash
bun run scripts/verify-cron.ts   # 24 assertions: auth, steps, persisted state, freshness
```

---

## Data sources & provenance

Nothing on this platform is generated. Every figure is either fetched from a named
source or absent, and every response says which.

| Source | Credentials | What it provides |
|---|---|---|
| PropertyFinder | none | Live sale + rent listings |
| DLD (Dubai Pulse) | `DUBAI_PULSE_API_KEY` — free self-serve at dubaipulse.gov.ae | Dubai registered transactions |
| ADREC (Abu Dhabi) | `ADREC_API_URL` + `ADREC_API_KEY` — request access at adrec.gov.ae/en/apisubscription | Abu Dhabi registered transactions |

`GET /api/sqftlab/sources` reports per-source status and record counts; the
Methodology page renders directly from it.

**Unconfigured sources are reported, never filled in.** The hourly cron records a
missing source as `skipped` (not `failed`), and transaction-derived endpoints
return an explicit `insufficientData` + `reason` rather than a fabricated number.

### The synthetic dataset is opt-in

`scripts/seed-pg.ts` **generates** listings and transactions with `Math.random()`
and stamps them with real source names. It is loaded only when
`SEED_DEMO_DATA=true`, and it is off by default. It previously ran on every
Railway boot, which fabricated the dataset and clobbered real ingested data on
each restart.

To confirm what is actually in a database:

```bash
bun run scripts/purge-mock-data.ts          # dry run — reports seeded vs real
bun run scripts/purge-mock-data.ts --apply  # delete the synthetic rows
```

Seeded rows are identifiable: listings are `<portal>-<slug>-<index>-<13-digit-ms>`
(real ones are `propertyfinder_<numericId>`), transactions are
`DLD-<emirate>-<13-digit-ms>-<n>`.

### Ingesting

```bash
bun run scripts/scraper-pf.ts                      # live listings (no credentials)
curl "$BASE/api/sqftlab/cron/hourly?secret=$CRON_SECRET"   # includes dld/adrec sync
```

The scraper attributes listings to the **area queried**, not the listing's own
`location.name` — for most PropertyFinder rows that field is a building
("AG Tower", "Building Y16"), and using it invented hundreds of phantom
"communities" that then appeared as market areas.
