import { prisma } from './db'
import { findCommunityByName, invalidateCommunityCache } from './community-match'

/**
 * Dubai Pulse (Dubai Land Department) transaction ingest — the real source.
 *
 * Everything the platform labels "DLD" must come from here. Until
 * DUBAI_PULSE_API_KEY is set, `dldConfigured()` is false and callers must report
 * the gap honestly rather than substituting generated numbers.
 *
 * Registration is free: https://dubaipulse.gov.ae → developer access.
 */

const DLD_BASE = process.env.DUBAI_PULSE_BASE ?? 'https://api.dubaipulse.gov.ae/open/dld'
const DLD_RESOURCE = process.env.DUBAI_PULSE_RESOURCE ?? 'dld_transactions-open-api'
const PAGE_SIZE = 500

export function dldConfigured(): boolean {
  return !!process.env.DUBAI_PULSE_API_KEY
}

/** Raw shape of a Dubai Pulse open-API transaction record. */
export interface DLDRecord {
  transaction_id?: string
  instance_date?: string
  trans_group_en?: string
  area_name_en?: string
  procedure_area?: number
  actual_area?: number
  trans_value?: number
  property_type_en?: string
  property_sub_type_en?: string
  rooms_en?: string
  project_name_en?: string
  building_name_en?: string
  master_project_en?: string
  buyer_type_en?: string
  buyer_nationality_en?: string
  nearest_landmark?: string
  no_of_parties_role_1?: number
}

export async function fetchDLDTransactions(opts: {
  since: string // YYYY-MM-DD
  offset: number
  limit?: number
}): Promise<DLDRecord[]> {
  const key = process.env.DUBAI_PULSE_API_KEY
  if (!key) throw new Error('DUBAI_PULSE_API_KEY is not set')

  const params = new URLSearchParams({
    api_key: key,
    $where: `instance_date >= '${opts.since}'`,
    $order: 'instance_date DESC',
    $limit: String(opts.limit ?? PAGE_SIZE),
    $offset: String(opts.offset),
  })

  const res = await fetch(`${DLD_BASE}/${DLD_RESOURCE}?${params}`, {
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    throw new Error(`DLD API ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  const body = await res.json()
  // The open API wraps rows differently depending on resource version.
  if (Array.isArray(body)) return body as DLDRecord[]
  if (Array.isArray(body?.result?.records)) return body.result.records as DLDRecord[]
  if (Array.isArray(body?.records)) return body.records as DLDRecord[]
  return []
}

/** "3 B/R" | "Studio" | "4" → 3 | 0 | 4 */
function parseRooms(rooms: string | undefined): number {
  if (!rooms) return 0
  if (/studio/i.test(rooms)) return 0
  const m = rooms.match(/\d+/)
  return m ? parseInt(m[0], 10) : 0
}

/** DLD mixes transaction groups; normalise into this schema's vocabulary. */
function normaliseType(group: string | undefined): string {
  const g = (group ?? '').toLowerCase()
  if (g.includes('off')) return 'off_plan_sale'
  if (g.includes('mortgage')) return 'mortgage'
  if (g.includes('gift')) return 'gift'
  return 'sale'
}

function normalisePropertyType(t: string | undefined): string {
  const v = (t ?? '').toLowerCase()
  if (v.includes('villa')) return 'villa'
  if (v.includes('townhouse')) return 'townhouse'
  if (v.includes('land') || v.includes('plot')) return 'land'
  if (v.includes('office') || v.includes('shop') || v.includes('commercial')) return 'commercial'
  return 'apartment'
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/**
 * Pull DLD transactions since the newest one already stored and upsert them.
 *
 * Ingesting in pages keeps memory flat and lets a partial run be resumed — the
 * high-water mark is derived from the data, so re-running after a failure just
 * continues rather than starting over.
 *
 * Area names here are genuine DLD administrative areas, so an unknown one is
 * created rather than skipped. (That is deliberately different from the
 * listing scraper, where `location.name` is often a building.)
 */
export async function syncDLDTransactions(opts: { fullBackfillFrom?: string } = {}): Promise<{
  imported: number
  pages: number
  since: string
  areasCreated: string[]
}> {
  if (!dldConfigured()) {
    throw new Error('DLD not configured: set DUBAI_PULSE_API_KEY')
  }

  const newest = await prisma.transaction.findFirst({
    where: { source: { in: ['dld', 'dld_dubai'] } },
    orderBy: { transactionDate: 'desc' },
    select: { transactionDate: true },
  })

  // Overlap by a day: DLD rows are registered with a lag, so a strict lower bound
  // permanently skips anything registered late.
  const sinceDate = newest?.transactionDate
    ? new Date(newest.transactionDate.getTime() - 24 * 60 * 60 * 1000)
    : new Date(opts.fullBackfillFrom ?? '2024-01-01')
  const since = sinceDate.toISOString().slice(0, 10)

  let offset = 0
  let imported = 0
  let pages = 0
  const areasCreated: string[] = []

  for (;;) {
    const records = await fetchDLDTransactions({ since, offset })
    pages++
    if (records.length === 0) break

    for (const r of records) {
      const areaName = (r.area_name_en ?? '').trim()
      if (!areaName || !r.transaction_id) continue

      let community = await findCommunityByName(areaName)
      if (!community) {
        community = await prisma.community.create({
          data: {
            slug: slugify(areaName),
            nameEn: areaName,
            emirate: 'dubai',
            latitude: 25.2,
            longitude: 55.27,
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
        invalidateCommunityCache()
        areasCreated.push(areaName)
      }

      // procedure_area is the registered area used for PSF; actual_area is the
      // built-up area and is not comparable across property types.
      const area = Number(r.procedure_area ?? r.actual_area ?? 0)
      const value = Number(r.trans_value ?? 0)
      if (!(value > 0) || !(area > 0)) continue

      await prisma.transaction.upsert({
        where: { dldId: String(r.transaction_id) },
        create: {
          dldId: String(r.transaction_id),
          source: 'dld',
          communityId: community.id,
          transactionType: normaliseType(r.trans_group_en),
          propertyType: normalisePropertyType(r.property_type_en ?? r.property_sub_type_en),
          beds: parseRooms(r.rooms_en),
          areaSqft: area,
          priceAed: value,
          pricePerSqft: Math.round(value / area),
          transactionDate: new Date(r.instance_date ?? Date.now()),
          buildingName: r.building_name_en ?? null,
          projectName: r.project_name_en ?? null,
          masterProject: r.master_project_en ?? null,
          buyerType: (r.buyer_type_en ?? '').toLowerCase() || null,
          buyerNationality: r.buyer_nationality_en ?? null,
        },
        update: {
          priceAed: value,
          pricePerSqft: Math.round(value / area),
        },
      })
      imported++
    }

    if (records.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }

  return { imported, pages, since, areasCreated }
}
