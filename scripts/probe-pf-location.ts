/**
 * Diagnostic: does PropertyFinder's listing payload carry the LISTING's own
 * location, or the SEARCHED location echoed back?
 *
 * The scraper assigns a community from `property.location` (see pfParse). If that
 * object is the search echo, every listing returned for a given `l=` is stamped
 * with that area regardless of where it actually is.
 */
const AREAS: Array<[string, string]> = [
  ['Dubai Marina', '31'],
  ['Discovery Gardens', '58'],
  ['Al Nahda', '44'],
]

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

for (const [label, lid] of AREAS) {
  const url = `https://www.propertyfinder.ae/en/search?c=1&l=${lid}&ob=mr&page=1`
  let items: any[] = []
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(20000) })
    if (!res.ok) {
      console.log(`${label} (l=${lid}) -> HTTP ${res.status}`)
      continue
    }
    const html = await res.text()
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/)
    if (!m) {
      console.log(`${label} (l=${lid}) -> no __NEXT_DATA__ (bot wall?)`)
      continue
    }
    const j = JSON.parse(m[1])
    const all = j?.props?.pageProps?.searchResult?.listings ?? []
    items = all.filter((l: any) => l.listing_type === 'property' && l.property).map((l: any) => l.property)
  } catch (e: any) {
    console.log(`${label} (l=${lid}) -> ${e?.name ?? 'error'}: ${e?.message ?? e}`)
    continue
  }

  console.log(`\n=== searched "${label}" (l=${lid}) — ${items.length} listings ===`)
  const locNames = new Map<string, number>()
  for (const p of items) {
    const n = p.location?.name ?? '<none>'
    locNames.set(n, (locNames.get(n) ?? 0) + 1)
  }
  console.log('  distinct property.location.name values:')
  for (const [n, c] of [...locNames.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(c).padStart(3)}x  ${n}`)
  }
  console.log('  first 6 titles:')
  for (const p of items.slice(0, 6)) {
    console.log(`    [loc=${p.location?.name ?? '?'}] ${String(p.title ?? '').slice(0, 58)}`)
  }
}
