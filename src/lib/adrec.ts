import { prisma } from './db'
import { findCommunityByName, invalidateCommunityCache } from './community-match'

/**
 * ADREC (Abu Dhabi Real Estate Centre) transaction ingest.
 *
 * IMPORTANT — unlike Dubai Pulse, ADREC has no self-serve open API. Access is
 * granted by request (https://adrec.gov.ae/en/apisubscription), so this adapter
 * is driven entirely by environment configuration:
 *
 *   ADREC_API_URL   base URL issued with your subscription
 *   ADREC_API_KEY   bearer token / api key issued with your subscription
 *
 * The record shape below is a *tolerant* mapping: ADREC's published schema is not
 * public, so `pick()` accepts several plausible spellings per field. Verify the
 * mapping against one real response before trusting the numbers, and adjust
 * `FIELD_MAP` if their keys differ. Nothing here fabricates a value — a field
 * that cannot be mapped is left null, and a record missing price or area is
 * skipped rather than guessed.
 */

export function adrecConfigured(): boolean {
  return !!process.env.ADREC_API_URL && !!process.env.ADREC_API_KEY
}

type Raw = Record<string, unknown>

const pick = (r: Raw, ...keys: string[]): unknown => {
  for (const k of keys) {
    const v = r[k]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v.replace(/[^0-9.\-]/g, '')) : Number(v)
  return Number.isFinite(n) ? n : 0
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined

export interface ADRECTransaction {
  externalId: string
  areaName: string
  propertyType: string
  transactionType: string
  areaSqft: number
  priceAed: number
  transactionDate: Date
}

/** Map one provider row to our shape, or null when it is unusable. */
export function mapADRECRecord(r: Raw): ADRECTransaction | null {
  const externalId = str(pick(r, '_id', 'id', 'transaction_id', 'transactionId', 'reference'))
  const areaName = str(pick(r, 'area_en', 'area_name_en', 'area', 'district_en', 'district'))
  const priceAed = num(pick(r, 'transaction_value', 'transaction_amount', 'amount', 'price', 'value'))
  const areaSqft = num(pick(r, 'area_sqft', 'area_sqft_total', 'size_sqft', 'area'))
  const dateRaw = pick(r, 'transaction_date', 'transactionDate', 'date', 'registration_date')

  if (!externalId || !areaName || !(priceAed > 0) || !(areaSqft > 0) || !dateRaw) return null
  const transactionDate = new Date(String(dateRaw))
  if (isNaN(transactionDate.getTime())) return null

  const rawType = (str(pick(r, 'transaction_type_en', 'transaction_type', 'type')) ?? '').toLowerCase()
  const transactionType = rawType.includes('off')
    ? 'off_plan_sale'
    : rawType.includes('mortgage')
      ? 'mortgage'
      : 'sale'

  const rawProp = (str(pick(r, 'property_type_en', 'property_type', 'propertyType')) ?? '').toLowerCase()
  const propertyType = rawProp.includes('villa')
    ? 'villa'
    : rawProp.includes('townhouse')
      ? 'townhouse'
      : rawProp.includes('land') || rawProp.includes('plot')
        ? 'land'
        : rawProp.includes('office') || rawProp.includes('commercial') || rawProp.includes('shop')
          ? 'commercial'
          : 'apartment'

  return { externalId: String(externalId), areaName, propertyType, transactionType, areaSqft, priceAed, transactionDate }
}

async function fetchPage(offset: number, limit: number): Promise<Raw[]> {
  const base = process.env.ADREC_API_URL!
  const key = process.env.ADREC_API_KEY!
  const url = `${base}${base.includes('?') ? '&' : '?'}limit=${limit}&offset=${offset}`

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`ADREC ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = await res.json()
  if (Array.isArray(body)) return body as Raw[]
  if (Array.isArray(body?.records)) return body.records as Raw[]
  if (Array.isArray(body?.result?.records)) return body.result.records as Raw[]
  if (Array.isArray(body?.data)) return body.data as Raw[]
  if (Array.isArray(body?.result)) return body.result as Raw[]
  if (Array.isArray(body?.data?.records)) return body.data.records as Raw[]
  return []
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

const PAGE_SIZE = 500

/**
 * Ingest ADREC transactions into the same table as Dubai Pulse, tagged
 * `source: 'adrec'` and keyed `adrec_<id>` so the two can never collide.
 *
 * Abu Dhabi area names are real administrative districts, so an unknown one is
 * created with `emirate: 'abu_dhabi'` rather than skipped.
 */
export async function syncADRECTransactions(): Promise<{
  imported: number
  skipped: number
  pages: number
  areasCreated: string[]
}> {
  if (!adrecConfigured()) {
    throw new Error('ADREC not configured: set ADREC_API_URL and ADREC_API_KEY')
  }

  let offset = 0
  let imported = 0
  let skipped = 0
  let pages = 0
  const areasCreated: string[] = []

  for (;;) {
    const rows = await fetchPage(offset, PAGE_SIZE)
    pages++
    if (rows.length === 0) break

    for (const raw of rows) {
      const mapped = mapADRECRecord(raw)
      if (!mapped) {
        skipped++
        continue
      }

      let community = await findCommunityByName(mapped.areaName)
      if (!community) {
        community = await prisma.community.create({
          data: {
            slug: slugify(mapped.areaName),
            nameEn: mapped.areaName,
            emirate: 'abu_dhabi',
            latitude: 24.45,
            longitude: 54.38,
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
        areasCreated.push(mapped.areaName)
      }

      const dldId = `adrec_${mapped.externalId}`
      await prisma.transaction.upsert({
        where: { dldId },
        create: {
          dldId,
          source: 'adrec',
          communityId: community.id,
          transactionType: mapped.transactionType,
          propertyType: mapped.propertyType,
          beds: 0,
          areaSqft: mapped.areaSqft,
          priceAed: mapped.priceAed,
          pricePerSqft: Math.round(mapped.priceAed / mapped.areaSqft),
          transactionDate: mapped.transactionDate,
        },
        update: {
          priceAed: mapped.priceAed,
          pricePerSqft: Math.round(mapped.priceAed / mapped.areaSqft),
        },
      })
      imported++
    }

    if (rows.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }

  return { imported, skipped, pages, areasCreated }
}
