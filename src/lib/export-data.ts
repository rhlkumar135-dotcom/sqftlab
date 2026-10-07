import { prisma } from './db'
import { SALE_TXN_TYPES } from './deals'
import { findCommunityByName } from './community-match'

/**
 * Shared filter/serialisation logic for the Export Centre (Day 11 Task C).
 *
 * Kept out of custom-routes.ts so the parts that are easy to get quietly wrong —
 * CSV escaping and formula-injection guarding — are plain functions that can be
 * tested directly rather than only through an HTTP round-trip.
 */

export type ExportFormat = 'csv' | 'excel'

export type ExportFilters = {
  area?: string
  beds?: number
  dateFrom?: string
  dateTo?: string
  psfMin?: number
  psfMax?: number
}

/** Rows a sub-100 AED/sqft transfer is a placeholder, not a market price. */
export const DEFAULT_PSF_FLOOR = 100

/**
 * Per-tier row ceilings.
 *
 * The spec says "unlimited" above Pro. That is not implementable as written —
 * an unbounded findMany streams the whole table into one string/buffer and the
 * request dies on memory long before it dies on size. So the top tiers get a
 * deliberately generous ceiling that no real filtered query reaches, and the
 * response reports `truncated` honestly when it is hit.
 */
export const SAFETY_CEILING = 100_000

export const EXPORT_ROW_LIMITS: Record<string, number> = {
  pro: 1_000,
  // `elite` is a real tier in this schema and ranks above pro. The spec's ladder
  // (pro | enterprise | institutional) omits it, and an omitted tier must not
  // silently LOSE a paid feature — that is the same omission that demoted the
  // seeded elite account to guest in Day 1. Elite is placed between pro and
  // enterprise; change this single line to move it.
  elite: 5_000,
  enterprise: SAFETY_CEILING,
  institutional: SAFETY_CEILING,
}

/** Excel is the higher-tier format; the spec grants it to Enterprise and up. */
export const EXCEL_MIN_RANK = 3 // elite and above (see TIER_RANK in custom-routes.ts)

export function rowLimitFor(tier: string): number {
  return EXPORT_ROW_LIMITS[tier] ?? 0
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

const NUMERIC = /^-?\d+(\.\d+)?$/

/**
 * A cell beginning with one of these is treated as a FORMULA by Excel and
 * Sheets, not as text. Exported data is user- and third-party-supplied (building
 * and community names come from portal scrape data), so a crafted name like
 * `=HYPERLINK("http://evil","click")` would execute in the buyer's spreadsheet
 * when they open the file. This is the export-side half of that class of bug.
 */
function needsFormulaGuard(s: string): boolean {
  // A genuine number must not be quoted into text — `-5` is a value, `-5+cmd`
  // is not. Only the ambiguous leading `-` needs the numeric exemption.
  if (NUMERIC.test(s)) return false
  return /^[=+\-@\t\r]/.test(s)
}

/** RFC 4180 cell: quote when it contains a delimiter, quote or newline. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let s = String(value)
  if (needsFormulaGuard(s)) s = `'${s}`
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`
  return s
}

export type ExportRow = {
  transactionDate: Date
  community: string
  buildingName: string | null
  beds: number
  areaSqft: number
  pricePerSqft: number
  priceAed: number
  propertyType: string
}

export const EXPORT_HEADER = [
  'Date',
  'Community',
  'Building',
  'Beds',
  'Size (sqft)',
  'PSF (AED)',
  'Total (AED)',
  'Type',
] as const

export function rowToCells(r: ExportRow): (string | number)[] {
  return [
    r.transactionDate.toISOString().slice(0, 10),
    r.community,
    r.buildingName ?? '',
    r.beds,
    Number(r.areaSqft.toFixed(0)),
    Number(r.pricePerSqft.toFixed(0)),
    Number(r.priceAed.toFixed(0)),
    r.propertyType,
  ]
}

/** CRLF line endings, as RFC 4180 specifies. Excel accepts LF too, but the
 *  standard one is what other parsers assume. */
export function toCsv(rows: ExportRow[]): string {
  const lines = [EXPORT_HEADER.map(csvCell).join(',')]
  for (const r of rows) lines.push(rowToCells(r).map(csvCell).join(','))
  // Trailing newline: without it some readers drop the final record.
  return lines.join('\r\n') + '\r\n'
}

// ─── Filtering ───────────────────────────────────────────────────────────────

export type WhereResult =
  | { ok: true; where: Record<string, unknown> }
  | { ok: false; reason: 'area_not_found'; area: string }

/**
 * Build the Prisma `where` for an export/API query.
 *
 * Two deliberate differences from the spec's version:
 *
 *  - `transactionType: 'Sales'` matches NOTHING in this schema (the stored values
 *    are `sale` / `off_plan_sale`), so the stock filter silently exports zero rows
 *    from a full table. SALE_TXN_TYPES is the schema's own list.
 *  - `mode: 'insensitive'` is Postgres-only and THROWS on SQLite. Area text is
 *    resolved to a community id in JS instead (see community-match.ts).
 *
 * An area that matches no community returns `ok: false`. Falling through to the
 * unfiltered query would answer a typo ("Downtwon Dubai") with the entire table —
 * a wrong answer dressed as a successful one.
 */
export async function buildTransactionWhere(f: ExportFilters): Promise<WhereResult> {
  const since = f.dateFrom ? new Date(f.dateFrom) : defaultFrom()
  const until = f.dateTo ? new Date(f.dateTo) : new Date()

  const where: Record<string, unknown> = {
    transactionType: { in: [...SALE_TXN_TYPES] },
    transactionDate: { gte: since, lte: until },
    pricePerSqft: {
      gt: f.psfMin ?? DEFAULT_PSF_FLOOR,
      ...(f.psfMax !== undefined && f.psfMax > 0 ? { lt: f.psfMax } : {}),
    },
  }
  if (f.beds) where.beds = f.beds

  if (f.area && f.area.trim()) {
    const community = await findCommunityByName(f.area)
    if (!community) return { ok: false, reason: 'area_not_found', area: f.area }
    where.communityId = community.id
  }

  return { ok: true, where }
}

/** 12 months back — the export window the spec specifies. */
export function defaultFrom(): Date {
  const d = new Date()
  d.setFullYear(d.getFullYear() - 1)
  return d
}

const ROW_SELECT = {
  transactionDate: true,
  buildingName: true,
  beds: true,
  areaSqft: true,
  pricePerSqft: true,
  priceAed: true,
  propertyType: true,
  community: { select: { nameEn: true } },
} as const

/** Rows plus the true match count, so the caller can say what was left behind. */
export async function fetchExportRows(
  where: Record<string, unknown>,
  take: number,
): Promise<{ rows: ExportRow[]; total: number }> {
  const [raw, total] = await Promise.all([
    prisma.transaction.findMany({
      where,
      select: ROW_SELECT,
      orderBy: { transactionDate: 'desc' },
      take,
    }),
    prisma.transaction.count({ where }),
  ])

  const rows: ExportRow[] = raw.map((r) => ({
    transactionDate: r.transactionDate,
    community: r.community?.nameEn ?? '',
    buildingName: r.buildingName,
    beds: r.beds,
    areaSqft: r.areaSqft,
    pricePerSqft: r.pricePerSqft,
    priceAed: r.priceAed,
    propertyType: r.propertyType,
  }))

  return { rows, total }
}

// ─── Excel ───────────────────────────────────────────────────────────────────

/**
 * Real .xlsx via SheetJS, imported lazily so the ~900 KB library is only paid
 * for by the requests that actually produce a workbook.
 */
export async function toExcelBuffer(rows: ExportRow[]): Promise<Uint8Array> {
  const mod = await import('xlsx')
  const XLSX = (mod as unknown as { default?: typeof mod }).default ?? mod

  const data = rows.map((r) => ({
    Date: r.transactionDate.toISOString().slice(0, 10),
    Community: r.community,
    Building: r.buildingName ?? '',
    Beds: r.beds,
    'Size (sqft)': Number(r.areaSqft.toFixed(0)),
    'PSF (AED)': Number(r.pricePerSqft.toFixed(0)),
    'Total (AED)': Number(r.priceAed.toFixed(0)),
    Type: r.propertyType,
  }))

  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.json_to_sheet(data)
  XLSX.utils.book_append_sheet(wb, ws, 'Transactions')
  // SheetJS types `write` as returning `any`; the buffer form is a Uint8Array.
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Uint8Array
}
