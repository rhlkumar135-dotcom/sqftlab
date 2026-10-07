// Day 16 recon probe: what the Deal Origination Network will actually see.
// Read-only. Answers: is there any DLD transaction data, what tier does the
// demo account hold, and can a community name be resolved to an id.
import { prisma } from '../src/lib/db'

// Prisma 7 needs an adapter; reuse the app's client so this reads the same
// database the server does. Print the URL because a workspace-root .env has
// previously shadowed the project's and silently pointed at another file.
console.log('DATABASE_URL =', process.env.DATABASE_URL ?? '(unset)')

const txTotal = await prisma.transaction.count()
const txSales = await prisma.transaction.count({
  where: { transactionType: { in: ['sale', 'off_plan_sale'] } },
})
const communities = await prisma.community.count()
const communitiesWithPsf = await prisma.community.count({ where: { medianAedSqft: { gt: 100 } } })

const users = await prisma.user.findMany({
  select: { id: true, email: true, name: true, company: true, subscriptionTier: true },
  orderBy: { createdAt: 'asc' },
  take: 5,
})

// Does the free-text `community` a poster types resolve, given Transaction has no
// `area` column and we must key off communityId?
const probes = ['Dubai Marina', 'dubai-marina', 'downtown', 'Nowhere At All']
const resolved: Record<string, string | null> = {}
for (const p of probes) {
  const slug = p.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const bySlugOrName = await prisma.community.findFirst({
    where: { OR: [{ slug }, { nameEn: p }] },
    select: { id: true, nameEn: true },
  })
  // SQLite `contains` compiles to LIKE, which is ASCII case-insensitive by default.
  const byContains =
    bySlugOrName ??
    (await prisma.community.findFirst({ where: { nameEn: { contains: p } }, select: { id: true, nameEn: true } }))
  resolved[p] = byContains ? `${byContains.nameEn} (${byContains.id})` : null
}

const listingCount = await prisma.listing.count()
const saleListings = await prisma.listing.count({ where: { purpose: 'sale' } })

console.log(
  JSON.stringify(
    { txTotal, txSales, communities, communitiesWithPsf, listingCount, saleListings, users, resolved },
    null,
    2,
  ),
)

await prisma.$disconnect()
