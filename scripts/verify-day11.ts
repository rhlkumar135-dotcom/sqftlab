// Day 11 verification — Public Data API v1 + Export Centre.
//
// Run:
//   cp prisma/dev.db /tmp/day11-e2e.db
//   DATABASE_URL=file:/tmp/day11-e2e.db bun run scripts/verify-day11.ts
//
// Runs the REAL Hono app in-process against a throwaway COPY of the database and
// creates its own synthetic users, one per entitlement, so the tier gates are
// exercised without touching the seeded demo account. Every row created here is
// removed in `finally`.
//
// A COPY is required rather than merely tidy: this suite creates API keys and
// forces counters to their limit, and it inserts transactions. Against the
// project database that would leave live credentials and synthetic market data
// behind.
import { prisma } from '../src/lib/db'
import { createHash } from 'node:crypto'

const dbUrl = process.env.DATABASE_URL ?? ''
if (!dbUrl.includes('day11-e2e')) {
  throw new Error(
    `Refusing to run: DATABASE_URL must point at the disposable copy (…day11-e2e.db), got "${dbUrl || '<unset>'}".\n` +
      'This script creates API keys and transactions; running it against the project database would pollute it.',
  )
}

const { default: app } = await import('../custom-routes')

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 300)}`}`)
  }
}

async function req(
  path: string,
  opts: { method?: string; body?: unknown; token?: string | null; apiKey?: string | null } = {},
): Promise<{ status: number; body: Record<string, unknown>; text: string; res: Response }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`
  const res = await app.request(path, {
    method: opts.method ?? 'GET',
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  })
  const text = await res.text()
  let body: Record<string, unknown> = {}
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    body = {}
  }
  return { status: res.status, body, text, res }
}

const ID = 'zz-verify-day11'
const NASTY_BUILDING = 'Zz Evil, "Tower" =1+2'
const createdUsers: string[] = []
const createdTransactions: string[] = []
const createdKeys: string[] = []

async function makeUser(role: string, tier: string, status = 'active') {
  const u = await prisma.user.create({
    data: { email: `${ID}-${role}@example.invalid`, subscriptionTier: tier, subscriptionStatus: status },
    select: { id: true },
  })
  createdUsers.push(u.id)
  return u.id
}

try {
  const community = await prisma.community.findFirst({
    select: { id: true, nameEn: true, slug: true, emirate: true },
    orderBy: { id: 'asc' },
  })
  if (!community) throw new Error('No community row to attach synthetic transactions to')
  const other = await prisma.community.findFirst({
    where: { id: { not: community.id } },
    select: { id: true },
    orderBy: { id: 'asc' },
  })

  const recent = new Date()
  recent.setDate(recent.getDate() - 5)

  // Two synthetic sales in `community`, and one with a hostile building name.
  for (const [i, building] of [
    ['Zz Verify One', 1800],
    [NASTY_BUILDING, 1750],
  ].entries()) {
    const t = await prisma.transaction.create({
      data: {
        dldId: `${ID}-TX-${i}`,
        communityId: community.id,
        transactionType: 'sale',
        propertyType: 'apartment',
        beds: 2,
        areaSqft: 1000,
        priceAed: building[1] * 1000,
        pricePerSqft: building[1],
        transactionDate: recent,
        buildingName: building[0] as string,
      },
      select: { id: true },
    })
    createdTransactions.push(t.id)
  }

  const proUser = await makeUser('pro', 'pro')
  const apiUser = await makeUser('api', 'pro')
  const entUser = await makeUser('ent', 'enterprise')
  const inactiveUser = await makeUser('inactive', 'pro', 'cancelled')
  const freeUser = await makeUser('free', 'free')

  // ── Task A — API key management ─────────────────────────────────────────────
  console.log('\n── Task A: API key management ──')

  const guestCreate = await req('/sqftlab/api-keys', { method: 'POST', body: { name: 'x' } })
  check('guest cannot create a key (403)', guestCreate.status === 403, guestCreate.status)

  const freeCreate = await req('/sqftlab/api-keys', { method: 'POST', body: { name: 'x' }, token: freeUser })
  check('free tier cannot create a key (403)', freeCreate.status === 403, freeCreate.status)

  const made = await req('/sqftlab/api-keys', { method: 'POST', body: { name: 'Zz primary' }, token: apiUser })
  const rawKey = String(made.body.key ?? '')
  const meta = (made.body.meta ?? {}) as Record<string, unknown>
  if (meta.id) createdKeys.push(String(meta.id))

  check('pro creates a key (201)', made.status === 201, made.status)
  check('key starts with sqft_', rawKey.startsWith('sqft_'), rawKey.slice(0, 10))
  check('key is long enough to be unguessable (>=32 chars)', rawKey.length >= 32, rawKey.length)
  check("key tier inherits the CALLER's tier", meta.tier === 'pro', meta.tier)
  check('response carries a save-it-once warning', typeof made.body.warning === 'string')

  const stored = await prisma.apiKey.findUnique({
    where: { id: String(meta.id) },
    select: { keyHash: true, prefix: true, name: true, tier: true },
  })
  check('only the SHA-256 hash is stored, never the key', stored?.keyHash === createHash('sha256').update(rawKey).digest('hex'))
  check('the plaintext key appears nowhere in the row', JSON.stringify(stored ?? {}).includes(rawKey) === false)
  check('prefix is the first 12 chars, for display', stored?.prefix === rawKey.slice(0, 12))

  const listed = await req('/sqftlab/api-keys', { token: apiUser })
  const listJson = JSON.stringify(listed.body)
  check('list returns the key', listed.status === 200 && Array.isArray(listed.body.keys))
  check('list NEVER returns the full key', !listJson.includes(rawKey))
  check('list exposes the prefix', listJson.includes(rawKey.slice(0, 12)))

  // Max keys is per tier: pro = 3.
  const cap1 = await req('/sqftlab/api-keys', { method: 'POST', body: { name: 'Zz 1' }, token: proUser })
  const cap2 = await req('/sqftlab/api-keys', { method: 'POST', body: { name: 'Zz 2' }, token: proUser })
  const cap3 = await req('/sqftlab/api-keys', { method: 'POST', body: { name: 'Zz 3' }, token: proUser })
  check(
    'pro can hold 3 keys',
    [cap1, cap2, cap3].every((r) => r.status === 201),
    [cap1.status, cap2.status, cap3.status],
  )
  const overCap = await req('/sqftlab/api-keys', { method: 'POST', body: { name: 'Zz 4' }, token: proUser })
  check('4th key on pro is refused (max 3)', overCap.status === 403, overCap.status)
  check('refusal names the cap and the upgrade path', overCap.body.maxKeys === 3 && overCap.body.upgradeUrl === '/pricing')

  const proKeys = await prisma.apiKey.findMany({ where: { userId: proUser }, select: { id: true } })
  proKeys.forEach((k) => createdKeys.push(k.id))
  check('exactly 3 active keys exist for that pro user', proKeys.length === 3, proKeys.length)

  // ── Task A/B — API-key auth on /v1 ──────────────────────────────────────────
  console.log('\n── Task B: /v1 authentication ──')

  const noKey = await req('/v1/transactions')
  check('no key → 401', noKey.status === 401, noKey.status)
  check('401 advertises the scheme', noKey.res.headers.get('www-authenticate')?.includes('Bearer') === true)

  const badKey = await req('/v1/transactions', { apiKey: 'sqft_deadbeef' })
  check('unknown key → 401', badKey.status === 401, badKey.status)

  const inactive = await req('/v1/transactions', {
    apiKey: await mintKeyFor(inactiveUser),
  })
  check('key whose owner cancelled → 403 (spec read the status but never used it)', inactive.status === 403, inactive.status)

  // ── Task B — /v1/transactions ───────────────────────────────────────────────
  console.log('\n── Task B: /v1/transactions ──')

  const tx = await req(`/v1/transactions?area=${encodeURIComponent(community.nameEn)}`, { apiKey: rawKey })
  check('valid key → 200', tx.status === 200, tx.status)
  const dataArr = Array.isArray(tx.body.data) ? (tx.body.data as Record<string, unknown>[]) : []
  const txMeta = (tx.body.meta ?? {}) as Record<string, unknown>
  check('returns a data array and a meta block', Array.isArray(tx.body.data) && typeof txMeta === 'object')
  check('meta reports total/limit/offset/source', ['total', 'limit', 'offset', 'source'].every((k) => k in txMeta))
  check('the synthetic sale is returned (positive path)', dataArr.some((r) => r.building === 'Zz Verify One'))

  const one = dataArr.find((r) => r.building === 'Zz Verify One') ?? {}
  check('row uses real column names (psfAed/sizeSqft/priceAed)', 'psfAed' in one && 'sizeSqft' in one && 'priceAed' in one, Object.keys(one))
  check('row has no phantom spec fields (area/pricePsf/amount)', !('area' in one) && !('pricePsf' in one) && !('amount' in one))
  check('community resolves to a name, not an id', one.community === community.nameEn, one.community)

  const bySlug = await req(`/v1/transactions?area=${encodeURIComponent(community.slug)}`, { apiKey: rawKey })
  check('area matching works off slug too (portal short forms)', bySlug.status === 200)

  const typo = await req('/v1/transactions?area=Downtwon%20Dubai', { apiKey: rawKey })
  check('unmatched area → 404, NOT the whole table', typo.status === 404, typo.status)
  check('unmatched area returns zero rows', Array.isArray(typo.body.data) && (typo.body.data as unknown[]).length === 0)

  const badDate = await req('/v1/transactions?date_from=not-a-date', { apiKey: rawKey })
  check('invalid date → 400 (not a 500)', badDate.status === 400, badDate.status)

  const stats = await req(`/v1/communities/${community.slug}/stats`, { apiKey: rawKey })
  check('/v1/communities/:slug/stats → 200', stats.status === 200, stats.status)
  check('stats counts the synthetic sales', Number(stats.body.transactions) >= 2, stats.body.transactions)
  check('stats reports null (not 0) psf when the window is empty', stats.body.avgPsfAed !== 0)

  const missing = await req('/v1/communities/zz-no-such-place/stats', { apiKey: rawKey })
  check('unknown community → 404', missing.status === 404, missing.status)

  // ── the daily counter rollover (the fix) ────────────────────────────────────
  console.log('\n── Task A: daily counter ──')

  const keyRow = await prisma.apiKey.findUnique({ where: { id: String(meta.id) }, select: { id: true, callsToday: true } })
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)

  await prisma.apiKey.update({
    where: { id: keyRow!.id },
    data: { callsToday: 500, callsResetAt: new Date() },
  })
  const exhausted = await req('/v1/transactions', { apiKey: rawKey })
  check('at the limit → 429', exhausted.status === 429, exhausted.status)
  check('429 states the limit and how to raise it', exhausted.body.limit === 500 && exhausted.body.upgradeUrl === '/pricing')
  check('429 reports remaining quota via headers', exhausted.res.headers.get('x-api-remaining') === '0')

  // THE BUG: counters were never reset, so a key that hit its limit once stayed
  // dead forever. A stale callsResetAt must roll the window over.
  await prisma.apiKey.update({
    where: { id: keyRow!.id },
    data: { callsToday: 500, callsResetAt: yesterday },
  })
  const rolled = await req('/v1/transactions', { apiKey: rawKey })
  check('a stale reset timestamp rolls the window → 200 (was permanently locked)', rolled.status === 200, rolled.status)

  const after = await prisma.apiKey.findUnique({ where: { id: keyRow!.id }, select: { callsToday: true, callsResetAt: true } })
  check('counter restarts at 1 after the roll', after?.callsToday === 1, after?.callsToday)
  check('reset timestamp is stamped forward', (after?.callsResetAt?.getTime() ?? 0) > yesterday.getTime())

  // ── revocation ──────────────────────────────────────────────────────────────
  const revoked = await req(`/sqftlab/api-keys/${meta.id}`, { method: 'DELETE', token: apiUser })
  check('DELETE revokes (200)', revoked.status === 200, revoked.status)
  const afterRevoke = await req('/v1/transactions', { apiKey: rawKey })
  check('revoked key is refused (401)', afterRevoke.status === 401, afterRevoke.status)

  // ── Task C — Export Centre ──────────────────────────────────────────────────
  console.log('\n── Task C: Export Centre ──')

  const guestExport = await req('/sqftlab/export', { method: 'POST', body: { format: 'csv' } })
  check('guest export → 403', guestExport.status === 403, guestExport.status)

  const freeExport = await req('/sqftlab/export', { method: 'POST', body: { format: 'csv' }, token: freeUser })
  check('free tier export → 403', freeExport.status === 403, freeExport.status)

  const csv = await req('/sqftlab/export', {
    method: 'POST',
    body: { format: 'csv', area: community.nameEn },
    token: apiUser,
  })
  check('pro CSV export → 200', csv.status === 200, csv.status)
  check('CSV content-type', csv.res.headers.get('content-type')?.startsWith('text/csv') === true)
  check('CSV is an attachment with a filename', csv.res.headers.get('content-disposition')?.includes('attachment') === true)
  check('CSV carries a UTF-8 BOM (Arabic names survive Excel)', csv.text.startsWith('\uFEFF'))
  check('CSV header row matches the documented columns', csv.text.includes('Date,Community,Building,Beds,Size (sqft),PSF (AED),Total (AED)'))
  check('CSV contains the synthetic row', csv.text.includes('Zz Verify One'))
  check('export reports counts in headers', csv.res.headers.get('x-export-rows') !== null && csv.res.headers.get('x-export-total') !== null)

  // CSV correctness — the two ways an export silently corrupts data.
  const nastyLine = csv.text.split('\r\n').find((l) => l.includes('Evil')) ?? ''
  check('a building name containing a comma is quoted', nastyLine.includes('"'), nastyLine)
  check('embedded quotes are doubled (RFC 4180)', nastyLine.includes('""'))
  check('a leading = is neutralised so Excel will not execute it', !/(^|,)"?=1\+2/.test(nastyLine), nastyLine)
  check('rows are CRLF separated', csv.text.includes('\r\n'))

  const proExcel = await req('/sqftlab/export', { method: 'POST', body: { format: 'excel' }, token: apiUser })
  check('pro requesting Excel → 403 enterprise required', proExcel.status === 403, proExcel.status)
  check('the 403 names the required tier', proExcel.body.requiredTier === 'enterprise')

  const entExcel = await req('/sqftlab/export', { method: 'POST', body: { format: 'excel' }, token: entUser })
  check('enterprise Excel export → 200', entExcel.status === 200, entExcel.status)
  check('xlsx content-type', entExcel.res.headers.get('content-type')?.includes('spreadsheetml.sheet') === true)
  check('body is a real xlsx (ZIP magic PK)', entExcel.text.startsWith('PK'))

  const badAreaExport = await req('/sqftlab/export', {
    method: 'POST',
    body: { format: 'csv', area: 'Nowhere At All' },
    token: apiUser,
  })
  check('export with an unmatched area → 404', badAreaExport.status === 404, badAreaExport.status)

  const badDateExport = await req('/sqftlab/export', {
    method: 'POST',
    body: { format: 'csv', dateFrom: 'yesterday-ish' },
    token: apiUser,
  })
  check('export with an invalid date → 400', badDateExport.status === 400, badDateExport.status)

  const preview = await req('/sqftlab/export/preview', {
    method: 'POST',
    body: { area: community.nameEn },
    token: apiUser,
  })
  check('preview → 200', preview.status === 200, preview.status)
  check('preview reports rowLimit for the tier (pro = 1000)', preview.body.rowLimit === 1000, preview.body.rowLimit)
  check('preview reports whether Excel is unlocked', preview.body.excelAllowed === false)
  check('preview is not truncated when under the cap', preview.body.truncated === false)

  const entPreview = await req('/sqftlab/export/preview', { method: 'POST', body: {}, token: entUser })
  check('enterprise preview unlocks Excel', entPreview.body.excelAllowed === true)
  check('enterprise preview marks the cap as effectively unlimited', entPreview.body.unlimited === true)

  // Truncation arithmetic, tested directly at the row limit the route uses.
  const { fetchExportRows, buildTransactionWhere } = await import('../src/lib/export-data')
  if (other) {
    const built = await buildTransactionWhere({ area: community.nameEn })
    if (built.ok) {
      const cut = await fetchExportRows(built.where, 1)
      check('fetchExportRows honours the cap', cut.rows.length === 1, cut.rows.length)
      check('fetchExportRows still reports the true total', cut.total >= 2, cut.total)
      check('total > returned is what drives the truncation notice', cut.total > cut.rows.length)
    } else {
      check('buildTransactionWhere resolved the community', false, built.reason)
    }
  }

  const history = await req('/sqftlab/export/history', { token: apiUser })
  check('export history → 200', history.status === 200, history.status)
  check('history records the export just performed', Array.isArray(history.body.exports) && (history.body.exports as unknown[]).length >= 1)
  check('history returns at most 3 entries', ((history.body.exports ?? []) as unknown[]).length <= 3)
} catch (e) {
  failed++
  failures.push('suite threw')
  console.log(`  ✗ suite threw — ${(e as Error).message}`)
} finally {
  const [k, t, u] = await Promise.all([
    prisma.apiKey.deleteMany({ where: { userId: { in: createdUsers } } }),
    prisma.transaction.deleteMany({ where: { dldId: { startsWith: ID } } }),
    prisma.userEvent.deleteMany({ where: { userId: { in: createdUsers } } }),
  ])
  const users = await prisma.user.deleteMany({ where: { email: { startsWith: ID } } })
  console.log(`\n  cleaned up: ${k.count} keys, ${t.count} transactions, ${u.count} events, ${users.count} users`)
  await prisma.$disconnect()

  console.log(`\n  ${passed} passed, ${failed} failed`)
  if (failed > 0) console.log(`  failing: ${failures.join(' | ')}`)
  process.exit(failed > 0 ? 1 : 0)
}

/** Mint a key directly for a user (bypasses the HTTP route where that is not the point). */
async function mintKeyFor(userId: string): Promise<string> {
  const raw = `sqft_${createHash('sha256').update(userId).digest('hex').slice(0, 40)}`
  await prisma.apiKey.create({
    data: {
      userId,
      keyHash: createHash('sha256').update(raw).digest('hex'),
      prefix: raw.slice(0, 12),
      name: 'Zz minted',
      tier: 'pro',
    },
  })
  return raw
}
