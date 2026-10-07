import { useState } from 'react'
import { KeyRound, Copy, Check, ArrowRight, Terminal, AlertTriangle, Gauge, Database } from 'lucide-react'
import { usePageMeta } from '@/lib/seo'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'

/**
 * Public API reference (Day 17 Task C).
 *
 * Corrections against the brief, all of them things the brief's version states that are
 * not true of this API:
 *
 *  · The brief lists two endpoints. There are three: `GET /api/v1/communities` is the
 *    discovery endpoint for the `area` parameter, and the endpoint's own 404 body points
 *    at it (`hint: 'GET /api/v1/communities to list valid names'`). A reference that omits
 *    it documents a query parameter with no documented way to find a valid value.
 *  · The brief's rate-limit table jumps pro → enterprise → institutional and omits
 *    `elite`, which is a real tier on this platform sitting between pro and enterprise.
 *    Omitting it would understate what an elite customer is paying for.
 *  · It labels the export column "Unlimited CSV+Excel" for enterprise/institutional. The
 *    real ceilings are 100,000 rows — a safety ceiling that exists because the scan walks
 *    the whole table. "Unlimited" is a claim the server would refuse.
 *  · Example requests and responses are copied from what the routes actually return, not
 *    from the brief's sketch, so a copy-paste from this page behaves as shown.
 *
 * It is a PUBLIC page: no session, no key needed to read it.
 */

const API_BASE = 'https://api.sqftlab.com'

const TIERS = [
  { tier: 'Pro', calls: '500 calls/day', rows: '1,000 rows/export', extra: '3 API keys' },
  { tier: 'Elite', calls: '2,000 calls/day', rows: '5,000 rows/export', extra: '5 API keys' },
  { tier: 'Enterprise', calls: '10,000 calls/day', rows: '100,000 rows/export', extra: 'CSV + Excel · 10 keys' },
  { tier: 'Institutional', calls: '100,000 calls/day', rows: '100,000 rows/export', extra: 'White-label API · 20 keys' },
]

const ENDPOINTS = [
  {
    method: 'GET',
    path: '/api/v1/transactions',
    auth: 'API key',
    tier: 'Pro',
    description: 'Registered DLD transactions, filtered by area, bedrooms, date and AED/sqft.',
  },
  {
    method: 'GET',
    path: '/api/v1/communities',
    auth: 'API key',
    tier: 'Pro',
    description: 'Every community name and slug accepted by the `area` parameter above.',
  },
  {
    method: 'GET',
    path: '/api/v1/communities/:slug/stats',
    auth: 'API key',
    tier: 'Pro',
    description: 'Rolling 90-day price-per-sqft statistics for one community.',
  },
]

const PARAMS = [
  { name: 'area', type: 'string', description: 'Community name or slug. `community` is accepted as an alias.' },
  { name: 'bedrooms', type: 'integer', description: 'Exact bedroom count. 0 selects studios.' },
  { name: 'psf_min / psf_max', type: 'integer', description: 'Price-per-sqft range in AED.' },
  { name: 'date_from / date_to', type: 'date', description: 'ISO dates, e.g. 2026-01-31.' },
  { name: 'limit', type: 'integer', description: 'Rows per page. Default 100, maximum 1000.' },
  { name: 'offset', type: 'integer', description: 'Rows to skip, for paging.' },
]

const ERRORS = [
  { status: '401', meaning: 'Missing or invalid API key.', fix: 'Send `Authorization: Bearer sqft_…`.' },
  { status: '403', meaning: "The key owner's subscription is not active.", fix: 'Renew the plan, or check /pricing.' },
  { status: '404', meaning: 'No community matches the `area` value.', fix: 'List valid names via /api/v1/communities.' },
  { status: '429', meaning: 'The key’s daily allowance is spent.', fix: 'Wait for the midnight UTC reset, or raise the tier.' },
]

const CURL = `curl -H "Authorization: Bearer sqft_YOUR_KEY" \\
  "${API_BASE}/api/v1/transactions?area=Downtown%20Dubai&bedrooms=2&limit=50"`

const NODE = `const res = await fetch(
  '${API_BASE}/api/v1/transactions?area=Downtown%20Dubai&bedrooms=2',
  { headers: { Authorization: 'Bearer sqft_YOUR_KEY' } }
)

if (!res.ok) {
  // 401 bad key · 403 subscription inactive · 429 daily limit · 404 unknown area
  const problem = await res.json()
  console.error(res.status, problem.error)
} else {
  const { data, meta } = await res.json()
  console.log(\`\${meta.total} transactions found\`)
  for (const txn of data) console.log(txn.date, txn.community, txn.psfAed)
}`

const PYTHON = `import requests

r = requests.get(
    '${API_BASE}/api/v1/transactions',
    headers={'Authorization': 'Bearer sqft_YOUR_KEY'},
    params={'area': 'Downtown Dubai', 'bedrooms': 2, 'limit': 50},
)

if r.status_code != 200:
    raise SystemExit(f"{r.status_code}: {r.json().get('error')}")

payload = r.json()
print(payload['meta']['total'], 'transactions')
for txn in payload['data']:
    print(txn['date'], txn['community'], txn['psfAed'])`

const RESPONSE = `{
  "data": [
    {
      "date": "2026-09-14",
      "community": "Downtown Dubai",
      "communitySlug": "downtown-dubai",
      "emirate": "Dubai",
      "building": "Burj Vista Tower 1",
      "bedrooms": 2,
      "sizeSqft": 1184,
      "psfAed": 2140,
      "priceAed": 2533760,
      "propertyType": "Flat",
      "transactionType": "Sales"
    }
  ],
  "meta": {
    "total": 1841,
    "limit": 50,
    "offset": 0,
    "returned": 50,
    "source": "DLD official records",
    "empty": false
  }
}`

function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard is unavailable over plain http and in some embedded browsers.
      // There is nothing useful to do; the block is selectable either way.
    }
  }
  return (
    <div>
      {/*
        The copy control sits ABOVE the block rather than floating over it. Absolutely
        positioned inside the block it overlapped the first line of code at 390px, where
        `Authorization: Bearer sqft_YOUR_API_KEY` is wider than the container — and
        `padding-right` does not fix it, because a scroll container's right padding is not
        part of its scrollable overflow area.
      */}
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--ink-5)' }}>{label ?? ''}</span>
        <button
          onClick={copy}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] shrink-0"
          style={{ background: 'rgba(15,23,42,0.06)', color: 'var(--ink-3)' }}
          aria-label="Copy code"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre
        className="overflow-x-auto text-[12px] leading-relaxed"
        style={{
          background: '#1a1a2e',
          color: '#fff',
          fontFamily: 'var(--font-data)',
          borderRadius: 8,
          padding: 16,
        }}
      >
        <code>{code}</code>
      </pre>
    </div>
  )
}

function Section({ title, icon: Icon, children }: { title: string; icon: typeof KeyRound; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Icon size={17} style={{ color: 'var(--b600)' }} />
        <h2 className="text-base font-semibold" style={{ color: 'var(--ink)' }}>{title}</h2>
      </div>
      {children}
    </section>
  )
}

export default function DocsPage({ onNavigate }: { onNavigate?: (page: 'api-keys' | 'pricing' | 'signin') => void }) {
  usePageMeta({
    title: 'API Documentation — sqftLab',
    description:
      'Access Dubai DLD transaction data programmatically. Bearer-key auth, JSON responses, 90-day community statistics.',
    canonicalPath: '/docs',
  })

  return (
    <div className="max-w-[1000px] mx-auto px-4 sm:px-6 py-8 sm:py-12 space-y-8">
      <header className="space-y-2">
        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium"
          style={{ background: 'rgba(37,99,235,0.08)', color: 'var(--b600)' }}>
          <Database size={12} /> REST · JSON
        </div>
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight" style={{ color: 'var(--ink)' }}>
          sqftLab API Documentation
        </h1>
        <p className="text-sm" style={{ color: 'var(--ink-4)' }}>
          Access Dubai DLD transaction data programmatically. Every response is JSON, authenticated
          with a bearer API key, and metered per key.
        </p>
      </header>

      <Section title="Authentication" icon={KeyRound}>
        <p className="text-sm" style={{ color: 'var(--ink-4)' }}>
          Send your key in the <code className="mono">Authorization</code> header on every request. Keys are
          shown once at creation and stored hashed — we cannot resend one.
        </p>
        <CodeBlock code={`Authorization: Bearer sqft_YOUR_API_KEY`} label="Header" />
        <div className="g4 p-3 flex gap-2 text-[12px]" style={{ color: 'var(--ink-4)' }}>
          <AlertTriangle size={14} className="shrink-0 mt-0.5" style={{ color: '#b45309' }} />
          <span>
            The key is only sent in the header, never as a <code className="mono">?api_key=</code> query
            parameter — a query string would leak the secret into access logs, proxies and referrer headers.
          </span>
        </div>
      </Section>

      <Section title="Endpoints" icon={Terminal}>
        <div className="g2 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--gb)' }}>
                  {['Endpoint', 'Method', 'Auth', 'Tier', 'Description'].map((h) => (
                    <th key={h} className="text-left px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide"
                      style={{ color: 'var(--ink-4)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ENDPOINTS.map((e) => (
                  <tr key={e.path} style={{ borderBottom: '1px solid var(--gb)' }}>
                    <td className="px-4 py-2.5 mono text-[12px]" style={{ color: 'var(--ink)' }}>{e.path}</td>
                    <td className="px-4 py-2.5">
                      <span className="px-2 py-0.5 rounded text-[10px] font-semibold"
                        style={{ background: 'rgba(34,197,94,0.12)', color: '#15803d' }}>{e.method}</span>
                    </td>
                    <td className="px-4 py-2.5 text-[12px]" style={{ color: 'var(--ink-4)' }}>{e.auth}</td>
                    <td className="px-4 py-2.5 text-[12px]" style={{ color: 'var(--ink-4)' }}>{e.tier}</td>
                    <td className="px-4 py-2.5 text-[12px]" style={{ color: 'var(--ink-4)' }}>{e.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <h3 className="text-sm font-semibold pt-1" style={{ color: 'var(--ink)' }}>Query parameters</h3>
        <div className="g2 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[560px]">
              <tbody>
                {PARAMS.map((p) => (
                  <tr key={p.name} style={{ borderBottom: '1px solid var(--gb)' }}>
                    <td className="px-4 py-2.5 mono text-[12px] whitespace-nowrap" style={{ color: 'var(--b600)' }}>{p.name}</td>
                    <td className="px-4 py-2.5 text-[11px] whitespace-nowrap" style={{ color: 'var(--ink-4)' }}>{p.type}</td>
                    <td className="px-4 py-2.5 text-[12px]" style={{ color: 'var(--ink-4)' }}>{p.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Section>

      <Section title="Code examples" icon={Terminal}>
        <Tabs defaultValue="curl">
          <TabsList>
            <TabsTrigger value="curl">cURL</TabsTrigger>
            <TabsTrigger value="node">Node.js</TabsTrigger>
            <TabsTrigger value="python">Python</TabsTrigger>
          </TabsList>
          <TabsContent value="curl"><CodeBlock code={CURL} /></TabsContent>
          <TabsContent value="node"><CodeBlock code={NODE} /></TabsContent>
          <TabsContent value="python"><CodeBlock code={PYTHON} /></TabsContent>
        </Tabs>
      </Section>

      <Section title="Response shape" icon={Terminal}>
        <CodeBlock code={RESPONSE} />
        <div className="g4 p-3 text-[12px] space-y-1" style={{ color: 'var(--ink-4)' }}>
          <div><strong style={{ color: 'var(--ink)' }}>meta.empty</strong> — the query was valid but the result set is empty.
            This is not an error: with no registry feed connected, it is the honest shape of the answer.</div>
          <div><strong style={{ color: 'var(--ink)' }}>meta.total</strong> — total matching rows before paging, so you can size your loop.</div>
          <div><strong style={{ color: 'var(--ink)' }}>X-API-Limit / X-API-Remaining</strong> — your per-key daily allowance and what is left of it,
            on every response.</div>
        </div>
      </Section>

      <Section title="Rate limits" icon={Gauge}>
        <p className="text-sm" style={{ color: 'var(--ink-4)' }}>
          Limits are enforced <strong style={{ color: 'var(--ink)' }}>per key</strong>, not per account: two keys do not
          share one daily pool. Counters reset at midnight UTC.
        </p>
        <div className="g2 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[560px]">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--gb)' }}>
                  {['Tier', 'API calls', 'Exports', 'Includes'].map((h) => (
                    <th key={h} className="text-left px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide"
                      style={{ color: 'var(--ink-4)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {TIERS.map((t) => (
                  <tr key={t.tier} style={{ borderBottom: '1px solid var(--gb)' }}>
                    <td className="px-4 py-2.5 font-medium text-[13px]" style={{ color: 'var(--ink)' }}>{t.tier}</td>
                    <td className="px-4 py-2.5 mono text-[12px]" style={{ color: 'var(--ink-4)' }}>{t.calls}</td>
                    <td className="px-4 py-2.5 text-[12px]" style={{ color: 'var(--ink-4)' }}>{t.rows}</td>
                    <td className="px-4 py-2.5 text-[12px]" style={{ color: 'var(--ink-4)' }}>{t.extra}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Section>

      <Section title="Errors" icon={AlertTriangle}>
        <div className="g2 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[560px]">
              <tbody>
                {ERRORS.map((e) => (
                  <tr key={e.status} style={{ borderBottom: '1px solid var(--gb)' }}>
                    <td className="px-4 py-2.5 mono text-[12px] font-semibold" style={{ color: '#b91c1c' }}>{e.status}</td>
                    <td className="px-4 py-2.5 text-[12px]" style={{ color: 'var(--ink-4)' }}>{e.meaning}</td>
                    <td className="px-4 py-2.5 text-[12px]" style={{ color: 'var(--ink-4)' }}>{e.fix}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Section>

      <section className="g2 p-5 sm:p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <div className="font-semibold text-sm" style={{ color: 'var(--ink)' }}>Get an API key</div>
          <div className="text-xs" style={{ color: 'var(--ink-4)' }}>
            Pro and above can create keys from the dashboard. Institutional adds white-label branding
            on your own domain.
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={() => onNavigate?.('api-keys')}
            className="flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-semibold"
            style={{ background: 'var(--b600)', color: '#fff', boxShadow: 'var(--sh-btn)' }}
          >
            Get API Key <ArrowRight size={13} />
          </button>
          <button
            onClick={() => onNavigate?.('pricing')}
            className="px-4 py-2 rounded-full text-xs font-semibold"
            style={{ color: 'var(--ink-3)', border: '1px solid var(--line)' }}
          >
            See pricing
          </button>
        </div>
      </section>
    </div>
  )
}
