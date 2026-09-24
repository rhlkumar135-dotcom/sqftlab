# sqftLab — UAE Property Intelligence Platform

Real-time price heatmaps, AI-powered yield forecasts, deal alerts, and portfolio tracking — across every community in Dubai and Abu Dhabi.

**Live:** [sqftlab.com](https://sqftlab.com)

## Features

- **Price Heatmap** — Interactive SVG map with 39 UAE communities, colour-graded AED/sqft
- **Community Detail** — 12-month price charts, transaction history, neighbourhood radar, live listings
- **Listings Feed** — Aggregated from Bayut, PropertyFinder, Dubizzle with deal detection
- **Portfolio Tracker** — Track properties, rental income, mortgage payments, total returns
- **Deal Alerts** — Below-market listings detected automatically
- **Yield Calculator** — Gross/net yields, cash flow, break-even analysis
- **Mortgage Simulator** — EMI calculation, amortization charts, bank rate comparison
- **Watchlist & Alerts** — Track communities, get notified of deals via push/email/WhatsApp

## Tech Stack

- **Frontend:** React + TypeScript + Tailwind CSS + shadcn/ui + Recharts
- **Backend:** Hono + Prisma 7 + PostgreSQL (Railway)
- **Deployment:** Railway + GitHub Actions CI/CD
- **Domain:** sqftlab.com (GoDaddy)

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/sqftlab/communities` | GET | All communities with heatmap data |
| `/api/sqftlab/communities/:slug` | GET | Community detail with listings |
| `/api/sqftlab/communities/:slug/trend` | GET | Monthly price trend data |
| `/api/sqftlab/communities/:slug/transactions` | GET | Paginated transaction history |
| `/api/sqftlab/portfolio` | GET | User portfolio summary |
| `/api/sqftlab/watchlist` | GET | User watchlisted communities |
| `/api/sqftlab/deals` | GET | Below-market listings |
| `/api/sqftlab/yield/calculate` | POST | Yield calculation |
| `/api/sqftlab/mortgage/simulate` | POST | Mortgage EMI simulation |
| `/api/sqftlab/stats` | GET | Platform statistics |

## Quick Start (Local)

```bash
bun install
bun run generate
bun run scripts/seed-sqftlab.ts
bun run dev
```

## Deploy to Railway

1. Connect GitHub repo `rhlkumar135-dotcom/sqftlab`
2. Add PostgreSQL database
3. Set `DATABASE_URL=${{Postgres.DATABASE_URL}}`
4. Set start command: `bash scripts/railway-setup.sh`
5. Add custom domain: `sqftlab.com`

See `DEPLOYMENT.md` for detailed instructions.

## Environment Variables

```
DATABASE_URL=postgresql://...
NODE_ENV=production
```
