import { prisma } from './db'

/**
 * Prisma's `mode: 'insensitive'` is Postgres-only. On SQLite it throws
 * "Unknown argument `mode`", which silently made the PropertyFinder scraper and
 * the /scrape endpoint unable to run against a local database — the reason the
 * real scraper had never populated anything.
 *
 * Matching therefore happens in JS rather than in SQL. The community table is
 * small (tens of rows) and the list is cached, so the cost is negligible next to
 * a per-listing database round-trip, and it removes the dialect dependency
 * instead of branching on it. It also gives Postgres the same intended
 * case-insensitive containment rather than plain `LIKE`.
 */

export type CommunityRow = NonNullable<Awaited<ReturnType<typeof prisma.community.findFirst>>>

let cache: { at: number; rows: CommunityRow[] } | null = null
const TTL_MS = 60_000

async function load(force = false): Promise<CommunityRow[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.rows
  const rows = await prisma.community.findMany()
  cache = { at: Date.now(), rows }
  return rows
}

/** Call after creating or renaming a community so the next lookup sees it. */
export function invalidateCommunityCache(): void {
  cache = null
}

/**
 * Resolve an area name as it appears in a portal's data to a community row.
 * Exact (case-insensitive) match wins, then containment in either direction, so
 * "Dubai Marina" still resolves against "Marina" and vice versa.
 */
export async function findCommunityByName(name: string): Promise<CommunityRow | null> {
  const needle = (name ?? '').trim().toLowerCase()
  if (!needle) return null

  const rows = await load()
  return (
    rows.find((r) => r.nameEn.toLowerCase() === needle) ??
    rows.find((r) => r.nameEn.toLowerCase().includes(needle)) ??
    rows.find((r) => needle.includes(r.nameEn.toLowerCase())) ??
    null
  )
}
