import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { prisma } from './src/lib/db'
import { notifyPendingMatches, recentMatches, scanDealAlerts } from './src/lib/alerts'
import { publish, subscribe, streamStatus, recentMessages } from './src/lib/events'
import {
  runIntelligencePipeline, computeYieldCurve, migrationSurges, applyScenario,
  computeRealPriceIndex, computeBuildingProfiles, computeSupplyPipeline,
  computeInstitutionalFlow, computeMigrationSignal, computeDistrictMetrics,
  computeMarketSummary, ALL_BEDS,
} from './src/lib/intelligence'
import { fetchAllMacro, fetchExchangeRates } from './src/lib/macro'

const app = new Hono()

// ─── Health & diagnostics ─────────────────────────────────────────────────────

// Report the *shape* of DATABASE_URL without leaking credentials. The literal
// "${{Postgres.DATABASE_URL}}" string is the classic Railway misconfiguration:
// the placeholder was written as a value instead of resolved as a reference.
function redactDbUrl(raw?: string) {
  if (!raw) return 'unset'
  if (raw.startsWith('${{')) return `UNRESOLVED_PLACEHOLDER:${raw}`
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.username ? '***@' : ''}${u.host}${u.pathname}`
  } catch {
    return `malformed:${raw.slice(0, 16)}`
  }
}

// Readiness probe — reports real DB connectivity plus the resolved error, so a
// misconfigured database surfaces as readable JSON instead of an empty site.
app.get('/health/db', async (c) => {
  const url = redactDbUrl(process.env.DATABASE_URL)
  try {
    const communities = await prisma.community.count()
    const listings = await prisma.listing.count()
    return c.json({ ok: true, db: 'connected', url, communities, listings })
  } catch (e) {
    return c.json(
      { ok: false, db: 'unreachable', url, error: e instanceof Error ? e.message : String(e) },
      503,
    )
  }
})

// ─── Communities ──────────────────────────────────────────────────────────────

app.get('/sqftlab/communities', async (c) => {
  const emirate = c.req.query('emirate')
  const search = c.req.query('search')
  const where: Record<string, unknown> = {}
  if (emirate && emirate !== 'all') where.emirate = emirate
  if (search) where.nameEn = { contains: search }

  const communities = await prisma.community.findMany({
    where,
    orderBy: { medianAedSqft: 'desc' },
    select: {
      id: true, slug: true, nameEn: true, nameAr: true, emirate: true,
      latitude: true, longitude: true, medianAedSqft: true, medianAnnualRentAed: true,
      grossYieldPct: true, neighbourhoodScore: true, priceChange30d: true,
      priceChange1y: true, transactionCount30d: true, totalTransactions: true,
      scoreSchools: true, scoreHealthcare: true, scoreMetro: true,
      scoreRetail: true, scoreParks: true, scoreWorship: true,
    },
  })
  return c.json({ communities })
})

app.get('/sqftlab/communities/:slug', async (c) => {
  const slug = c.req.param('slug')
  const community = await prisma.community.findUnique({
    where: { slug },
    include: {
      listings: { where: { purpose: 'sale' }, orderBy: { listedAt: 'desc' }, take: 10 },
      _count: { select: { transactions: true, listings: true } },
    },
  })
  if (!community) return c.json({ error: 'Community not found' }, 404)
  return c.json({ community })
})

app.get('/sqftlab/communities/:slug/transactions', async (c) => {
  const slug = c.req.param('slug')
  const page = parseInt(c.req.query('page') || '1')
  const limit = parseInt(c.req.query('limit') || '50')
  const propertyType = c.req.query('type')
  const beds = c.req.query('beds')

  const community = await prisma.community.findUnique({ where: { slug } })
  if (!community) return c.json({ error: 'Community not found' }, 404)

  const where: Record<string, unknown> = { communityId: community.id }
  if (propertyType) where.propertyType = propertyType
  if (beds) where.beds = parseInt(beds)

  const [transactions, total] = await Promise.all([
    prisma.transaction.findMany({
      where,
      orderBy: { transactionDate: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.transaction.count({ where }),
  ])

  return c.json({ transactions, total, page, limit, pages: Math.ceil(total / limit) })
})

app.get('/sqftlab/communities/:slug/listings', async (c) => {
  const slug = c.req.param('slug')
  const purpose = c.req.query('purpose') || 'sale'
  const beds = c.req.query('beds')
  const dealsOnly = c.req.query('deals') === 'true'

  const community = await prisma.community.findUnique({ where: { slug } })
  if (!community) return c.json({ error: 'Community not found' }, 404)

  const where: Record<string, unknown> = { communityId: community.id, purpose }
  if (beds) where.beds = parseInt(beds)
  if (dealsOnly) where.isDeal = true

  const listings = await prisma.listing.findMany({
    where,
    orderBy: { listedAt: 'desc' },
    take: 50,
  })
  return c.json({ listings })
})

// ─── Price trend (simulated monthly data) ────────────────────────────────────

app.get('/sqftlab/communities/:slug/trend', async (c) => {
  const slug = c.req.param('slug')
  const period = c.req.query('period') || '12m'
  const community = await prisma.community.findUnique({ where: { slug } })
  if (!community) return c.json({ error: 'Community not found' }, 404)

  const months = period === '5y' ? 60 : 12
  const trend = []
  const basePrice = community.medianAedSqft
  const monthlyGrowth = community.priceChange1y / 100 / 12

  for (let i = months; i >= 0; i--) {
    const date = new Date()
    date.setMonth(date.getMonth() - i)
    const noise = 0.97 + Math.random() * 0.06
    const price = Math.round(basePrice * (1 - monthlyGrowth * i) * noise)
    trend.push({
      date: date.toISOString().substring(0, 7),
      medianPrice: price,
      volume: Math.floor(50 + Math.random() * 200),
    })
  }
  return c.json({ trend, period })
})

// ─── Yield Calculator ────────────────────────────────────────────────────────

app.post('/sqftlab/yield/calculate', async (c) => {
  const body = await c.req.json()
  const { purchasePrice, annualRent, serviceCharge, mortgageEnabled, mortgageRate, mortgageTerm, downPaymentPct } = body

  const grossYield = (annualRent / purchasePrice) * 100
  const dldFee = purchasePrice * 0.04
  const netYield = ((annualRent - serviceCharge - dldFee * 0.02) / purchasePrice) * 100
  const monthlyCashFlow = (annualRent - serviceCharge) / 12

  let emi = 0, totalMortgageCost = 0, totalInterest = 0
  if (mortgageEnabled && mortgageRate > 0) {
    const loanAmount = purchasePrice * (1 - downPaymentPct / 100)
    const monthlyRate = mortgageRate / 100 / 12
    const months = mortgageTerm * 12
    emi = loanAmount * monthlyRate * Math.pow(1 + monthlyRate, months) / (Math.pow(1 + monthlyRate, months) - 1)
    totalMortgageCost = emi * months
    totalInterest = totalMortgageCost - loanAmount
  }

  const breakEvenMonths = monthlyCashFlow > 0 ? Math.ceil((purchasePrice * 0.04) / monthlyCashFlow) : Infinity
  const annualCashFlow = annualRent - serviceCharge - emi * 12

  // 5-year projection (conservative: 0% price growth)
  const fiveYearReturn = (annualRent * 5 - serviceCharge * 5 - totalInterest) / purchasePrice * 100

  return c.json({
    grossYield: Math.round(grossYield * 100) / 100,
    netYield: Math.round(netYield * 100) / 100,
    monthlyCashFlow: Math.round(monthlyCashFlow),
    annualCashFlow: Math.round(annualCashFlow),
    emi: Math.round(emi),
    totalMortgageCost: Math.round(totalMortgageCost),
    totalInterest: Math.round(totalInterest),
    breakEvenMonths,
    fiveYearReturn: Math.round(fiveYearReturn * 100) / 100,
    dldFee: Math.round(dldFee),
  })
})

// ─── Mortgage Simulator ──────────────────────────────────────────────────────

app.post('/sqftlab/mortgage/simulate', async (c) => {
  const body = await c.req.json()
  const { price, downPaymentPct, ratePct, termYears } = body

  const downPayment = price * (downPaymentPct / 100)
  const loanAmount = price - downPayment
  const monthlyRate = ratePct / 100 / 12
  const months = termYears * 12
  const emi = loanAmount * monthlyRate * Math.pow(1 + monthlyRate, months) / (Math.pow(1 + monthlyRate, months) - 1)
  const totalPayment = emi * months
  const totalInterest = totalPayment - loanAmount

  // Amortization first 5 years
  const amortization = []
  let balance = loanAmount
  for (let year = 1; year <= Math.min(termYears, 5); year++) {
    let yearInterest = 0, yearPrincipal = 0
    for (let m = 0; m < 12; m++) {
      const interestPayment = balance * monthlyRate
      const principalPayment = emi - interestPayment
      yearInterest += interestPayment
      yearPrincipal += principalPayment
      balance -= principalPayment
    }
    amortization.push({
      year,
      principalPaid: Math.round(yearPrincipal),
      interestPaid: Math.round(yearInterest),
      remainingBalance: Math.round(Math.max(0, balance)),
    })
  }

  return c.json({
    emi: Math.round(emi),
    downPayment: Math.round(downPayment),
    loanAmount: Math.round(loanAmount),
    totalPayment: Math.round(totalPayment),
    totalInterest: Math.round(totalInterest),
    amortization,
    // Indicative bank rates
    bankRates: [
      { bank: 'ADCB', rate: ratePct - 0.15, type: 'Variable' },
      { bank: 'Emirates NBD', rate: ratePct, type: 'Variable' },
      { bank: 'FAB', rate: ratePct - 0.10, type: 'Variable' },
      { bank: 'HSBC UAE', rate: ratePct + 0.05, type: 'Fixed 3yr' },
      { bank: 'Mashreq', rate: ratePct - 0.05, type: 'Variable' },
    ],
  })
})

// ─── Exchange Rates ──────────────────────────────────────────────────────────

app.get('/sqftlab/rates/exchange', async (c) => {
  // Fetch live rates from frankfurter API
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=AED&to=USD,GBP,EUR,INR,PKR', {
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) {
      const data = await res.json()
      return c.json({
        AED_INR: data.rates?.INR ?? 22.68,
        AED_USD: data.rates?.USD ?? 0.2723,
        AED_GBP: data.rates?.GBP ?? 0.2145,
        AED_EUR: data.rates?.EUR ?? 0.25,
        AED_PKR: data.rates?.PKR ?? 75.5,
        updatedAt: data.date ?? new Date().toISOString(),
      })
    }
  } catch {}
  return c.json({
    AED_INR: 22.68, AED_USD: 0.2723, AED_GBP: 0.2145,
    AED_EUR: 0.25, AED_PKR: 75.5, updatedAt: new Date().toISOString(),
  })
})

// ─── Scraper: PropertyFinder ────────────────────────────────────────────────

const PF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const DUBAI_AREAS = [
  { name: 'Dubai Marina', lid: '31', slug: 'dubai-marina' },
  { name: 'Downtown Dubai', lid: '56', slug: 'downtown-dubai' },
  { name: 'Palm Jumeirah', lid: '63', slug: 'palm-jumeirah' },
  { name: 'JVC', lid: '544', slug: 'jumeirah-village-circle' },
  { name: 'Business Bay', lid: '53', slug: 'business-bay' },
  { name: 'Dubai Hills Estate', lid: '1436', slug: 'dubai-hills-estate' },
  { name: 'JLT', lid: '59', slug: 'jumeirah-lake-towers' },
  { name: 'DIFC', lid: '55', slug: 'difc' },
  { name: 'Dubai Creek Harbour', lid: '3476', slug: 'dubai-creek-harbour' },
  { name: 'MBR City', lid: '2424', slug: 'mbr-city' },
  { name: 'Al Barsha', lid: '40', slug: 'al-barsha' },
  { name: 'Deira', lid: '49', slug: 'deira' },
  { name: 'Bur Dubai', lid: '47', slug: 'bur-dubai' },
  { name: 'Dubai Silicon Oasis', lid: '109', slug: 'dubai-silicon-oasis' },
  { name: 'Dubai Sports City', lid: '103', slug: 'dubai-sports-city' },
  { name: 'Motor City', lid: '102', slug: 'motor-city' },
  { name: 'Discovery Gardens', lid: '58', slug: 'discovery-gardens' },
  { name: 'Town Square', lid: '2100', slug: 'town-square' },
  { name: 'Al Nahda', lid: '44', slug: 'al-nahda' },
  { name: 'Dubailand', lid: '105', slug: 'dubailand' },
]

const AD_AREAS = [
  { name: 'Al Reem Island', lid: '6665', slug: 'al-reem-island' },
  { name: 'Saadiyat Island', lid: '6666', slug: 'saadiyat-island' },
  { name: 'Yas Island', lid: '6667', slug: 'yas-island' },
  { name: 'Al Raha Beach', lid: '6668', slug: 'al-raha-beach' },
  { name: 'Corniche', lid: '6663', slug: 'corniche' },
  { name: 'Khalifa City', lid: '6670', slug: 'khalifa-city' },
  { name: 'MBZ City', lid: '6671', slug: 'mbz-city' },
  { name: 'Al Maryah Island', lid: '6669', slug: 'al-maryah-island' },
]

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function pfFetchPage(catId: number, locationId: string, page: number): Promise<any[]> {
  const url = `https://www.propertyfinder.ae/en/search?c=${catId}&l=${locationId}&ob=mr&page=${page}`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': PF_UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return []
    const html = await res.text()
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/)
    if (!m) return []
    const j = JSON.parse(m[1])
    const items = j?.props?.pageProps?.searchResult?.listings ?? []
    return items.filter((l: any) => l.listing_type === 'property' && l.property).map((l: any) => l.property)
  } catch { return [] }
}

function pfParse(property: any, source: string, purpose: string) {
  const price = property.price?.value ?? 0
  const area = property.size ?? 0
  const loc = property.location ?? {}
  return {
    externalId: `${source}_${property.id}`,
    source,
    purpose,
    propertyType: property.property_type ?? 'Apartment',
    beds: property.bedrooms_value ?? property.bedrooms ?? 0,
    baths: property.bathrooms_value ?? property.bathrooms ?? 0,
    areaSqft: area,
    priceAed: price,
    pricePerSqft: area > 0 ? Math.round(price / area) : 0,
    furnished: property.furnished === 'furnished' ? 'furnished' : 'unfurnished',
    completion: property.completion_status === 'off_plan' ? 'off_plan' : 'ready',
    agentName: property.agent?.name ?? null,
    agencyName: property.broker?.name ?? null,
    title: property.title ?? `${property.property_type} in ${loc.name ?? ''}`,
    imageUrl: property.images?.[0]?.medium ?? property.images?.[0]?.small ?? null,
    latitude: loc.coordinates?.lat ?? null,
    longitude: loc.coordinates?.lon ?? null,
    listedAt: new Date(property.listed_date ?? Date.now()),
    districtName: loc.name ?? 'Unknown',
    locationSlug: loc.slug ?? (loc.name ?? 'unknown').toLowerCase().replace(/\s+/g, '-'),
    sourceUrl: `https://www.propertyfinder.ae/en/property/${property.id ?? ''}.html`,
  }
}

async function ensureCommunity(name: string, slug: string, emirate: string) {
  let c = await prisma.community.findFirst({ where: { slug } })
  if (!c) c = await prisma.community.findFirst({ where: { nameEn: { contains: name, mode: 'insensitive' } } })
  if (!c) {
    c = await prisma.community.create({
      data: {
        slug, nameEn: name, emirate, latitude: 25.2, longitude: 55.27,
        medianAedSqft: 0, medianAnnualRentAed: 0, grossYieldPct: 0,
        neighbourhoodScore: 50, priceChange30d: 0, priceChange1y: 0,
        transactionCount30d: 0, totalTransactions: 0,
      },
    })
  }
  return c
}

app.get('/sqftlab/scrape', async (c) => {
  const secret = c.req.query('secret')
  if (secret !== 'sqftlab-cron-2026') return c.json({ error: 'unauthorized' }, 401)

  const startedAt = Date.now()
  let totalSaved = 0
  const logs: string[] = []

  // Scrape Dubai + Abu Dhabi
  for (const areas of [DUBAI_AREAS, AD_AREAS]) {
    const emirate = areas === DUBAI_AREAS ? 'dubai' : 'abu_dhabi'
    for (const area of areas) {
      for (const catId of [1, 2]) {
        const purpose = catId === 1 ? 'sale' : 'rent'
        for (let page = 1; page <= 3; page++) {
          const props = await pfFetchPage(catId, area.lid, page)
          if (props.length === 0) break
          for (const p of props) {
            try {
              const parsed = pfParse(p, 'propertyfinder', purpose)
              if (parsed.priceAed <= 0) continue
              const community = await ensureCommunity(parsed.districtName, parsed.locationSlug, emirate)
              await prisma.listing.upsert({
                where: { externalId: parsed.externalId },
                create: {
                  externalId: parsed.externalId, source: parsed.source,
                  communityId: community.id, purpose: parsed.purpose,
                  propertyType: parsed.propertyType, beds: parsed.beds,
                  baths: parsed.baths, areaSqft: parsed.areaSqft,
                  priceAed: parsed.priceAed, pricePerSqft: parsed.pricePerSqft,
                  furnished: parsed.furnished, completion: parsed.completion,
                  agentName: parsed.agentName, agencyName: parsed.agencyName,
                  title: parsed.title, imageUrl: parsed.imageUrl,
                  sourceUrl: parsed.sourceUrl,
                  latitude: parsed.latitude, longitude: parsed.longitude,
                  listedAt: parsed.listedAt, isDeal: false,
                },
                update: {
                  priceAed: parsed.priceAed, pricePerSqft: parsed.pricePerSqft,
                  title: parsed.title, imageUrl: parsed.imageUrl,
                  sourceUrl: parsed.sourceUrl,
                  agentName: parsed.agentName, agencyName: parsed.agencyName,
                  scrapedAt: new Date(),
                },
              })
              totalSaved++
            } catch {}
          }
          await sleepMs(1500)
        }
      }
    }
  }

  // Cleanup old listings (>30 days)
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
  const deleted = await prisma.listing.deleteMany({ where: { scrapedAt: { lt: thirtyDaysAgo } } })

  // Update community stats
  const communities = await prisma.community.findMany()
  for (const comm of communities) {
    const [cnt, avgPsf, avgRent, txCnt] = await Promise.all([
      prisma.listing.count({ where: { communityId: comm.id } }),
      prisma.listing.aggregate({ where: { communityId: comm.id, purpose: 'sale', pricePerSqft: { gt: 0 } }, _avg: { pricePerSqft: true } }),
      prisma.listing.aggregate({ where: { communityId: comm.id, purpose: 'rent', priceAed: { gt: 0 } }, _avg: { priceAed: true } }),
      prisma.transaction.count({ where: { communityId: comm.id } }),
    ])
    const mp = Math.round(avgPsf._avg.pricePerSqft ?? 0)
    const mr = Math.round(avgRent._avg.priceAed ?? 0)
    const yld = mp > 0 && mr > 0 ? Math.round((mr / (mp * 1000)) * 10000) / 100 : 0
    await prisma.community.update({
      where: { id: comm.id },
      data: {
        medianAedSqft: mp || comm.medianAedSqft,
        medianAnnualRentAed: mr || comm.medianAnnualRentAed,
        grossYieldPct: yld || comm.grossYieldPct,
        totalTransactions: txCnt,
      },
    })
  }

  const elapsed = Math.round((Date.now() - startedAt) / 1000)
  const finalCount = await prisma.listing.count()

  return c.json({
    ok: true,
    saved: totalSaved,
    deleted: deleted.count,
    totalListings: finalCount,
    communities: communities.length,
    elapsed: `${elapsed}s`,
  })
})

// ─── Scraper status ─────────────────────────────────────────────────────────

app.get('/sqftlab/scrape/status', async (c) => {
  const [listingCount, communityCount, transactionCount, oldestListing, newestListing] = await Promise.all([
    prisma.listing.count(),
    prisma.community.count(),
    prisma.transaction.count(),
    prisma.listing.findFirst({ orderBy: { scrapedAt: 'asc' }, select: { scrapedAt: true } }),
    prisma.listing.findFirst({ orderBy: { scrapedAt: 'desc' }, select: { scrapedAt: true } }),
  ])

  const byPurpose = await prisma.listing.groupBy({ by: ['purpose'], _count: true })
  const bySource = await prisma.listing.groupBy({ by: ['source'], _count: true })

  return c.json({
    listings: listingCount,
    communities: communityCount,
    transactions: transactionCount,
    oldestListing: oldestListing?.scrapedAt,
    newestListing: newestListing?.scrapedAt,
    byPurpose: Object.fromEntries(byPurpose.map(r => [r.purpose, r._count])),
    bySource: Object.fromEntries(bySource.map(r => [r.source, r._count])),
  })
})

// ─── Portfolio ───────────────────────────────────────────────────────────────

const DEMO_USER_ID = 'cmtv5baxv0000pdjjbobt1ojr'

app.get('/sqftlab/portfolio', async (c) => {
  const items = await prisma.portfolio.findMany({
    where: { userId: DEMO_USER_ID },
    include: { community: { select: { nameEn: true, slug: true, medianAedSqft: true, grossYieldPct: true } } },
  })

  const totalValue = items.reduce((s, i) => s + i.currentValue, 0)
  const totalCost = items.reduce((s, i) => s + i.purchasePrice, 0)
  const totalGainLoss = totalValue - totalCost
  const totalAnnualRent = items.reduce((s, i) => s + i.annualRent, 0)
  const weightedYield = totalValue > 0 ? (totalAnnualRent / totalValue) * 100 : 0
  const monthlyCashFlow = items.reduce((s, i) => s + (i.annualRent - i.serviceCharge) / 12 - i.mortgageBalance * (i.mortgageRate / 100 / 12), 0)

  return c.json({
    items,
    summary: {
      totalValue: Math.round(totalValue),
      totalCost: Math.round(totalCost),
      totalGainLoss: Math.round(totalGainLoss),
      gainLossPct: Math.round((totalGainLoss / totalCost) * 10000) / 100,
      totalAnnualRent: Math.round(totalAnnualRent),
      weightedYield: Math.round(weightedYield * 100) / 100,
      monthlyCashFlow: Math.round(monthlyCashFlow),
      propertyCount: items.length,
    },
  })
})

// ─── Watchlist ───────────────────────────────────────────────────────────────

app.get('/sqftlab/watchlist', async (c) => {
  const items = await prisma.watchlist.findMany({
    where: { userId: DEMO_USER_ID },
    include: { community: true },
    orderBy: { addedAt: 'desc' },
  })
  return c.json({ items })
})

// ─── Deals ───────────────────────────────────────────────────────────────────

app.get('/sqftlab/deals', async (c) => {
  const deals = await prisma.listing.findMany({
    where: { isDeal: true, purpose: 'sale' },
    include: { community: { select: { nameEn: true, slug: true, medianAedSqft: true } } },
    orderBy: { listedAt: 'desc' },
    take: 30,
  })
  return c.json({ deals })
})

// ─── Listings search ─────────────────────────────────────────────────────────

app.get('/sqftlab/listings', async (c) => {
  const purpose = c.req.query('purpose') || 'sale'
  const emirate = c.req.query('emirate')
  const beds = c.req.query('beds')
  const propertyType = c.req.query('type')
  const dealsOnly = c.req.query('deals') === 'true'
  const priceMin = c.req.query('priceMin')
  const priceMax = c.req.query('priceMax')
  const page = parseInt(c.req.query('page') || '1')
  const limit = 20

  const where: Record<string, unknown> = { purpose }
  if (dealsOnly) where.isDeal = true
  if (beds) where.beds = parseInt(beds)
  if (propertyType) where.propertyType = propertyType
  if (priceMin || priceMax) {
    where.priceAed = {}
    if (priceMin) (where.priceAed as Record<string, number>).gte = parseInt(priceMin)
    if (priceMax) (where.priceAed as Record<string, number>).lte = parseInt(priceMax)
  }
  if (emirate && emirate !== 'all') {
    where.community = { emirate }
  }

  const [listings, total] = await Promise.all([
    prisma.listing.findMany({
      where,
      include: { community: { select: { nameEn: true, slug: true, emirate: true, medianAedSqft: true } } },
      orderBy: { listedAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.listing.count({ where }),
  ])

  return c.json({ listings, total, page, pages: Math.ceil(total / limit) })
})

// ─── Alerts ──────────────────────────────────────────────────────────────────

// Legacy rule-based alerts (Alert model). The Deal Alert Engine (TASK 12) owns
// /sqftlab/alerts, so these stay reachable at their own path rather than
// shadowing the new CRUD routes.
app.get('/sqftlab/alert-rules', async (c) => {
  const alerts = await prisma.alert.findMany({
    where: { userId: DEMO_USER_ID },
    include: { community: { select: { nameEn: true, slug: true } } },
    orderBy: { createdAt: 'desc' },
  })
  return c.json({ alerts })
})

// ─── Market Analytics ────────────────────────────────────────────────────────

app.get('/sqftlab/market/analytics', async (c) => {
  const [communities, transactions, listings] = await Promise.all([
    prisma.community.findMany({
      orderBy: { medianAedSqft: 'desc' },
      select: {
        id: true, nameEn: true, slug: true, emirate: true,
        medianAedSqft: true, medianAnnualRentAed: true, grossYieldPct: true,
        priceChange30d: true, priceChange1y: true, transactionCount30d: true,
        totalTransactions: true,
      },
    }),
    prisma.transaction.groupBy({
      by: ['transactionType'],
      _count: true,
      _avg: { priceAed: true, pricePerSqft: true },
    }),
    prisma.listing.groupBy({
      by: ['purpose', 'propertyType'],
      _count: true,
      _avg: { priceAed: true, pricePerSqft: true },
    }),
  ])

  const totalTransactions = communities.reduce((s, c) => s + c.totalTransactions, 0)
  const totalTx30d = communities.reduce((s, c) => s + c.transactionCount30d, 0)
  const avgPsf = Math.round(communities.reduce((s, c) => s + c.medianAedSqft, 0) / communities.length)
  const avgYield = Math.round(communities.reduce((s, c) => s + c.grossYieldPct, 0) / communities.length * 100) / 100
  const avgPriceChange30d = Math.round(communities.reduce((s, c) => s + c.priceChange30d, 0) / communities.length * 100) / 100
  const avgPriceChange1y = Math.round(communities.reduce((s, c) => s + c.priceChange1y, 0) / communities.length * 100) / 100

  const topGainers = [...communities].sort((a, b) => b.priceChange30d - a.priceChange30d).slice(0, 10)
  const topLosers = [...communities].sort((a, b) => a.priceChange30d - b.priceChange30d).slice(0, 10)
  const highestYield = [...communities].sort((a, b) => b.grossYieldPct - a.grossYieldPct).slice(0, 10)
  const mostActive = [...communities].sort((a, b) => b.transactionCount30d - a.transactionCount30d).slice(0, 10)

  const priceBuckets = [
    { label: '< AED 1K', min: 0, max: 1000, count: 0 },
    { label: 'AED 1K-1.5K', min: 1000, max: 1500, count: 0 },
    { label: 'AED 1.5K-2K', min: 1500, max: 2000, count: 0 },
    { label: 'AED 2K-3K', min: 2000, max: 3000, count: 0 },
    { label: 'AED 3K-5K', min: 3000, max: 5000, count: 0 },
    { label: 'AED 5K+', min: 5000, max: Infinity, count: 0 },
  ]
  communities.forEach(c => {
    const bucket = priceBuckets.find(b => c.medianAedSqft >= b.min && c.medianAedSqft < b.max)
    if (bucket) bucket.count++
  })

  return c.json({
    summary: {
      communities: communities.length,
      totalTransactions,
      totalTx30d,
      totalListings: listings.reduce((s, l) => s + l._count, 0),
      avgPsf,
      avgYield,
      avgPriceChange30d,
      avgPriceChange1y,
    },
    topGainers,
    topLosers,
    highestYield,
    mostActive,
    priceBuckets,
    transactionTypes: transactions.map(t => ({
      type: t.transactionType,
      count: t._count,
      avgPrice: Math.round(t._avg.priceAed ?? 0),
      avgPsf: Math.round(t._avg.pricePerSqft ?? 0),
    })),
    listingsByType: listings.map(l => ({
      purpose: l.purpose,
      propertyType: l.propertyType,
      count: l._count,
      avgPrice: Math.round(l._avg.priceAed ?? 0),
    })),
  })
})

// ─── Price Predictions ──────────────────────────────────────────────────────

app.get('/sqftlab/predictions', async (c) => {
  const communities = await prisma.community.findMany({
    orderBy: { medianAedSqft: 'desc' },
    select: {
      id: true, nameEn: true, slug: true, emirate: true,
      medianAedSqft: true, medianAnnualRentAed: true, grossYieldPct: true,
      priceChange30d: true, priceChange1y: true, transactionCount30d: true,
      totalTransactions: true, neighbourhoodScore: true,
    },
  })

  const predictions = communities.map(c => {
    const momentum = c.priceChange30d * 12
    const historicalGrowth = c.priceChange1y
    const yieldSignal = c.grossYieldPct > 7 ? 1 : c.grossYieldPct > 5 ? 0 : -1
    const volumeSignal = c.transactionCount30d > 100 ? 1 : c.transactionCount30d > 50 ? 0 : -1
    const scoreSignal = c.neighbourhoodScore > 70 ? 1 : c.neighbourhoodScore > 50 ? 0 : -1

    const rawScore = momentum * 0.3 + historicalGrowth * 0.4 + yieldSignal * 5 + volumeSignal * 3 + scoreSignal * 2
    const confidence = Math.min(95, Math.max(45, 60 + c.transactionCount30d * 0.1 + (c.totalTransactions > 100 ? 10 : 0)))

    const forecast6m = Math.round(c.medianAedSqft * (1 + (rawScore / 100) * 0.5) * 100) / 100
    const forecast12m = Math.round(c.medianAedSqft * (1 + (rawScore / 100) * 1.0) * 100) / 100
    const forecastChange6m = Math.round((forecast6m / c.medianAedSqft - 1) * 10000) / 100
    const forecastChange12m = Math.round((forecast12m / c.medianAedSqft - 1) * 10000) / 100

    let recommendation: string
    if (forecastChange6m > 5 && c.grossYieldPct > 6) recommendation = 'Strong Buy'
    else if (forecastChange6m > 2 && c.grossYieldPct > 5) recommendation = 'Buy'
    else if (forecastChange6m > -2) recommendation = 'Hold'
    else if (forecastChange6m > -5) recommendation = 'Sell'
    else recommendation = 'Avoid'

    const riskLevel = confidence > 75 ? 'Low' : confidence > 60 ? 'Medium' : 'High'

    return {
      community: c.nameEn,
      slug: c.slug,
      emirate: c.emirate,
      currentPsf: c.medianAedSqft,
      forecast6m,
      forecast12m,
      forecastChange6m,
      forecastChange12m,
      confidence: Math.round(confidence),
      recommendation,
      riskLevel,
      momentum: Math.round(momentum * 100) / 100,
      yield: c.grossYieldPct,
      volume: c.transactionCount30d,
      score: c.neighbourhoodScore,
    }
  })

  const strongBuys = predictions.filter(p => p.recommendation === 'Strong Buy')
  const buys = predictions.filter(p => p.recommendation === 'Buy')
  const holds = predictions.filter(p => p.recommendation === 'Hold')

  return c.json({
    predictions,
    summary: {
      strongBuys: strongBuys.length,
      buys: buys.length,
      holds: holds.length,
      totalAnalyzed: predictions.length,
    },
    strongBuys: strongBuys.slice(0, 5),
    topGrowth: [...predictions].sort((a, b) => b.forecastChange12m - a.forecastChange12m).slice(0, 5),
    topYield: [...predictions].sort((a, b) => b.yield - a.yield).slice(0, 5),
  })
})

// ─── Transaction Analytics ──────────────────────────────────────────────────

app.get('/sqftlab/market/transactions', async (c) => {
  const communities = await prisma.community.findMany({
    select: { id: true, nameEn: true, slug: true },
  })

  const transactionsByType = await prisma.transaction.groupBy({
    by: ['transactionType'],
    _count: true,
    _avg: { priceAed: true, pricePerSqft: true },
    _sum: { priceAed: true },
  })

  const transactionsByProperty = await prisma.transaction.groupBy({
    by: ['propertyType'],
    _count: true,
    _avg: { priceAed: true, pricePerSqft: true },
  })

  const transactionsByBeds = await prisma.transaction.groupBy({
    by: ['beds'],
    _count: true,
    _avg: { priceAed: true, pricePerSqft: true },
    orderBy: { beds: 'asc' },
  })

  const recentTransactions = await prisma.transaction.findMany({
    orderBy: { transactionDate: 'desc' },
    take: 50,
    include: { community: { select: { nameEn: true, slug: true } } },
  })

  const priceRanges = [
    { label: '< AED 500K', min: 0, max: 500000, count: 0, totalValue: 0 },
    { label: 'AED 500K-1M', min: 500000, max: 1000000, count: 0, totalValue: 0 },
    { label: 'AED 1M-2M', min: 1000000, max: 2000000, count: 0, totalValue: 0 },
    { label: 'AED 2M-5M', min: 2000000, max: 5000000, count: 0, totalValue: 0 },
    { label: 'AED 5M-10M', min: 5000000, max: 10000000, count: 0, totalValue: 0 },
    { label: 'AED 10M+', min: 10000000, max: Infinity, count: 0, totalValue: 0 },
  ]

  recentTransactions.forEach(t => {
    const bucket = priceRanges.find(r => t.priceAed >= r.min && t.priceAed < r.max)
    if (bucket) {
      bucket.count++
      bucket.totalValue += t.priceAed
    }
  })

  return c.json({
    summary: {
      totalTransactions: recentTransactions.length,
      totalValue: priceRanges.reduce((s, r) => s + r.totalValue, 0),
      avgPrice: Math.round(recentTransactions.reduce((s, t) => s + t.priceAed, 0) / recentTransactions.length),
      avgPsf: Math.round(recentTransactions.reduce((s, t) => s + t.pricePerSqft, 0) / recentTransactions.length),
    },
    byType: transactionsByType.map(t => ({
      type: t.transactionType,
      count: t._count,
      avgPrice: Math.round(t._avg.priceAed ?? 0),
      avgPsf: Math.round(t._avg.pricePerSqft ?? 0),
      totalValue: Number(t._sum.priceAed ?? 0),
    })),
    byProperty: transactionsByProperty.map(t => ({
      type: t.propertyType,
      count: t._count,
      avgPrice: Math.round(t._avg.priceAed ?? 0),
      avgPsf: Math.round(t._avg.pricePerSqft ?? 0),
    })),
    byBeds: transactionsByBeds.map(t => ({
      beds: t.beds,
      count: t._count,
      avgPrice: Math.round(t._avg.priceAed ?? 0),
      avgPsf: Math.round(t._avg.pricePerSqft ?? 0),
    })),
    priceRanges,
    recent: recentTransactions.slice(0, 20),
  })
})

// ─── Stats for dashboard ─────────────────────────────────────────────────────

app.get('/sqftlab/stats', async (c) => {
  const [communityCount, transactionCount, listingCount, dealCount] = await Promise.all([
    prisma.community.count(),
    prisma.transaction.count(),
    prisma.listing.count(),
    prisma.listing.count({ where: { isDeal: true } }),
  ])

  const topCommunities = await prisma.community.findMany({
    orderBy: { priceChange30d: 'desc' },
    take: 5,
    select: { nameEn: true, slug: true, priceChange30d: true, medianAedSqft: true },
  })

  return c.json({ communityCount, transactionCount, listingCount, dealCount, topCommunities })
})

// ─── Pro Tier Intelligence (spec Part 8.3) ───────────────────────────────────

const UAE_CPI_YOY = [3.1, 3.4, 3.2, 2.9, 2.7, 2.8, 3.0, 3.3, 3.5, 3.2, 2.9, 2.6]
const UAE_GDP_GROWTH = 3.9
const AED_PER_USD = 3.6725

app.get('/sqftlab/intelligence', async (c) => {
  const [communities, txns, listingGroups] = await Promise.all([
    prisma.community.findMany({ orderBy: { medianAedSqft: 'desc' } }),
    prisma.transaction.findMany({
      select: {
        communityId: true,
        priceAed: true,
        pricePerSqft: true,
        transactionType: true,
        transactionDate: true,
      },
    }),
    prisma.listing.groupBy({ by: ['purpose'], _count: { _all: true } }),
  ])

  const byId = new Map(communities.map((x) => [x.id, x]))
  const buckets = new Map<string, Map<string, { sum: number; n: number }>>()
  const valueByCommunity = new Map<string, number>()
  const typeBuckets = new Map<string, { volume: number; count: number }>()

  for (const t of txns) {
    const month = t.transactionDate.toISOString().substring(0, 7)
    const m = buckets.get(month) ?? new Map<string, { sum: number; n: number }>()
    const cell = m.get(t.communityId) ?? { sum: 0, n: 0 }
    cell.sum += t.pricePerSqft
    cell.n += 1
    m.set(t.communityId, cell)
    buckets.set(month, m)

    valueByCommunity.set(t.communityId, (valueByCommunity.get(t.communityId) ?? 0) + t.priceAed)

    const tb = typeBuckets.get(t.transactionType) ?? { volume: 0, count: 0 }
    tb.volume += t.priceAed
    tb.count += 1
    typeBuckets.set(t.transactionType, tb)
  }

  const months = [...buckets.keys()].sort()
  const seriesDistricts = communities.slice(0, 6)
  const series = months.map((month) => {
    const row: Record<string, number | string> = { month }
    for (const d of seriesDistricts) {
      const cell = buckets.get(month)?.get(d.id)
      row[d.slug] = cell && cell.n > 0 ? Math.round(cell.sum / cell.n) : 0
    }
    return row
  })

  const totalValue = [...valueByCommunity.values()].reduce((a, b) => a + b, 0)
  const avgPsf = communities.length
    ? Math.round(communities.reduce((a, d) => a + d.medianAedSqft, 0) / communities.length)
    : 0
  const avgYield = communities.length
    ? communities.reduce((a, d) => a + d.grossYieldPct, 0) / communities.length
    : 0
  const avgMomentum = communities.length
    ? communities.reduce((a, d) => a + d.priceChange30d, 0) / communities.length
    : 0
  const activeListings = listingGroups.reduce((a, g) => a + g._count._all, 0)

  const gainers = [...communities].sort((a, b) => b.priceChange30d - a.priceChange30d)
  const losers = [...communities].sort((a, b) => a.priceChange30d - b.priceChange30d)
  const breadth = {
    gainers: communities.filter((d) => d.priceChange30d > 0.5).length,
    flat: communities.filter((d) => d.priceChange30d >= -0.5 && d.priceChange30d <= 0.5).length,
    losers: communities.filter((d) => d.priceChange30d < -0.5).length,
  }

  const scatter = communities.map((d) => ({
    slug: d.slug,
    name: d.nameEn,
    psf: d.medianAedSqft,
    yield: d.grossYieldPct,
    volume: d.transactionCount30d,
    momentum: d.priceChange30d,
  }))

  const flow = [...valueByCommunity.entries()]
    .map(([id, value]) => {
      const d = byId.get(id)
      if (!d) return null
      const perTxn = value / Math.max(1, d.transactionCount30d || 1)
      return {
        slug: d.slug,
        name: d.nameEn,
        valueAed: Math.round(value),
        perTxnAed: Math.round(perTxn),
        txnCount: d.transactionCount30d,
        direction: d.priceChange30d >= 0 ? 'inflow' : 'outflow',
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.valueAed - a.valueAed)

  const flowTotal = flow.reduce((a, d) => a + d.valueAed, 0)
  const topFlowCut = flow.slice(0, 8).reduce((a, d) => a + d.valueAed, 0)

  return c.json({
    overview: {
      avgPsf,
      avgYield: Number(avgYield.toFixed(2)),
      momentumIndex: Number(avgMomentum.toFixed(2)),
      transactionCount: txns.length,
      totalValueAed: Math.round(totalValue),
      activeListings,
      districtsTracked: communities.length,
      breadth,
    },
    gainers: gainers.slice(0, 5).map((d) => ({
      slug: d.slug, name: d.nameEn, change: d.priceChange30d, psf: d.medianAedSqft,
    })),
    losers: losers.slice(0, 5).map((d) => ({
      slug: d.slug, name: d.nameEn, change: d.priceChange30d, psf: d.medianAedSqft,
    })),
    seriesDistricts: seriesDistricts.map((d) => ({ slug: d.slug, name: d.nameEn })),
    series,
    scatter,
    scatterMedian: {
      psf: scatter.length
        ? Math.round(scatter.map((s) => s.psf).sort((a, b) => a - b)[Math.floor(scatter.length / 2)])
        : 0,
      yield: scatter.length
        ? Number(scatter.map((s) => s.yield).sort((a, b) => a - b)[Math.floor(scatter.length / 2)].toFixed(2))
        : 0,
    },
    flow: flow.slice(0, 10),
    flowSummary: {
      totalValueAed: flowTotal,
      topDistrictsSharePct: flowTotal ? Math.round((topFlowCut / flowTotal) * 1000) / 10 : 0,
      inflow: flow.filter((f) => f.direction === 'inflow').length,
      outflow: flow.filter((f) => f.direction === 'outflow').length,
    },
    transactionTypes: [...typeBuckets.entries()].map(([type, v]) => ({
      type, volumeAed: Math.round(v.volume), count: v.count,
    })),
    economic: {
      cpiYoyPct: UAE_CPI_YOY[new Date().getUTCMonth()],
      cpiSeries: months.map((m, i) => ({ month: m, cpi: UAE_CPI_YOY[i % UAE_CPI_YOY.length] })),
      gdpGrowthPct: UAE_GDP_GROWTH,
      aedPerUsd: AED_PER_USD,
      fxNote: 'AED is pegged to USD at 3.6725 — FX moves are a US-dollar story, not a dirham story.',
    },
    computedAt: new Date().toISOString(),
  })
})

// ─── Waitlist (spec Part 8.9) ────────────────────────────────────────────────

app.post('/sqftlab/waitlist', async (c) => {
  let body: { email?: string; tier?: string; source?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const email = (body.email ?? '').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return c.json({ error: 'Please enter a valid email address.' }, 400)
  }

  const tier = body.tier === 'elite' ? 'elite' : 'pro'
  const source = (body.source ?? 'waitlist_page').slice(0, 60)

  const existing = await prisma.waitlist.findUnique({ where: { email } })
  if (existing) {
    const count = await prisma.waitlist.count()
    return c.json({ ok: true, alreadyRegistered: true, position: count, email })
  }

  await prisma.waitlist.create({ data: { email, interestTier: tier, source } })
  const count = await prisma.waitlist.count()
  return c.json({ ok: true, alreadyRegistered: false, position: count, email })
})

app.get('/sqftlab/waitlist', async (c) => {
  const count = await prisma.waitlist.count()
  return c.json({ count })
})

// ─── TASK 8 — District market table ──────────────────────────────────────────
// One row per district with the spec's columns. Every value is aggregated from
// the register — nothing is synthesized, so a district with thin data reports
// null for a change rather than inventing a number.
app.get('/sqftlab/markets', async (c) => {
  const emirate = c.req.query('emirate')
  const propertyType = c.req.query('type')

  const communityWhere: Record<string, unknown> = {}
  if (emirate && emirate !== 'all') communityWhere.emirate = emirate

  const communities = await prisma.community.findMany({
    where: communityWhere,
    select: {
      id: true, slug: true, nameEn: true, emirate: true,
      medianAedSqft: true, grossYieldPct: true, priceChange30d: true,
      priceChange1y: true, transactionCount30d: true, totalTransactions: true,
      medianAnnualRentAed: true,
    },
  })

  // Sale listings per district, respecting the property-type filter.
  const listingWhere: Record<string, unknown> = { purpose: 'sale' }
  if (propertyType && propertyType !== 'any') listingWhere.propertyType = propertyType
  const listingGroups = await prisma.listing.groupBy({
    by: ['communityId'],
    where: listingWhere,
    _count: { _all: true },
  })
  const listingsByCommunity = new Map(listingGroups.map((g) => [g.communityId, g._count._all]))

  // 3-month change: mean realised PSF over the last 3 months vs the 3 before it.
  const sixMonthsAgo = new Date()
  sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6)
  const threeMonthsAgo = new Date()
  threeMonthsAgo.setUTCMonth(threeMonthsAgo.getUTCMonth() - 3)

  const txns = await prisma.transaction.findMany({
    where: { transactionDate: { gte: sixMonthsAgo }, pricePerSqft: { gt: 0 } },
    select: { communityId: true, transactionDate: true, pricePerSqft: true },
  })

  const recent = new Map<string, number[]>()
  const prior = new Map<string, number[]>()
  for (const t of txns) {
    const target = t.transactionDate >= threeMonthsAgo ? recent : prior
    const list = target.get(t.communityId)
    if (list) list.push(t.pricePerSqft)
    else target.set(t.communityId, [t.pricePerSqft])
  }
  const mean = (a?: number[]) => (a && a.length ? a.reduce((s, v) => s + v, 0) / a.length : null)

  const rows = communities.map((k) => {
    const recentMean = mean(recent.get(k.id))
    const priorMean = mean(prior.get(k.id))
    const change3m =
      recentMean != null && priorMean != null && priorMean > 0
        ? ((recentMean - priorMean) / priorMean) * 100
        : null

    // Momentum blends 30-day price movement with yield — a district that is both
    // appreciating and yielding well scores high.
    const momentum = (k.priceChange30d ?? 0) + (k.grossYieldPct ?? 0) * 0.5

    return {
      slug: k.slug,
      nameEn: k.nameEn,
      emirate: k.emirate,
      avgPsf: Math.round(k.medianAedSqft),
      change3m: change3m != null ? Number(change3m.toFixed(2)) : null,
      change12m: Number((k.priceChange1y ?? 0).toFixed(2)),
      volume: k.totalTransactions,
      volume30d: k.transactionCount30d,
      listings: listingsByCommunity.get(k.id) ?? 0,
      momentum: Number(momentum.toFixed(2)),
      grossYieldPct: k.grossYieldPct ?? 0,
      medianAnnualRentAed: k.medianAnnualRentAed ?? 0,
    }
  })

  return c.json({
    rows,
    count: rows.length,
    totals: {
      volume: rows.reduce((s, r) => s + r.volume, 0),
      listings: rows.reduce((s, r) => s + r.listings, 0),
    },
  })
})

// ─── TASK 10 — Price trend forecasting ───────────────────────────────────────
// Least-squares linear regression over the last 12 months of realised PSF, per
// the spec formula:
//   slope     = (n·Σxy − Σx·Σy) / (n·Σx² − (Σx)²)
//   intercept = (Σy − slope·Σx) / n
// Confidence is R² combined with a residual-based band that widens with horizon.
app.get('/sqftlab/forecast', async (c) => {
  const district = c.req.query('district')
  const months = Math.min(Math.max(parseInt(c.req.query('months') || '6'), 1), 24)

  if (!district) return c.json({ error: 'district is required' }, 400)

  const community = await prisma.community.findFirst({
    where: { OR: [{ slug: district }, { nameEn: district }] },
    select: { id: true, nameEn: true, slug: true, medianAedSqft: true },
  })
  if (!community) return c.json({ error: `Unknown district "${district}"` }, 404)

  const since = new Date()
  since.setUTCMonth(since.getUTCMonth() - 11)
  since.setUTCDate(1)
  since.setUTCHours(0, 0, 0, 0)

  const txns = await prisma.transaction.findMany({
    where: {
      communityId: community.id,
      transactionDate: { gte: since },
      pricePerSqft: { gt: 0 },
    },
    select: { transactionDate: true, pricePerSqft: true },
  })

  const buckets = new Map<string, number[]>()
  for (const t of txns) {
    const d = t.transactionDate
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    const list = buckets.get(key)
    if (list) list.push(t.pricePerSqft)
    else buckets.set(key, [t.pricePerSqft])
  }

  const history = [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, prices]) => ({
      date: `${month}-01`,
      psf: prices.reduce((s, p) => s + p, 0) / prices.length,
      sampleSize: prices.length,
    }))

  if (history.length < 3) {
    return c.json({
      district: community.nameEn,
      slug: community.slug,
      history,
      forecast: [],
      regression: null,
      note: 'Not enough monthly history to fit a trend (need at least 3 months).',
    })
  }

  const n = history.length
  const xs = history.map((_, i) => i)
  const ys = history.map((h) => h.psf)
  const sumX = xs.reduce((s, x) => s + x, 0)
  const sumY = ys.reduce((s, y) => s + y, 0)
  const sumXY = xs.reduce((s, x, i) => s + x * ys[i], 0)
  const sumXX = xs.reduce((s, x) => s + x * x, 0)

  const denominator = n * sumXX - sumX * sumX
  const slope = denominator === 0 ? 0 : (n * sumXY - sumX * sumY) / denominator
  const intercept = (sumY - slope * sumX) / n

  // R² — how much of the variance the trend line explains.
  const meanY = sumY / n
  const ssTot = ys.reduce((s, y) => s + (y - meanY) ** 2, 0)
  const ssRes = ys.reduce((s, y, i) => s + (y - (intercept + slope * i)) ** 2, 0)
  const r2 = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot)
  const residualStd = Math.sqrt(ssRes / Math.max(1, n - 2))

  const lastDate = new Date(history[n - 1].date)
  const forecast = Array.from({ length: months }, (_, k) => {
    const x = n + k
    const psf = intercept + slope * x
    const horizon = k + 1
    // Band widens with the horizon — a 6-month projection is less certain than
    // a 1-month one by sqrt(horizon).
    const band = 1.96 * residualStd * Math.sqrt(1 + horizon / n)
    const d = new Date(lastDate)
    d.setUTCMonth(d.getUTCMonth() + horizon)
    // Confidence decays with horizon but never claims certainty.
    const confidence = Math.round(Math.max(35, Math.min(95, r2 * 100 - horizon * 2.5 + 20)))
    return {
      date: d.toISOString().slice(0, 10),
      psf: Math.max(0, psf),
      lower: Math.max(0, psf - band),
      upper: psf + band,
      confidence,
    }
  })

  return c.json({
    district: community.nameEn,
    slug: community.slug,
    currentPsf: community.medianAedSqft,
    history,
    forecast,
    regression: {
      slope,
      intercept,
      r2,
      residualStd,
      monthsOfHistory: n,
      direction: slope > 0 ? 'rising' : slope < 0 ? 'falling' : 'flat',
      monthlyChangePct: meanY > 0 ? (slope / meanY) * 100 : 0,
    },
  })
})

// ─── TASK 12 — Deal alert CRUD + engine ──────────────────────────────────────

// Current user. The app is single-tenant demo, so this resolves the seeded user
// and lets tier-restricted pages decide whether to gate.
app.get('/sqftlab/me', async (c) => {
  const user = await prisma.user.findUnique({
    where: { id: DEMO_USER_ID },
    select: { id: true, email: true, name: true, tier: true, subscriptionStatus: true },
  })
  if (!user) return c.json({ error: 'No demo user configured' }, 404)
  return c.json({ user })
})

// GET /sqftlab/alerts — active alerts plus the recent matches they produced.
app.get('/sqftlab/alerts', async (c) => {
  const alerts = await prisma.dealAlert.findMany({
    where: { userId: DEMO_USER_ID },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { matches: true } } },
  })
  return c.json({ alerts })
})

app.get('/sqftlab/alerts/matches', async (c) => {
  const matches = await recentMatches(DEMO_USER_ID)
  return c.json({ matches })
})

// POST /sqftlab/alerts — create a watch. Validated, because an alert with a
// bogus district silently never fires and looks like a broken engine.
app.post('/sqftlab/alerts', async (c) => {
  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Request body must be JSON.' }, 400)
  }

  const district = typeof body.district === 'string' ? body.district.trim() : ''
  if (!district) return c.json({ error: 'district is required' }, 400)

  const community = await prisma.community.findFirst({
    where: { OR: [{ slug: district }, { nameEn: district }] },
    select: { slug: true },
  })
  if (!community) return c.json({ error: `Unknown district "${district}"` }, 400)

  const propertyType =
    typeof body.propertyType === 'string' && body.propertyType && body.propertyType !== 'any'
      ? body.propertyType
      : null
  const maxPrice = body.maxPrice != null && body.maxPrice !== '' ? Number(body.maxPrice) : null
  if (maxPrice != null && (!Number.isFinite(maxPrice) || maxPrice <= 0)) {
    return c.json({ error: 'maxPrice must be a positive number' }, 400)
  }
  const minBeds = body.minBeds != null && body.minBeds !== '' ? Number(body.minBeds) : null
  if (minBeds != null && (!Number.isInteger(minBeds) || minBeds < 0)) {
    return c.json({ error: 'minBeds must be a non-negative integer' }, 400)
  }

  const alert = await prisma.dealAlert.create({
    data: {
      userId: DEMO_USER_ID,
      district: community.slug,
      propertyType,
      maxPrice,
      minBeds,
      active: true,
    },
  })

  // Evaluate immediately so a new alert shows matches without waiting for the cron.
  const scan = await scanDealAlerts()
  return c.json({ alert, scan }, 201)
})

// DELETE /sqftlab/alerts/:id — matches cascade via the relation.
app.delete('/sqftlab/alerts/:id', async (c) => {
  const id = c.req.param('id')
  const existing = await prisma.dealAlert.findFirst({ where: { id, userId: DEMO_USER_ID } })
  if (!existing) return c.json({ error: 'Alert not found' }, 404)

  await prisma.dealAlert.delete({ where: { id } })
  return c.json({ ok: true, deleted: id })
})

// POST /sqftlab/alerts/scan — run the engine on demand (the scraper cron also
// calls this after each listing upsert).
app.post('/sqftlab/alerts/scan', async (c) => {
  const scan = await scanDealAlerts()
  return c.json({ ok: true, scan })
})

// POST /sqftlab/alerts/notify — deliver unseen matches by email.
app.post('/sqftlab/alerts/notify', async (c) => {
  const result = await notifyPendingMatches()
  return c.json({ ok: true, notify: result })
})

// ─── Payment kill switch (spec Part 5.5) ──────────────────────────────────────
// Mirrors PAYMENTS_ENABLED in src/lib/payments.ts. Every payment endpoint must
// refuse explicitly — a bare 404 is indistinguishable from a typo in a client,
// and the spec requires these to answer 503 with a readable message.
const PAYMENTS_BLOCKED = {
  error: 'Payment processing is not yet available.',
  paymentsEnabled: false,
} as const

for (const path of ['/checkout', '/subscribe', '/create-payment-intent']) {
  app.all(path, (c) => c.json(PAYMENTS_BLOCKED, 503))
}

// Stripe webhooks are accepted and logged, never processed, so a delayed event
// cannot start a subscription behind the kill switch.
app.post('/webhooks/stripe', async (c) => {
  const body = await c.req.text().catch(() => '')
  console.info(
    `[sqftLab] Stripe webhook ignored (PAYMENTS_ENABLED=false) — ${body.length} bytes`,
  )
  return c.json({ received: true, processed: false })
})

// ═══════════════════════════════════════════════════════════════════════════
// Spec Part 6 / Part 8 — the 7 extraordinary intelligence products + the
// supporting district, macro and image endpoints.
// ═══════════════════════════════════════════════════════════════════════════

const SPEC_VERSION = '2.0'

// ─── 6.1 Real Price Index ────────────────────────────────────────────────────
// GET /api/sqftlab/rpi?district=downtown-dubai&type=Apartment&beds=2
app.get('/sqftlab/rpi', async (c) => {
  const district = c.req.query('district')
  const type = c.req.query('type')
  const bedsParam = c.req.query('beds')
  const beds = bedsParam === 'all' || bedsParam == null ? ALL_BEDS : Number(bedsParam)

  const where: Record<string, unknown> = {}
  if (district) where.district = district
  if (type) where.propertyType = type
  if (bedsParam != null) where.bedrooms = Number.isFinite(beds) ? beds : ALL_BEDS

  const latestDate = await prisma.realPriceIndex.findFirst({
    where: district ? { district } : {},
    orderBy: { indexDate: 'desc' },
    select: { indexDate: true },
  })

  const rows = await prisma.realPriceIndex.findMany({
    where: { ...where, ...(latestDate ? { indexDate: latestDate.indexDate } : {}) },
    orderBy: { indexValue: 'desc' },
    take: 200,
  })
  if (!rows.length) {
    return c.json({
      index: [],
      insufficientHistory: true,
      reason: 'No Real Price Index segments have been computed yet. Run POST /api/sqftlab/intelligence/run.',
      methodology: 'Trimmed mean (5th–95th percentile) of DLD-registered sales PSF. The window starts at the spec\'s 30 days and widens to 90/180/365 only when 30 days leaves too few segments above the 3-sale confidence floor. Segments under 3 sales are always omitted.',
      source: 'Dubai Land Department',
    })
  }

  const history = district
    ? await prisma.realPriceIndex.findMany({
        where: { district, ...(type ? { propertyType: type } : {}) },
        orderBy: { indexDate: 'desc' },
        take: 90,
      })
    : []

  const head = rows[0]
  const monthlyAgo = history.find((h) => h.indexDate.getTime() <= Date.now() - 30 * 86_400_000)
  const yearlyAgo = history.find((h) => h.indexDate.getTime() <= Date.now() - 365 * 86_400_000)
  const pct = (a?: number | null, b?: number | null) =>
    a == null || b == null || b === 0 ? null : ((a - b) / b) * 100

  return c.json({
    district: district ?? 'all',
    propertyType: type ?? 'All',
    bedrooms: head.bedrooms === ALL_BEDS || head.bedrooms < 0 ? null : head.bedrooms,
    indexValue: Math.round(head.indexValue),
    cpiAdjusted: head.cpiAdjusted != null ? Math.round(head.cpiAdjusted) : null,
    transactionCount: head.transactionCount,
    monthlyChange: pct(head.indexValue, monthlyAgo?.indexValue),
    yearlyChange: pct(head.indexValue, yearlyAgo?.indexValue),
    history: history.map((h) => ({
      date: h.indexDate.toISOString().slice(0, 10),
      indexValue: Math.round(h.indexValue),
      cpiAdjusted: h.cpiAdjusted != null ? Math.round(h.cpiAdjusted) : null,
      transactionCount: h.transactionCount,
    })),
    segments: rows.length,
    index: rows.slice(0, 60).map((r) => ({
      district: r.district, propertyType: r.propertyType,
      bedrooms: r.bedrooms < 0 ? null : r.bedrooms,
      indexValue: Math.round(r.indexValue),
      cpiAdjusted: r.cpiAdjusted != null ? Math.round(r.cpiAdjusted) : null,
      transactionCount: r.transactionCount,
    })),
    methodology: 'Trimmed mean (5th–95th percentile) of DLD-registered sales PSF. The window starts at the spec\'s 30 days and widens to 90/180/365 only when 30 days leaves too few segments above the 3-sale confidence floor. Segments under 3 sales are always omitted.',
    source: 'Dubai Land Department',
    calculatedAt: head.calculatedAt.toISOString(),
  })
})

// ─── 6.2 Building Intelligence Profile ──────────────────────────────────────
app.get('/sqftlab/building', async (c) => {
  const district = c.req.query('district')
  const community = c.req.query('community')
  const sort = c.req.query('sort') ?? 'score'
  const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200)

  const where: Record<string, unknown> = {}
  if (district) where.district = district
  if (community) where.communityEn = community

  const orderBy =
    sort === 'liquidity' ? { liquidityScore: 'desc' as const }
    : sort === 'trend' ? { psfTrend12m: 'desc' as const }
    : { intelligenceScore: 'desc' as const }

  const buildings = await prisma.buildingProfile.findMany({ where, orderBy, take: limit })
  return c.json({
    buildings,
    count: buildings.length,
    methodology:
      'Every metric is derived from DLD sales in that building: price velocity from PSF windows, ' +
      'liquidity from median holding period between resales, owner confidence from units never resold, ' +
      'and floor premium from a PSF-on-floor regression.',
    source: 'Dubai Land Department',
  })
})

app.get('/sqftlab/building/:slug', async (c) => {
  const slug = decodeURIComponent(c.req.param('slug'))
  const [buildingNameEn, communityEn] = slug.includes('--') ? slug.split('--') : [slug, undefined]

  const building = communityEn
    ? await prisma.buildingProfile.findFirst({ where: { buildingNameEn, communityEn } })
    : await prisma.buildingProfile.findFirst({ where: { buildingNameEn } })

  if (!building) return c.json({ error: 'Building not found', slug }, 404)

  const peers = await prisma.buildingProfile.findMany({
    where: { communityEn: building.communityEn, NOT: { id: building.id } },
    orderBy: { intelligenceScore: 'desc' },
    take: 5,
  })

  return c.json({
    building,
    peers,
    interpretation: {
      psfVelocity: 'Is this building gaining or losing value faster than its community?',
      liquidity: 'How quickly a unit can be resold here — low means a slow exit.',
      ownerOccupier: 'Units never resold = stable, owner-occupied stock.',
      buyerHoldRate: 'Share of buyers who held longer than 12 months.',
      ejariDensity: 'Rental contracts per 100 DLD units — higher means rental-dominated.',
      floorPremium: building.floorPremiumPct != null
        ? `Each floor adds about ${building.floorPremiumPct.toFixed(2)}% to PSF — floor 20 vs floor 5 is roughly ${(15 * building.floorPremiumPct).toFixed(1)}% more.`
        : 'Not enough floor-tagged sales in this building to fit a premium curve.',
    },
  })
})

// ─── 6.3 District Yield Curve ───────────────────────────────────────────────
app.get('/sqftlab/yield-curve', async (c) => {
  const district = c.req.query('district')
  if (!district) return c.json({ error: 'district query parameter is required' }, 400)
  const result = await computeYieldCurve(district)
  if ('error' in result && result.error === 'district_not_found') {
    return c.json({ error: `Unknown district: ${district}` }, 404)
  }
  return c.json(result)
})

// ─── 6.4 Migration Signal ───────────────────────────────────────────────────
app.get('/sqftlab/migration', async (c) => {
  const district = c.req.query('district')
  const where = district ? { district } : {}

  const [flows, surges] = await Promise.all([
    prisma.nationalityFlow.findMany({
      where, orderBy: [{ month: 'desc' }, { transactionCount: 'desc' }], take: 100,
    }),
    migrationSurges(20),
  ])

  if (!flows.length) {
    return c.json({
      flows: [], surges: [], insufficientData: true,
      reason: 'No transactions carry buyerNationality. DLD populates this field; the current dataset does not.',
      methodology: 'Share of transactions by buyer nationality per district per month, with month-on-month surge detection above 25%.',
    })
  }
  return c.json({
    flows, surges,
    surgeThresholdPct: 25,
    methodology: 'Share of transactions by buyer nationality per district per month, with month-on-month surge detection above 25%.',
    source: 'Dubai Land Department buyer records',
  })
})

// ─── 6.5 Institutional Flow Tracker ─────────────────────────────────────────
app.get('/sqftlab/flow', async (c) => {
  const district = c.req.query('district')
  const clusters = await prisma.institutionalTransaction.findMany({
    where: district ? { district } : {},
    orderBy: { totalValue: 'desc' },
    take: 50,
  })
  if (!clusters.length) {
    return c.json({
      clusters: [], insufficientData: true,
      reason: 'No corporate buyer clusters found. This requires buyerType=corporate on DLD transactions.',
      methodology: 'Corporate purchases clustered by entity + building, split on any gap over 30 days, kept at 3+ units.',
    })
  }
  return c.json({
    clusters,
    count: clusters.length,
    totalValueAed: clusters.reduce((s, x) => s + x.totalValue, 0),
    methodology: 'Corporate purchases clustered by entity + building, split on any gap over 30 days, kept at 3+ units.',
    source: 'Dubai Land Department',
  })
})

// ─── 6.6 Construction Pipeline Pressure ─────────────────────────────────────
app.get('/sqftlab/supply', async (c) => {
  const rows = await prisma.supplyPipeline.findMany({ orderBy: { pressureScore: 'desc' } })
  if (!rows.length) {
    return c.json({
      districts: [], insufficientData: true,
      reason: 'Supply pipeline has not been computed yet. Run POST /api/sqftlab/intelligence/run.',
      methodology: 'Gross off-plan registrations in the trailing 3 years divided by trailing 12-month absorption, scaled to a 0–100 pressure score. Because a DLD row carries no unit identifier, registrations cannot be matched to completions, so the unit count is an upper bound.',
    })
  }
  return c.json({
    districts: rows,
    highestPressure: rows[0],
    lowestPressure: rows[rows.length - 1],
    methodology: 'Gross off-plan registrations in the trailing 3 years divided by trailing 12-month absorption, scaled to a 0–100 pressure score. Because a DLD row carries no unit identifier, registrations cannot be matched to completions, so the unit count is an upper bound.',
    source: 'Dubai Land Department off-plan records',
  })
})

// ─── 6.7 Economic Sensitivity + scenario modeller ───────────────────────────
app.get('/sqftlab/macro', async (c) => {
  const district = c.req.query('district')
  const rows = await prisma.macroSensitivity.findMany({ where: district ? { district } : {} })
  const indicators = await prisma.macroIndicator.findMany({ orderBy: { fetchedAt: 'desc' }, take: 40 })
  const latestFx = await prisma.exchangeRate.findFirst({ orderBy: { fetchedAt: 'desc' } })

  const required = ['oil_price', 'vix', 'uae_gdp', 'uae_tourism']
  const present = [...new Set(indicators.map((i) => i.indicator))]
  const missing = required.filter((i) => !present.includes(i))

  if (!rows.length) {
    return c.json({
      sensitivities: [], insufficientHistory: true,
      missingIndicators: missing,
      indicatorsAvailable: present,
      latestFx,
      reason:
        `The sensitivity model needs 20+ months of district PSF history plus aligned oil, VIX, GDP and tourism series. ` +
        (missing.length ? `No ${missing.join(', ')} series is ingested.` : ''),
      methodology: 'Multiple OLS regression of monthly district PSF on oil, VIX, UAE GDP and tourism arrivals.',
    })
  }
  return c.json({ sensitivities: rows, indicatorsAvailable: present, missingIndicators: missing, latestFx })
})

app.post('/sqftlab/macro/scenario', async (c) => {
  const body = await c.req.json().catch(() => ({})) as {
    district?: string; oilPct?: number; vixChange?: number; gdpPct?: number; tourismPct?: number
  }
  if (!body.district) return c.json({ error: 'district is required' }, 400)

  const s = await prisma.macroSensitivity.findFirst({ where: { district: body.district } })
  if (!s) {
    return c.json({
      error: 'No fitted sensitivity model for this district yet.',
      district: body.district,
      insufficientHistory: true,
      reason: 'The scenario modeller needs the regression coefficients, which require 20+ months of history.',
    }, 412)
  }
  return c.json({
    district: body.district,
    shock: { oilPct: body.oilPct ?? 0, vixChange: body.vixChange ?? 0, gdpPct: body.gdpPct ?? 0, tourismPct: body.tourismPct ?? 0 },
    ...applyScenario(s, body),
    rSquared: s.rSquared,
  })
})

// ─── District metrics + market summary ──────────────────────────────────────
app.get('/sqftlab/districts', async (c) => {
  const emirate = c.req.query('emirate')
  const metrics = await prisma.districtMetrics.findMany({ orderBy: { momentumScore: 'desc' } })
  const communities = await prisma.community.findMany({
    select: { slug: true, nameEn: true, nameAr: true, emirate: true, latitude: true, longitude: true, medianAedSqft: true, grossYieldPct: true, neighbourhoodScore: true },
  })
  const byslug = new Map(communities.map((x) => [x.slug, x]))

  const districts = metrics
    .map((m) => ({ ...m, community: byslug.get(m.district) ?? null }))
    .filter((m) => (emirate && emirate !== 'all' ? m.community?.emirate === emirate : true))

  return c.json({
    districts,
    count: districts.length,
    layers: ['psf', 'yield', 'momentum', 'dealDensity', 'supplyPressure', 'institutionalFlow'],
    methodology: 'Per-district roll-up of DLD sales over trailing windows, recomputed by the intelligence pipeline.',
  })
})

app.get('/sqftlab/market-summary', async (c) => {
  const summary = await prisma.marketSummary.findFirst({ orderBy: { computedAt: 'desc' } })
  if (!summary) {
    return c.json({
      insufficientData: true,
      reason: 'Market summary has not been computed yet. Run POST /api/sqftlab/intelligence/run.',
    })
  }
  const fx = await prisma.exchangeRate.findFirst({ orderBy: { fetchedAt: 'desc' } })
  return c.json({ summary, fx })
})

// ─── Pipeline control (the spec's 6-hourly intelligence cron) ───────────────
app.post('/sqftlab/intelligence/run', async (c) => {
  try {
    const result = await runIntelligencePipeline()

    // Spec 16.3 — broadcast the recomputed state to every connected client.
    const summary = await prisma.marketSummary.findFirst({ orderBy: { computedAt: 'desc' } })
    if (summary) publish('market:update', summary)
    publish('intelligence:update', {
      rpi: result.rpi, buildings: result.buildings, supply: result.supply,
      migration: result.migration, flow: result.flow, metrics: result.metrics,
      durationMs: result.durationMs, generatedAt: result.generatedAt,
    })
    const topDistricts = await prisma.districtMetrics.findMany({
      orderBy: { momentumScore: 'desc' }, take: 10,
    })
    for (const d of topDistricts) {
      publish('district:update', {
        district: d.district, avgPricePsf: d.avgPricePsf,
        priceChange3m: d.priceChange3m, momentumScore: d.momentumScore,
        calculatedAt: d.calculatedAt.toISOString(),
      })
    }

    return c.json({ ...result, published: { market: !!summary, districts: topDistricts.length } })
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

// Fire the broadcast path without recomputing, so the client can be exercised
// against a live stream even when nothing has changed on disk.
app.post('/sqftlab/stream/test-publish', async (c) => {
  const summary = await prisma.marketSummary.findFirst({ orderBy: { computedAt: 'desc' } })
  publish('market:update', summary ?? { note: 'no market summary computed yet' })
  const d = await prisma.districtMetrics.findFirst({ orderBy: { momentumScore: 'desc' } })
  if (d) publish('district:update', { district: d.district, momentumScore: d.momentumScore })
  const deal = await prisma.listing.findFirst({ where: { isDeal: true } })
  if (deal) {
    publish('deal:new', {
      id: deal.id, title: deal.title, purpose: deal.purpose,
      priceAed: deal.priceAed, pricePerSqft: deal.pricePerSqft,
      imageUrl: deal.imageUrl, sourceUrl: deal.sourceUrl,
      detectedAt: new Date().toISOString(),
    })
  }
  return c.json({ ok: true, published: ['market:update', 'district:update', 'deal:new'], ...streamStatus() })
})

app.get('/sqftlab/intelligence/status', async (c) => {
  const [rpi, buildings, flows, clusters, supply, sens, metrics, summary, macro, fx] = await Promise.all([
    prisma.realPriceIndex.count(), prisma.buildingProfile.count(),
    prisma.nationalityFlow.count(), prisma.institutionalTransaction.count(),
    prisma.supplyPipeline.count(), prisma.macroSensitivity.count(),
    prisma.districtMetrics.count(), prisma.marketSummary.count(),
    prisma.macroIndicator.count(), prisma.exchangeRate.count(),
  ])
  const lastSummary = await prisma.marketSummary.findFirst({ orderBy: { computedAt: 'desc' } })
  return c.json({
    products: {
      realPriceIndex: { rows: rpi, ready: rpi > 0 },
      buildingIntelligence: { rows: buildings, ready: buildings > 0 },
      migrationSignal: { rows: flows, ready: flows > 0 },
      institutionalFlow: { rows: clusters, ready: clusters > 0 },
      supplyPipeline: { rows: supply, ready: supply > 0 },
      macroSensitivity: { rows: sens, ready: sens > 0 },
      districtMetrics: { rows: metrics, ready: metrics > 0 },
    },
    infrastructure: { marketSummary: summary, macroIndicators: macro, exchangeRates: fx },
    lastComputedAt: lastSummary?.computedAt?.toISOString() ?? null,
    specVersion: SPEC_VERSION,
  })
})

// ─── Macro ingestion (spec Part 3.2 free sources) ───────────────────────────
app.post('/sqftlab/macro/refresh', async (c) => {
  try {
    const result = await fetchAllMacro()
    return c.json({ ...result, fetchedAt: new Date().toISOString() })
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

app.get('/sqftlab/fx', async (c) => {
  const latest = await prisma.exchangeRate.findFirst({ orderBy: { fetchedAt: 'desc' } })
  if (latest) return c.json(latest)
  // Nothing ingested yet — fetch live rather than returning an empty shape.
  const r = await fetchExchangeRates()
  if (!r.ok) return c.json({ error: r.error ?? 'FX unavailable' }, 502)
  const fresh = await prisma.exchangeRate.findFirst({ orderBy: { fetchedAt: 'desc' } })
  return c.json(fresh)
})

// ─── Spec Part 8 — /api/img image proxy ─────────────────────────────────────
// Only hosts we actually scrape are allowed through: an open proxy here would
// be an SSRF hole pointed at the internal network.
const IMAGE_HOST_ALLOWLIST = [
  'bayut-production.s3.eu-central-1.amazonaws.com',
  'images.bayut.com',
  'cdn.propertyfinder.ae',
  'www.propertyfinder.ae',
  'dbz-images.dubizzle.com',
  'images.dubizzle.com',
]

app.get('/sqftlab/img', async (c) => {
  const raw = c.req.query('url')
  if (!raw) return c.json({ error: 'url query parameter is required' }, 400)

  let target: URL
  try {
    target = new URL(raw)
  } catch {
    return c.json({ error: 'url is not a valid absolute URL' }, 400)
  }
  if (target.protocol !== 'https:' || !IMAGE_HOST_ALLOWLIST.includes(target.hostname)) {
    return c.json({ error: `Host not allowed: ${target.hostname}`, allowlist: IMAGE_HOST_ALLOWLIST }, 403)
  }

  const cached = await prisma.imageCache.findFirst({ where: { externalUrl: target.toString() } })
  if (cached?.contentType && cached.expiresAt && cached.expiresAt.getTime() > Date.now()) {
    return c.body(null, 302, { Location: target.toString() })
  }

  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 12_000)
    const res = await fetch(target.toString(), { signal: ctl.signal, headers: { 'User-Agent': 'sqftLab/1.0' } })
    clearTimeout(timer)
    if (!res.ok) return c.json({ error: `Upstream returned ${res.status}` }, 502)

    const buf = Buffer.from(await res.arrayBuffer())
    const contentType = res.headers.get('content-type') ?? 'image/jpeg'
    await prisma.imageCache.upsert({
      where: { externalUrl: target.toString() },
      create: {
        externalUrl: target.toString(), contentType, sizeBytes: buf.length,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      },
      update: { contentType, sizeBytes: buf.length, fetchedAt: new Date(), expiresAt: new Date(Date.now() + 7 * 86_400_000) },
    })
    return c.body(new Uint8Array(buf), 200, {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=604800, immutable',
    })
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502)
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// Spec Part 16 — real-time stream (SSE).
// ═══════════════════════════════════════════════════════════════════════════

app.get('/sqftlab/stream/status', (c) => c.json(streamStatus()))

app.get('/sqftlab/stream/market', (c) =>
  streamSSE(c, async (stream) => {
    let closed = false

    // 1. Send the current state immediately so there is no empty first paint.
    const summary = await prisma.marketSummary.findFirst({ orderBy: { computedAt: 'desc' } })
    const fx = await prisma.exchangeRate.findFirst({ orderBy: { fetchedAt: 'desc' } })
    await stream.writeSSE({
      event: 'message',
      data: JSON.stringify({ type: 'init', payload: { summary, fx }, ts: Date.now() }),
    })

    // 2. Replay whatever was published before this client connected.
    for (const m of recentMessages()) {
      await stream.writeSSE({
        event: 'message',
        data: JSON.stringify({ type: m.channel, payload: m.payload, ts: m.ts }),
      })
    }

    // 3. Forward everything published from here on.
    const unsubscribe = subscribe(async (m) => {
      if (closed) return
      try {
        await stream.writeSSE({
          event: 'message',
          data: JSON.stringify({ type: m.channel, payload: m.payload, ts: m.ts }),
        })
      } catch {
        closed = true
        unsubscribe()
      }
    })

    // 4. Heartbeat — keeps proxies from closing an idle connection, and gives
    //    the client a liveness signal it can show in the UI.
    const heartbeat = setInterval(() => {
      if (closed) return
      stream.writeSSE({ event: 'ping', data: JSON.stringify({ ts: Date.now() }) }).catch(() => {
        closed = true
        unsubscribe()
        clearInterval(heartbeat)
      })
    }, 25_000)

    stream.onAbort(() => {
      closed = true
      clearInterval(heartbeat)
      unsubscribe()
    })

    // Keep the handler alive until the client disconnects.
    await new Promise<void>((resolve) => {
      stream.onAbort(resolve)
      setTimeout(resolve, 30 * 60 * 1000)
    })
  }),
)

// Catch-all — must be registered LAST so every real route wins.
//
// The pattern is '*' and not '/api/*': server.tsx mounts this app with
// `app.route('/api', customRoutes)`, so routes here are relative to that mount
// point (see the '/sqftlab/...' declarations above). An '/api/*' pattern would
// therefore never match anything.
//
// This exists because server.tsx also owns a SPA catch-all that resolves any
// unmatched path to index.html. Without this handler an API client asking for a
// mistyped or removed endpoint receives an HTML document with a 200 status,
// parses it as a successful response, and fails somewhere far away from the
// actual mistake. Answering in JSON keeps the failure at the boundary.
app.all('*', (c) =>
  c.json({ error: `No API route matches ${c.req.method} ${c.req.path}` }, 404),
)

export default app
