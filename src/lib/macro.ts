// Spec Part 3.2 — macro + FX ingestion from the free, keyless sources.
//
// Every fetcher is written to *fail loudly and locally*: a blocked or rate
// limited upstream records an error string and leaves the table untouched,
// rather than writing a placeholder value that would silently poison the
// Economic Sensitivity regression downstream.
//
// Verified reachable from this runtime: ExchangeRate-API, World Bank, IMF.
// Not reachable (datacenter IP blocked / rate limited): Yahoo Finance, OSM.

import { prisma } from './db'

export interface FetchResult {
  source: string
  ok: boolean
  rows?: number
  error?: string
}

const UA = 'sqftLab/1.0 (+https://sqftlab.com; data intelligence platform)'

async function getJson<T>(url: string, timeoutMs = 30_000): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, status: res.status, error: `HTTP ${res.status}${body ? ` — ${body.slice(0, 140)}` : ''}` }
    }
    return { ok: true, data: (await res.json()) as T }
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }
  } finally {
    clearTimeout(timer)
  }
}

// ─── Source 5: ExchangeRate-API (open endpoint, no key) ─────────────────────

interface ErApiResponse {
  result: string
  base_code?: string
  rates?: Record<string, number>
  time_last_update_utc?: string
}

export async function fetchExchangeRates(): Promise<FetchResult> {
  const r = await getJson<ErApiResponse>('https://open.er-api.com/v6/latest/AED')
  if (!r.ok) return { source: 'exchangerate-api', ok: false, error: r.error }
  const rates = r.data.rates
  if (!rates) return { source: 'exchangerate-api', ok: false, error: 'No rates in response' }

  await prisma.exchangeRate.create({
    data: {
      base: 'AED',
      usd: rates.USD ?? null,
      gbp: rates.GBP ?? null,
      eur: rates.EUR ?? null,
      inr: rates.INR ?? null,
      pkr: rates.PKR ?? null,
      cny: rates.CNY ?? null,
    },
  })
  // Keep the table to the most recent 500 snapshots.
  const stale = await prisma.exchangeRate.findMany({ orderBy: { fetchedAt: 'desc' }, skip: 500, select: { id: true } })
  if (stale.length) await prisma.exchangeRate.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } })

  return { source: 'exchangerate-api', ok: true, rows: 1 }
}

// ─── Sources 7: World Bank Open Data (no key) ───────────────────────────────

const WB_INDICATORS: { code: string; key: string }[] = [
  { code: 'NY.GDP.MKTP.CD', key: 'uae_gdp' },
  { code: 'NY.GDP.PCAP.CD', key: 'uae_gdp_per_capita' },
  { code: 'SP.POP.TOTL', key: 'uae_population' },
  { code: 'FP.CPI.TOTL', key: 'uae_cpi' }, // CPI index level (2010 = 100)
  { code: 'FP.CPI.TOTL.ZG', key: 'uae_inflation' },
]

interface WbRow { date: string; value: number | null }

export async function fetchWorldBankIndicators(): Promise<FetchResult> {
  let rows = 0
  const errors: string[] = []

  // World Bank is slow per-indicator (up to ~30s); run them concurrently so the
  // total is bounded by the slowest request rather than their sum.
  const settled = await Promise.all(
    WB_INDICATORS.map(async (ind) => {
      const url = `https://api.worldbank.org/v2/country/AE/indicator/${ind.code}?format=json&per_page=60`
      const r = await getJson<[unknown, WbRow[]]>(url)
      return { ind, r }
    }),
  )

  for (const { ind, r } of settled) {
    if (!r.ok) { errors.push(`${ind.key}: ${r.error}`); continue }
    const series = Array.isArray(r.data) ? r.data[1] : null
    if (!Array.isArray(series)) { errors.push(`${ind.key}: unexpected shape`); continue }

    for (const row of series) {
      if (row.value == null) continue
      await prisma.macroIndicator.upsert({
        where: { indicator_period: { indicator: ind.key, period: row.date } },
        create: { indicator: ind.key, period: row.date, value: row.value, source: 'world_bank' },
        update: { value: row.value, fetchedAt: new Date() },
      })
      rows++
    }
  }
  return errors.length && !rows
    ? { source: 'world_bank', ok: false, error: errors.join('; ') }
    : { source: 'world_bank', ok: true, rows, ...(errors.length ? { error: errors.join('; ') } : {}) }
}

// ─── Source 8: IMF DataMapper (no key) ──────────────────────────────────────

interface ImfResponse { values?: Record<string, Record<string, Record<string, number>>> }

export async function fetchIMFData(): Promise<FetchResult> {
  const r = await getJson<ImfResponse>(
    'https://www.imf.org/external/datamapper/api/v1/NGDP_RPCH/ARE',
  )
  if (!r.ok) return { source: 'imf', ok: false, error: r.error }
  // DataMapper nests as values[INDICATOR][COUNTRY][YEAR] — not values[COUNTRY].
  const series = r.data.values?.NGDP_RPCH?.ARE
  if (!series) {
    return {
      source: 'imf', ok: false,
      error: `No NGDP_RPCH.ARE series — keys: ${Object.keys(r.data.values ?? {}).join(',') || 'none'}`,
    }
  }

  let rows = 0
  for (const [year, value] of Object.entries(series)) {
    if (value == null) continue
    await prisma.macroIndicator.upsert({
      where: { indicator_period: { indicator: 'uae_gdp_growth', period: year } },
      create: { indicator: 'uae_gdp_growth', period: year, value, source: 'imf_weo' },
      update: { value, fetchedAt: new Date() },
    })
    rows++
  }
  return { source: 'imf', ok: true, rows }
}

/** Source 9 — oil price. Yahoo blocks this runtime; recorded as a honest failure. */
export async function fetchOilPrice(): Promise<FetchResult> {
  const r = await getJson<{ chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { close?: (number | null)[] }[] } }[] } }>(
    'https://query1.finance.yahoo.com/v8/finance/chart/BZ=F?range=1mo&interval=1d',
  )
  if (!r.ok) return { source: 'yahoo_oil', ok: false, error: r.error }
  const result = r.data.chart?.result?.[0]
  const ts = result?.timestamp
  const closes = result?.indicators?.quote?.[0]?.close
  if (!ts?.length || !closes) return { source: 'yahoo_oil', ok: false, error: 'Empty chart payload' }

  let rows = 0
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i]
    if (c == null) continue
    const d = new Date(ts[i] * 1000)
    const period = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    await prisma.macroIndicator.upsert({
      where: { indicator_period: { indicator: 'oil_price', period } },
      create: { indicator: 'oil_price', period, value: c, source: 'yahoo_finance' },
      update: { value: c, fetchedAt: new Date() },
    })
    rows++
  }
  return { source: 'yahoo_oil', ok: true, rows }
}

/** All macro sources in one call — the spec's macro worker. */
export async function fetchAllMacro(): Promise<{ ok: boolean; results: FetchResult[] }> {
  const results: FetchResult[] = []
  results.push(await fetchExchangeRates())
  results.push(await fetchWorldBankIndicators())
  results.push(await fetchIMFData())
  results.push(await fetchOilPrice())
  return { ok: results.some((r) => r.ok), results }
}
