import './_env-guard'
import { prisma } from '../src/lib/db'

const row = await prisma.portfolio.findFirst({
  select: {
    id: true, buildingName: true, floor: true, unitNumber: true,
    valuedAt: true, valuationSource: true, valuationComps: true,
  },
})
console.log('  new columns readable:', row ? 'yes' : 'no rows, but query compiled → columns exist')
console.log('  sample:', JSON.stringify(row))
