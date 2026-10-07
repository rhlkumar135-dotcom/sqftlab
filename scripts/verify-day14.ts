// Day 14 verification — WhatsApp digest + mortgage calculator.
//
// Run:
//   cp prisma/dev.db /tmp/day14-e2e.db
//   DATABASE_URL=file:/tmp/day14-e2e.db bun run scripts/verify-day14.ts
//
// Runs the real Hono app in-process against a throwaway COPY. A copy is required: this
// suite seeds DLD transactions to exercise the calculator's pre-fill path and creates
// subscriber rows to exercise the digest, none of which belong in the project database.
import { prisma } from '../src/lib/db'

const dbUrl = process.env.DATABASE_URL ?? ''
if (!dbUrl.includes('day14-e2e')) {
  throw new Error(
    `Refusing to run: DATABASE_URL must point at the disposable copy (…day14-e2e.db), got "${dbUrl || '<unset>'}".\n` +
      'This suite seeds transactions and subscriber rows, which must not land in the project database.',
  )
}

const { default: app } = await import('../custom-routes')
const {
  normaliseE164,
  isUaeMobile,
  buildDigest,
  buildConfirmation,
  isStopKeyword,
  resolveTwilioConfig,
  isWhatsappConfigured,
} = await import('../src/lib/whatsapp')
const { computeMortgage, monthlyPayment, buildSchedule, minDownPaymentPct, upfrontCosts } = await import(
  '../src/lib/mortgage'
)
const { sendWhatsappDigests } = await import('../src/lib/whatsapp-jobs')

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

async function call(path: string, opts: { method?: string; token?: string; body?: unknown; form?: string } = {}) {
  const headers: Record<string, string> = {}
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  if (opts.form !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded'
  else if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await app.request(path, {
    method: opts.method ?? 'GET',
    headers,
    ...(opts.form !== undefined ? { body: opts.form } : opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
  const text = await res.text()
  let body: any = {}
  try { body = text ? JSON.parse(text) : {} } catch { body = {} }
  return { status: res.status, body, res }
}

const users: string[] = []
async function mkuser(tier: string, phone?: string) {
  const u = await prisma.user.create({
    data: {
      email: `d14v-${tier}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@verify.test`,
      name: `${tier} verify`,
      subscriptionTier: tier,
      role: 'investor',
      ...(phone
        ? { whatsappPhone: phone, whatsappEnabled: true, digestFrequency: 'daily', whatsappAreas: JSON.stringify(['dubai-marina']) }
        : {}),
    },
    select: { id: true },
  })
  users.push(u.id)
  return u
}

const txnIds: string[] = []
const tag = `d14-${Date.now()}`

try {
  console.log('\n── phone normalisation ──')
  check('the brief form is accepted', normaliseE164('+971501234567') === '+971501234567')
  check('a UAE local number is normalised, not rejected', normaliseE164('0501234567') === '+971501234567')
  check('a 00 prefix is normalised', normaliseE164('00971501234567') === '+971501234567')
  check('a bare country code is normalised', normaliseE164('971501234567') === '+971501234567')
  check('separators are tolerated', normaliseE164('+971 50-123 4567') === '+971501234567')
  check('letters are rejected', normaliseE164('call me') === null)
  check('too short is rejected', normaliseE164('+97150') === null)
  check('a leading zero as country code is rejected', normaliseE164('+0501234567') === null)
  check('non-string is rejected', normaliseE164(971501234567) === null)
  check('UAE mobile detection', isUaeMobile('+971501234567') && !isUaeMobile('+14155552671'))

  console.log('\n── digest composition (a quiet day is stated as quiet) ──')
  const quiet = buildDigest('Sara Ali', [
    { slug: 'a', name: 'JLT', transactionsYesterday: 0, psfYesterday: 0, psf90d: 1500 },
  ], { now: new Date('2026-10-07T04:00:00Z') })
  check('no sales is stated, not inferred from a zero PSF', /No registered sales yesterday/i.test(quiet))
  check('no PSF is claimed for a day with no sales', !/PSF: AED 0/.test(quiet))
  check('the 90-day context is still offered', /90-day average/.test(quiet))
  check('no percentage change is invented without a comparison', !/%/.test(quiet.split('90-day')[0]))

  const busy = buildDigest(null, [
    { slug: 'b', name: 'Dubai Marina', transactionsYesterday: 4, psfYesterday: 2200, psf90d: 2000 },
  ], { now: new Date('2026-10-07T04:00:00Z') })
  check('a busy day reports the count', /4 transactions yesterday/.test(busy))
  check('the delta is computed against the 90-day average', /↑ 10\.0% vs 90d/.test(busy))
  check('downward motion gets the down arrow', /↓/.test(buildDigest(null, [{ slug: 'c', name: 'X', transactionsYesterday: 1, psfYesterday: 1800, psf90d: 2000 }])))
  check('single transaction is not pluralised', /1 transaction yesterday/.test(buildDigest(null, [{ slug: 'd', name: 'Y', transactionsYesterday: 1, psfYesterday: 2100, psf90d: 2000 }])))
  check('a greeting uses the first name', /Hi Sara,/.test(quiet))
  check('the STOP instruction is always present', /Reply STOP to unsubscribe/.test(busy))

  const many = Array.from({ length: 5 }, (_, i) => ({ slug: `s${i}`, name: `Area ${i}`, transactionsYesterday: 1, psfYesterday: 2000, psf90d: 2000 }))
  const capped = buildDigest(null, many)
  check('the digest is capped at 3 communities', (capped.match(/\*Area /g) ?? []).length === 3)
  check('the omitted count is reported rather than hidden', /\+2 more tracked area/.test(capped))
  check('no tracked communities is stated', /No tracked communities/.test(buildDigest(null, [])))

  check('STOP is recognised', isStopKeyword('stop') && isStopKeyword(' STOP ') && isStopKeyword('Unsubscribe'))
  check('ordinary text is not treated as STOP', !isStopKeyword('how much is my flat worth'))
  check('confirmation names the areas', /dubai-marina, jlt/.test(buildConfirmation(['dubai-marina', 'jlt'], 'weekly')))

  console.log('\n── transport configuration is honest about absence ──')
  check('no env resolves to null', resolveTwilioConfig({} as NodeJS.ProcessEnv) === null)
  check('a sid without a token is not configured', resolveTwilioConfig({ TWILIO_ACCOUNT_SID: 'AC1' } as NodeJS.ProcessEnv) === null)
  check('isWhatsappConfigured mirrors it', isWhatsappConfigured({} as NodeJS.ProcessEnv) === false)
  const cfg = resolveTwilioConfig({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok' } as NodeJS.ProcessEnv)
  check('the sandbox sender is the default FROM', cfg?.from === 'whatsapp:+14155238886')
  check('an explicit FROM wins', resolveTwilioConfig({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_WHATSAPP_FROM: 'whatsapp:+971500000000' } as NodeJS.ProcessEnv)?.from === 'whatsapp:+971500000000')

  console.log('\n── mortgage maths ──')
  // Reference: 2,000,000 at 25% down = 1,500,000 over 25y at 4.5% -> 8,337.50/mo.
  const m = computeMortgage({ price: 2_000_000, downPaymentPct: 25, ratePct: 4.5, termYears: 25 })
  check('down payment is exact', m.downPayment === 500_000)
  check('loan amount is exact', m.loanAmount === 1_500_000)
  check('monthly payment matches the annuity formula', m.monthly === 8337, m.monthly)
  check('total interest exceeds the loan (not zeroed)', m.totalInterest > 700_000, m.totalInterest)
  check('a zero rate divides evenly instead of NaN', monthlyPayment(1_200_000, 0, 20) === 5000)
  check('a zero loan is zero, not NaN', monthlyPayment(0, 4.5, 25) === 0)
  check('a negative loan does not produce a negative payment', monthlyPayment(-5, 4.5, 25) === 0)
  check('principal falls to zero at the end of term', m.schedule[m.schedule.length - 1].remainingBalance === 0)
  check('the schedule covers the whole term, not 5 years', m.schedule.length === 25)
  // The brief's route builds 5 years, so its "Year 25" figure cannot exist.
  check('a 25-year term exposes a final-year split', buildSchedule(1_000_000, 4.5, 25).at(-1)?.year === 25)
  const y1 = m.schedule[0]
  check('year 1 is interest-heavy', y1.interestPaid > y1.principalPaid, y1)
  const yN = m.schedule[24]
  check('the final year is principal-heavy', yN.principalPaid > yN.interestPaid, yN)
  check('a 10-year term is half the schedule of 20', buildSchedule(1e6, 4.5, 10).length * 2 === buildSchedule(1e6, 4.5, 20).length)

  console.log('\n── UAE cost rules ──')
  check('under AED 5M the floor is 20%', minDownPaymentPct(4_900_000) === 20)
  check('above AED 5M the floor rises', minDownPaymentPct(6_000_000) === 30)
  const costs = upfrontCosts(2_000_000)
  check('DLD transfer fee is 4%', costs.transferFee === 80_000)
  check('registration fee is AED 4,000', costs.registrationFee === 4000)
  check('total upfront is the sum', costs.total === 84_000)
  check('a zero price carries no registration fee', upfrontCosts(0).registrationFee === 0)

  console.log('\n── the client maths and the server route must agree ──')
  for (const [price, down, rate, term] of [
    [2_000_000, 25, 4.5, 25],
    [1_350_000, 20, 3.99, 20],
    [5_500_000, 30, 5.25, 15],
    [800_000, 40, 4.0, 10],
  ] as const) {
    const server = await call('/sqftlab/mortgage/simulate', {
      method: 'POST',
      body: { price, downPaymentPct: down, ratePct: rate, termYears: term },
    })
    const local = computeMortgage({ price, downPaymentPct: down, ratePct: rate, termYears: term })
    check(
      `agrees with /mortgage/simulate at ${price}/${down}%/${rate}%/${term}y`,
      server.body.emi === local.monthly &&
        server.body.loanAmount === local.loanAmount &&
        server.body.totalInterest === local.totalInterest,
      { server: { emi: server.body.emi, loan: server.body.loanAmount, interest: server.body.totalInterest }, local: { emi: local.monthly, loan: local.loanAmount, interest: local.totalInterest } },
    )
  }

  console.log('\n── /mortgage/estimate ──')
  const noArg = await call('/sqftlab/mortgage/estimate')
  check('a missing community is 400', noArg.status === 400, noArg.status)
  const unknown = await call('/sqftlab/mortgage/estimate?community=zzz-nope')
  check('an unknown community is 404', unknown.status === 404, unknown.status)
  const badBeds = await call('/sqftlab/mortgage/estimate?community=dubai-marina&bedrooms=abc')
  check('a non-numeric bedroom count is 400', badBeds.status === 400, badBeds.status)
  check('the 400 names the offending field', Array.isArray(badBeds.body.fields) && badBeds.body.fields.includes('bedrooms'))
  const badSize = await call('/sqftlab/mortgage/estimate?community=dubai-marina&sizeSqft=-5')
  check('a negative size is 400', badSize.status === 400, badSize.status)

  // Seed real comparables plus four decoys.
  const community = await prisma.community.findFirst({ where: { slug: 'dubai-marina' }, select: { id: true } })
  if (!community) throw new Error('dubai-marina missing from the copy — cannot exercise the pre-fill path')
  const recent = new Date(Date.now() - 10 * 24 * 3600 * 1000)
  const old = new Date(Date.now() - 200 * 24 * 3600 * 1000)
  const rows = [
    { beds: 2, psf: 2000, area: 1100, when: recent, type: 'sale' },
    { beds: 2, psf: 2100, area: 1050, when: recent, type: 'sale' },
    { beds: 2, psf: 1900, area: 1150, when: recent, type: 'off_plan_sale' },
    { beds: 2, psf: 2000, area: 1100, when: recent, type: 'sale' },
    { beds: 5, psf: 9000, area: 4000, when: recent, type: 'sale' },      // decoy: wrong bedrooms
    { beds: 2, psf: 50, area: 1100, when: recent, type: 'sale' },        // decoy: placeholder psf
    { beds: 2, psf: 8000, area: 1100, when: recent, type: 'mortgage' },  // decoy: not a sale
    { beds: 2, psf: 8000, area: 1100, when: old, type: 'sale' },         // decoy: outside 90d
  ]
  for (const [i, r] of rows.entries()) {
    const t = await prisma.transaction.create({
      data: {
        dldId: `${tag}-${i}`,
        communityId: community.id,
        transactionType: r.type,
        propertyType: 'apartment',
        beds: r.beds,
        areaSqft: r.area,
        priceAed: r.psf * r.area,
        pricePerSqft: r.psf,
        transactionDate: r.when,
        source: 'test',
      },
      select: { id: true },
    })
    txnIds.push(t.id)
  }

  const est = await call('/sqftlab/mortgage/estimate?community=dubai-marina&bedrooms=2&sizeSqft=1100')
  check('the estimate is 200 with comparables present', est.status === 200, est.status)
  check('the average PSF is the filtered mean, decoys excluded', est.body.avgPsfAed === 2000, est.body.avgPsfAed)
  check('exactly the 4 valid sales were counted', est.body.basedOnTx === 4, est.body.basedOnTx)
  check('the estimated price is PSF x size', est.body.estimatedPriceAed === 2_200_000, est.body.estimatedPriceAed)
  check('the source names the register', /DLD register/.test(est.body.source), est.body.source)
  check('no note is needed when a figure exists', est.body.note === null, est.body.note)

  const noBeds = await call('/sqftlab/mortgage/estimate?community=dubai-marina&sizeSqft=1000')
  check('omitting bedrooms widens the set instead of failing', noBeds.status === 200 && noBeds.body.basedOnTx > 4, noBeds.body.basedOnTx)

  const noSize = await call('/sqftlab/mortgage/estimate?community=dubai-marina&bedrooms=2')
  check('omitting size returns PSF but no estimated price', noSize.body.avgPsfAed === 2000 && noSize.body.estimatedPriceAed === null)

  console.log('\n── WhatsApp routes ──')
  const anon = await call('/sqftlab/whatsapp/subscribe', { method: 'POST', body: { phone: '+971501234567', communities: ['dubai-marina'] } })
  check('anonymous is 401, not 403', anon.status === 401, anon.status)

  const pro = await mkuser('pro')
  const asPro = await call('/sqftlab/whatsapp/subscribe', { method: 'POST', token: pro.id, body: { phone: '+971501234567', communities: ['dubai-marina'] } })
  check('pro is 403 with upgrade guidance', asPro.status === 403 && asPro.body.upgradeUrl === '/pricing', asPro.body)

  const ent = await mkuser('enterprise')
  const bad = await call('/sqftlab/whatsapp/subscribe', { method: 'POST', token: ent.id, body: { phone: 'nope', communities: ['x'] } })
  check('an invalid phone is 400', bad.status === 400, bad.status)
  const noAreas = await call('/sqftlab/whatsapp/subscribe', { method: 'POST', token: ent.id, body: { phone: '+971501234567', communities: [] } })
  check('an empty area list is 400', noAreas.status === 400, noAreas.status)
  const tooMany = await call('/sqftlab/whatsapp/subscribe', { method: 'POST', token: ent.id, body: { phone: '+971501234567', communities: Array.from({ length: 11 }, (_, i) => `a${i}`) } })
  check('an over-long area list is 400 with the limit', tooMany.status === 400 && tooMany.body.limit === 10, tooMany.body)

  const sub = await call('/sqftlab/whatsapp/subscribe', { method: 'POST', token: ent.id, body: { phone: '0501234567', communities: ['dubai-marina', 'jlt'], frequency: 'weekly' } })
  check('subscribe returns 201', sub.status === 201, sub.status)
  check('the local-format phone was normalised before storing', sub.body.phone === '+971501234567', sub.body.phone)
  check('the subscription is reported as undelivered, not silently accepted', sub.body.confirmationSent === false && sub.body.delivery === 'unconfigured', sub.body)
  const stored = await prisma.user.findUnique({ where: { id: ent.id }, select: { whatsappAreas: true, digestFrequency: true, whatsappEnabled: true } })
  check('areas are stored as JSON text (SQLite has no array type)', stored?.whatsappAreas === '["dubai-marina","jlt"]', stored?.whatsappAreas)
  check('frequency is stored', stored?.digestFrequency === 'weekly', stored?.digestFrequency)

  const got = await call('/sqftlab/whatsapp/subscribe', { token: ent.id })
  check('GET returns the subscription', got.status === 200 && got.body.subscription.active === true, got.body)
  check('GET reports delivery state', got.body.delivery === 'unconfigured')
  const anonGet = await call('/sqftlab/whatsapp/subscribe')
  check('GET without identity is 401', anonGet.status === 401, anonGet.status)
  const anonDel = await call('/sqftlab/whatsapp/subscribe', { method: 'DELETE' })
  check('DELETE without identity is 401', anonDel.status === 401, anonDel.status)

  console.log('\n── STOP webhook ──')
  const stop = await call('/sqftlab/whatsapp/webhook', { method: 'POST', form: 'From=whatsapp%3A%2B971501234567&Body=STOP' })
  check('the webhook acknowledges with an empty 200', stop.status === 200, stop.status)
  const afterStop = await prisma.user.findUnique({ where: { id: ent.id }, select: { whatsappEnabled: true, digestFrequency: true } })
  check('STOP deactivates the subscription', afterStop?.whatsappEnabled === false, afterStop)
  check('STOP sets frequency to none', afterStop?.digestFrequency === 'none', afterStop?.digestFrequency)

  const ent2 = await mkuser('enterprise', '+971505556666')
  await call('/sqftlab/whatsapp/webhook', { method: 'POST', form: 'From=whatsapp%3A%2B971505556666&Body=how are you' })
  const notStopped = await prisma.user.findUnique({ where: { id: ent2.id }, select: { whatsappEnabled: true } })
  check('a non-STOP message does not unsubscribe', notStopped?.whatsappEnabled === true, notStopped)
  // The webhook is public by design: Twilio cannot present a session, so a gated webhook
  // would never fire and a STOP would be silently ignored.
  const ent3 = await mkuser('enterprise', '+971507778888')
  await call('/sqftlab/whatsapp/webhook', { method: 'POST', form: 'From=whatsapp%3A%2B971507778888&Body=UNSUBSCRIBE' })
  const third = await prisma.user.findUnique({ where: { id: ent3.id }, select: { whatsappEnabled: true } })
  check('UNSUBSCRIBE is honoured too', third?.whatsappEnabled === false)

  console.log('\n── unsubscribe ──')
  const ent4 = await mkuser('enterprise', '+971509990000')
  const del = await call('/sqftlab/whatsapp/subscribe', { method: 'DELETE', token: ent4.id })
  const afterDel = await prisma.user.findUnique({ where: { id: ent4.id }, select: { whatsappPhone: true, whatsappEnabled: true, digestFrequency: true } })
  check('DELETE unsubscribes', del.status === 200 && afterDel?.whatsappEnabled === false, afterDel)
  check('the phone is retained so a later STOP can be attributed', afterDel?.whatsappPhone === '+971509990000', afterDel?.whatsappPhone)

  console.log('\n── digest job ──')
  const due = await mkuser('enterprise', '+971501112222')
  await prisma.user.update({ where: { id: due.id }, data: { whatsappAreas: JSON.stringify(['dubai-marina']) } })
  const run = await sendWhatsappDigests()
  check('the job considers the due subscribers', run.considered >= 1, run.considered)
  check('with no credentials it sends nothing', run.sent === 0, run.sent)
  check('and reports them as unconfigured rather than failed', run.skipped.unconfigured >= 1, run.skipped)
  check('no error is fabricated', run.errorMsg === null, run.errorMsg)
  const stamped = await prisma.user.findUnique({ where: { id: due.id }, select: { whatsappLastSentAt: true } })
  check('an undelivered digest is NOT stamped as sent', stamped?.whatsappLastSentAt === null, stamped?.whatsappLastSentAt)
  // The brief's route uses 2 aggregates per community per subscriber; this uses 2 total.
  check('queries stay bounded by design, not by subscriber count', run.queries <= 8, run.queries)

  console.log('\n── source wiring ──')
  const { readFileSync } = await import('node:fs')
  const page = readFileSync('src/components/MortgagePage.tsx', 'utf8')
  const appSrc = readFileSync('src/App.tsx', 'utf8')
  const cronSrc = readFileSync('src/lib/cron.ts', 'utf8')
  const routesSrc = readFileSync('custom-routes.ts', 'utf8')

  check('the calculator reuses the shared maths rather than re-deriving it', /from '@\/lib\/mortgage'/.test(page))
  check('the calculator does not use a browser dialog', !/\balert\(/.test(page))
  check('the pre-fill only adopts a real figure', /estimatedPriceAed === 'number'/.test(page))
  check('the UAE minimum is surfaced to the user', /UAE minimum/.test(page))
  check('the transfer-fee note is labelled indicative', /Indicative/.test(page))
  check('the CMA call to action is present', /onNavigate\('cma'\)/.test(page))
  check('MortgagePage is wired into App', /page === 'mortgage' && <MortgagePage/.test(appSrc))
  check('the retired inline simulator is gone', !/MortgageSimulator/.test(appSrc))
  check('/mortgage publishes a URL', /mortgage:\s*'\/mortgage'/.test(appSrc))

  check('the digest step is registered in the pipeline', /step\('whatsappDigest', whatsappDigestStep\)/.test(cronSrc))
  check('the digest step is hour-guarded', /async function whatsappDigestStep[\s\S]{0,200}uaeHour\(\) !== 8/.test(cronSrc))
  check('the portfolio revalue step kept its own hour guard', /async function portfolioRevalueStep[\s\S]{0,120}uaeHour\(\) !== 4/.test(cronSrc))
  check('no module-scope Twilio client is constructed', !/twilio\s*\(/.test(routesSrc) && !/require\('twilio'\)/.test(routesSrc))
  check('the webhook is registered before the catch-all', routesSrc.indexOf("'/sqftlab/whatsapp/webhook'") < routesSrc.indexOf("app.all('*'"))
  check('the mortgage estimate is registered before the catch-all', routesSrc.indexOf("'/sqftlab/mortgage/estimate'") < routesSrc.indexOf("app.all('*'"))
} finally {
  if (txnIds.length) await prisma.transaction.deleteMany({ where: { id: { in: txnIds } } })
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users } } })
  console.log(`\ncleaned up ${txnIds.length} transaction(s) and ${users.length} user(s)`)
  await prisma.$disconnect()
}

console.log(`\n${'─'.repeat(60)}`)
console.log(`  ${passed} passed, ${failed} failed`)
if (failures.length) {
  console.log('\n  Failures:')
  for (const f of failures) console.log(`    ✗ ${f}`)
}
console.log(`${'─'.repeat(60)}\n`)
process.exit(failed === 0 ? 0 : 1)
