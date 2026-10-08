/**
 * Free-first model transport for the market assistant.
 *
 * THE PROBLEM WITH THE PREVIOUS WIRING. The assistant had exactly one transport: the
 * platform AI gateway, reached through `AI_PROXY_TOKENS`. That credential is pod-scoped
 * and, when it is absent — which is the normal case for a self-hosted deployment — the
 * route answered HTTP 503 and the assistant did nothing at all. Worse, the only models
 * the gateway serves are frontier ones (Claude Opus 5.5, GPT-6, and the platform's own).
 * Probed live: there is no free model on it. So the assistant was either unavailable or
 * billed against premium models, with nothing in between.
 *
 * WHAT THIS DOES. Every provider below speaks the OpenAI chat-completions wire format,
 * which the gateway also speaks (verified against `/api/ai/v1/chat/completions`), so one
 * small `fetch` client fronts all of them — no provider SDK on the critical path, and no
 * new dependency to install.
 *
 * PROFILES. The free tiers come first by default, because the point of this module is to
 * make the assistant cost nothing to run:
 *
 *   groq        free tier, no card       → llama-3.3-70b-versatile
 *   openrouter  free `:free` models      → llama-3.3-70b-instruct:free
 *   gemini      free tier, no card       → gemini-2.0-flash
 *   custom      any OpenAI-compatible    → local Ollama / LM Studio, i.e. genuinely free
 *   shogo       platform gateway         → opt-in only; it serves billed frontier models
 *   offline     no model at all          → the deterministic engine in ai-grounding.ts
 *
 * `AI_PROVIDER=auto` (the default) walks the free providers in that order, then falls back
 * to the gateway only if `AI_ALLOW_GATEWAY_FALLBACK` has not been set to `false`, and
 * finally to `offline`. The floor is therefore never a 503: setting `AI_PROVIDER=offline`
 * guarantees zero model spend while the assistant still answers from live database facts.
 */

export type LlmProviderId = 'groq' | 'openrouter' | 'gemini' | 'custom' | 'shogo' | 'offline'

export interface LlmProvider {
  id: Exclude<LlmProviderId, 'offline'>
  /** Shown in the UI, so a reader can tell which engine answered. Never a credential. */
  label: string
  model: string
  baseUrl: string
  apiKey: string
  /** True when this provider has a free tier — preferred in `auto`. */
  free: boolean
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmChoiceResult {
  text: string
  tokensUsed: number
  model: string
  providerId: LlmProvider['id']
  providerLabel: string
}

export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LlmUnavailableError'
  }
}

/** Per-call ceiling. A chat surface must fail fast rather than hold the request open. */
export const LLM_TIMEOUT_MS = 30_000

const GROQ_BASE = 'https://api.groq.com/openai/v1'
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'
const GEMINI_OPENAI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai'
/** The SDK hardcodes this origin; `SHOGO_API_URL` is the app origin, not the API base. */
const SHOGO_GATEWAY_BASE = 'https://studio.shogo.ai/api/ai/v1'

function nonEmpty(value: string | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * The gateway credential.
 *
 * Two sources, tried in order. `AI_PROXY_TOKENS` is a JSON map of projectId -> token and
 * is what the deployment actually carries. `SHOGO_API_KEY` is the self-managed override.
 * The pod's own `RUNTIME_AUTH_SECRET` is deliberately NOT accepted: it is a workspace
 * token (`wrt_v1_…`) and the gateway rejects it with `invalid_api_key`, which was
 * confirmed by probe rather than assumed.
 */
export function resolveGatewayToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = nonEmpty(env.AI_PROXY_TOKENS)
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const entries = parsed as Record<string, string>
        const preferred = env.PROJECT_ID ? entries[env.PROJECT_ID] : undefined
        const token = preferred ?? Object.values(entries).find((v) => typeof v === 'string' && v !== '')
        if (typeof token === 'string' && token !== '') return token
      }
    } catch {
      // A malformed map falls through to the next source rather than crashing the route.
    }
  }
  const key = nonEmpty(env.SHOGO_API_KEY)
  return key !== null && key.startsWith('shogo_sk_') ? key : null
}

/**
 * Every provider this deployment could use, whether or not it is configured.
 *
 * Kept separate from selection so the route can report `availableProviders` for
 * diagnostics — "why is it offline" is answerable without reading the environment.
 */
export function candidateProviders(env: NodeJS.ProcessEnv = process.env): LlmProvider[] {
  const out: LlmProvider[] = []

  const groq = nonEmpty(env.GROQ_API_KEY)
  if (groq) {
    out.push({
      id: 'groq',
      label: 'Groq · Llama 3.3 70B',
      model: nonEmpty(env.GROQ_MODEL) ?? 'llama-3.3-70b-versatile',
      baseUrl: nonEmpty(env.GROQ_BASE_URL) ?? GROQ_BASE,
      apiKey: groq,
      free: true,
    })
  }

  const openrouter = nonEmpty(env.OPENROUTER_API_KEY)
  if (openrouter) {
    out.push({
      id: 'openrouter',
      label: 'OpenRouter · Llama 3.3 70B (free)',
      model: nonEmpty(env.OPENROUTER_MODEL) ?? 'meta-llama/llama-3.3-70b-instruct:free',
      baseUrl: nonEmpty(env.OPENROUTER_BASE_URL) ?? OPENROUTER_BASE,
      apiKey: openrouter,
      free: true,
    })
  }

  const gemini = nonEmpty(env.GEMINI_API_KEY) ?? nonEmpty(env.GOOGLE_AI_API_KEY)
  if (gemini) {
    out.push({
      id: 'gemini',
      label: 'Gemini · 2.0 Flash',
      model: nonEmpty(env.GEMINI_MODEL) ?? 'gemini-2.0-flash',
      baseUrl: nonEmpty(env.GEMINI_BASE_URL) ?? GEMINI_OPENAI_BASE,
      apiKey: gemini,
      free: true,
    })
  }

  // A local runtime (Ollama, LM Studio, vLLM) is the only genuinely free-at-any-volume
  // option, and it needs no key — so the base URL alone is enough to enable it.
  const baseUrl = nonEmpty(env.AI_BASE_URL)
  const customModel = nonEmpty(env.AI_MODEL)
  if (baseUrl && customModel) {
    out.push({
      id: 'custom',
      label: `Local · ${customModel}`,
      model: customModel,
      baseUrl,
      apiKey: nonEmpty(env.AI_API_KEY) ?? 'not-needed',
      free: true,
    })
  }

  const gatewayToken = resolveGatewayToken(env)
  if (gatewayToken) {
    out.push({
      id: 'shogo',
      label: 'Platform gateway (billed)',
      model: nonEmpty(env.SHOGO_MODEL) ?? nonEmpty(env.AI_GATEWAY_MODEL) ?? 'claude-haiku-4-5',
      baseUrl: nonEmpty(env.AI_GATEWAY_URL) ?? SHOGO_GATEWAY_BASE,
      apiKey: gatewayToken,
      free: false,
    })
  }

  return out
}

/**
 * Pick the provider to use.
 *
 * Returns `null` to mean "offline": answer from the database deterministically. That is a
 * supported end state, not a failure — see `deterministicAnswer` in ai-grounding.ts.
 */
export function selectProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider | null {
  const wanted = (nonEmpty(env.AI_PROVIDER) ?? 'auto').toLowerCase()
  if (wanted === 'offline' || wanted === 'none' || wanted === 'deterministic') return null

  const candidates = candidateProviders(env)

  if (wanted !== 'auto') {
    const exact = candidates.find((p) => p.id === wanted)
    if (exact) return exact
    // A named provider that is not configured must not silently become a different one:
    // that is how a "free" setting quietly starts billing. Offline is the honest floor.
    return null
  }

  const free = candidates.find((p) => p.free)
  if (free) return free

  // The gateway is a real cost, so it is only reached when the operator has not opted out.
  const allowGateway = (nonEmpty(env.AI_ALLOW_GATEWAY_FALLBACK) ?? 'true').toLowerCase() !== 'false'
  if (allowGateway) {
    const gateway = candidates.find((p) => p.id === 'shogo')
    if (gateway) return gateway
  }

  return null
}

/** One model call. Returns the assistant text, or throws `LlmUnavailableError`. */
export async function callProvider(
  provider: LlmProvider,
  messages: LlmMessage[],
  opts: { maxTokens?: number; temperature?: number; timeoutMs?: number } = {},
): Promise<LlmChoiceResult> {
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const body = {
    model: provider.model,
    messages,
    max_tokens: opts.maxTokens ?? 800,
    temperature: opts.temperature ?? 0.2,
  }

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${provider.apiKey}`,
        // OpenRouter attributes free-tier traffic by these two headers; harmless elsewhere.
        'HTTP-Referer': nonEmpty(process.env.PUBLIC_APP_URL) ?? 'https://www.sqftlab.com',
        'X-Title': 'sqftLab',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? LLM_TIMEOUT_MS),
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new LlmUnavailableError(`${provider.id} request failed: ${detail}`)
  }

  const text = await response.text()
  if (!response.ok) {
    throw new LlmUnavailableError(`${provider.id} returned HTTP ${response.status}: ${text.slice(0, 240)}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new LlmUnavailableError(`${provider.id} returned non-JSON: ${text.slice(0, 160)}`)
  }

  const choices = (parsed as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new LlmUnavailableError(`${provider.id} returned no choices`)
  }
  const message = (choices[0] as { message?: { content?: unknown } }).message
  const content = message?.content
  if (typeof content !== 'string' || content.trim() === '') {
    throw new LlmUnavailableError(`${provider.id} returned an empty message`)
  }

  const usage = (parsed as { usage?: { total_tokens?: unknown } }).usage
  const tokensUsed = typeof usage?.total_tokens === 'number' ? usage.total_tokens : 0

  return {
    text: content.trim(),
    tokensUsed,
    model: provider.model,
    providerId: provider.id,
    providerLabel: provider.label,
  }
}

/**
 * Ask each configured provider in turn until one answers.
 *
 * Deliberately sequential rather than racing: the free tiers are first for a reason, and
 * firing every provider in parallel would bill the gateway on every single question even
 * when a free tier was about to answer.
 */
export async function callWithFallback(
  providers: LlmProvider[],
  messages: LlmMessage[],
  opts: { maxTokens?: number } = {},
): Promise<LlmChoiceResult> {
  const errors: string[] = []
  for (const provider of providers) {
    try {
      return await callProvider(provider, messages, opts)
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }
  throw new LlmUnavailableError(errors.join(' | ') || 'no provider configured')
}
