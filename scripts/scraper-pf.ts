/**
 * PropertyFinder Scraper — HTTP-based, no Playwright needed.
 * Scrapes rent + buy listings from propertyfinder.ae
 * Only keeps listings from the last 30 days.
 * 
 * Run: bun scripts/scraper-pf.ts
 * Or trigger via: GET /api/sqftlab/scrape
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

// Dubai areas with PropertyFinder location IDs
const DUBAI_AREAS: { name: string; locationId: string; slug: string }[] = [
  { name: 'Dubai Marina', locationId: '31', slug: 'dubai-marina' },
  { name: 'Downtown Dubai', locationId: '56', slug: 'downtown-dubai' },
  { name: 'Palm Jumeirah', locationId: '63', slug: 'palm-jumeirah' },
  { name: 'JVC', locationId: '544', slug: 'jumeirah-village-circle' },
  { name: 'Business Bay', locationId: '53', slug: 'business-bay' },
  { name: 'Dubai Hills Estate', locationId: '1436', slug: 'dubai-hills-estate' },
  { name: 'JLT', locationId: '59', slug: 'jumeirah-lake-towers' },
  { name: 'DIFC', locationId: '55', slug: 'difc' },
  { name: 'Dubai Creek Harbour', locationId: '3476', slug: 'dubai-creek-harbour' },
  { name: 'MBR City', locationId: '2424', slug: 'mbr-city' },
  { name: 'Al Barsha', locationId: '40', slug: 'al-barsha' },
  { name: 'Deira', locationId: '49', slug: 'deira' },
  { name: 'Bur Dubai', locationId: '47', slug: 'bur-dubai' },
  { name: 'Dubai Silicon Oasis', locationId: '109', slug: 'dubai-silicon-oasis' },
  { name: 'Dubai Sports City', locationId: '103', slug: 'dubai-sports-city' },
  { name: 'Motor City', locationId: '102', slug: 'motor-city' },
  { name: 'Discovery Gardens', locationId: '58', slug: 'discovery-gardens' },
  { name: 'Dubai Land', locationId: '105', slug: 'dubai-land' },
  { name: 'Al Nahda', locationId: '44', slug: 'al-nahda' },
  { name: 'Town Square', locationId: '2100', slug: 'town-square' },
]

// Abu Dhabi areas
const ABU_DHABI_AREAS: { name: string; locationId: string; slug: string }[] = [
  { name: 'Al Reem Island', locationId: '6665', slug: 'al-reem-island' },
  { name: 'Saadiyat Island', locationId: '6666', slug: 'saadiyat-island' },
  { name: 'Yas Island', locationId: '6667', slug: 'yas-island' },
  { name: 'Al Raha Beach', locationId: '6668', slug: 'al-raha-beach' },
  { name: 'Corniche', locationId: '6663', slug: 'corniche' },
  { name: 'Khalifa City', locationId: '6670', slug: 'khalifa-city' },
  { name: 'Mohammed Bin Zayed City', locationId: '6671', slug: 'mbz' },
  { name: 'Al Maryah Island', locationId: '6669', slug: 'al-maryah-island' },
]

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function fetchPage(categoryId: number, locationId: string, page: number): Promise<any[]> {
  const url = `https://www.propertyfinder.ae/en/search?c=${categoryId}&l=${locationId}&ob=mr&page=${page}`
  
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(15000),
    })
    
    if (!res.ok) return []
    
    const html = await res.text()
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/)
    if (!match) return []
    
    const data = JSON.parse(match[1])
    const listings = data?.props?.pageProps?.searchResult?.listings ?? []
    
    return listings
      .filter((l: any) => l.listing_type === 'property' && l.property)
      .map((l: any) => l.property)
  } catch (err: any) {
    console.error(`  ✗ Failed page ${page} for location ${locationId}: ${err.message}`)
    return []
  }
}

function parseListing(property: any, source: string, purpose: string) {
  const price = property.price?.value ?? 0
  const area = property.size ?? 0
  const pricePerSqft = area > 0 ? Math.round(price / area) : 0
  const beds = property.bedrooms_value ?? property.bedrooms ?? 0
  const baths = property.bathrooms_value ?? property.bathrooms ?? 0
  const location = property.location ?? {}
  const districtName = location.name ?? location.full_name ?? 'Unknown'
  const lat = location.coordinates?.lat ?? null
  const lon = location.coordinates?.lon ?? null
  const imageUrl = property.images?.[0]?.medium ?? property.images?.[0]?.small ?? null
  const agentName = property.agent?.name ?? null
  const agencyName = property.broker?.name ?? null
  const title = property.title ?? `${property.property_type ?? 'Property'} in ${districtName}`
  const listedDate = property.listed_date ?? property.last_refreshed_at ?? new Date().toISOString()
  const furnished = property.furnished === 'furnished' ? 'furnished' : property.furnished === 'semi_furnished' ? 'semi_furnished' : 'unfurnished'
  const completion = property.completion_status === 'off_plan' ? 'off_plan' : 'ready'

  return {
    externalId: `${source}_${property.id}`,
    source,
    purpose,
    propertyType: property.property_type ?? 'Apartment',
    beds: beds || 0,
    baths: baths || 0,
    areaSqft: area || 0,
    priceAed: price || 0,
    pricePerSqft,
    furnished,
    completion,
    agentName,
    agencyName,
    title,
    imageUrl,
    latitude: lat,
    longitude: lon,
    listedAt: new Date(listedDate),
    districtName,
    locationSlug: location.slug ?? districtName.toLowerCase().replace(/\s+/g, '-'),
  }
}

async function findOrCreateCommunity(name: string, slug: string, emirate: string, lat?: number | null, lon?: number | null) {
  // Try to find existing community by slug
  let community = await prisma.community.findFirst({ where: { slug } })
  
  if (!community) {
    // Try by name
    community = await prisma.community.findFirst({ 
      where: { nameEn: { contains: name, mode: 'insensitive' } } 
    })
  }
  
  if (!community) {
    // Create new community
    community = await prisma.community.create({
      data: {
        slug,
        nameEn: name,
        emirate,
        latitude: lat ?? 25.2,
        longitude: lon ?? 55.27,
        medianAedSqft: 0,
        medianAnnualRentAed: 0,
        grossYieldPct: 0,
        neighbourhoodScore: 50,
        priceChange30d: 0,
        priceChange1y: 0,
        transactionCount30d: 0,
        totalTransactions: 0,
      },
    })
    console.log(`  + Created community: ${name}`)
  }
  
  return community
}

async function scrapeArea(area: { name: string; locationId: string; slug: string }, emirate: string) {
  let totalSaved = 0
  
  for (const categoryId of [1, 2]) { // 1=buy, 2=rent
    const purpose = categoryId === 1 ? 'sale' : 'rent'
    
    for (let page = 1; page <= 5; page++) {
      const properties = await fetchPage(categoryId, area.locationId, page)
      if (properties.length === 0) break
      
      for (const property of properties) {
        try {
          const parsed = parseListing(property, 'propertyfinder', purpose)
          
          // Skip if no price or area
          if (parsed.priceAed <= 0) continue
          
          const community = await findOrCreateCommunity(
            parsed.districtName,
            parsed.locationSlug,
            emirate,
            parsed.latitude,
            parsed.longitude,
          )
          
          await prisma.listing.upsert({
            where: { externalId: parsed.externalId },
            create: {
              externalId: parsed.externalId,
              source: parsed.source,
              communityId: community.id,
              purpose: parsed.purpose,
              propertyType: parsed.propertyType,
              beds: parsed.beds,
              baths: parsed.baths,
              areaSqft: parsed.areaSqft,
              priceAed: parsed.priceAed,
              pricePerSqft: parsed.pricePerSqft,
              furnished: parsed.furnished,
              completion: parsed.completion,
              agentName: parsed.agentName,
              agencyName: parsed.agencyName,
              title: parsed.title,
              imageUrl: parsed.imageUrl,
              latitude: parsed.latitude,
              longitude: parsed.longitude,
              listedAt: parsed.listedAt,
              isDeal: false,
            },
            update: {
              priceAed: parsed.priceAed,
              pricePerSqft: parsed.pricePerSqft,
              areaSqft: parsed.areaSqft,
              title: parsed.title,
              imageUrl: parsed.imageUrl,
              agentName: parsed.agentName,
              agencyName: parsed.agencyName,
              scrapedAt: new Date(),
            },
          })
          totalSaved++
        } catch (err: any) {
          // Skip individual listing errors
        }
      }
      
      await sleep(1500) // Rate limit
    }
  }
  
  return totalSaved
}

async function cleanupOldListings() {
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
  
  const result = await prisma.listing.deleteMany({
    where: {
      scrapedAt: { lt: thirtyDaysAgo },
    },
  })
  
  console.log(`🗑️  Cleaned up ${result.count} old listings (>30 days)`)
  return result.count
}

async function updateCommunityStats() {
  const communities = await prisma.community.findMany()
  
  for (const community of communities) {
    const [listingCount, avgPricePsf, avgRent, transactionCount] = await Promise.all([
      prisma.listing.count({ where: { communityId: community.id } }),
      prisma.listing.aggregate({
        where: { communityId: community.id, purpose: 'sale', pricePerSqft: { gt: 0 } },
        _avg: { pricePerSqft: true },
      }),
      prisma.listing.aggregate({
        where: { communityId: community.id, purpose: 'rent', priceAed: { gt: 0 } },
        _avg: { priceAed: true },
      }),
      prisma.transaction.count({ where: { communityId: community.id } }),
    ])
    
    const medianPsf = Math.round(avgPricePsf._avg.pricePerSqft ?? 0)
    const medianRent = Math.round(avgRent._avg.priceAed ?? 0)
    const yieldPct = medianPsf > 0 && medianRent > 0 
      ? Math.round((medianRent / (medianPsf * 1000)) * 10000) / 100 
      : 0
    
    await prisma.community.update({
      where: { id: community.id },
      data: {
        medianAedSqft: medianPsf || community.medianAedSqft,
        medianAnnualRentAed: medianRent || community.medianAnnualRentAed,
        grossYieldPct: yieldPct || community.grossYieldPct,
        totalTransactions: transactionCount,
        transactionCount30d: transactionCount, // Simplified
      },
    })
  }
  
  console.log(`📊 Updated stats for ${communities.length} communities`)
}

async function updateMarketSummary() {
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
  
  const [txCount, avgPsf, totalValue, listingCount] = await Promise.all([
    prisma.transaction.count({ where: { transactionDate: { gte: thirtyDaysAgo } } }),
    prisma.transaction.aggregate({
      where: { transactionDate: { gte: thirtyDaysAgo }, pricePerSqft: { gt: 0 } },
      _avg: { pricePerSqft: true },
    }),
    prisma.transaction.aggregate({
      where: { transactionDate: { gte: thirtyDaysAgo } },
      _sum: { priceAed: true },
    }),
    prisma.listing.count(),
  ])
  
  console.log(`📈 Market: ${txCount} transactions, ${listingCount} listings, avg PSF: ${Math.round(avgPsf._avg.pricePerSqft ?? 0)}`)
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 Starting PropertyFinder scraper...')
  console.log(`   Areas: ${DUBAI_AREAS.length} Dubai + ${ABU_DHABI_AREAS.length} Abu Dhabi`)
  
  let totalListings = 0
  
  // Scrape Dubai areas
  console.log('\n📍 Scraping Dubai...')
  for (const area of DUBAI_AREAS) {
    process.stdout.write(`  ${area.name}... `)
    const count = await scrapeArea(area, 'dubai')
    console.log(`${count} listings`)
    totalListings += count
    await sleep(2000)
  }
  
  // Scrape Abu Dhabi areas
  console.log('\n📍 Scraping Abu Dhabi...')
  for (const area of ABU_DHABI_AREAS) {
    process.stdout.write(`  ${area.name}... `)
    const count = await scrapeArea(area, 'abu_dhabi')
    console.log(`${count} listings`)
    totalListings += count
    await sleep(2000)
  }
  
  // Cleanup old listings
  console.log('\n🧹 Cleaning up old listings...')
  await cleanupOldListings()
  
  // Update community stats
  console.log('\n📊 Updating community stats...')
  await updateCommunityStats()
  
  // Update market summary
  console.log('\n📈 Updating market summary...')
  await updateMarketSummary()
  
  console.log(`\n✅ Done! Total listings saved/updated: ${totalListings}`)
  
  const finalCount = await prisma.listing.count()
  console.log(`   Total listings in DB: ${finalCount}`)
  
  await prisma.$disconnect()
}

main().catch(console.error)
