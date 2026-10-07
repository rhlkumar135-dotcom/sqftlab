/**
 * Day 16 end-to-end verification — Deal Origination Network.
 *
 * Hits the RUNNING server over HTTP (localhost:3101) because that is the path a client
 * takes, and because several assertions are about gate ordering and route precedence
 * (`/mine` vs `/:id`) that an in-process `app.request()` call can hide.
 *
 * DATABASE_URL: the sandbox shell exports a DATABASE_URL pointing at the WORKSPACE-ROOT
 * stub database, which shadows this project's .env. `src/lib/db` would then read an empty
 * database while the server reads the real one. The script refuses to run unless the URL
 * is this project's dev.db — compared as resolved absolute paths, because the stub also
 * ends in `/prisma/dev.db` and a substring check would pass against it.
 *
 * Writes: three throwaway users (`verify-day16-*@example.invalid`), their deal briefs and
 * expressions, plus the UserEvent rows the routes emit. All of it is deleted in the
 * `finally` block. The seeded demo account (demo@sqftlab.com, tier `elite`) is never
 * modified — and it is used deliberately as the "insufficient tier" case.
 */
import { prisma } from '../src/lib/db'
import { resolve } from 'node:path'

const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3101'
const EXPECTED_DB = resolve('prisma/dev.db')

function isProjectDb(url: string): boolean {
  if (!url) return false
  const path = url.replace(/^file:\/\//, '').replace(/^file:/, '')
  return resolve(path) === EXPECTED_DB
}

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title: string) {
  console.log(`\n── ${title}`)
}

async function req(
  path: string,
  init: RequestInit & { userId?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers = new Headers(init.headers)
  if (init.userId) headers.set('Authorization', `Bearer ${init.userId}`)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: 'manual' })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, body }
}

const POSTER_EMAIL = 'verify-day16-poster@example.invalid'
const BUYER_EMAIL = 'verify-day16-buyer@example.invalid'
const FREE_EMAIL = 'verify-day16-free@example.invalid'
const DEMO_EMAIL = 'demo@sqftlab.com'

const VALID_DEAL = {
  title: 'Marina tower floor, off-market',
  community: 'Dubai Marina',
  bedrooms: 2,
  sizeSqftMin: 1100,
  sizeSqftMax: 1400,
  askingPriceAed: 3_200_000,
  targetYieldPct: 6.5,
  dealType: 'acquisition',
  description: 'Full floor in a 2019 tower, single owner since handover, motivated seller.',
}

async function main() {
  const url = process.env.DATABASE_URL ?? ''
  if (!isProjectDb(url)) {
    console.error(
      `Refusing to run: DATABASE_URL must resolve to this project's ${EXPECTED_DB}.\n` +
        `Got "${url || '<unset>'}" — the sandbox shell's default points at the workspace-root\n` +
        `stub, and the server would disagree with whatever this script checked.\n` +
        `Run: DATABASE_URL=file:${EXPECTED_DB} bun run scripts/verify-day16.ts`,
    )
    process.exit(2)
  }

  let posterId = ''
  let buyerId = ''
  let freeId = ''
  let demoId = ''

  try {
    // ── Fixtures ──────────────────────────────────────────────────────────────
    const [poster, buyer, free, demo] = await Promise.all([
      prisma.user.create({
        data: {
          email: POSTER_EMAIL,
          name: 'Verify Poster',
          company: 'Verify Capital',
          subscriptionTier: 'enterprise',
        },
      }),
      prisma.user.create({
        data: { email: BUYER_EMAIL, name: 'Verify Buyer', company: null, subscriptionTier: 'enterprise' },
      }),
      prisma.user.create({
        data: { email: FREE_EMAIL, name: 'Verify Free', subscriptionTier: 'free' },
      }),
      prisma.user.findFirst({ where: { email: DEMO_EMAIL }, select: { id: true, subscriptionTier: true } }),
    ])
    posterId = poster.id
    buyerId = buyer.id
    freeId = free.id
    demoId = demo?.id ?? ''

    // ── Gate ──────────────────────────────────────────────────────────────────
    section('Gate — enterprise only')
    {
      const anon = await req('/api/sqftlab/deal-briefs')
      check('anonymous → 403', anon.status === 403, `got ${anon.status}`)
      check(
        'refusal names the required tier and the feature',
        anon.body.requiredTier === 'enterprise' && anon.body.feature === 'Deal Origination Network',
        JSON.stringify(anon.body),
      )
      check('refusal points at the pricing page', anon.body.upgradeUrl === '/pricing')

      const asFree = await req('/api/sqftlab/deal-briefs', { userId: freeId })
      check('free tier → 403', asFree.status === 403, `got ${asFree.status}`)

      if (demoId) {
        const asDemo = await req('/api/sqftlab/deal-briefs', { userId: demoId })
        check(
          `elite tier → 403 (demo account is '${demo?.subscriptionTier}')`,
          asDemo.status === 403,
          `got ${asDemo.status}`,
        )
        check('refusal reports the current tier', asDemo.body.currentTier === 'elite', String(asDemo.body.currentTier))
      }

      // Every route in the network is gated, not just the list.
      for (const [label, path, init] of [
        ['POST /deal-briefs', '/api/sqftlab/deal-briefs', { method: 'POST', body: JSON.stringify(VALID_DEAL) }],
        ['GET /deal-briefs/mine', '/api/sqftlab/deal-briefs/mine', {}],
        ['GET /deal-briefs/:id', '/api/sqftlab/deal-briefs/anything', {}],
        ['POST /deal-briefs/:id/express', '/api/sqftlab/deal-briefs/anything/express', { method: 'POST', body: '{}' }],
      ] as const) {
        const r = await req(path, { ...(init as RequestInit) })
        check(`${label} anonymous → 403`, r.status === 403, `got ${r.status}`)
      }
    }

    // ── Privacy of the generated CRUD surface ─────────────────────────────────
    section('Privacy — the ungated generated CRUD must not expose the network')
    {
      const auto = await req('/api/deal-briefs')
      const autoExpr = await req('/api/deal-expressions')
      check(
        '/api/deal-briefs (auto-CRUD) is not mounted',
        auto.status === 404,
        `got ${auto.status}: ${JSON.stringify(auto.body).slice(0, 120)}`,
      )
      check('/api/deal-expressions (auto-CRUD) is not mounted', autoExpr.status === 404, `got ${autoExpr.status}`)
    }

    // ── Create ────────────────────────────────────────────────────────────────
    section('POST /sqftlab/deal-briefs — create')
    let dealId = ''
    let buyerDealId = ''
    {
      const r = await req('/api/sqftlab/deal-briefs', {
        method: 'POST',
        userId: posterId,
        body: JSON.stringify(VALID_DEAL),
      })
      check('enterprise → 201', r.status === 201, `got ${r.status}: ${JSON.stringify(r.body).slice(0, 160)}`)
      dealId = String(r.body.id ?? '')
      check('returns an id', dealId.length > 0)
      check('status defaults to active', r.body.status === 'active', String(r.body.status))
      check('isConfidential defaults to true', r.body.isConfidential === true)
      check('beds stored as given', r.body.bedrooms === 2, String(r.body.bedrooms))
      check(
        'community resolved against the community table',
        r.body.communityMatched === true,
        `communityMatched=${r.body.communityMatched}`,
      )

      // The headline Day 16 item: DLD context auto-attached. This deployment has no
      // transaction rows, so the honest result is transCount 0 and a NULL average —
      // the assertion is that it is *populated from the register*, not guessed at.
      const txRows = await prisma.transaction.count({
        where: { communityId: { not: '' }, pricePerSqft: { gt: 100 } },
      })
      check('dldTransCount is a number', typeof r.body.dldTransCount === 'number', String(r.body.dldTransCount))
      check('dldLastUpdated is stamped', typeof r.body.dldLastUpdated === 'string')
      if (txRows === 0) {
        check(
          'with 0 registered transactions, dldAvgPsfAed is null (not fabricated)',
          r.body.dldAvgPsfAed === null,
          String(r.body.dldAvgPsfAed),
        )
        check('and dldTransCount is 0', r.body.dldTransCount === 0, String(r.body.dldTransCount))
      }
      check(
        'market context carries provenance, not just a number',
        typeof r.body.marketContext === 'object' &&
          r.body.marketContext !== null &&
          'source' in (r.body.marketContext as object),
        JSON.stringify(r.body.marketContext),
      )
    }

    // ── Validation ────────────────────────────────────────────────────────────
    section('POST — validation and mass-assignment')
    {
      const cases: [string, Record<string, unknown>, number][] = [
        ['missing title', { ...VALID_DEAL, title: undefined }, 400],
        ['title too short', { ...VALID_DEAL, title: 'ab' }, 400],
        ['missing description', { ...VALID_DEAL, description: undefined }, 400],
        ['bad dealType', { ...VALID_DEAL, dealType: 'land-grab' }, 400],
        ['negative price', { ...VALID_DEAL, askingPriceAed: -5 }, 400],
        ['yield over 100', { ...VALID_DEAL, targetYieldPct: 250 }, 400],
        ['fractional bedrooms', { ...VALID_DEAL, bedrooms: 2.5 }, 400],
        ['sizeSqftMin above max', { ...VALID_DEAL, sizeSqftMin: 2000, sizeSqftMax: 1000 }, 400],
        ['isConfidential not boolean', { ...VALID_DEAL, isConfidential: 'yes' }, 400],
        ['malformed JSON', undefined as unknown as Record<string, unknown>, 400],
      ]
      for (const [label, payload, want] of cases) {
        const r = await req('/api/sqftlab/deal-briefs', {
          method: 'POST',
          userId: posterId,
          body: payload === undefined ? '{not json' : JSON.stringify(payload),
        })
        check(`${label} → ${want}`, r.status === want, `got ${r.status}: ${JSON.stringify(r.body).slice(0, 120)}`)
      }

      // The brief spreads the body into create(), which would honour all of these.
      const escalate = await req('/api/sqftlab/deal-briefs', {
        method: 'POST',
        userId: buyerId,
        body: JSON.stringify({
          ...VALID_DEAL,
          title: 'Mass assignment probe',
          userId: posterId,
          status: 'closed',
          dldAvgPsfAed: 99999,
          dldTransCount: 424242,
          isConfidential: true,
        }),
      })
      check('escalation attempt still 201', escalate.status === 201, `got ${escalate.status}`)
      buyerDealId = String(escalate.body.id ?? '')
      check('  userId not overridden (posted as the caller)', escalate.body.userId === buyerId, String(escalate.body.userId))
      check("  status not forced to 'closed'", escalate.body.status === 'active', String(escalate.body.status))
      check('  dldAvgPsfAed not fabricated', escalate.body.dldAvgPsfAed === null, String(escalate.body.dldAvgPsfAed))
      check('  dldTransCount not fabricated', escalate.body.dldTransCount === 0, String(escalate.body.dldTransCount))
    }

    // ── List ──────────────────────────────────────────────────────────────────
    section('GET /sqftlab/deal-briefs — list, filters, no email leak')
    {
      const r = await req('/api/sqftlab/deal-briefs', { userId: buyerId })
      check('→ 200', r.status === 200, `got ${r.status}`)
      const deals = (r.body.deals ?? []) as Record<string, unknown>[]
      check('returns deals', deals.length >= 2, `got ${deals.length}`)
      check('exposes the four deal types', Array.isArray(r.body.dealTypes) && (r.body.dealTypes as unknown[]).length === 4)
      const one = deals.find((d) => d.id === dealId)
      check('the created deal is listed', !!one)
      check(
        'poster name and company attached (no email)',
        !!one && typeof one.user === 'object' && 'name' in (one.user as object) && !('email' in (one.user as object)),
        JSON.stringify(one?.user),
      )
      check('expression count attached', !!one && typeof one._count === 'object')
      check('never leaks a poster email anywhere in the payload', !JSON.stringify(r.body).includes('@example.invalid'))
      check('marketContext attached per deal', !!one && typeof one.marketContext === 'object')

      const byType = await req('/api/sqftlab/deal-briefs?dealType=acquisition', { userId: buyerId })
      check('filter by dealType → 200', byType.status === 200)
      check(
        'filter actually applied',
        ((byType.body.deals ?? []) as Record<string, unknown>[]).every((d) => d.dealType === 'acquisition'),
      )

      const badType = await req('/api/sqftlab/deal-briefs?dealType=nope', { userId: buyerId })
      check('unknown dealType → 400', badType.status === 400, `got ${badType.status}`)

      // SQLite's LIKE is ASCII case-insensitive, so no `mode: 'insensitive'` is needed —
      // that argument is rejected outright by the SQLite connector.
      const lower = await req('/api/sqftlab/deal-briefs?community=marina', { userId: buyerId })
      check('community filter is case-insensitive', lower.status === 200 && ((lower.body.deals ?? []) as unknown[]).length >= 2, `got ${((lower.body.deals ?? []) as unknown[]).length}`)

      const none = await req('/api/sqftlab/deal-briefs?community=zzzz-no-such-area', { userId: buyerId })
      check('a filter matching nothing returns an empty list, not everything', ((none.body.deals ?? []) as unknown[]).length === 0)
      check('...and says so', typeof none.body.message === 'string')
    }

    // ── /mine vs /:id ─────────────────────────────────────────────────────────
    section('GET /sqftlab/deal-briefs/mine — precedence over /:id')
    {
      const r = await req('/api/sqftlab/deal-briefs/mine', { userId: posterId })
      check('→ 200', r.status === 200, `got ${r.status}`)
      const deals = (r.body.deals ?? []) as Record<string, unknown>[]
      check('returns a { deals } envelope, not a "Deal not found" 404', Array.isArray(r.body.deals), JSON.stringify(r.body).slice(0, 120))
      check('only the caller\'s own deals', deals.every((d) => d.userId === posterId))
      check("the poster's own deal is present", deals.some((d) => d.id === dealId))
      check("another member's deal is absent", !deals.some((d) => d.id === buyerDealId))

      const buyerMine = await req('/api/sqftlab/deal-briefs/mine', { userId: buyerId })
      const buyerDeals = (buyerMine.body.deals ?? []) as Record<string, unknown>[]
      check('a different member sees only their own', buyerDeals.every((d) => d.userId === buyerId))
      check("and sees their own deal, not the other member's", buyerDeals.some((d) => d.id === buyerDealId) && !buyerDeals.some((d) => d.id === dealId))
    }

    // ── Detail ────────────────────────────────────────────────────────────────
    section('GET /sqftlab/deal-briefs/:id — detail, comps, ownership')
    {
      const asOther = await req(`/api/sqftlab/deal-briefs/${dealId}`, { userId: buyerId })
      check('→ 200 for another member', asOther.status === 200, `got ${asOther.status}`)
      const deal = (asOther.body.deal ?? {}) as Record<string, unknown>
      check('returns the deal', deal.id === dealId)
      check('reports isOwner false', deal.isOwner === false)
      check('does NOT expose the poster email', !JSON.stringify(asOther.body).includes('@example.invalid'))
      check('comps is an array', Array.isArray(asOther.body.comps))
      check(
        'compsNote explains the empty table rather than leaving it blank',
        Array.isArray(asOther.body.comps) && (asOther.body.comps as unknown[]).length === 0
          ? typeof asOther.body.compsNote === 'string'
          : true,
        String(asOther.body.compsNote),
      )
      check('the poster\'s inbox is not exposed to other members', asOther.body.expressions === undefined)

      const asOwner = await req(`/api/sqftlab/deal-briefs/${dealId}`, { userId: posterId })
      check('owner sees isOwner true', ((asOwner.body.deal ?? {}) as Record<string, unknown>).isOwner === true)
      check('owner receives the expressions array', Array.isArray(asOwner.body.expressions))

      const missing = await req('/api/sqftlab/deal-briefs/does-not-exist', { userId: buyerId })
      check('unknown id → 404', missing.status === 404, `got ${missing.status}`)
    }

    // ── Express interest ──────────────────────────────────────────────────────
    section('POST /sqftlab/deal-briefs/:id/express')
    let firstExpressionId = ''
    {
      const r = await req(`/api/sqftlab/deal-briefs/${dealId}/express`, {
        method: 'POST',
        userId: buyerId,
        body: JSON.stringify({ message: 'Interested, subject to survey.', contactOk: true }),
      })
      check('→ 201', r.status === 201, `got ${r.status}: ${JSON.stringify(r.body).slice(0, 160)}`)
      firstExpressionId = String(r.body.id ?? '')
      check('creates an expression with an id', firstExpressionId.length > 0)
      check('records consent', r.body.contactOk === true)
      check(
        'reports the email outcome honestly',
        ['sent', 'unconfigured', 'failed'].includes(String(r.body.emailStatus)),
        String(r.body.emailStatus),
      )
      check(
        'no mail transport configured in this deployment → unconfigured, not a false "sent"',
        r.body.emailStatus === 'unconfigured',
        String(r.body.emailStatus),
      )

      // Duplicate must upsert, not stack.
      const again = await req(`/api/sqftlab/deal-briefs/${dealId}/express`, {
        method: 'POST',
        userId: buyerId,
        body: JSON.stringify({ message: 'Updated: still interested.', contactOk: false }),
      })
      check('expressing twice → 201', again.status === 201, `got ${again.status}`)
      check('upserts the same row (no duplicate)', again.body.id === firstExpressionId)
      check('and applies the update', again.body.contactOk === false)
      const count = await prisma.dealExpression.count({ where: { dealId } })
      check('exactly one expression row exists', count === 1, `got ${count}`)

      const self = await req(`/api/sqftlab/deal-briefs/${dealId}/express`, {
        method: 'POST',
        userId: posterId,
        body: JSON.stringify({ message: 'Mine' }),
      })
      check('expressing interest in your own deal → 400', self.status === 400, `got ${self.status}`)

      const badContact = await req(`/api/sqftlab/deal-briefs/${dealId}/express`, {
        method: 'POST',
        userId: buyerId,
        body: JSON.stringify({ contactOk: 'yes' }),
      })
      check('non-boolean contactOk → 400', badContact.status === 400, `got ${badContact.status}`)

      const longMsg = await req(`/api/sqftlab/deal-briefs/${dealId}/express`, {
        method: 'POST',
        userId: buyerId,
        body: JSON.stringify({ message: 'x'.repeat(2001) }),
      })
      check('over-long message → 400', longMsg.status === 400, `got ${longMsg.status}`)

      const unknown = await req('/api/sqftlab/deal-briefs/nope/express', {
        method: 'POST',
        userId: buyerId,
        body: '{}',
      })
      check('unknown deal → 404', unknown.status === 404, `got ${unknown.status}`)

      // The owner now sees it.
      const owner = await req(`/api/sqftlab/deal-briefs/${dealId}`, { userId: posterId })
      const exprs = (owner.body.expressions ?? []) as Record<string, unknown>[]
      check('the poster sees the expression', exprs.length === 1, `got ${exprs.length}`)
      check('with the expresser\'s name', !!exprs[0] && 'name' in ((exprs[0].user ?? {}) as object))
      check('and the consent flag', exprs[0]?.contactOk === false)

      // Sanity: consent default is opt-in.
      const dealForDefault = await prisma.dealBrief.create({
        data: {
          userId: posterId,
          title: 'Consent default probe',
          community: 'Dubai Marina',
          dealType: 'acquisition',
          description: 'Checks that consent is opt-in rather than implied.',
        },
      })
      const noConsent = await req(`/api/sqftlab/deal-briefs/${dealForDefault.id}/express`, {
        method: 'POST',
        userId: buyerId,
        body: '{}',
      })
      check('omitting contactOk records consent as false', noConsent.body.contactOk === false, String(noConsent.body.contactOk))
    }

    // ── Status transitions ────────────────────────────────────────────────────
    section('PATCH /sqftlab/deal-briefs/:id — owner only, validated')
    {
      const asOther = await req(`/api/sqftlab/deal-briefs/${dealId}`, {
        method: 'PATCH',
        userId: buyerId,
        body: JSON.stringify({ status: 'closed' }),
      })
      check('a non-owner cannot change the status → 404', asOther.status === 404, `got ${asOther.status}`)

      const toOffer = await req(`/api/sqftlab/deal-briefs/${dealId}`, {
        method: 'PATCH',
        userId: posterId,
        body: JSON.stringify({ status: 'under-offer' }),
      })
      check('owner sets under-offer → 200', toOffer.status === 200, `got ${toOffer.status}`)
      check('status updated', toOffer.body.status === 'under-offer', String(toOffer.body.status))

      const badStatus = await req(`/api/sqftlab/deal-briefs/${dealId}`, {
        method: 'PATCH',
        userId: posterId,
        body: JSON.stringify({ status: 'sold-maybe' }),
      })
      check('an unknown status → 400 (not written)', badStatus.status === 400, `got ${badStatus.status}`)
      const afterBad = await prisma.dealBrief.findUnique({ where: { id: dealId }, select: { status: true } })
      check('and the stored status is unchanged', afterBad?.status === 'under-offer', String(afterBad?.status))

      const escalate = await req(`/api/sqftlab/deal-briefs/${dealId}`, {
        method: 'PATCH',
        userId: posterId,
        body: JSON.stringify({ userId: buyerId, dldAvgPsfAed: 55555, dldTransCount: 777, createdAt: '2000-01-01' }),
      })
      check('a body of only protected fields → 400, nothing to update', escalate.status === 400, `got ${escalate.status}`)
      const after = await prisma.dealBrief.findUnique({
        where: { id: dealId },
        select: { userId: true, dldAvgPsfAed: true, dldTransCount: true },
      })
      check('userId unchanged', after?.userId === posterId)
      check('dldAvgPsfAed unchanged', after?.dldAvgPsfAed === null, String(after?.dldAvgPsfAed))
      check('dldTransCount unchanged', after?.dldTransCount === 0, String(after?.dldTransCount))

      const closed = await req(`/api/sqftlab/deal-briefs/${dealId}`, {
        method: 'PATCH',
        userId: posterId,
        body: JSON.stringify({ status: 'closed' }),
      })
      check('owner closes the deal → 200', closed.status === 200, `got ${closed.status}`)

      const expressClosed = await req(`/api/sqftlab/deal-briefs/${dealId}/express`, {
        method: 'POST',
        userId: buyerId,
        body: JSON.stringify({ message: 'Too late?' }),
      })
      check('expressing interest in a closed deal → 409', expressClosed.status === 409, `got ${expressClosed.status}`)

      const closedGone = await req('/api/sqftlab/deal-briefs', { userId: buyerId })
      check(
        'a closed deal leaves the default (active) list',
        !((closedGone.body.deals ?? []) as Record<string, unknown>[]).some((d) => d.id === dealId),
      )
      const closedShown = await req('/api/sqftlab/deal-briefs?status=closed', { userId: buyerId })
      check(
        'but is retrievable with status=closed',
        ((closedShown.body.deals ?? []) as Record<string, unknown>[]).some((d) => d.id === dealId),
      )
      const badStatusFilter = await req('/api/sqftlab/deal-briefs?status=bogus', { userId: buyerId })
      check('unknown status filter → 400', badStatusFilter.status === 400, `got ${badStatusFilter.status}`)
    }

    // ── Analytics ─────────────────────────────────────────────────────────────
    section('Analytics')
    {
      const events = await prisma.userEvent.findMany({
        where: { userId: { in: [posterId, buyerId] }, eventType: { in: ['deal_posted', 'deal_expression', 'deal_status_changed'] } },
        select: { eventType: true },
      })
      const types = new Set(events.map((e) => e.eventType))
      check("'deal_posted' recorded", types.has('deal_posted'))
      check("'deal_expression' recorded", types.has('deal_expression'))
      check("'deal_status_changed' recorded", types.has('deal_status_changed'))
    }
  } finally {
    // ── Teardown ──────────────────────────────────────────────────────────────
    // Every fixture row, in FK order. A leftover row would sit in the live database
    // and be indistinguishable from real network activity.
    const ids = [posterId, buyerId, freeId].filter(Boolean)
    if (ids.length) {
      const briefs = await prisma.dealBrief.findMany({ where: { userId: { in: ids } }, select: { id: true } })
      const briefIds = briefs.map((b) => b.id)
      if (briefIds.length) {
        await prisma.dealExpression.deleteMany({ where: { OR: [{ dealId: { in: briefIds } }, { userId: { in: ids } }] } })
        await prisma.dealBrief.deleteMany({ where: { id: { in: briefIds } } })
      }
      // Expressions the fixtures left on other members' deals (none today, but a
      // future edit to this file must not be able to strand rows).
      await prisma.dealExpression.deleteMany({ where: { userId: { in: ids } } })
      await prisma.userEvent.deleteMany({ where: { userId: { in: ids } } })
      await prisma.user.deleteMany({ where: { id: { in: ids } } })
    }
  }

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`Day 16: ${passed} passed, ${failed} failed`)
  if (failed) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  · ${f}`)
  }
  await prisma.$disconnect()
  process.exit(failed ? 1 : 0)
}

await main()
