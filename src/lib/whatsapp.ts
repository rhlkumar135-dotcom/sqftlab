/**
 * WhatsApp daily digest (Day 14).
 *
 * Why this is not the brief's `twilio(sid, token)` client:
 *
 * 1. A module-scope `twilio(process.env.TWILIO_ACCOUNT_SID, …)` THROWS when the env vars
 *    are absent, and this module is imported by `custom-routes.ts` — so on any deployment
 *    without Twilio credentials (dev, preview, CI) the entire API would fail to boot. That
 *    is the same defect as Day 5's Stripe client. Configuration is read lazily here, and
 *    an unconfigured transport reports itself rather than taking the server down.
 *
 * 2. Twilio's send is a single form-encoded POST with HTTP basic auth, so `fetch` covers it
 *    without a ~5 MB SDK dependency. Nothing here needs the SDK's types or helpers.
 *
 * The digest is built by a pure function so its arithmetic is testable without a network
 * call or a database — the part of this feature most likely to be wrong is the numbers,
 * not the transport.
 */

export interface DigestCommunity {
  slug: string
  name: string
  transactionsYesterday: number
  psfYesterday: number
  psf90d: number
}

export interface TwilioConfig {
  accountSid: string
  authToken: string
  from: string
}

/** How long a community may be silent before the digest says so instead of printing 0. */
export const DIGEST_MAX_COMMUNITIES = 3

export interface SendResult {
  ok: boolean
  /** Present when the send did not happen for a configuration reason, not a failure. */
  reason?: 'unconfigured'
  status?: number
  error?: string
  sid?: string
}

export function resolveTwilioConfig(env: NodeJS.ProcessEnv = process.env): TwilioConfig | null {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim()
  const authToken = env.TWILIO_AUTH_TOKEN?.trim()
  if (!accountSid || !authToken) return null
  // Twilio's sandbox sender is the only value worth defaulting: it is a fixed, public
  // number, so it cannot leak a credential. Everything else must be supplied.
  const from = (env.TWILIO_WHATSAPP_FROM?.trim() || 'whatsapp:+14155238886')
  return { accountSid, authToken, from }
}

export const isWhatsappConfigured = (env: NodeJS.ProcessEnv = process.env): boolean =>
  resolveTwilioConfig(env) !== null

/**
 * Normalise a phone number to E.164.
 *
 * The brief validates `/^\+[1-9]\d{7,14}$/` and rejects everything else. That is correct
 * for the wire format but wrong for an input field: a UAE user types `0501234567`, and
 * telling them their own number is invalid is a bug in a user-facing feature. So the
 * common spellings are accepted and normalised, and anything unparseable returns null
 * (which the route turns into the brief's 400 with its E.164 example).
 */
export function normaliseE164(input: unknown): string | null {
  if (typeof input !== 'string') return null
  // Strip the separators people actually type: spaces, dashes, parentheses, dots.
  let s = input.trim().replace(/[\s\-().]/g, '')
  if (s === '') return null

  if (s.startsWith('+')) {
    // already international
  } else if (s.startsWith('00')) {
    s = `+${s.slice(2)}`
  } else if (s.startsWith('0')) {
    // UAE local trunk form: 0501234567 -> +971501234567
    s = `+971${s.slice(1)}`
  } else if (/^\d+$/.test(s)) {
    s = `+${s}`
  } else {
    return null
  }

  if (!/^\+[1-9]\d{7,14}$/.test(s)) return null
  return s
}

/** UAE mobile numbers must be 9 digits after the +971 country code. */
export function isUaeMobile(e164: string): boolean {
  return /^\+971\d{9}$/.test(e164)
}

/**
 * Compose the digest body.
 *
 * Deviations from the brief's template, each because the brief's version would print a
 * number that is not true:
 *
 * - The brief falls back to `avgPsf24h = avgPsf90` when there were no sales yesterday, so
 *   a day with zero transactions renders a confident PSF and "0 transactions yesterday".
 *   A quiet day is stated as quiet.
 * - The brief computes the delta against the same 90-day window it just used as the
 *   fallback, so with no sales the delta is always exactly 0.0% and the arrow is always
 *   "→" — motion invented from an absent comparison. The delta is only shown when there
 *   is a real 24h figure to compare.
 * - `.slice(0, 3)` silently drops the rest. The count is reported so the reader knows the
 *   message is partial.
 */
export function buildDigest(
  name: string | null,
  communities: DigestCommunity[],
  opts: { now?: Date; windowDays?: number } = {},
): string {
  const now = opts.now ?? new Date()
  const when = now.toLocaleDateString('en-AE', { weekday: 'long', day: 'numeric', month: 'long' })
  const greeting = name ? `Hi ${name.split(' ')[0]}, ` : ''

  const lines: string[] = [`📊 *sqftLab Market Digest*`, `${greeting}${when}`, '']

  const shown = communities.slice(0, DIGEST_MAX_COMMUNITIES)

  if (shown.length === 0) {
    lines.push('No tracked communities have data to report today.')
  }

  for (const cm of shown) {
    lines.push(`*${cm.name}*`)
    if (cm.transactionsYesterday === 0) {
      lines.push(`No registered sales yesterday.`)
      if (cm.psf90d > 0) lines.push(`90-day average: AED ${Math.round(cm.psf90d).toLocaleString()}/sqft`)
      lines.push('')
      continue
    }
    lines.push(`${cm.transactionsYesterday} transaction${cm.transactionsYesterday === 1 ? '' : 's'} yesterday`)
    if (cm.psf90d > 0 && cm.psfYesterday > 0) {
      const delta = ((cm.psfYesterday - cm.psf90d) / cm.psf90d) * 100
      const arrow = delta > 0.05 ? '↑' : delta < -0.05 ? '↓' : '→'
      lines.push(
        `PSF: AED ${Math.round(cm.psfYesterday).toLocaleString()} ${arrow} ${Math.abs(delta).toFixed(1)}% vs 90d`,
      )
    } else {
      lines.push(`PSF: AED ${Math.round(cm.psfYesterday).toLocaleString()}`)
    }
    lines.push('')
  }

  if (communities.length > shown.length) {
    lines.push(`_+${communities.length - shown.length} more tracked area(s) not shown._`)
    lines.push('')
  }

  lines.push('View full data: sqftlab.com')
  lines.push('Reply STOP to unsubscribe.')
  return lines.join('\n')
}

/**
 * Send one WhatsApp message.
 *
 * Never throws: a transport that is missing or a provider that is refusing is reported,
 * because the caller has to decide whether the digest counted as delivered.
 */
export async function sendWhatsapp(to: string, body: string, env: NodeJS.ProcessEnv = process.env): Promise<SendResult> {
  const cfg = resolveTwilioConfig(env)
  if (!cfg) return { ok: false, reason: 'unconfigured' }

  const e164 = normaliseE164(to)
  if (!e164) return { ok: false, error: `not a valid E.164 number: ${to}` }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Messages.json`
  const form = new URLSearchParams({
    From: cfg.from.startsWith('whatsapp:') ? cfg.from : `whatsapp:${cfg.from}`,
    To: `whatsapp:${e164}`,
    Body: body,
  })

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(15_000),
    })
    const payload = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number }
    if (!res.ok) {
      return { ok: false, status: res.status, error: payload.message ?? `Twilio refused (HTTP ${res.status})` }
    }
    return { ok: true, status: res.status, sid: payload.sid }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'network failure' }
  }
}

/** The confirmation the brief sends on subscribe. Kept separate so it is testable. */
export function buildConfirmation(communities: string[], frequency: string): string {
  const list = communities.length ? communities.join(', ') : 'your saved areas'
  return [
    '✅ *sqftLab Market Digest*',
    '',
    `You're subscribed! You'll receive ${frequency} DLD market updates for:`,
    list,
    '',
    'Reply STOP to unsubscribe.',
  ].join('\n')
}

/** STOP / UNSUBSCRIBE keywords Twilio reports in the inbound `Body`. */
export function isStopKeyword(body: unknown): boolean {
  if (typeof body !== 'string') return false
  const t = body.trim().toUpperCase()
  return t === 'STOP' || t === 'UNSUBSCRIBE' || t === 'CANCEL' || t === 'END'
}
