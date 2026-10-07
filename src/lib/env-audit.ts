/**
 * Environment audit (Day 17 Task E3).
 *
 * The brief hands over a fixed list of variables to check in Railway. That list does not
 * describe this deployment, and copying it verbatim would be worse than not checking at
 * all:
 *
 *   · It requires REDIS_URL, NEXTAUTH_SECRET and NEXTAUTH_URL. There is no Redis (the
 *     cache is an in-process Map) and no NextAuth (this app issues its own session
 *     tokens). `NEXTAUTH_URL` appears in the codebase exactly once — in a comment
 *     explaining why it is not used.
 *   · It requires RESEND_API_KEY. Nothing here reads it; there is no email transport.
 *   · It omits every variable that actually matters for this build: DUBAI_PULSE_API_KEY
 *     (the DLD feed), ADREC_API_KEY, the `STRIPE_PRICE_*` ids, TWILIO_*, APP_URL,
 *     PUPPETEER_EXECUTABLE_PATH.
 *
 * Reporting a set of names that are supposed to be absent as "MISSING" trains whoever
 * reads the log to ignore it — which is precisely how the genuinely missing ones get
 * missed. So the list below is derived from what the code reads, grouped by the
 * capability that silently disappears without it.
 *
 * Nothing except DATABASE_URL is fatal. Every other entry disables one feature while the
 * site stays up and looks fine, which is why they ship unnoticed.
 */

export interface EnvRequirement {
  /** What stops working when these are absent. */
  capability: string
  /** Fatal = the process cannot serve anything useful. */
  fatal?: boolean
  vars: string[]
  /** The user-visible symptom, for the report. */
  symptom: string
}

export const ENV_REQUIREMENTS: EnvRequirement[] = [
  {
    capability: 'Database',
    fatal: true,
    vars: ['DATABASE_URL'],
    symptom: 'Prisma cannot open a connection; every data route fails.',
  },
  {
    capability: 'Cron authentication',
    vars: ['CRON_SECRET'],
    symptom: 'The hourly refresh and intelligence endpoints are unauthenticated or unusable.',
  },
  {
    capability: 'DLD transaction feed',
    vars: ['DUBAI_PULSE_API_KEY'],
    symptom:
      'Transactions stay at 0, so every median, yield, capital-flow and CMA figure has no source behind it. This is the single most consequential missing variable.',
  },
  {
    capability: 'Abu Dhabi feed',
    vars: ['ADREC_API_KEY'],
    symptom: 'ADREC sync is skipped; Abu Dhabi districts keep their seeded values.',
  },
  {
    capability: 'Exchange rates',
    vars: ['EXCHANGE_RATE_API_KEY'],
    symptom: 'FX falls back to stored rates and stops updating.',
  },
  {
    capability: 'Billing',
    vars: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
    symptom: 'Checkout cannot start and subscription state never syncs from Stripe.',
  },
  {
    capability: 'Billing price ids',
    vars: [
      'STRIPE_PRICE_PRO_MONTHLY', 'STRIPE_PRICE_PRO_ANNUAL',
      'STRIPE_PRICE_ENTERPRISE_MONTHLY', 'STRIPE_PRICE_ENTERPRISE_ANNUAL',
      'STRIPE_PRICE_INSTITUTIONAL_MONTHLY', 'STRIPE_PRICE_INSTITUTIONAL_ANNUAL',
    ],
    symptom: 'The affected plan cannot be purchased; checkout returns a price-not-found error.',
  },
  {
    capability: 'Google sign-in',
    vars: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    symptom: 'The Google OAuth button fails; magic-link and session sign-in still work.',
  },
  {
    capability: 'WhatsApp digests',
    vars: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
    symptom: 'Digest sends are skipped and the subscription UI reports WhatsApp as unconfigured.',
  },
  {
    capability: 'AI assistant',
    vars: ['ANTHROPIC_API_KEY'],
    symptom: 'The chat widget answers with a not-configured message.',
  },
  {
    capability: 'Absolute links',
    vars: ['APP_URL'],
    symptom: 'Verification and digest links fall back to a relative path in outbound messages.',
  },
  {
    capability: 'PDF reports',
    vars: ['PUPPETEER_EXECUTABLE_PATH'],
    symptom:
      'Report generation searches common Chromium paths, then raises PdfUnavailableError. On Debian trixie the binary is /usr/bin/chromium, not /usr/bin/chromium-browser.',
  },
]

/**
 * Variables the Day 17 brief asks for that this deployment does not use, with the reason.
 * Reported explicitly so a checklist reading "all env vars set" can be answered, instead
 * of the names being quietly absent and looking like an oversight.
 */
export const NOT_APPLICABLE: Array<{ name: string; reason: string }> = [
  { name: 'REDIS_URL', reason: 'No Redis. The cache is a process-local Map (src/lib/cache.ts).' },
  { name: 'NEXTAUTH_SECRET', reason: 'No NextAuth. Session tokens are issued by /sqftlab/auth/*.' },
  { name: 'NEXTAUTH_URL', reason: 'No NextAuth. APP_URL / PUBLIC_APP_URL serve the same purpose.' },
  { name: 'RESEND_API_KEY', reason: 'No email transport is wired up; nothing reads this.' },
]

export interface EnvReport {
  fatalMissing: string[]
  degraded: Array<{ capability: string; missing: string[]; symptom: string }>
  present: string[]
}

export function envReport(env: NodeJS.ProcessEnv = process.env): EnvReport {
  const fatalMissing: string[] = []
  const degraded: EnvReport['degraded'] = []
  const present: string[] = []

  for (const group of ENV_REQUIREMENTS) {
    const missing = group.vars.filter((k) => !env[k] || String(env[k]).trim() === '')
    present.push(...group.vars.filter((k) => !missing.includes(k)))
    if (missing.length === 0) continue
    if (group.fatal) fatalMissing.push(...missing)
    else degraded.push({ capability: group.capability, missing, symptom: group.symptom })
  }

  return { fatalMissing, degraded, present }
}

/**
 * One line per problem at boot.
 *
 * Deliberately NOT split across a dozen logger calls: a wall of warnings on every restart
 * is scrolled past. One fatal line and one summary line stay readable in a deploy log.
 */
export function auditEnv(env: NodeJS.ProcessEnv = process.env): EnvReport {
  const report = envReport(env)
  if (report.fatalMissing.length > 0) {
    console.error(`[env] MISSING REQUIRED ENV VARS: ${report.fatalMissing.join(', ')}`)
  }
  if (report.degraded.length > 0) {
    console.warn(
      `[env] ${report.degraded.length} feature(s) dormant for lack of configuration: ` +
        report.degraded.map((d) => `${d.capability} <${d.missing.join(', ')}>`).join(' · '),
    )
  }
  return report
}
