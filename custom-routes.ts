import { Hono } from 'hono'
import { prisma } from './src/lib/db'

const app = new Hono()

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

app.get('/sqftlab/alerts', async (c) => {
  const alerts = await prisma.alert.findMany({
    where: { userId: DEMO_USER_ID },
    include: { community: { select: { nameEn: true, slug: true } } },
    orderBy: { createdAt: 'desc' },
  })
  return c.json({ alerts })
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

export default app
