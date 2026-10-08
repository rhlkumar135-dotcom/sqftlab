/**
 * Verification for the grounded assistant.
 *
 * Two properties are under test, and neither is asserted from a prompt:
 *
 *  1. A FIGURE THAT IS NOT IN THE DATA CANNOT REACH THE READER. The model path is driven
 *     through a stubbed HTTP transport that returns a deliberately fabricated answer, so
 *     the repair-and-replace logic is exercised for real without depending on a live model
 *     misbehaving and without spending anything.
 *
 *  2. THE ASSISTANT ANSWERS WHEN THERE IS NO MODEL. With AI_PROVIDER=offline every reply
 *     is computed from the database, so the suite asserts the figures match what the
 *     database actually holds — and that a question about a district we do not cover is
 *     refused rather than estimated.
 *
 * No network calls to any provider: the transport is stubbed, and the offline path touches
 * only the local SQLite database. A test suite must not bill anyone.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'file:./prisma/dev.db'

const DATABASE_URL = 'file:./prisma/dev.db'
process.env.DATABASE_URL = DATABASE_URL

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    failures.push(name)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n${title}`)
}

/** A canned OpenAI-compatible transport. Records every request so the repair turn is visible. */
function installStub(contents: string[]) {
  const original = globalThis.fetch
  const seen: Array<{ url: string; body: { messages?: Array<{ role: string; content: string }> } | null }> = []
  let call = 0
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    seen.push({
      url: String(input),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    })
    const content = contents[Math.min(call, contents.length - 1)] ?? ''
    call += 1
    return new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { total_tokens: 42 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
  return { seen, restore: () => { globalThis.fetch = original } }
}

async function main() {
  const { prisma } = await import('../src/lib/db')
  const {
    buildLiveContext,
    buildSystemPrompt,
    answerMarketQuestion,
    detectUncoveredPlace,
  } = await import('../src/lib/ai-chat')
  const { buildEvidence, validateAnswer, deterministicAnswer } = await import('../src/lib/ai-grounding')
  const { selectProvider, candidateProviders } = await import('../src/lib/llm-providers')

  // ── Ground truth, read straight from the database ─────────────────────────────
  const marina = await prisma.community.findFirst({
    where: { nameEn: 'Dubai Marina' },
    select: { id: true, nameEn: true, medianAedSqft: true },
  })
  const marinaAgg = await prisma.listing.aggregate({
    where: { communityId: marina?.id ?? '', purpose: 'sale', priceAed: { gt: 0 } },
    _count: { id: true },
    _avg: { pricePerSqft: true },
  })
  const registerCount = await prisma.transaction.count()
  const listingCount = await prisma.listing.count()
  const marinaOk = marina !== null && (marinaAgg._count.id ?? 0) > 0

  console.log(`database: ${listingCount} listings, ${registerCount} register rows`)
  console.log(`fixture: Dubai Marina — ${marinaAgg._count.id} sale listings, avg AED ${Math.round(marinaAgg._avg.pricePerSqft ?? 0)}/sqft`)

  // ── 1. The validator ──────────────────────────────────────────────────────────
  section('validateAnswer — a figure with no evidence must be caught')
  {
    const ctx = await buildLiveContext('What are asking prices in Dubai Marina?')
    const evidence = buildEvidence(ctx)
    const psf = ctx.focus?.salePsfAed ?? 0
    const allowed = `AED ${psf.toLocaleString('en-US')}`

    const truthful = validateAnswer(`Asking prices in Dubai Marina average ${allowed} per sqft.`, evidence, ctx.knownPlaces)
    check('a figure quoted from the evidence passes', truthful.verified, JSON.stringify(truthful.unsupportedNumbers))

    const rounded = validateAnswer(`Asking prices average about AED ${Math.round(psf / 100) * 100} per sqft.`, evidence, ctx.knownPlaces)
    check('a legitimate rounding of an evidence value passes', rounded.verified, JSON.stringify(rounded.unsupportedNumbers))

    const invented = validateAnswer('Asking prices in Dubai Marina average AED 9,750 per sqft.', evidence, ctx.knownPlaces)
    check('an invented price is caught', !invented.verified && invented.unsupportedNumbers.length > 0, JSON.stringify(invented))

    const inventedYield = validateAnswer('Gross yield in Dubai Marina is 23.4%.', evidence, ctx.knownPlaces)
    check('an invented yield is caught', !inventedYield.verified, JSON.stringify(inventedYield.unsupportedNumbers))

    const structural = validateAnswer('Most listings are 2 to 3 bed, over the last 30 days, on a 1,000 sqft basis.', evidence, ctx.knownPlaces)
    check('structural integers are not flagged', structural.verified, JSON.stringify(structural.unsupportedNumbers))

    const yearOnly = validateAnswer('The data was collected in 2026.', evidence, ctx.knownPlaces)
    check('a year is not treated as a market figure', yearOnly.verified, JSON.stringify(yearOnly.unsupportedNumbers))

    // A district named that the evidence never covered — the convincing kind of wrong answer.
    const otherPlace = ctx.knownPlaces.find((p) => p !== ctx.focus?.name && p.length > 5) ?? ''
    const placeViolation = validateAnswer(
      `Prices in ${otherPlace} are rising while Dubai Marina averages ${allowed}.`,
      evidence,
      ctx.knownPlaces,
    )
    check(
      'a district the evidence did not cover is caught',
      !placeViolation.verified && placeViolation.unsupportedPlaces.length > 0,
      JSON.stringify(placeViolation.unsupportedPlaces),
    )
  }

  // ── 2. Uncovered-place detection ──────────────────────────────────────────────
  section('detectUncoveredPlace — refuse what we cannot answer, not what we can')
  {
    const ctx = await buildLiveContext('Which districts do you cover?')
    const known = ctx.knownPlaces
    check('a fictional district is caught', detectUncoveredPlace('What are prices in Palm Ridge Heights?', known) === 'Palm Ridge Heights')
    check('a district we cover is not caught', detectUncoveredPlace('Tell me about Dubai Marina', known) === null)
    check('the emirates are not mistaken for districts', detectUncoveredPlace('Compare Dubai and Abu Dhabi market trends', known) === null)
    check('a question word is not mistaken for a place', detectUncoveredPlace('Which districts do you cover?', known) === null)
    check('an unlisted district is caught', detectUncoveredPlace('What about Al Barsha South?', known) === 'Al Barsha South')
  }

  // ── 3. Offline mode: answers computed from the database ────────────────────────
  section('AI_PROVIDER=offline — the model-free engine')
  const offlineEnv = { AI_PROVIDER: 'offline' } as NodeJS.ProcessEnv
  {
    const ctx = await buildLiveContext('What are asking prices in Dubai Marina?')
    const det = deterministicAnswer('What are asking prices in Dubai Marina?', ctx, ctx.knownPlaces)
    const selfCheck = validateAnswer(det.reply, buildEvidence(ctx), ctx.knownPlaces)
    check('the computed answer validates against the evidence it was built from', selfCheck.verified, JSON.stringify(selfCheck.unsupportedNumbers))
    check('it quotes the real database figure', marinaOk && det.reply.includes(Math.round(marinaAgg._avg.pricePerSqft ?? 0).toLocaleString('en-US')))

    const answer = await answerMarketQuestion({ message: 'What are asking prices in Dubai Marina?', env: offlineEnv })
    check('mode is deterministic', answer.mode === 'deterministic')
    check('no tokens were spent', answer.tokensUsed === 0)
    check('the answer is grounded', answer.verified)
    check('the named district is reported', answer.focus === 'Dubai Marina')
    check('sources name the live listings', answer.sources.includes('listings'))
    check('it is not a refusal', !answer.refused)
  }
  {
    const answer = await answerMarketQuestion({ message: 'What are the asking prices in Palm Ridge Heights?', env: offlineEnv })
    check('an uncovered district is refused', answer.refused)
    check('the refusal names the district', answer.reply.includes('Palm Ridge Heights'))
    check('the refusal quotes no price at all', !/AED\s?[\d,]+/.test(answer.reply), answer.reply.slice(0, 120))
  }
  {
    const answer = await answerMarketQuestion({ message: 'How many registered sales were there last month?', env: offlineEnv })
    check('an empty register produces no invented transaction count', answer.refused || answer.reply.includes('no registered sales'), answer.reply.slice(0, 140))
    check('it does not claim a register figure', !/\b\d[\d,]{3,}\s+transactions/.test(answer.reply))
  }
  {
    const answer = await answerMarketQuestion({ message: 'Which districts do you cover?', env: offlineEnv })
    check('a coverage question is answered, not refused', !answer.refused)
    check('the listing count in the reply is the real one', answer.reply.includes(listingCount.toLocaleString('en-US')))
  }

  // ── 4. Model path: fabricated answer is repaired ───────────────────────────────
  section('model path — a fabricated draft is repaired before it is shown')
  const stubEnv = {
    AI_PROVIDER: 'shogo',
    PROJECT_ID: 'verify',
    AI_PROXY_TOKENS: JSON.stringify({ verify: 'stub-token' }),
  } as NodeJS.ProcessEnv
  {
    const ctx = await buildLiveContext('What are asking prices in Dubai Marina?')
    const psf = ctx.focus?.salePsfAed ?? 0
    const honest = `Asking prices in Dubai Marina average AED ${psf.toLocaleString('en-US')} per sqft, based on ${ctx.focus?.saleListings ?? 0} sale listings collected ${ctx.asOf?.slice(0, 10) ?? 'recently'}.`
    const fabricated = 'Asking prices in Dubai Marina average AED 9,750 per sqft, up 34% year on year, with gross yields of 23.4%.'

    const stub = installStub([fabricated, honest])
    const answer = await answerMarketQuestion({ message: 'What are asking prices in Dubai Marina?', env: stubEnv })
    stub.restore()

    check('two model calls were made (draft, then repair)', stub.seen.length === 2, `saw ${stub.seen.length}`)
    const repairTurn = stub.seen[1]?.body?.messages?.at(-1)?.content ?? ''
    check('the repair turn named the rejected figures', repairTurn.includes('9,750') || repairTurn.includes('9750'), repairTurn.slice(0, 140))
    check('the shown reply is the corrected one', answer.reply === honest)
    check('the fabricated figure never reached the reader', !answer.reply.includes('9,750') && !answer.reply.includes('23.4'))
    check('the answer is marked verified', answer.verified)
    check('the correction is disclosed, not hidden', answer.note !== null)
    check('mode is model', answer.mode === 'model')
    check('token usage is reported', answer.tokensUsed === 84, String(answer.tokensUsed))
  }

  // ── 5. Model path: two fabricated drafts are discarded ─────────────────────────
  section('model path — if the repair also fails, the computed answer replaces it')
  {
    const fabricated = 'Dubai Marina averages AED 9,750 per sqft and yields 23.4%.'
    const stub = installStub([fabricated, fabricated])
    const answer = await answerMarketQuestion({ message: 'What are asking prices in Dubai Marina?', env: stubEnv })
    stub.restore()

    check('it fell back to the computed answer', answer.mode === 'deterministic', answer.mode)
    check('the fabricated figure is absent', !answer.reply.includes('9,750') && !answer.reply.includes('23.4'))
    check('the fallback is disclosed with the offending figures', answer.note !== null && answer.note.includes('9,750'), answer.note ?? '')
    check('the replacement quotes the real figure', answer.reply.includes(Math.round(marinaAgg._avg.pricePerSqft ?? 0).toLocaleString('en-US')))
    check('the replacement is grounded', answer.verified)
  }

  // ── 6. Model path: a provider outage is not a hallucination ────────────────────
  section('model path — an unreachable provider degrades to computed figures')
  {
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response('upstream exploded', { status: 500 })) as typeof fetch
    const answer = await answerMarketQuestion({ message: 'What are asking prices in Dubai Marina?', env: stubEnv })
    globalThis.fetch = original

    check('the reply still carries real figures', answer.reply.includes(Math.round(marinaAgg._avg.pricePerSqft ?? 0).toLocaleString('en-US')))
    check('the outage is disclosed', answer.note !== null && answer.note.includes('could not be reached'), answer.note ?? '')
    check('it is not an error page', answer.reply.length > 40)
  }

  // ── 7. Provider selection ─────────────────────────────────────────────────────
  section('provider selection — free tiers first, never a silent billed fallback')
  {
    const free = selectProvider({ GROQ_API_KEY: 'gsk_test' } as NodeJS.ProcessEnv)
    check('Groq is preferred when present', free?.id === 'groq', free?.id ?? 'null')
    check('the Groq default model is a free-tier one', free?.model === 'llama-3.3-70b-versatile', free?.model ?? '')

    const openrouter = selectProvider({ OPENROUTER_API_KEY: 'sk-or-test' } as NodeJS.ProcessEnv)
    check('OpenRouter uses a :free model', openrouter?.model.endsWith(':free') === true, openrouter?.model ?? '')

    const local = selectProvider({ AI_BASE_URL: 'http://localhost:11434/v1', AI_MODEL: 'llama3.1' } as NodeJS.ProcessEnv)
    check('a local runtime is usable', local?.id === 'custom', local?.id ?? 'null')

    const paidOnly = selectProvider({
      PROJECT_ID: 'p',
      AI_PROXY_TOKENS: JSON.stringify({ p: 'tok' }),
    } as NodeJS.ProcessEnv)
    check('the billed gateway is reachable as a fallback', paidOnly?.id === 'shogo', paidOnly?.id ?? 'null')

    const optOut = selectProvider({
      PROJECT_ID: 'p',
      AI_PROXY_TOKENS: JSON.stringify({ p: 'tok' }),
      AI_ALLOW_GATEWAY_FALLBACK: 'false',
    } as NodeJS.ProcessEnv)
    check('the gateway can be refused, giving offline instead of a bill', optOut === null, optOut?.id ?? 'null')

    const forced = selectProvider({ GROQ_API_KEY: 'gsk_test', AI_PROVIDER: 'offline' } as NodeJS.ProcessEnv)
    check('offline is honoured even when a free key exists', forced === null, forced?.id ?? 'null')

    const named = selectProvider({ GROQ_API_KEY: 'g', AI_PROVIDER: 'gemini' } as NodeJS.ProcessEnv)
    check('a named provider that is not configured goes offline, not elsewhere', named === null, named?.id ?? 'null')

    check('the gateway is tagged as not free', candidateProviders({ PROJECT_ID: 'p', AI_PROXY_TOKENS: JSON.stringify({ p: 't' }) } as NodeJS.ProcessEnv).every((p) => p.id !== 'shogo' || p.free === false))
  }

  // ── 8. The prompt actually carries the evidence ───────────────────────────────
  section('system prompt — the evidence block is present and numbered')
  {
    const ctx = await buildLiveContext('What are asking prices in Dubai Marina?')
    const prompt = buildSystemPrompt(ctx)
    const evidence = buildEvidence(ctx)
    check('the contract is stated', prompt.includes('GROUNDING CONTRACT'))
    check('the evidence block is present', prompt.includes('EVIDENCE — the only figures and districts you may use:'))
    check('evidence ids are numbered', prompt.includes('[focus.psf]'), evidence.slice(0, 3).map((e) => e.id).join(','))
    check('the asking-vs-registered distinction survives', prompt.includes('Registered sales') || prompt.includes('register holds no rows'))
    check('derived arithmetic is forbidden in words', prompt.includes('Do NOT compute new figures'))
  }

  await prisma.$disconnect()

  console.log(`\n${'─'.repeat(64)}`)
  console.log(`${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log('\nfailures:')
    for (const f of failures) console.log(`  · ${f}`)
  }
  process.exit(failed > 0 ? 1 : 0)
}

await main()
