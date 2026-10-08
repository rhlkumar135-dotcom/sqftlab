import { prisma } from './db'

/**
 * DLD open-data gateway — the keyless half of Dubai Land Department data.
 *
 * The `gateway.dubailand.gov.ae/open-data` surface powers the public DLD open-data
 * portal. Probing it (scripts/probe-dld.sh) showed two very different classes of
 * command:
 *
 *   - Reference/lookup commands answer with no credential at all:
 *     `carea-lookup` (437 administrative areas), `projects-lookup` (4,215
 *     registered projects), `ejari-property-types` (83).
 *   - Record commands (`transactions`, `rents`, `buildings`, `units`, `lands`,
 *     `valuations`, ...) sit behind a Google reCAPTCHA. The portal only reaches
 *     them through `/umbraco/surface/CaptchaProxy/CallThenPost` with a solved
 *     token; a direct call returns HTTP 500. That is a deliberate anti-bot
 *     control, so this client does NOT attempt to reach them. Those records need
 *     either a human-solved captcha or the Dubai Pulse API key (UAE Pass), which
 *     `./dld.ts` handles.
 *
 * So: everything here is genuinely live and government-sourced, and anything
 * requiring a capital of its own is reported as unavailable rather than faked.
 */

const BASE = process.env.DLD_OPEN_BASE ?? 'https://gateway.dubailand.gov.ae/open-data'

/** Commands the portal calls with no captcha token. Verified by probing. */
export const OPEN_COMMANDS = ['carea-lookup', 'projects-lookup', 'ejari-property-types'] as const
export type OpenCommand = (typeof OPEN_COMMANDS)[number]

/** Commands that exist but are captcha-gated. Listed so the audit can name them. */
export const CAPTCHA_GATED_COMMANDS = [
  'transactions',
  'rents',
  'buildings',
  'units',
  'lands',
  'brokers',
  'developers',
  'valuations',
  'projects',
] as const

interface DldEnvelope<T> {
  responseCode?: number
  validationErrorsList?: unknown[]
  response?: { result?: T[] } | null
}

export class DldCaptchaError extends Error {
  constructor(command: string) {
    super(`DLD '${command}' is captcha-protected and cannot be fetched automatically`)
    this.name = 'DldCaptchaError'
  }
}

/**
 * POST a command to the gateway and unwrap its envelope.
 *
 * HTTP 500 is how the gateway signals a captcha-gated command to a non-browser
 * caller, so it is surfaced as its own error type rather than a generic failure —
 * "this needs a human" and "this is broken" must not read the same in a health check.
 */
async function callOpenData<T>(command: OpenCommand, body: unknown = {}): Promise<T[]> {
  const res = await fetch(`${BASE}/${command}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // The gateway is CORS-restricted to the portal origin.
      Origin: 'https://dubailand.gov.ae',
      Referer: 'https://dubailand.gov.ae/',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  })

  if (res.status === 500) throw new DldCaptchaError(command)
  if (!res.ok) throw new Error(`DLD open-data ${command} HTTP ${res.status}`)

  const json = (await res.json()) as DldEnvelope<T>
  if (json.responseCode && json.responseCode !== 200) {
    throw new Error(`DLD open-data ${command} responseCode ${json.responseCode}`)
  }
  return json.response?.result ?? []
}

export interface DldLookupRow {
  AREA_ID?: string
  ID?: string
  NAME_EN?: string
  NAME_AR?: string
}

export async function fetchDldAreas(): Promise<DldLookupRow[]> {
  return callOpenData<DldLookupRow>('carea-lookup')
}

export async function fetchDldProjects(): Promise<DldLookupRow[]> {
  return callOpenData<DldLookupRow>('projects-lookup')
}

export async function fetchDldPropertyTypes(): Promise<DldLookupRow[]> {
  return callOpenData<DldLookupRow>('ejari-property-types')
}

/** Reference rows are namespaced by kind; areas key on AREA_ID, the rest on ID. */
function externalIdOf(kind: string, row: DldLookupRow): string | null {
  const id = kind === 'area' ? row.AREA_ID : row.ID
  return id ? String(id) : null
}

/** Loose key for matching a DLD area name against a scraped community name. */
function nameKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(area|community|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Refresh the DLD reference tables and link communities to their official area id.
 *
 * Fetches everything BEFORE touching the database, so a gateway outage leaves the
 * previous reference set intact rather than emptying it. Each kind is then swapped
 * inside one transaction: reference data is small, changes rarely, and a
 * replace-in-place avoids trying to diff 4,200 rows.
 */
export async function syncDldReference(): Promise<{
  areas: number
  projects: number
  propertyTypes: number
  linkedCommunities: number
  newlyLinked: number
}> {
  const [areaRows, projectRows, typeRows] = await Promise.all([
    fetchDldAreas(),
    fetchDldProjects(),
    fetchDldPropertyTypes(),
  ])

  const specs: { kind: string; rows: DldLookupRow[] }[] = [
    { kind: 'area', rows: areaRows },
    { kind: 'project', rows: projectRows },
    { kind: 'property_type', rows: typeRows },
  ]

  for (const { kind, rows } of specs) {
    const data = rows
      .map((r) => {
        const externalId = externalIdOf(kind, r)
        const nameEn = (r.NAME_EN ?? '').trim()
        if (!externalId || !nameEn) return null
        return {
          kind,
          externalId,
          nameEn,
          nameAr: (r.NAME_AR ?? '').trim() || null,
          fetchedAt: new Date(),
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)

    // Chunked so a single statement never carries thousands of parameter sets.
    await prisma.$transaction([
      prisma.dldReference.deleteMany({ where: { kind } }),
      ...chunk(data, 500).map((batch) => prisma.dldReference.createMany({ data: batch })),
    ])
  }

  // Link each community to its official DLD area. This is provenance only: the
  // community keeps its own name, but now records which government area it is.
  const areas = await prisma.dldReference.findMany({
    where: { kind: 'area' },
    select: { externalId: true, nameEn: true },
  })
  const byName = new Map(areas.map((a) => [nameKey(a.nameEn), a.externalId]))

  const communities = await prisma.community.findMany({
    select: { id: true, nameEn: true, dldAreaId: true },
  })

  const toLink = communities
    .map((c) => ({ id: c.id, areaId: byName.get(nameKey(c.nameEn)) }))
    .filter((x): x is { id: string; areaId: string } => !!x.areaId)
    .filter((x) => communities.find((c) => c.id === x.id)?.dldAreaId !== x.areaId)

  if (toLink.length) {
    await prisma.$transaction(
      toLink.map((x) =>
        prisma.community.update({ where: { id: x.id }, data: { dldAreaId: x.areaId } })
      )
    )
  }

  // Total linked, not just linked-this-run: the step is idempotent, so a healthy
  // steady-state run would otherwise always report "0 linked" and read as a no-op.
  const linkedCommunities = await prisma.community.count({
    where: { dldAreaId: { not: null } },
  })

  return {
    areas: areaRows.length,
    projects: projectRows.length,
    propertyTypes: typeRows.length,
    linkedCommunities,
    newlyLinked: toLink.length,
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** Counts for the provenance/sources surface, without a network call. */
export async function dldReferenceCounts(): Promise<Record<string, number>> {
  const rows = await prisma.dldReference.groupBy({ by: ['kind'], _count: { _all: true } })
  return Object.fromEntries(rows.map((r) => [r.kind, r._count._all]))
}
