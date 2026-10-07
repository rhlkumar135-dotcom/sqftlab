import './_env-guard'
import { prisma } from '../src/lib/db'

const rows = await prisma.portfolio.findMany({
  select: {
    id: true,
    title: true,
    purchasePrice: true,
    currentValue: true,
    purchaseDate: true,
    updatedAt: true,
    community: { select: { nameEn: true, slug: true } },
  },
  orderBy: { purchaseDate: 'desc' },
})

let purchase = 0
let current = 0
for (const r of rows) {
  purchase += r.purchasePrice
  current += r.currentValue
  console.log(
    `  ${r.title.padEnd(22)} ${r.community.slug.padEnd(18)} buy ${Math.round(r.purchasePrice).toLocaleString('en-US').padStart(12)}  now ${Math.round(r.currentValue).toLocaleString('en-US').padStart(12)}  updated ${r.updatedAt.toISOString().slice(0, 10)}`,
  )
}
console.log(`\n  rows:            ${rows.length}`)
console.log(`  total purchase:  AED ${Math.round(purchase).toLocaleString('en-US')}`)
console.log(`  total current:   AED ${Math.round(current).toLocaleString('en-US')}`)
console.log(`  the AED 10,941,214 from the QA report? ${Math.round(current) === 10941214 ? 'YES — exact match' : `no (${Math.round(current).toLocaleString('en-US')})`}`)

const tx = await prisma.transaction.count()
console.log(`  transactions backing those "valuations": ${tx}`)
