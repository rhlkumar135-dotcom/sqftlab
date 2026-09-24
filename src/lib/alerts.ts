// TASK 12 — Deal Alert Engine
//
// A "deal" is a listing priced more than 15% below its district's current
// average price per sqft (Community.medianAedSqft). This module is shared by
// the scraper worker path and the /api/sqftlab/alerts routes so the threshold
// is defined in exactly one place.
import { prisma } from './db'

/** Listings must be at least this far below the district average to qualify. */
export const DEAL_DISCOUNT_THRESHOLD = 0.15

/** pricePerSqft below which a listing counts as a deal. */
export function dealThresholdPsf(districtAvgPsf: number): number {
  return districtAvgPsf * (1 - DEAL_DISCOUNT_THRESHOLD)
}

/** How far below the district average a listing sits, as a positive percentage. */
export function psfDiscountPct(districtAvgPsf: number, listingPsf: number): number {
  if (!districtAvgPsf || districtAvgPsf <= 0) return 0
  return ((districtAvgPsf - listingPsf) / districtAvgPsf) * 100
}

export type ScanMatch = {
  alertId: string
  listingId: string
  psfDiscount: number
  district: string
  title: string | null
}

export type ScanResult = {
  alertsScanned: number
  listingsEvaluated: number
  matchesCreated: number
  alreadyMatched: number
  created: ScanMatch[]
}

/**
 * Walk every active DealAlert, find listings in that district priced below the
 * deal threshold, and record an AlertMatch for each new pairing.
 *
 * Idempotent: the (alertId, listingId) unique constraint means re-running the
 * scan never duplicates a match.
 */
export async function scanDealAlerts(): Promise<ScanResult> {
  const alerts = await prisma.dealAlert.findMany({
    where: { active: true },
    include: { user: { select: { id: true, email: true } } },
  })

  let listingsEvaluated = 0
  let matchesCreated = 0
  let alreadyMatched = 0
  const created: ScanMatch[] = []

  for (const alert of alerts) {
    const community = await prisma.community.findUnique({ where: { slug: alert.district } })
    if (!community || !community.medianAedSqft) continue

    const where: Record<string, unknown> = {
      purpose: 'sale',
      communityId: community.id,
      pricePerSqft: { lt: dealThresholdPsf(community.medianAedSqft), gt: 0 },
    }
    if (alert.propertyType) where.propertyType = alert.propertyType
    if (alert.maxPrice) where.priceAed = { lte: alert.maxPrice }
    if (alert.minBeds != null) where.beds = { gte: alert.minBeds }

    const listings = await prisma.listing.findMany({ where, take: 500 })
    listingsEvaluated += listings.length

    for (const listing of listings) {
      const existing = await prisma.alertMatch.findUnique({
        where: { alertId_listingId: { alertId: alert.id, listingId: listing.id } },
      })
      if (existing) {
        alreadyMatched += 1
        continue
      }

      const psfDiscount = psfDiscountPct(community.medianAedSqft, listing.pricePerSqft)
      await prisma.alertMatch.create({
        data: { alertId: alert.id, listingId: listing.id, psfDiscount },
      })
      matchesCreated += 1
      created.push({
        alertId: alert.id,
        listingId: listing.id,
        psfDiscount,
        district: alert.district,
        title: listing.title,
      })
    }
  }

  return { alertsScanned: alerts.length, listingsEvaluated, matchesCreated, alreadyMatched, created }
}

export type NotifyResult = {
  pending: number
  sent: number
  transport: 'email' | 'unconfigured'
  reason?: string
}

/**
 * Email unseen AlertMatches and mark them notified.
 *
 * If no mail transport is configured this reports `unconfigured` and sends
 * nothing — it must never mark a match notified that was not actually delivered,
 * or the alert is lost silently.
 */
export async function notifyPendingMatches(limit = 50): Promise<NotifyResult> {
  const pending = await prisma.alertMatch.findMany({
    where: { notified: false },
    include: {
      alert: { include: { user: { select: { email: true } } } },
      listing: { include: { community: { select: { nameEn: true } } } },
    },
    orderBy: { detectedAt: 'desc' },
    take: limit,
  })

  if (pending.length === 0) {
    return { pending: 0, sent: 0, transport: 'email' }
  }

  type EmailSender = { send: (opts: { to: string; subject: string; html: string }) => Promise<unknown> }
  let email: EmailSender | null = null
  try {
    const mod = await import('@shogo-ai/sdk/email/server')
    email = (mod.createEmailOptional?.() as EmailSender | null) ?? null
  } catch {
    email = null
  }

  if (!email) {
    return {
      pending: pending.length,
      sent: 0,
      transport: 'unconfigured',
      reason: 'No mail transport configured — set SMTP_* or AWS_* env vars to deliver alerts.',
    }
  }

  let sent = 0
  for (const match of pending) {
    const to = match.alert.user?.email
    if (!to) continue
    const district = match.listing.community?.nameEn ?? match.alert.district
    const price = Math.round(match.listing.priceAed).toLocaleString('en-US')
    const psf = Math.round(match.listing.pricePerSqft).toLocaleString('en-US')

    try {
      await email.send({
        to,
        subject: `${match.psfDiscount.toFixed(1)}% below market — ${district}`,
        html: `
          <h2>Deal alert: ${district}</h2>
          <p><strong>${match.listing.title ?? 'Listing'}</strong></p>
          <p>AED ${price} &middot; AED ${psf}/sqft</p>
          <p><strong>${match.psfDiscount.toFixed(1)}%</strong> below the ${district} median.</p>
          ${match.listing.sourceUrl ? `<p><a href="${match.listing.sourceUrl}">View listing</a></p>` : ''}
        `,
      })
      await prisma.alertMatch.update({
        where: { id: match.id },
        data: { notified: true, notifiedAt: new Date() },
      })
      sent += 1
    } catch (e) {
      console.error(`[sqftLab] deal alert email failed for ${match.id}:`, e)
    }
  }

  return { pending: pending.length, sent, transport: 'email' }
}

/** Recent matches for a user, newest first, with listing + district detail. */
export async function recentMatches(userId: string, limit = 24) {
  return prisma.alertMatch.findMany({
    where: { alert: { userId } },
    include: {
      alert: { select: { id: true, district: true, propertyType: true, maxPrice: true, minBeds: true } },
      listing: {
        include: { community: { select: { nameEn: true, slug: true, medianAedSqft: true } } },
      },
    },
    orderBy: { detectedAt: 'desc' },
    take: limit,
  })
}
