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
