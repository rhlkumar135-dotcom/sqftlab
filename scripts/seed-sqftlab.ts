import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient } from '../src/generated/prisma/client'

const adapter = new PrismaLibSql({ url: 'file:./prisma/dev.db' })
const prisma = new PrismaClient({ adapter })

const communities = [
  // Dubai Phase 1
  { slug: 'dubai-marina', nameEn: 'Dubai Marina', nameAr: 'دبي مارينا', emirate: 'dubai', lat: 25.0805, lng: 55.1389, median: 2100, rent: 120000, yield: 6.8, score: 82, s30d: 2.3, s1y: 18.5, t30: 342, total: 28400, schools: 7, health: 8, metro: 9, retail: 9, parks: 5, worship: 7 },
  { slug: 'downtown-dubai', nameEn: 'Downtown Dubai', nameAr: 'وسط مدينة دبي', emirate: 'dubai', lat: 25.1972, lng: 55.2744, median: 2800, rent: 150000, yield: 5.2, score: 88, s30d: 1.8, s1y: 22.1, t30: 287, total: 31200, schools: 8, health: 9, metro: 8, retail: 10, parks: 6, worship: 7 },
  { slug: 'jbr', nameEn: 'Jumeirah Beach Residence', nameAr: 'جميرا بيتش ريزيدنس', emirate: 'dubai', lat: 25.0826, lng: 55.1307, median: 1950, rent: 110000, yield: 6.5, score: 80, s30d: 1.5, s1y: 16.2, t30: 198, total: 19800, schools: 6, health: 7, metro: 8, retail: 9, parks: 6, worship: 6 },
  { slug: 'business-bay', nameEn: 'Business Bay', nameAr: 'بيزنس باي', emirate: 'dubai', lat: 25.1857, lng: 55.2642, median: 1800, rent: 95000, yield: 6.1, score: 76, s30d: 3.1, s1y: 20.8, t30: 256, total: 22100, schools: 6, health: 7, metro: 9, retail: 8, parks: 4, worship: 7 },
  { slug: 'difc', nameEn: 'DIFC', nameAr: 'مركز دبي المالي', emirate: 'dubai', lat: 25.2130, lng: 55.2798, median: 3200, rent: 180000, yield: 5.0, score: 85, s30d: 0.9, s1y: 15.4, t30: 89, total: 8900, schools: 5, health: 8, metro: 7, retail: 9, parks: 4, worship: 6 },
  { slug: 'palm-jumeirah', nameEn: 'Palm Jumeirah', nameAr: 'نخلة جميرا', emirate: 'dubai', lat: 25.1120, lng: 55.1380, median: 3500, rent: 200000, yield: 4.8, score: 83, s30d: 2.7, s1y: 25.3, t30: 167, total: 15600, schools: 4, health: 6, metro: 3, retail: 8, parks: 7, worship: 5 },
  { slug: 'jlt', nameEn: 'Jumeirah Lake Towers', nameAr: 'أبراج بحيرات جميرا', emirate: 'dubai', lat: 25.0778, lng: 55.1410, median: 1650, rent: 85000, yield: 6.0, score: 74, s30d: 1.2, s1y: 14.8, t30: 213, total: 21300, schools: 6, health: 7, metro: 8, retail: 8, parks: 4, worship: 7 },
  { slug: 'al-barsha', nameEn: 'Al Barsha', nameAr: 'البرشاء', emirate: 'dubai', lat: 25.1130, lng: 55.2000, median: 1400, rent: 72000, yield: 6.1, score: 78, s30d: 0.8, s1y: 11.2, t30: 178, total: 17800, schools: 8, health: 7, metro: 7, retail: 9, parks: 6, worship: 8 },
  { slug: 'dubai-hills-estate', nameEn: 'Dubai Hills Estate', nameAr: ' دبي هيلز إستيت', emirate: 'dubai', lat: 25.1300, lng: 55.2350, median: 1900, rent: 100000, yield: 5.9, score: 86, s30d: 4.2, s1y: 28.5, t30: 312, total: 18900, schools: 9, health: 7, metro: 4, retail: 8, parks: 9, worship: 7 },
  { slug: 'meydan', nameEn: 'Meydan', nameAr: 'ميدان', emirate: 'dubai', lat: 25.1650, lng: 55.3100, median: 1700, rent: 85000, yield: 5.8, score: 72, s30d: 5.1, s1y: 32.1, t30: 198, total: 12400, schools: 7, health: 5, metro: 3, retail: 6, parks: 8, worship: 6 },
  { slug: 'arabian-ranches', nameEn: 'Arabian Ranches', nameAr: 'الصواريخ', emirate: 'dubai', lat: 25.0580, lng: 55.2860, median: 1200, rent: 95000, yield: 7.2, score: 84, s30d: 1.4, s1y: 12.8, t30: 156, total: 15600, schools: 9, health: 6, metro: 2, retail: 7, parks: 9, worship: 8 },
  { slug: 'dubai-silicon-oasis', nameEn: 'Dubai Silicon Oasis', nameAr: 'واحة دبي السيليكونية', emirate: 'dubai', lat: 25.1150, lng: 55.3850, median: 950, rent: 55000, yield: 6.8, score: 68, s30d: 0.5, s1y: 8.9, t30: 134, total: 13400, schools: 7, health: 5, metro: 2, retail: 6, parks: 6, worship: 7 },
  { slug: 'jvc', nameEn: 'Jumeirah Village Circle', nameAr: 'قرية جميرا الدائرية', emirate: 'dubai', lat: 25.0630, lng: 55.2270, median: 1300, rent: 68000, yield: 6.2, score: 70, s30d: 3.8, s1y: 24.6, t30: 289, total: 24500, schools: 6, health: 5, metro: 4, retail: 7, parks: 5, worship: 7 },
  { slug: 'al-furjan', nameEn: 'Al Furjan', nameAr: 'الفرجان', emirate: 'dubai', lat: 25.0480, lng: 55.1200, median: 1500, rent: 80000, yield: 6.0, score: 73, s30d: 2.9, s1y: 19.7, t30: 167, total: 11200, schools: 6, health: 5, metro: 6, retail: 6, parks: 6, worship: 6 },
  { slug: 'dubai-sports-city', nameEn: 'Dubai Sports City', nameAr: 'مدينة دبي الرياضية', emirate: 'dubai', lat: 25.0380, lng: 55.2250, median: 1100, rent: 58000, yield: 6.2, score: 66, s30d: 0.7, s1y: 9.5, t30: 145, total: 14500, schools: 5, health: 5, metro: 3, retail: 6, parks: 7, worship: 6 },
  { slug: 'international-city', nameEn: 'International City', nameAr: 'المدينة الدولية', emirate: 'dubai', lat: 25.1640, lng: 55.4100, median: 750, rent: 42000, yield: 6.7, score: 58, s30d: -0.3, s1y: 5.2, t30: 223, total: 22300, schools: 6, health: 4, metro: 3, retail: 7, parks: 4, worship: 8 },
  { slug: 'deira', nameEn: 'Deira', nameAr: 'ديرة', emirate: 'dubai', lat: 25.2680, lng: 55.3100, median: 1050, rent: 58000, yield: 6.5, score: 64, s30d: 0.4, s1y: 7.8, t30: 189, total: 26700, schools: 5, health: 6, metro: 8, retail: 8, parks: 3, worship: 9 },
  { slug: 'bur-dubai', nameEn: 'Bur Dubai', nameAr: 'بر دبي', emirate: 'dubai', lat: 25.2580, lng: 55.2960, median: 1150, rent: 62000, yield: 6.4, score: 66, s30d: 0.6, s1y: 8.4, t30: 167, total: 21800, schools: 5, health: 7, metro: 8, retail: 7, parks: 3, worship: 9 },
  { slug: 'discovery-gardens', nameEn: 'Discovery Gardens', nameAr: 'حدائق ديسكفري', emirate: 'dubai', lat: 25.0840, lng: 55.1530, median: 1200, rent: 65000, yield: 6.3, score: 71, s30d: 0.9, s1y: 10.3, t30: 134, total: 13400, schools: 5, health: 5, metro: 6, retail: 6, parks: 7, worship: 6 },
  { slug: 'the-springs', nameEn: 'The Springs', nameAr: 'الينابيع', emirate: 'dubai', lat: 25.0950, lng: 55.1600, median: 1350, rent: 85000, yield: 7.1, score: 81, s30d: 0.3, s1y: 8.1, t30: 98, total: 9800, schools: 7, health: 6, metro: 5, retail: 6, parks: 9, worship: 7 },
  { slug: 'the-greens', nameEn: 'The Greens', nameAr: 'الغابات', emirate: 'dubai', lat: 25.1010, lng: 55.1550, median: 1500, rent: 90000, yield: 6.8, score: 82, s30d: 1.1, s1y: 12.5, t30: 112, total: 11200, schools: 7, health: 6, metro: 6, retail: 7, parks: 9, worship: 7 },
  { slug: 'the-views', nameEn: 'The Views', nameAr: 'المناظر', emirate: 'dubai', lat: 25.0980, lng: 55.1480, median: 1450, rent: 82000, yield: 6.6, score: 79, s30d: 0.7, s1y: 11.8, t30: 87, total: 8700, schools: 6, health: 6, metro: 5, retail: 6, parks: 8, worship: 6 },
  { slug: 'jumeirah', nameEn: 'Jumeirah', nameAr: 'جميرا', emirate: 'dubai', lat: 25.2340, lng: 55.2480, median: 2400, rent: 160000, yield: 5.5, score: 87, s30d: 1.6, s1y: 14.2, t30: 123, total: 12300, schools: 8, health: 8, metro: 4, retail: 7, parks: 8, worship: 7 },
  { slug: 'umm-suqeim', nameEn: 'Umm Suqeim', nameAr: 'أم سقيم', emirate: 'dubai', lat: 25.2250, lng: 55.2350, median: 2100, rent: 140000, yield: 5.8, score: 84, s30d: 1.3, s1y: 13.5, t30: 89, total: 8900, schools: 7, health: 7, metro: 3, retail: 6, parks: 8, worship: 7 },
  { slug: 'motor-city', nameEn: 'Motor City', nameAr: 'المدينةmotor', emirate: 'dubai', lat: 25.0460, lng: 55.2450, median: 1150, rent: 62000, yield: 6.3, score: 72, s30d: 1.0, s1y: 10.8, t30: 134, total: 13400, schools: 6, health: 5, metro: 2, retail: 6, parks: 7, worship: 6 },
  { slug: 'town-square', nameEn: 'Town Square', nameAr: 'تاون سكوير', emirate: 'dubai', lat: 25.0700, lng: 55.2700, median: 1050, rent: 52000, yield: 5.8, score: 65, s30d: 2.4, s1y: 18.3, t30: 234, total: 15600, schools: 5, health: 4, metro: 2, retail: 6, parks: 6, worship: 6 },
  { slug: 'dubailand', nameEn: 'Dubailand', nameAr: 'دبي لاند', emirate: 'dubai', lat: 25.1100, lng: 55.3500, median: 1000, rent: 48000, yield: 5.6, score: 60, s30d: 1.8, s1y: 15.2, t30: 178, total: 17800, schools: 5, health: 4, metro: 2, retail: 5, parks: 5, worship: 6 },
  { slug: 'dubai-investment-park', nameEn: 'Dubai Investment Park', nameAr: 'حديقة دبي الاستثمارية', emirate: 'dubai', lat: 24.9900, lng: 55.1400, median: 900, rent: 48000, yield: 6.3, score: 59, s30d: 0.2, s1y: 6.8, t30: 112, total: 11200, schools: 5, health: 4, metro: 2, retail: 5, parks: 5, worship: 6 },
  { slug: 'culture-village', nameEn: 'Culture Village', nameAr: 'قرية الثقافة', emirate: 'dubai', lat: 25.2620, lng: 55.3250, median: 1600, rent: 88000, yield: 6.4, score: 71, s30d: 1.5, s1y: 13.2, t30: 78, total: 7800, schools: 5, health: 6, metro: 6, retail: 6, parks: 5, worship: 7 },
  // Abu Dhabi Phase 1
  { slug: 'al-reem-island', nameEn: 'Al Reem Island', nameAr: 'جزيرة 알 ريم', emirate: 'abu_dhabi', lat: 24.4880, lng: 54.3530, median: 1600, rent: 88000, yield: 6.4, score: 80, s30d: 1.9, s1y: 16.8, t30: 234, total: 19800, schools: 7, health: 8, metro: 5, retail: 8, parks: 6, worship: 7 },
  { slug: 'saadiyat-island', nameEn: 'Saadiyat Island', nameAr: 'جزيرة السReadOnly', emirate: 'abu_dhabi', lat: 24.5560, lng: 54.4340, median: 2200, rent: 130000, yield: 5.8, score: 86, s30d: 2.1, s1y: 19.4, t30: 123, total: 10200, schools: 8, health: 7, metro: 3, retail: 7, parks: 9, worship: 6 },
  { slug: 'yas-island', nameEn: 'Yas Island', nameAr: 'جزيرة ياس', emirate: 'abu_dhabi', lat: 24.4900, lng: 54.5990, median: 1400, rent: 78000, yield: 6.5, score: 78, s30d: 2.5, s1y: 21.2, t30: 189, total: 14500, schools: 6, health: 6, metro: 3, retail: 8, parks: 8, worship: 6 },
  { slug: 'al-raha-beach', nameEn: 'Al Raha Beach', nameAr: 'شاطئ الراحة', emirate: 'abu_dhabi', lat: 24.4600, lng: 54.6100, median: 1700, rent: 95000, yield: 6.3, score: 79, s30d: 1.4, s1y: 14.6, t30: 156, total: 12800, schools: 6, health: 6, metro: 3, retail: 7, parks: 7, worship: 6 },
  { slug: 'al-khalidiyah', nameEn: 'Al Khalidiyah', nameAr: 'الخالدية', emirate: 'abu_dhabi', lat: 24.4670, lng: 54.3460, median: 1300, rent: 72000, yield: 6.5, score: 75, s30d: 0.8, s1y: 9.8, t30: 134, total: 16700, schools: 7, health: 8, metro: 5, retail: 7, parks: 5, worship: 8 },
  { slug: 'corniche-area', nameEn: 'Corniche Area', nameAr: 'منطقة الكورنيش', emirate: 'abu_dhabi', lat: 24.4530, lng: 54.3330, median: 1800, rent: 105000, yield: 5.8, score: 83, s30d: 1.1, s1y: 12.4, t30: 112, total: 14200, schools: 6, health: 8, metro: 5, retail: 8, parks: 7, worship: 7 },
  { slug: 'al-mushrif', nameEn: 'Al Mushrif', nameAr: 'المشرف', emirate: 'abu_dhabi', lat: 24.4400, lng: 54.3700, median: 1500, rent: 85000, yield: 6.3, score: 77, s30d: 0.6, s1y: 8.9, t30: 98, total: 11200, schools: 8, health: 7, metro: 4, retail: 6, parks: 7, worship: 8 },
  { slug: 'khalifa-city', nameEn: 'Khalifa City', nameAr: 'مدينة خليفة', emirate: 'abu_dhabi', lat: 24.4200, lng: 54.6100, median: 1100, rent: 65000, yield: 6.8, score: 72, s30d: 1.3, s1y: 11.5, t30: 167, total: 13400, schools: 7, health: 5, metro: 2, retail: 6, parks: 7, worship: 7 },
  { slug: 'al-shamkha', nameEn: 'Al Shamkha', nameAr: 'الشمخة', emirate: 'abu_dhabi', lat: 24.3800, lng: 54.7200, median: 850, rent: 48000, yield: 6.6, score: 55, s30d: 0.4, s1y: 6.2, t30: 89, total: 7800, schools: 4, health: 3, metro: 1, retail: 4, parks: 4, worship: 6 },
  { slug: 'masdar-city', nameEn: 'Masdar City', nameAr: 'مدينة مصدر', emirate: 'abu_dhabi', lat: 24.4340, lng: 54.6180, median: 1350, rent: 75000, yield: 6.4, score: 76, s30d: 1.7, s1y: 13.8, t30: 112, total: 8900, schools: 5, health: 5, metro: 4, retail: 5, parks: 7, worship: 6 },
]

async function main() {
  console.log('Seeding sqftLab database...')

  // Create demo user
  const user = await prisma.user.upsert({
    where: { email: 'demo@sqftlab.com' },
    update: {},
    create: {
      email: 'demo@sqftlab.com',
      name: 'Demo Investor',
      phone: '+971501234567',
      nationality: 'Indian',
      tier: 'elite',
    },
  })
  console.log(`User: ${user.id}`)

  // Create communities
  const communityRecords: Record<string, { id: string; medianAedSqft: number }> = {}
  for (const c of communities) {
    const rec = await prisma.community.upsert({
      where: { slug: c.slug },
      update: {
        medianAedSqft: c.median,
        medianAnnualRentAed: c.rent,
        grossYieldPct: c.yield,
        neighbourhoodScore: c.score,
        priceChange30d: c.s30d,
        priceChange1y: c.s1y,
        transactionCount30d: c.t30,
        totalTransactions: c.total,
        scoreSchools: c.schools,
        scoreHealthcare: c.health,
        scoreMetro: c.metro,
        scoreRetail: c.retail,
        scoreParks: c.parks,
        scoreWorship: c.worship,
      },
      create: {
        slug: c.slug,
        nameEn: c.nameEn,
        nameAr: c.nameAr,
        emirate: c.emirate,
        latitude: c.lat,
        longitude: c.lng,
        medianAedSqft: c.median,
        medianAnnualRentAed: c.rent,
        grossYieldPct: c.yield,
        neighbourhoodScore: c.score,
        priceChange30d: c.s30d,
        priceChange1y: c.s1y,
        transactionCount30d: c.t30,
        totalTransactions: c.total,
        scoreSchools: c.schools,
        scoreHealthcare: c.health,
        scoreMetro: c.metro,
        scoreRetail: c.retail,
        scoreParks: c.parks,
        scoreWorship: c.worship,
      },
    })
    communityRecords[c.slug] = { id: rec.id, medianAedSqft: c.median }
  }
  console.log(`Communities: ${communities.length}`)

  // Seed transactions for each community
  const propertyTypes = ['apartment', 'villa', 'townhouse', 'commercial']
  const bedOptions = [0, 1, 2, 3, 4, 5]
  let txCount = 0

  for (const c of communities) {
    const cid = communityRecords[c.slug].id
    const txs = []
    for (let i = 0; i < 15; i++) {
      const pt = propertyTypes[Math.floor(Math.random() * (c.emirate === 'abu_dhabi' ? 3 : 4))]
      const beds = pt === 'villa' ? bedOptions[2 + Math.floor(Math.random() * 3)] : bedOptions[1 + Math.floor(Math.random() * 3)]
      const area = pt === 'villa' ? 2000 + Math.random() * 4000 : 400 + Math.random() * 2000
      const variation = 0.85 + Math.random() * 0.30
      const ppsf = Math.round(c.median * variation)
      const price = Math.round(ppsf * area)
      const daysAgo = Math.floor(Math.random() * 365)
      const txDate = new Date(Date.now() - daysAgo * 86400000)
      const dldId = `DLD-${c.slug.substring(0, 3).toUpperCase()}-${Date.now()}-${i}`

      txs.push({
        dldId,
        communityId: cid,
        transactionType: Math.random() > 0.15 ? 'sale' : 'off_plan_sale',
        propertyType: pt,
        beds,
        areaSqft: Math.round(area),
        priceAed: price,
        pricePerSqft: ppsf,
        transactionDate: txDate,
      })
    }
    await prisma.transaction.createMany({ data: txs,  })
    txCount += txs.length
  }
  console.log(`Transactions: ${txCount}`)

  // Seed listings for each community
  const sources = ['bayut', 'propertyfinder', 'dubizzle']
  const agents = ['John Smith', 'Sarah Ahmed', 'Mohammed Al-Rashid', 'Priya Patel', 'James Wilson', 'Fatima Hassan', 'Raj Kumar', 'Emily Chen', 'Ahmed Khan', 'Maria Santos']
  const agencies = ['Betterhomes', 'Allsopp & Allsopp', 'Crompton Partners', 'Devmark', 'Property Finder Realty', 'Bayut Direct', 'DXB Interiors', 'REGENT', 'Driven Properties', 'Acorn Real Estate']
  let listingCount = 0

  for (const c of communities) {
    const cid = communityRecords[c.slug].id
    const listings = []
    const numListings = 5 + Math.floor(Math.random() * 10)
    for (let i = 0; i < numListings; i++) {
      const isRent = Math.random() > 0.6
      const pt = propertyTypes[Math.floor(Math.random() * (c.emirate === 'abu_dhabi' ? 3 : 4))]
      const beds = pt === 'villa' ? bedOptions[2 + Math.floor(Math.random() * 3)] : bedOptions[1 + Math.floor(Math.random() * 3)]
      const area = pt === 'villa' ? 2200 + Math.random() * 3500 : 450 + Math.random() * 1800
      const variation = 0.88 + Math.random() * 0.24
      const ppsf = Math.round(c.median * variation)
      const salePrice = Math.round(ppsf * area)
      const rentPrice = isRent ? Math.round(c.rent / 12 * (0.8 + Math.random() * 0.4)) : salePrice
      const price = isRent ? rentPrice : salePrice
      const isDeal = ppsf < c.median * 0.9

      listings.push({
        externalId: `${sources[i % 3]}-${c.slug}-${i}`,
        source: sources[i % 3],
        communityId: cid,
        purpose: isRent ? 'rent' : 'sale',
        propertyType: pt,
        beds,
        baths: Math.max(1, beds),
        areaSqft: Math.round(area),
        priceAed: price,
        pricePerSqft: isRent ? Math.round(price * 12 / area) : ppsf,
        furnished: ['furnished', 'unfurnished', 'partly'][Math.floor(Math.random() * 3)],
        completion: Math.random() > 0.8 ? 'off_plan' : 'ready',
        agentName: agents[Math.floor(Math.random() * agents.length)],
        agencyName: agencies[Math.floor(Math.random() * agencies.length)],
        trakheesiPermit: `TRK-${100000 + Math.floor(Math.random() * 900000)}`,
        latitude: c.lat + (Math.random() - 0.5) * 0.02,
        longitude: c.lng + (Math.random() - 0.5) * 0.02,
        listedAt: new Date(Date.now() - Math.floor(Math.random() * 90) * 86400000),
        isDeal,
        title: `${beds}BR ${pt.charAt(0).toUpperCase() + pt.slice(1)} in ${c.nameEn}`,
      })
    }
    await prisma.listing.createMany({ data: listings,  })
    listingCount += listings.length
  }
  console.log(`Listings: ${listingCount}`)

  // Add watchlist entries for demo user
  const watchSlugs = ['dubai-marina', 'downtown-dubai', 'dubai-hills-estate', 'palm-jumeirah', 'business-bay', 'jvc', 'al-reem-island', 'yas-island']
  for (const slug of watchSlugs) {
    const cid = communityRecords[slug]?.id
    if (cid) {
      await prisma.watchlist.upsert({
        where: { userId_communityId: { userId: user.id, communityId: cid } },
        update: {},
        create: { userId: user.id, communityId: cid },
      })
    }
  }
  console.log('Watchlist entries created')

  // Add portfolio entries
  const portfolioItems = [
    { slug: 'dubai-marina', title: 'Marina Tower Apt 1204', type: 'apartment', beds: 2, area: 1250, price: 2450000, date: new Date('2022-03-15'), rent: 120000, sc: 15000, mortgage: 1200000, rate: 4.49, term: 25 },
    { slug: 'downtown-dubai', title: 'Buri Khalifa View Apt 801', type: 'apartment', beds: 1, area: 780, price: 2100000, date: new Date('2023-06-20'), rent: 110000, sc: 18000, mortgage: 0, rate: 0, term: 0 },
    { slug: 'dubai-hills-estate', title: 'Maple Villa 23', type: 'villa', beds: 4, area: 3200, price: 4800000, date: new Date('2024-01-10'), rent: 180000, sc: 12000, mortgage: 2400000, rate: 4.25, term: 20 },
  ]
  for (const p of portfolioItems) {
    const cid = communityRecords[p.slug]?.id
    if (cid) {
      const currentVal = p.price * (1 + Math.random() * 0.2)
      await prisma.portfolio.create({
        data: {
          userId: user.id,
          communityId: cid,
          title: p.title,
          propertyType: p.type,
          beds: p.beds,
          areaSqft: p.area,
          purchasePrice: p.price,
          purchaseDate: p.date,
          currentValue: Math.round(currentVal),
          annualRent: p.rent,
          serviceCharge: p.sc,
          mortgageBalance: p.mortgage,
          mortgageRate: p.rate,
          mortgageTerm: p.term,
        },
      })
    }
  }
  console.log('Portfolio entries created')

  // Add alerts
  const alertTypes = ['below_market', 'price_drop', 'new_listing', 'yield_target']
  for (let i = 0; i < 5; i++) {
    const slug = watchSlugs[i % watchSlugs.length]
    const cid = communityRecords[slug]?.id
    if (cid) {
      await prisma.alert.create({
        data: {
          userId: user.id,
          communityId: cid,
          alertType: alertTypes[i % alertTypes.length],
          thresholdPct: 10 + Math.random() * 15,
          yieldTargetPct: alertTypes[i % alertTypes.length] === 'yield_target' ? 6 + Math.random() * 2 : null,
          propertyType: propertyTypes[i % 3],
          beds: i + 1,
          notifyPush: true,
          notifyEmail: true,
          notifyWhatsapp: i > 2,
        },
      })
    }
  }
  console.log('Alerts created')

  console.log('Seeding complete!')
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
