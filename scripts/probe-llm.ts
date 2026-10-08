/**
 * Probe which LLM transports actually answer in this environment.
 *
 * Everything here is a live call. Nothing is inferred from documentation, because the
 * failure mode this guards against is a transport that looks configured and throws.
 */
const CANDIDATE_MODELS = [
  'claude-haiku-4-5',
  'claude-sonnet-4-5',
  'gemini-2.0-flash',
  'gpt-4o-mini',
  'llama-3.3-70b-versatile',
  'meta-llama/llama-3.3-70b-instruct:free',
  'deepseek/deepseek-chat:free',
]

function mask(v: string | undefined): string {
  if (!v) return '(unset)'
  return `set(len=${v.length}, prefix=${v.slice(0, 8)}…)`
}

async function probe(label: string, makeProvider: () => (m: string) => unknown) {
  let provider: (m: string) => unknown
  try {
    provider = makeProvider()
  } catch (err) {
    console.log(`\n[${label}] provider construction FAILED: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  console.log(`\n[${label}] provider constructed`)
  for (const model of CANDIDATE_MODELS) {
    const started = Date.now()
    try {
      const { generateText } = await import('ai')
      const result = await generateText({
        model: provider(model) as never,
        prompt: 'Reply with exactly: OK',
        maxOutputTokens: 16,
      })
      const ms = Date.now() - started
      console.log(`  ✓ ${model.padEnd(42)} ${ms}ms  text=${JSON.stringify(result.text.slice(0, 40))}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`  ✗ ${model.padEnd(42)} ${Date.now() - started}ms  ${msg.slice(0, 150)}`)
    }
  }
}

async function main() {
  console.log('=== env presence (values masked) ===')
  for (const k of ['PROJECT_ID', 'SHOGO_API_URL', 'RUNTIME_AUTH_SECRET', 'AI_PROXY_TOKENS', 'SHOGO_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY']) {
    console.log(`  ${k.padEnd(20)} ${mask(process.env[k])}`)
  }

  console.log('\n=== installed SDKs ===')
  for (const pkg of ['ai', '@shogo-ai/sdk']) {
    try {
      const meta = await import(`${pkg}/package.json`, { with: { type: 'json' } }).catch(() => null)
      console.log(`  ${pkg.padEnd(20)} ${meta ? (meta as { default?: { version?: string } }).default?.version ?? 'present' : 'import failed'}`)
    } catch {
      console.log(`  ${pkg.padEnd(20)} not resolvable`)
    }
  }

  const sdk = await import('@shogo-ai/sdk')
  const runtimeToken = process.env.RUNTIME_AUTH_SECRET
  const apiUrl = process.env.SHOGO_API_URL

  if (runtimeToken) {
    await probe('runtime token (keyless pod path)', () =>
      sdk.createShogoLlmProvider({ runtimeToken, ...(apiUrl ? { baseUrl: apiUrl } : {}) } as never),
    )
  } else {
    console.log('\n[runtime token] skipped — RUNTIME_AUTH_SECRET unset')
  }

  const proxyRaw = process.env.AI_PROXY_TOKENS
  if (proxyRaw) {
    try {
      const parsed = JSON.parse(proxyRaw) as Record<string, string>
      const token = (process.env.PROJECT_ID && parsed[process.env.PROJECT_ID]) || Object.values(parsed)[0]
      if (token) await probe('AI_PROXY_TOKENS', () => sdk.createShogoLlmProvider({ apiKey: token }))
    } catch (err) {
      console.log(`\n[AI_PROXY_TOKENS] unparseable: ${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    console.log('\n[AI_PROXY_TOKENS] skipped — unset')
  }

  console.log('\n=== OpenAI-compatible free providers (direct) ===')
  for (const [name, keyVar, base] of [
    ['groq', 'GROQ_API_KEY', 'https://api.groq.com/openai/v1'],
    ['openrouter', 'OPENROUTER_API_KEY', 'https://openrouter.ai/api/v1'],
  ] as const) {
    const key = process.env[keyVar]
    if (!key) {
      console.log(`  ${name}: skipped — ${keyVar} unset`)
      continue
    }
    const models = name === 'groq' ? ['llama-3.3-70b-versatile'] : ['meta-llama/llama-3.3-70b-instruct:free', 'deepseek/deepseek-chat:free']
    for (const m of models) {
      const started = Date.now()
      try {
        const res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], max_tokens: 16 }),
        })
        const body = await res.text()
        console.log(`  ✓ ${name}/${m} ${res.status} ${Date.now() - started}ms  ${body.slice(0, 120).replace(/\s+/g, ' ')}`)
      } catch (err) {
        console.log(`  ✗ ${name}/${m} ${Date.now() - started}ms  ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
}

await main()
