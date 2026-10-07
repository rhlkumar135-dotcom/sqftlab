// One-shot helper: put the demo account back to "has not taken the tour" so the
// onboarding banner can be exercised end to end. Not part of the shipped app.
import { prisma } from '../src/lib/db'

const users = await prisma.user.findMany({ select: { id: true, email: true } })
for (const u of users) {
  await prisma.user.update({
    where: { id: u.id },
    data: { tourCompleted: false, tourSteps: 0 },
  })
}
const after = await prisma.user.findMany({
  select: { email: true, tourCompleted: true, tourSteps: true },
})
console.log(JSON.stringify(after, null, 1))
await prisma.$disconnect()
