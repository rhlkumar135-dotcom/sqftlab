import { prisma } from './db'
import { SALE_TXN_TYPES } from './deals'
import { buildDigest, sendWhatsapp, type DigestCommunity } from './whatsapp'

/**
 * WhatsApp daily digest sender (Day 14 Task C).
 *
 * Query shape: the brief runs two aggregates per tracked community inside a loop over
 * every subscriber, so a subscriber tracking 3 areas costs 6 round trips and N
 * subscribers cost 6N. This resolves every community once and then runs exactly TWO
 * grouped aggregates for the whole run, regardless of subscriber count.
 *
 * The other deliberate difference is when `whatsappLastSentAt` is stamped. The brief
 * updates it immediately after a `.catch(() => {})`ed send, so a digest that never
 * arrived is recorded as delivered and the next run believes the user was served. Here
 * the stamp only follows a confirmed send, and failures are counted and surfaced.
 */

export interface DigestRunResult {
  considered: number
  sent: number
  failed: number
  skipped: { disabled: number; interval: number; unconfigured: number }
  /** First failure message, so a run that sent nothing can say why. */
  errorMsg: string | null
  queries: number
}

const WEEKLY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

function resolveAreas(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export async function sendWhatsappDigests(now: Date = new Date()): Promise<DigestRunResult> {
  const result: DigestRunResult = {
    considered: 0,
    sent: 0,
    failed: 0,
    skipped: { disabled: 0, interval: 0, unconfigured: 0 },
    errorMsg: null,
    queries: 0,
  }

  const subs = await prisma.user.findMany({
    where: {
      whatsappEnabled: true,
      whatsappPhone: { not: null },
      digestFrequency: { in: ['daily', 'weekly'] },
    },
    select: {
      id: true,
      name: true,
      whatsappPhone: true,
      whatsappAreas: true,
      digestFrequency: true,
      whatsappLastSentAt: true,
    },
  })
  result.queries++

  result.considered = subs.length
  if (subs.length === 0) return result

  // Interval gating: `daily` means at most once per day, `weekly` at most once per week.
  // The brief only ever selects `frequency: 'daily'`, so a weekly subscriber is never
  // messaged at all — a subscription that silently delivers nothing.
  const due = subs.filter((s) => {
    if (s.digestFrequency === 'weekly') {
      const last = s.whatsappLastSentAt?.getTime() ?? 0
      if (Date.now() - last < WEEKLY_INTERVAL_MS) {
        result.skipped.interval++
        return false
      }
    } else if (s.whatsappLastSentAt) {
      const last = s.whatsappLastSentAt.getTime()
      if (now.getTime() - last < 24 * 60 * 60 * 1000) {
        result.skipped.interval++
        return false
      }
    }
    return true
  })

  if (due.length === 0) return result

  // Resolve every tracked slug once for the whole run.
  const allSlugs = [...new Set(due.flatMap((s) => resolveAreas(s.whatsappAreas)))]
  const communities = await prisma.community.findMany({
    where: { slug: { in: allSlugs } },
    select: { id: true, slug: true, nameEn: true },
  })
  result.queries++
  const bySlug = new Map(communities.map((c) => [c.slug, c]))

  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const since90 = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
  const ids = communities.map((c) => c.id)

  const baseWhere = {
    communityId: { in: ids },
    // Spread because SALE_TXN_TYPES is a readonly tuple, which `in` does not accept.
    transactionType: { in: [...SALE_TXN_TYPES] },
    pricePerSqft: { gt: 100 },
  }

  // Two grouped aggregates total — not two per community per subscriber.
  const [day, ninety] = await Promise.all([
    prisma.transaction.groupBy({
      by: ['communityId'],
      where: { ...baseWhere, transactionDate: { gte: since24h } },
      _avg: { pricePerSqft: true },
      _count: true,
    }),
    prisma.transaction.groupBy({
      by: ['communityId'],
      where: { ...baseWhere, transactionDate: { gte: since90 } },
      _avg: { pricePerSqft: true },
    }),
  ])
  result.queries += 2

  const dayBy = new Map(day.map((d) => [d.communityId, d]))
  const ninetyBy = new Map(ninety.map((d) => [d.communityId, d]))

  for (const sub of due) {
    if (!sub.whatsappPhone) continue

    const areas: DigestCommunity[] = resolveAreas(sub.whatsappAreas)
      .map((slug) => bySlug.get(slug))
      .filter((c): c is { id: string; slug: string; nameEn: string } => Boolean(c))
      .map((c) => {
        const d = dayBy.get(c.id)
        const n = ninetyBy.get(c.id)
        return {
          slug: c.slug,
          name: c.nameEn,
          transactionsYesterday: typeof d?._count === 'number' ? d._count : 0,
          psfYesterday: d?._avg?.pricePerSqft ?? 0,
          psf90d: n?._avg?.pricePerSqft ?? 0,
        }
      })

    const message = buildDigest(sub.name, areas, { now, windowDays: 1 })
    const sent = await sendWhatsapp(sub.whatsappPhone, message)

    if (sent.reason === 'unconfigured') {
      // Nothing was attempted. Do NOT stamp lastSentAt — recording a delivery that never
      // happened would hide the misconfiguration on every subsequent run.
      result.skipped.unconfigured++
      continue
    }

    if (!sent.ok) {
      result.failed++
      result.errorMsg ??= `${sub.whatsappPhone}: ${sent.error ?? `HTTP ${sent.status}`}`
      continue
    }

    // Confirmed delivered by the provider, so this is safe to record.
    await prisma.user.update({ where: { id: sub.id }, data: { whatsappLastSentAt: new Date() } })
    result.queries++
    result.sent++

    // Sequential with a pause: WhatsApp rate-limits per sender, and the brief's 500ms is
    // the documented courtesy interval.
    await new Promise((r) => setTimeout(r, 500))
  }

  return result
}
