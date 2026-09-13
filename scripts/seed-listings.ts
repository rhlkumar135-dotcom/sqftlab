/**
 * Seed realistic listings with images and source URLs.
 * Uses placeholder images from picsum.photos + realistic property data.
 * The live PropertyFinder scraper will replace these with real data over time.
 */
import { PrismaClient } from '../src/generated/prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'

const adapter = new PrismaLibSql({ url: 'file:./prisma/dev.db' })
const prisma = new PrismaClient({ adapter })

const PROPERTY_IMAGES: Record<string, string[]> = {
  apartment: [
    'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1493809842364-78817add7ffb?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1512917774080-9991f1c4c750?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1484154218962-a197022b5858?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1567767292278-a4f21aa2d36e?w=600&h=400&fit=crop',
  ],
  villa: [
    'https://images.unsplash.com/photo-1613490493576-7fde63acd811?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1605276374104-dee2a0ed3cd6?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1583608205776-bfd35f0d9f83?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1564013799919-ab600027ffc6?w=600&h=400&fit=crop',
  ],
  townhouse: [
    'https://images.unsplash.com/photo-1600047509807-ba8f99d2cdde?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1600566753376-12c8ab7c15b2?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1600573472592-401b489a3cdc?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1580587771525-78b9dba3b914?w=600&h=400&fit=crop',
  ],
  commercial: [
    'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1497366216548-37526070297c?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1497366811353-6870744d04b2?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1554469384-e58fac16e23a?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1464938050520-ef2571f65114?w=600&h=400&fit=crop',
  ],
}

const SOURCES = [
  { name: 'propertyfinder', baseUrl: 'https://www.propertyfinder.ae/en/rent/apartments-for-rent-in-' },
  { name: 'bayut', baseUrl: 'https://www.bayut.com/for-rent/apartments/dubai/' },
  { name: 'dubizzle', baseUrl: 'https://www.dubizzle.com/en/properties/apartments-for-rent/' },
]

const AGENTS = [
  { name: 'Sarah Mitchell', agency: 'Allsopp & Allsopp' },
  { name: 'Ahmed Al-Rashid', agency: 'Betterhomes' },
  { name: 'Priya Sharma', agency: 'Crompton Partners' },
  { name: 'James Wilson', agency: 'Hamptons International' },
  { name: 'Fatima Al-Mansoori', agency: 'Damac Properties' },
  { name: 'Raj Patel', agency: 'Asteco' },
  { name: 'Maria Santos', agency: 'Knight Frank' },
  { name: 'Omar Hassan', agency: 'Espace Real Estate' },
  { name: 'Emily Chen', agency: 'DTZ' },
  { name: 'Mohammed Al-Ketbi', agency: 'Drake & Scull' },
]

function randomFrom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

async function main() {
  console.log('🏠 Seeding listings with images and source URLs...\n')

  const communities = await prisma.community.findMany()
  console.log(`Found ${communities.length} communities`)

  // Clear old seed listings
  const deleted = await prisma.listing.deleteMany({})
  console.log(`Cleared ${deleted.count} old listings\n`)

  let totalCreated = 0

  for (const community of communities) {
    const numListings = randomBetween(8, 25)
    const listings = []

    for (let i = 0; i < numListings; i++) {
      const propertyTypes = ['apartment', 'apartment', 'apartment', 'villa', 'townhouse', 'commercial']
      const propertyType = randomFrom(propertyTypes)
      const beds = propertyType === 'commercial' ? randomFrom([1, 2, 3]) : randomFrom([0, 1, 1, 2, 2, 3, 3, 4])
      const purpose = randomFrom(['sale', 'sale', 'sale', 'rent'])
      const source = randomFrom(SOURCES)
      const agent = randomFrom(AGENTS)
      const images = PROPERTY_IMAGES[propertyType] || PROPERTY_IMAGES.apartment
      const imageUrl = randomFrom(images)

      // Generate realistic pricing based on community median
      const basePsf = community.medianAedSqft || 1200
      const variance = 0.7 + Math.random() * 0.6
      const pricePerSqft = Math.round(basePsf * variance)
      const areaSqft = propertyType === 'villa' ? randomBetween(2500, 8000) :
                       propertyType === 'townhouse' ? randomBetween(1800, 4000) :
                       propertyType === 'commercial' ? randomBetween(800, 5000) :
                       beds === 0 ? randomBetween(400, 700) :
                       beds === 1 ? randomBetween(600, 1100) :
                       beds === 2 ? randomBetween(900, 1800) :
                       beds === 3 ? randomBetween(1400, 2800) :
                       randomBetween(2000, 5000)

      const priceAed = purpose === 'sale'
        ? pricePerSqft * areaSqft
        : Math.round(pricePerSqft * areaSqft * 0.06 + randomBetween(5000, 50000))

      const furnishing = randomFrom(['unfurnished', 'unfurnished', 'furnished', 'partly'])
      const completion = randomFrom(['ready', 'ready', 'ready', 'off_plan'])

      // Build source URL
      const slug = community.slug
      const sourceUrl = source.name === 'propertyfinder'
        ? `https://www.propertyfinder.ae/en/properties-for-sale-in-${slug}.html`
        : source.name === 'bayut'
        ? `https://www.bayut.com/for-sale/properties/dubai/${slug}/`
        : `https://www.dubizzle.com/en/properties/apartments-for-rent-in-${slug}/`

      const externalId = `${source.name}-${slug}-${i}-${Date.now()}`

      listings.push({
        externalId,
        source: source.name,
        communityId: community.id,
        purpose,
        propertyType,
        beds,
        baths: Math.max(1, beds),
        areaSqft,
        priceAed: Math.round(priceAed),
        pricePerSqft,
        furnished: furnishing,
        completion,
        agentName: agent.name,
        agencyName: agent.agency,
        title: `${beds === 0 ? 'Studio' : beds + 'BR'} ${propertyType.charAt(0).toUpperCase() + propertyType.slice(1)} in ${community.nameEn}`,
        imageUrl,
        sourceUrl,
        latitude: community.latitude + (Math.random() - 0.5) * 0.02,
        longitude: community.longitude + (Math.random() - 0.5) * 0.02,
        listedAt: new Date(Date.now() - randomBetween(0, 30) * 86400000),
        isDeal: pricePerSqft < community.medianAedSqft * 0.85,
      })
    }

    // Batch create for this community
    if (listings.length > 0) {
      await prisma.listing.createMany({ data: listings })
      totalCreated += listings.length
    }
  }

  console.log(`✅ Created ${totalCreated} listings with images and source URLs`)

  // Verify
  const withImages = await prisma.listing.count({ where: { imageUrl: { not: null } } })
  const withSourceUrl = await prisma.listing.count({ where: { sourceUrl: { not: null } } })
  const total = await prisma.listing.count()
  const bySource = await prisma.listing.groupBy({ by: ['source'], _count: true })
  const byPurpose = await prisma.listing.groupBy({ by: ['purpose'], _count: true })

  console.log(`\n📊 Stats:`)
  console.log(`  Total: ${total}`)
  console.log(`  With images: ${withImages}`)
  console.log(`  With source URLs: ${withSourceUrl}`)
  console.log(`  By source: ${bySource.map(r => `${r.source}: ${r._count}`).join(', ')}`)
  console.log(`  By purpose: ${byPurpose.map(r => `${r.purpose}: ${r._count}`).join(', ')}`)

  // Update community stats from new listings
  console.log('\n🔄 Updating community stats...')
  for (const comm of communities) {
    const [avgPsf, avgRent, dealCount] = await Promise.all([
      prisma.listing.aggregate({
        where: { communityId: comm.id, purpose: 'sale', pricePerSqft: { gt: 0 } },
        _avg: { pricePerSqft: true },
      }),
      prisma.listing.aggregate({
        where: { communityId: comm.id, purpose: 'rent', priceAed: { gt: 0 } },
        _avg: { priceAed: true },
      }),
      prisma.listing.count({ where: { communityId: comm.id, isDeal: true } }),
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
      },
    })
  }

  console.log('✅ Community stats updated')
  console.log('\n🎉 Done!')
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
