// Day 12 verification — saved searches, price alerts, and the Investment Score UI.
//
// Run:
//   cp prisma/dev.db /tmp/day12-e2e.db
//   DATABASE_URL=file:/tmp/day12-e2e.db bun run scripts/verify-day12.ts
//
// Runs the real Hono app in-process against a throwaway COPY of the database and
// creates its own users, alerts and listings. Everything it creates is removed in
// `finally`.
//
// A COPY is required: this suite drives the alert SCAN, which is not scoped to
// the caller — it walks every active alert in the database and writes matches. On
// the project database that would attach synthetic matches to real alerts and
// notify real addresses once a mail transport exists.
import { prisma } from '../src/lib/db'

const dbUrl = process.env.DATABASE_URL ?? ''
if (!dbUrl.includes('day12-e2e')) {
  throw new Error(
    `Refusing to run: DATABASE_URL must point at the disposable copy (…day12-e2e.db), got "${dbUrl || '<unset>'}".\n` +
      'The alert scan is not caller-scoped and would write matches against real alerts.',
  )
}

const { default: app } = await import('../custom-routes')
const { scanDealAlerts, notifyPendingMatches, DEAL_DISCOUNT_THRESHOLD } = await import('../src/lib/alerts')
const { computeInvestmentScore, latestInvestmentScores } = await import('../src/lib/score-engine')

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

async function req(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const res = await app.request(path, {
    method: opts.method ?? 'GET',
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  })
  const text = await res.text()
  let body = {}
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = {}
  }
  return { status: res.status, body, text, res }
}

const ID = 'zz-verify-day12'
const createdUserIds: string[] = []
const createdListingIds: string[] = []
const createdAlertIds: string[] = []

async function makeUser(role, tier) {
  const u = await prisma.user.create({
    data: { email: `${ID}-${role}@example.invalid`, subscriptionTier: tier, subscriptionStatus: 'active' },
    select: { id: true },
  })
  createdUserIds.push(u.id)
  return u.id
}

try {
  // ── a market to alert against ───────────────────────────────────────────────
  const community = await prisma.community.findFirst({
    where: { medianAedSqft: { gt: 0 } },
    select: { id: true, slug: true, nameEn: true, medianAedSqft: true },
    orderBy: { id: 'asc' },
  })
  if (!community) throw new Error('no community with a medianAedSqft to build the test market from')
  const median = community.medianAedSqft
  const threshold = median * (1 - DEAL_DISCOUNT_THRESHOLD)

  const mkListing = async (tag, psf, purpose = 'sale') => {
    const l = await prisma.listing.create({
      data: {
        externalId: `${ID}-${tag}`,
        source: 'bayut',
        communityId: community.id,
        purpose,
        propertyType: 'apartment',
        beds: 2,
        baths: 2,
        title: `Zz ${tag}`,
        areaSqft: 1000,
        priceAed: psf * 1000,
        pricePerSqft: psf,
        listedAt: new Date(),
      },
      select: { id: true },
    })
    createdListingIds.push(l.id)
    return l.id
  }

  // One genuine deal (below the district threshold) and one that is not.
  await mkListing('below', Math.floor(threshold * 0.9))
  await mkListing('above', Math.ceil(threshold * 1.4))
  await mkListing('rent-cheap', 1, 'rent')

  const proUser = await makeUser('pro', 'pro')
  const freeUser = await makeUser('free', 'free')
  const entUser = await makeUser('ent', 'enterprise')

  // ── Task A — model shape ────────────────────────────────────────────────────
  console.log('\n── Task A: schema ──')
  const cols = await prisma.$queryRawUnsafe('PRAGMA table_info(deal_alerts)')
  const names = cols.map((c) => c.name)
  check('deal_alerts has `name` (user-given label)', names.includes('name'))
  check('deal_alerts has `last_checked_at`', names.includes('last_checked_at'))
  check('deal_alerts has `active` for soft delete', names.includes('active'))

  const matchCols = (await prisma.$queryRawUnsafe('PRAGMA table_info(alert_matches)')).map((c) => c.name)
  check(
    'alert_matches keys on listing_id, not transaction_id',
    matchCols.includes('listing_id') && !matchCols.includes('transaction_id'),
    matchCols,
  )
  check('alert_matches stores psf_discount', matchCols.includes('psf_discount'))

  // ── Task B — routes and gating ──────────────────────────────────────────────
  console.log('\n── Task B: alert routes ──')

  // No identity at all → 401 (upgradeRequired). A caller who IS signed in but
  // below the tier gets 403 from requireTier — asserted separately below.
  const guestList = await req('/sqftlab/alerts')
  check('guest GET /alerts is refused (401)', guestList.status === 401, guestList.status)

  const freeCreate = await req('/sqftlab/alerts', {
    method: 'POST', body: { district: community.slug }, token: freeUser,
  })
  check('free tier cannot create an alert (403)', freeCreate.status === 403, freeCreate.status)

  const noDistrict = await req('/sqftlab/alerts', { method: 'POST', body: {}, token: proUser })
  check('missing district → 400', noDistrict.status === 400, noDistrict.status)

  const bogus = await req('/sqftlab/alerts', {
    method: 'POST', body: { district: 'ZZ Not A Real Place' }, token: proUser,
  })
  check('unknown district → 400 (a bogus alert would never fire)', bogus.status === 400, bogus.status)

  const badPrice = await req('/sqftlab/alerts', {
    method: 'POST', body: { district: community.slug, maxPrice: -5 }, token: proUser,
  })
  check('negative maxPrice → 400', badPrice.status === 400, badPrice.status)

  const badBeds = await req('/sqftlab/alerts', {
    method: 'POST', body: { district: community.slug, minBeds: 1.5 }, token: proUser,
  })
  check('non-integer minBeds → 400', badBeds.status === 400, badBeds.status)

  const made = await req('/sqftlab/alerts', {
    method: 'POST',
    body: { district: community.slug, name: 'Zz named alert', minBeds: 1 },
    token: proUser,
  })
  check('pro creates an alert (201)', made.status === 201, made.status)
  check('the user-given name is stored', made.body.alert?.name === 'Zz named alert', made.body.alert?.name)
  check('creation runs the scan immediately', typeof made.body.scan === 'object')
  if (made.body.alert?.id) createdAlertIds.push(made.body.alert.id)

  // The cap: pro = 5. `made` above is #1.
  for (let i = 2; i <= 5; i++) {
    const r = await req('/sqftlab/alerts', {
      method: 'POST', body: { district: community.slug, name: `Zz cap ${i}` }, token: proUser,
    })
    if (r.body.alert?.id) createdAlertIds.push(r.body.alert.id)
  }
  const overCap = await req('/sqftlab/alerts', {
    method: 'POST', body: { district: community.slug, name: 'Zz cap 6' }, token: proUser,
  })
  check('6th alert on pro → 403', overCap.status === 403, overCap.status)
  check('the refusal names the cap', overCap.body.limit === 5, overCap.body.limit)
  check('the refusal offers an upgrade path', overCap.body.upgradeUrl === '/pricing')

  const entAlert = await req('/sqftlab/alerts', {
    method: 'POST', body: { district: community.slug, name: 'Zz ent alert' }, token: entUser,
  })
  check('enterprise is not capped by the pro limit', entAlert.status === 201, entAlert.status)
  if (entAlert.body.alert?.id) createdAlertIds.push(entAlert.body.alert.id)

  const listed = await req('/sqftlab/alerts', { token: proUser })
  check('GET /alerts → 200', listed.status === 200, listed.status)
  check('only ACTIVE alerts are listed', listed.body.alerts?.every((a) => a.active === true))
  check('the list reports the tier limit', listed.body.limit === 5, listed.body.limit)
  check('the list flags being at the limit', listed.body.atLimit === true, listed.body.atLimit)

  const first = listed.body.alerts?.[0]
  check('each alert carries its match count', typeof first?._count?.matches === 'number', first?._count)
  check('each alert carries at most 3 recent matches', Array.isArray(first?.matches) && first.matches.length <= 3, first?.matches?.length)
  check('the recent-match rows include their listing', first?.matches?.[0]?.listing != null)
  check('lastCheckedAt was stamped by the scan', first?.lastCheckedAt != null, first?.lastCheckedAt)

  // The threshold has to actually mean something: the cheap listing should have
  // matched, the expensive one should not.
  const allMatches = await prisma.alertMatch.findMany({ where: { alertId: { in: createdAlertIds } }, select: { listingId: true, psfDiscount: true } })
  const matchedIds = new Set(allMatches.map((m) => m.listingId))
  const [belowId, aboveId, rentId] = createdListingIds
  check('a listing below the district threshold matched', matchedIds.has(belowId))
  check('a listing above the threshold did NOT match', !matchedIds.has(aboveId))
  check('a cheap RENTAL did not match a sale alert', !matchedIds.has(rentId))
  check('matches carry a positive psfDiscount', allMatches.every((m) => m.psfDiscount > 0), allMatches.slice(0, 2))

  // ── Task C — the scan is idempotent and honest ──────────────────────────────
  console.log('\n── Task C: scan + notify ──')
  const before = await prisma.alertMatch.count({ where: { alertId: { in: createdAlertIds } } })
  const rescan = await scanDealAlerts()
  const after = await prisma.alertMatch.count({ where: { alertId: { in: createdAlertIds } } })
  check('re-running the scan creates no duplicate matches', after === before, { before, after })
  check('re-running reports them as already matched', rescan.alreadyMatched > 0, rescan.alreadyMatched)

  const notify = await notifyPendingMatches()
  check('notify reports when no mail transport is configured', notify.transport === 'unconfigured', notify.transport)
  check('notify sends nothing without a transport', notify.sent === 0, notify.sent)
  check('notify explains why', typeof notify.reason === 'string' && notify.reason.length > 0)

  // THE HONESTY PROPERTY: the spec marked every pending match `notifiedAt` right
  // after a `.catch(() => {})` on the send — so a failed or impossible delivery
  // erased the alert permanently. With no transport, nothing may be marked sent.
  const stillPending = await prisma.alertMatch.count({ where: { alertId: { in: createdAlertIds }, notified: false } })
  check(
    'an undelivered match is NOT marked notified (it would be lost forever)',
    stillPending === before,
    { stillPending, before },
  )

  // ── Task B — deactivation preserves history ─────────────────────────────────
  console.log('\n── Task B: delete is soft ──')
  const victim = createdAlertIds[0]
  const matchesBeforeDelete = await prisma.alertMatch.count({ where: { alertId: victim } })
  const del = await req(`/sqftlab/alerts/${victim}`, { method: 'DELETE', token: proUser })
  check('DELETE → 200', del.status === 200, del.status)
  check('DELETE reports deactivation, not deletion', del.body.deactivated === victim)

  const row = await prisma.dealAlert.findUnique({ where: { id: victim }, select: { active: true } })
  check('the row still EXISTS after delete', row !== null)
  check('the row is marked inactive', row?.active === false, row?.active)
  const matchesAfter = await prisma.alertMatch.count({ where: { alertId: victim } })
  check('its match history SURVIVES the delete', matchesAfter === matchesBeforeDelete, { matchesBeforeDelete, matchesAfter })

  const afterList = await req('/sqftlab/alerts', { token: proUser })
  check('the deactivated alert leaves the list', !afterList.body.alerts?.some((a) => a.id === victim))
  check('deactivating frees a slot', afterList.body.atLimit === false, afterList.body.atLimit)

  const missing = await req('/sqftlab/alerts/zz-does-not-exist', { method: 'DELETE', token: proUser })
  check('deleting an unknown alert → 404', missing.status === 404, missing.status)

  const othersAlert = await req(`/sqftlab/alerts/${victim}`, { method: 'DELETE', token: freeUser })
  check("another user cannot deactivate someone else's alert", othersAlert.status === 404, othersAlert.status)

  // ── Task D — score endpoint and its tier gate ───────────────────────────────
  console.log('\n── Task D: Investment Score ──')

  const scored = await latestInvestmentScores()
  let slug = scored.size > 0 ? null : community.slug
  if (!slug) {
    const someId = [...scored.keys()][0]
    const c2 = await prisma.community.findUnique({ where: { id: someId }, select: { slug: true } })
    slug = c2?.slug ?? community.slug
  }
  if (scored.size === 0) await computeInvestmentScore(community.id)

  const unknownSlug = await req('/sqftlab/scores/zz-no-such-community')
  check('unknown community → 404', unknownSlug.status === 404, unknownSlug.status)

  const asGuest = await req(`/sqftlab/scores/${slug}`)
  check('guest score request → 200', asGuest.status === 200, asGuest.status)
  check('guest sees the composite', typeof asGuest.body.score === 'number', asGuest.body.score)
  check('guest does NOT receive a breakdown', asGuest.body.breakdown === null, asGuest.body.breakdown)
  check('guest is told why it is locked', typeof asGuest.body.lockedReason === 'string')
  check('guest still gets the data-coverage caveat', typeof asGuest.body.dataCoverage === 'number')
  check('guest still gets the driver note', asGuest.body.notes !== undefined)
  check('the locked response advertises the upgrade', asGuest.body.upgradeUrl === '/pricing')

  const asPro = await req(`/sqftlab/scores/${slug}`, { token: proUser })
  check('pro score request → 200', asPro.status === 200, asPro.status)
  check('pro RECEIVES the breakdown', asPro.body.breakdown !== null, asPro.body.breakdown)
  check(
    "the breakdown carries the engine's five factors",
    ['psfMomentum', 'rentalYield', 'supplyAbsorption', 'volumeTrend', 'capitalFlow'].every(
      (k) => k in (asPro.body.breakdown ?? {}),
    ),
    Object.keys(asPro.body.breakdown ?? {}),
  )
  check('pro is not marked locked', asPro.body.breakdownLocked === false)
  check(
    'the breakdown names its placeholder factor honestly',
    Array.isArray(asPro.body.placeholderFactors) && asPro.body.placeholderFactors.includes('capitalFlow'),
    asPro.body.placeholderFactors,
  )

  // Withholding has to mean ABSENT, not merely un-rendered: no factor key may
  // appear anywhere in the guest payload.
  //
  // This compares KEYS, not values. A value comparison false-fires whenever the
  // composite coincides with a factor — with every input at the neutral 50 the
  // composite is exactly 50, so `"score":50` looks like a leaked factor.
  const factorKeys = ['psfMomentum', 'rentalYield', 'supplyAbsorption', 'volumeTrend', 'capitalFlow']
  const guestRaw = JSON.stringify(asGuest.body)
  const leakedKeys = factorKeys.filter((k) => guestRaw.includes(k))
  check('no factor key appears anywhere in the guest payload', leakedKeys.length === 0, { leakedKeys })

  const listRaw = JSON.stringify((await req('/sqftlab/scores')).body)
  check('the scores LIST endpoint withholds the factor keys too', !factorKeys.some((k) => listRaw.includes(k)))

  // ── the engineer's own contract: score matches the stored row ───────────────
  const stored = (await latestInvestmentScores()).get(
    (await prisma.community.findUnique({ where: { slug }, select: { id: true } }))?.id ?? '',
  )
  if (stored) {
    check('the served score equals the persisted composite', asPro.body.score === stored.score, {
      served: asPro.body.score, stored: stored.score,
    })
  }
} catch (e) {
  failed++
  failures.push('suite threw')
  console.log(`  ✗ suite threw — ${(e as Error).message}`)
} finally {
  const m = await prisma.alertMatch.deleteMany({ where: { alertId: { in: createdAlertIds } } })
  const a = await prisma.dealAlert.deleteMany({ where: { userId: { in: createdUserIds } } })
  const l = await prisma.listing.deleteMany({ where: { externalId: { startsWith: ID } } })
  const ue = await prisma.userEvent.deleteMany({ where: { userId: { in: createdUserIds } } })
  const us = await prisma.user.deleteMany({ where: { email: { startsWith: ID } } })
  console.log(`\n  cleaned up: ${m.count} matches, ${a.count} alerts, ${l.count} listings, ${ue.count} events, ${us.count} users`)
  await prisma.$disconnect()

  console.log(`\n  ${passed} passed, ${failed} failed`)
  if (failed > 0) console.log(`  failing: ${failures.join(' | ')}`)
  process.exit(failed > 0 ? 1 : 0)
}
