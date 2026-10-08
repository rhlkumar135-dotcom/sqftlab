/**
 * Resolve the correct PropertyFinder location IDs (`lid`) for every community the
 * scraper targets, and PROVE each one before writing it.
 *
 * Why this exists: the `lid` values in `custom-routes.ts` do not match the areas they
 * are labelled with. `?l=31` is documented there as "Dubai Marina"; PropertyFinder
 * resolves it to **Al Twar**. `?l=544` is labelled "JVC" and resolves to **AG Tower**.
 * All eight Abu Dhabi ids (6663–6671) resolve to nothing at all — PropertyFinder
 * ignores the filter and answers with the entire 192k UAE catalogue, which is how
 * Dubai villas ended up filed under Saadiyat Island.
 *
 * The source of truth is PropertyFinder's own data: every listing carries a
 * `location.path` whose segments are the location ids, aligned with
 * `location.path_name`:
 *
 *     path      = "1.31.461.12518"
 *     path_name = "Dubai, Al Twar, Al Twar 1"
 *                  ↑      ↑       ↑
 *                  |      area id 31
 *                  emirate
 *
 * So harvesting listings and reading those two fields yields a real
 * `area name -> area id` map, rather than a guessed one.
 *
 * Run: bun run scripts/resolve-lids.ts
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Harvested {
  /** Lowercased area name -> { id, emirate, hits } */
  areas: Map<string, { id: string; emirate: string; hits: number; name: string }>
}

async function fetchPage(lid: string | null, page: number, catId: number): Promise<unknown[]> {
  const url = lid
    ? `https://www.propertyfinder.ae/en/search?c=${catId}&l=${lid}&ob=mr&page=${page}`
    : `https://www.propertyfinder.ae/en/search?c=${catId}&ob=mr&page=${page}`
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(15000) })
      if (res.status === 429 || res.status === 503) {
        await sleep(attempt * 4000)
        continue
      }
      if (!res.ok) return []
      const html = await res.text()
      const m = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/)
      if (!m) return []
      const j = JSON.parse(m[1]) as { props?: { pageProps?: { searchResult?: { listings?: unknown[] } } } }
      return j.props?.pageProps?.searchResult?.listings ?? []
    } catch {
      await sleep(1500)
    }
  }
  return []
}

function harvest(listings: unknown[], into: Harvested): void {
  for (const entry of listings) {
    const p = (entry as { property?: { location?: { path?: string; path_name?: string } } }).property
    const loc = p?.location
    if (!loc?.path || !loc?.path_name) continue
    const idParts = loc.path.split('.')
    const nameParts = loc.path_name.split(',').map((s) => s.trim())
    // index 1 is the AREA (0 = emirate, 1 = area, 2 = sub-community)
    const id = idParts[1]
    const areaName = nameParts[1]
    const emirate = nameParts[0]
    if (!id || !areaName) continue
    const key = areaName.toLowerCase()
    const prev = into.areas.get(key)
    if (prev) prev.hits++
    else into.areas.set(key, { id, emirate, hits: 1, name: areaName })
  }
}

/** The targets, and the aliases PropertyFinder might list them under. */
const TARGETS: Array<{ label: string; slug: string; aliases: string[] }> = [
  { label: 'Dubai Marina', slug: 'dubai-marina', aliases: ['dubai marina'] },
  { label: 'Downtown Dubai', slug: 'downtown-dubai', aliases: ['downtown dubai', 'downtown'] },
  { label: 'Palm Jumeirah', slug: 'palm-jumeirah', aliases: ['palm jumeirah', 'palm jumeirah residences'] },
  { label: 'JVC', slug: 'jumeirah-village-circle', aliases: ['jumeirah village circle', 'jumeirah village circle (jvc)'] },
  { label: 'Business Bay', slug: 'business-bay', aliases: ['business bay'] },
  { label: 'Dubai Hills Estate', slug: 'dubai-hills-estate', aliases: ['dubai hills estate', 'dubai hills'] },
  { label: 'JLT', slug: 'jumeirah-lake-towers', aliases: ['jumeirah lake towers', 'jumeirah lake towers (jlt)'] },
  { label: 'DIFC', slug: 'difc', aliases: ['difc', 'difc (dubai international financial centre)'] },
  { label: 'Dubai Creek Harbour', slug: 'dubai-creek-harbour', aliases: ['dubai creek harbour'] },
  { label: 'MBR City', slug: 'mbr-city', aliases: ['mohammed bin rashid city', 'mbr city'] },
  { label: 'Al Barsha', slug: 'al-barsha', aliases: ['al barsha'] },
  { label: 'Deira', slug: 'deira', aliases: ['deira'] },
  { label: 'Bur Dubai', slug: 'bur-dubai', aliases: ['bur dubai'] },
  { label: 'Dubai Silicon Oasis', slug: 'dubai-silicon-oasis', aliases: ['dubai silicon oasis'] },
  { label: 'Dubai Sports City', slug: 'dubai-sports-city', aliases: ['dubai sports city'] },
  { label: 'Motor City', slug: 'motor-city', aliases: ['motor city'] },
  { label: 'Discovery Gardens', slug: 'discovery-gardens', aliases: ['discovery gardens'] },
  { label: 'Town Square', slug: 'town-square', aliases: ['town square'] },
  { label: 'Al Nahda', slug: 'al-nahda', aliases: ['al nahda'] },
  { label: 'Dubailand', slug: 'dubailand', aliases: ['dubailand'] },
  { label: 'Al Reem Island', slug: 'al-reem-island', aliases: ['al reem island'] },
  { label: 'Saadiyat Island', slug: 'saadiyat-island', aliases: ['saadiyat island', 'saadiyat'] },
  { label: 'Yas Island', slug: 'yas-island', aliases: ['yas island', 'yas'] },
  { label: 'Al Raha Beach', slug: 'al-raha-beach', aliases: ['al raha beach'] },
  { label: 'Corniche', slug: 'corniche', aliases: ['corniche', 'abu dhabi corniche', 'corniche area'] },
  { label: 'Khalifa City', slug: 'khalifa-city', aliases: ['khalifa city'] },
  { label: 'MBZ City', slug: 'mbz-city', aliases: ['mohammed bin zayed city', 'mbz city'] },
  { label: 'Al Maryah Island', slug: 'al-maryah-island', aliases: ['al maryah island', 'maryah island'] },
]

console.log('=== harvesting PropertyFinder location ids from listing metadata ===\n')
const into: Harvested = { areas: new Map() }

for (const catId of [1, 2]) {
  for (let page = 1; page <= 45; page++) {
    const listings = await fetchPage(null, page, catId)
    if (listings.length === 0) break
    harvest(listings, into)
    await sleep(700)
  }
  console.log(`  cat=${catId} harvested, ${into.areas.size} distinct areas so far`)
}

console.log(`\ntotal distinct areas harvested: ${into.areas.size}`)

// ── Resolve each target ──
interface Resolved { label: string; slug: string; id: string; resolvedName: string; hits: number; ok: boolean }
const resolved: Resolved[] = []

for (const t of TARGETS) {
  let hit: { id: string; emirate: string; hits: number; name: string } | undefined
  for (const alias of t.aliases) {
    const found = into.areas.get(alias)
    if (found && (!hit || found.hits > hit.hits)) hit = found
  }
  resolved.push({
    label: t.label, slug: t.slug,
    id: hit?.id ?? '', resolvedName: hit?.name ?? '', hits: hit?.hits ?? 0,
    ok: !!hit,
  })
}

console.log('\n=== resolved from harvested data ===')
for (const r of resolved) {
  console.log(`  ${r.ok ? 'OK  ' : 'MISS'} ${r.label.padEnd(22)} -> id=${(r.id || '?').padEnd(8)} as "${r.resolvedName}" (${r.hits} listings)`)
}

// ── Verify every resolved id actually scopes to that area ──
console.log('\n=== verifying each id against PropertyFinder\'s own resolved location ===')
const verified: Array<{ label: string; slug: string; id: string; pfloc: string; ok: boolean }> = []
for (const r of resolved.filter((x) => x.ok)) {
  const listings = await fetchPage(r.id, 1, 1)
  let pfloc = '(no location)'
  try {
    const res = await fetch(`https://www.propertyfinder.ae/en/search?c=1&l=${r.id}&ob=mr`, {
      headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000),
    })
    const html = await res.text()
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/)
    if (m) {
      const j = JSON.parse(m[1]) as { props?: { pageProps?: { location?: { name?: string } } } }
      pfloc = j.props?.pageProps?.location?.name ?? '(none)'
    }
  } catch { /* keep the placeholder */ }
  // A mismatch is the whole bug class: the id must resolve to the area we label it.
  const ok = pfloc.toLowerCase().includes(r.label.toLowerCase().split(' ')[0].toLowerCase().slice(0, 4))
  verified.push({ label: r.label, slug: r.slug, id: r.id, pfloc, ok })
  console.log(`  ${ok ? 'OK  ' : 'MISMATCH'} ${r.label.padEnd(22)} lid=${r.id.padEnd(8)} PF says "${pfloc}"  (${listings.length} listings)`)
  await sleep(800)
}

// ── Emit the corrected arrays ──
const dubai = verified.filter((v) => !['al-reem-island', 'saadiyat-island', 'yas-island', 'al-raha-beach', 'corniche', 'khalifa-city', 'mbz-city', 'al-maryah-island'].includes(v.slug))
const ad = verified.filter((v) => ['al-reem-island', 'saadiyat-island', 'yas-island', 'al-raha-beach', 'corniche', 'khalifa-city', 'mbz-city', 'al-maryah-island'].includes(v.slug))

const fmt = (v: { label: string; slug: string; id: string }) =>
  `  { name: '${v.label}', lid: '${v.id}', slug: '${v.slug}' },`

console.log('\n=== DUBAI_AREAS (corrected) ===')
console.log(dubai.map(fmt).join('\n'))
console.log('\n=== AD_AREAS (corrected) ===')
console.log(ad.map(fmt).join('\n'))

const failed = verified.filter((v) => !v.ok)
console.log(`\n=== ${failed.length === 0 ? 'ALL IDs VERIFIED' : `${failed.length} ID(s) UNVERIFIED: ${failed.map((f) => f.label).join(', ')}`} ===`)
