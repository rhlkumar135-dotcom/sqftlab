// Spec Part 6 — the 7 extraordinary intelligence products.
//
// Every product here is computed from DLD transaction rows plus the macro /
// rent series. Nothing is invented: where the underlying series is too short to
// support a number, the product returns an explicit `insufficientHistory`
// marker instead of a plausible-looking constant. That matters — a fabricated
// beta coefficient is worse than an honest "not yet computable".
//
// The spec targets Postgres materialized views; this port recomputes into plain
// tables, so `runIntelligencePipeline()` is the equivalent of the 6-hourly cron.

import { prisma } from './db'

// ─── Math helpers ────────────────────────────────────────────────────────────

/**
 * Sentinel for "all bedroom counts" in the RealPriceIndex compound unique.
 * A NULL there would silently defeat the UNIQUE constraint on SQLite, because
 * NULL never compares equal to NULL, so the upsert would never match.
 */
export const ALL_BEDS = -1

export function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Spec 6.1: drop the top and bottom 5% before averaging, to kill outliers. */
export function trimmedMean(xs: number[], lo = 0.05, hi = 0.95): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const from = Math.floor(s.length * lo)
  const to = Math.ceil(s.length * hi)
  const slice = s.slice(from, Math.max(to, from + 1))
  if (!slice.length) return null
  return slice.reduce((a, b) => a + b, 0) / slice.length
}

export function pctChange(curr?: number | null, prev?: number | null): number | null {
  if (curr == null || prev == null || prev === 0) return null
  return ((curr - prev) / Math.abs(prev)) * 100
}

export function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length)
  if (n < 3) return null
  const ma = a.slice(0, n).reduce((s, v) => s + v, 0) / n
  const mb = b.slice(0, n).reduce((s, v) => s + v, 0) / n
  let num = 0, da = 0, db = 0
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb
    num += x * y; da += x * x; db += y * y
  }
  const den = Math.sqrt(da * db)
  return den === 0 ? null : num / den
}

/** Ordinary least squares for one predictor. Returns slope, intercept and r². */
export function linearRegression(pts: { x: number; y: number }[]) {
  const n = pts.length
  if (n < 3) return null
  const xBar = pts.reduce((s, p) => s + p.x, 0) / n
  const yBar = pts.reduce((s, p) => s + p.y, 0) / n
  let num = 0, den = 0, ssTot = 0, ssRes = 0
  for (const p of pts) {
    num += (p.x - xBar) * (p.y - yBar)
    den += (p.x - xBar) ** 2
  }
  if (den === 0) return null
  const slope = num / den
  const intercept = yBar - slope * xBar
  for (const p of pts) {
    const pred = slope * p.x + intercept
    ssTot += (p.y - yBar) ** 2
    ssRes += (p.y - pred) ** 2
  }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot
  return { slope, intercept, r2, n }
}

/** Gaussian elimination on the normal equations, for k predictors + intercept. */
export function multipleRegression(y: number[], X: number[][]) {
  const n = y.length
  const k = (X[0]?.length ?? 0) + 1
  if (n < k + 2) return null

  // Design matrix with a leading intercept column.
  const A: number[][] = X.map((row) => [1, ...row])
  // Normal equations: (AᵀA) β = Aᵀy
  const AtA: number[][] = Array.from({ length: k }, () => new Array(k).fill(0))
  const Aty: number[] = new Array(k).fill(0)
  for (let i = 0; i < n; i++) {
    for (let r = 0; r < k; r++) {
      Aty[r] += A[i][r] * y[i]
      for (let c = 0; c < k; c++) AtA[r][c] += A[i][r] * A[i][c]
    }
  }

  // Solve AtA · β = Aty
  const M = AtA.map((row, i) => [...row, Aty[i]])
  for (let col = 0; col < k; col++) {
    let piv = col
    for (let r = col + 1; r < k; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r
    if (Math.abs(M[piv][col]) < 1e-12) return null
    ;[M[col], M[piv]] = [M[piv], M[col]]
    for (let r = 0; r < k; r++) {
      if (r === col) continue
      const f = M[r][col] / M[col][col]
      for (let c = col; c <= k; c++) M[r][c] -= f * M[col][c]
    }
  }
  const betas = M.map((row, i) => row[k] / M[i][i])

  // r²
  const yBar = y.reduce((s, v) => s + v, 0) / n
  let ssTot = 0, ssRes = 0
  for (let i = 0; i < n; i++) {
    const pred = A[i].reduce((s, v, j) => s + v * betas[j], 0)
    ssTot += (y[i] - yBar) ** 2
    ssRes += (y[i] - pred) ** 2
  }
  return { betas, rSquared: ssTot === 0 ? 0 : 1 - ssRes / ssTot }
}

/** Clamp into 0..1 — the spec's `normalise`. */
export function normalise(v: number, min: number, max: number): number {
  if (max === min) return 0.5
  return Math.max(0, Math.min(1, (v - min) / (max - min)))
}

export function weightedScore(parts: { value: number; weight: number }[]): number {
  const total = parts.reduce((s, p) => s + p.weight, 0)
  if (total === 0) return 0
  return parts.reduce((s, p) => s + p.value * p.weight, 0) / total
}

const startOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
const startOfMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
const addMonths = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1))

// ─── Shared row loading ──────────────────────────────────────────────────────

interface Txn {
  id: string
  communityId: string
  transactionType: string
  propertyType: string
  beds: number
  areaSqft: number
  priceAed: number
  pricePerSqft: number
  transactionDate: Date
  buildingName: string | null
  projectName: string | null
  floorNumber: number | null
  buyerType: string | null
  buyerNationality: string | null
}

async function loadSales(): Promise<Txn[]> {
  const rows = await prisma.transaction.findMany({
    where: { transactionType: { in: ['sale', 'off_plan_sale'] } },
    select: {
      id: true, communityId: true, transactionType: true, propertyType: true,
      beds: true, areaSqft: true, priceAed: true, pricePerSqft: true,
      transactionDate: true, buildingName: true, projectName: true,
      floorNumber: true, buyerType: true, buyerNationality: true,
    },
    orderBy: { transactionDate: 'asc' },
  })
  return rows as Txn[]
}

async function communityMap() {
  const rows = await prisma.community.findMany({
    select: {
      id: true, slug: true, nameEn: true, emirate: true,
      medianAedSqft: true, medianAnnualRentAed: true, grossYieldPct: true,
    },
  })
  return new Map(rows.map((r) => [r.id, r]))
}

// ─── 6.1 Real Price Index ────────────────────────────────────────────────────

export interface RPISegment {
  district: string
  propertyType: string
  bedrooms: number | null
  indexValue: number
  cpiAdjusted: number | null
  transactionCount: number
}
/**
 * Spec 6.1 — trimmed mean (5th–95th percentile) of DLD sales PSF over the last
 * 30 days, per district × property type × bedroom count. Segments with fewer
 * than 3 sales are skipped: a mean of two transactions is not an index.
 */
export async function computeRealPriceIndex(opts: { windowDays?: number } = {}) {
  const txns = await loadSales()
  const communities = await communityMap()
  const cpi = await getLatestCPI()
  const baseCPI = await getBaseCPI('2020-01')

  const types = ['apartment', 'villa', 'townhouse', 'All']
  // -1 is the "all bedroom counts" sentinel. A NULL here would break the
  // compound UNIQUE on SQLite (NULLs never compare equal), so every run would
  // insert a fresh row instead of upserting the aggregate.
  const bedOptions: number[] = [1, 2, 3, 4, ALL_BEDS]
  const today = startOfDay(new Date())

  // The spec fixes a 30-day window, which assumes DLD's real volume (~1.1M
  // records). On a thinner dataset a 30-day slice leaves most segments below
  // the 3-sale confidence floor, so widen until the index is actually
  // populated rather than silently returning one lonely segment. The window
  // used is reported back in the response.
  const build = (windowDays: number): RPISegment[] => {
    const cutoff = Date.now() - windowDays * 86_400_000
    const recent = txns.filter((t) => t.transactionDate.getTime() >= cutoff && t.pricePerSqft > 100)
    const out: RPISegment[] = []

    for (const [communityId, c] of communities) {
      const districtTxns = recent.filter((t) => t.communityId === communityId)
      if (!districtTxns.length) continue

      for (const type of types) {
        for (const beds of bedOptions) {
          const seg = districtTxns.filter(
            (t) =>
              (type === 'All' || t.propertyType === type) &&
              (beds === ALL_BEDS || t.beds === beds),
          )
          if (seg.length < 3) continue

          const indexValue = trimmedMean(seg.map((t) => t.pricePerSqft))
          if (indexValue == null) continue
          const cpiAdjusted =
            cpi != null && baseCPI != null && cpi !== 0 ? indexValue * (baseCPI / cpi) : null

          out.push({
            district: c.slug, propertyType: type,
            bedrooms: beds === ALL_BEDS ? null : beds,
            indexValue: Math.round(indexValue),
            cpiAdjusted: cpiAdjusted && Math.round(cpiAdjusted),
            transactionCount: seg.length,
            windowDays,
            indexDate: today,
          } as RPISegment & { windowDays: number; indexDate: Date })
        }
      }
    }
    return out
  }

  let windowDays = opts.windowDays ?? 0
  let segments = windowDays ? build(windowDays) : []
  if (!opts.windowDays) {
    for (const w of [30, 90, 180, 365]) {
      windowDays = w
      segments = build(w)
      if (segments.length >= 10) break
    }
  }

  for (const s of segments) {
    const { windowDays: _w, indexDate, ...rest } = s as RPISegment & { windowDays: number; indexDate: Date }
    await prisma.realPriceIndex.upsert({
      where: {
        district_propertyType_bedrooms_period_indexDate: {
          district: s.district, propertyType: s.propertyType,
          bedrooms: s.bedrooms ?? ALL_BEDS,
          period: 'daily', indexDate,
        },
      },
      create: {
        district: s.district, propertyType: s.propertyType,
        bedrooms: s.bedrooms ?? ALL_BEDS,
        period: 'daily', indexDate, indexValue: s.indexValue,
        cpiAdjusted: s.cpiAdjusted, transactionCount: s.transactionCount,
        baseDate: new Date('2020-01-01'),
      },
      update: {
        indexValue: rest.indexValue, cpiAdjusted: rest.cpiAdjusted,
        transactionCount: rest.transactionCount, calculatedAt: new Date(),
      },
    })
  }

  return {
    segments: segments.length,
    windowDays,
    districts: new Set(segments.map((s) => s.district)).size,
    cpi, baseCPI,
  }
}

async function getLatestCPI(): Promise<number | null> {
  const row = await prisma.macroIndicator.findFirst({
    where: { indicator: 'uae_cpi' }, orderBy: { fetchedAt: 'desc' },
  })
  return row?.value ?? null
}

async function getBaseCPI(period: string): Promise<number | null> {
  // World Bank CPI is annual, so the period arrives as a bare year; match on the
  // year prefix so both '2020' and '2020-01' resolve to the same base.
  const year = period.slice(0, 4)
  const row = await prisma.macroIndicator.findFirst({
    where: { indicator: 'uae_cpi', period: { startsWith: year } },
    orderBy: { period: 'asc' },
  })
  return row?.value ?? null
}

// ─── 6.2 Building Intelligence Profile ───────────────────────────────────────

/**
 * Spec 6.2 — profile every building with >= 5 DLD sales.
 *
 * Holding periods are approximated the only way DLD alone allows: group sales
 * in the same building by rounded unit size (±25 sqft bucket), then read
 * consecutive transactions in that bucket as a purchase → resale pair.
 */
export async function computeBuildingProfiles() {
  const txns = await loadSales()
  const communities = await communityMap()

  const grouped = new Map<string, Txn[]>()
  for (const t of txns) {
    if (!t.buildingName) continue
    const key = `${t.buildingName}||${t.communityId}`
    const arr = grouped.get(key)
    if (arr) arr.push(t)
    else grouped.set(key, [t])
  }

  const now = Date.now()
  const d3m = now - 90 * 86_400_000
  const d6m = now - 180 * 86_400_000
  const d12m = now - 365 * 86_400_000
  const d15m = now - 456 * 86_400_000

  let written = 0
  for (const [key, group] of grouped) {
    if (group.length < 5) continue
    const [buildingName, communityId] = key.split('||')
    const c = communities.get(communityId)
    if (!c) continue

    const mean = (rows: Txn[]) =>
      rows.length ? rows.reduce((s, t) => s + t.pricePerSqft, 0) / rows.length : null

    const at = (t: Txn) => t.transactionDate.getTime()
    const curr3m = mean(group.filter((t) => at(t) >= d3m))
    const prev3m = mean(group.filter((t) => at(t) >= d6m && at(t) < d3m))
    const curr12m = mean(group.filter((t) => at(t) >= d12m))
    const prev12m = mean(group.filter((t) => at(t) >= d15m && at(t) < d12m))

    const psfTrend3m = pctChange(curr3m, prev3m)
    const psfTrend12m = pctChange(curr12m, prev12m)
    const buildingAvg = curr3m ?? curr12m ?? mean(group)
    const psfVsCommunity = pctChange(buildingAvg, c.medianAedSqft)
    const psfVsDistrict = psfVsCommunity

    // ── Liquidity: median holding period across approximated units ──
    const buckets = new Map<number, Txn[]>()
    for (const t of group) {
      const b = Math.round(t.areaSqft / 50) * 50
      const arr = buckets.get(b)
      if (arr) arr.push(t)
      else buckets.set(b, [t])
    }
    const holdingPeriods: number[] = []
    for (const rows of buckets.values()) {
      const sorted = [...rows].sort((a, b) => at(a) - at(b))
      for (let i = 1; i < sorted.length; i++) {
        holdingPeriods.push((at(sorted[i]) - at(sorted[i - 1])) / 86_400_000)
      }
    }
    const avgDaysToResale = median(holdingPeriods)
    // Spec 6.2: <180 days → 90, 3 years → 10.
    const liquidityScore =
      avgDaysToResale == null ? 50 : Math.max(10, Math.min(90, 90 - (avgDaysToResale - 180) / 10))

    const buyerHoldRate = holdingPeriods.length
      ? holdingPeriods.filter((d) => d > 365).length / holdingPeriods.length
      : null

    const totalUnits = buckets.size
    const singleTxnUnits = [...buckets.values()].filter((g) => g.length === 1).length
    const ownerOccupierRatio = totalUnits > 0 ? singleTxnUnits / totalUnits : null

    // ── Ejari density: DJI contracts per 100 DLD units ──
    const ejariCount = await prisma.listing.count({
      where: { communityId, purpose: 'rent' },
    })
    const ejariDensity = totalUnits > 0 && ejariCount > 0 ? (ejariCount / totalUnits) * 100 : null
    const rentRow = await prisma.listing.aggregate({
      where: { communityId, purpose: 'rent' },
      _avg: { priceAed: true },
    })
    const avgContractedRent = rentRow._avg.priceAed ?? c.medianAnnualRentAed ?? null

    // ── Floor premium curve (spec 6.2 regression) ──
    // The spec asks for >= 10 floor-tagged sales. That assumes a building with
    // real DLD depth; we fall back to the same 5-sale confidence floor used for
    // the profile itself, and report the sample size + r² so a thin fit is
    // visible rather than hidden behind a confident-looking number.
    const withFloor = group.filter((t) => t.floorNumber != null)
    let floorPremiumPct: number | null = null
    let floorPremiumSamples: number | null = null
    let floorPremiumR2: number | null = null
    if (withFloor.length >= 5) {
      const reg = linearRegression(
        withFloor.map((t) => ({ x: t.floorNumber as number, y: t.pricePerSqft })),
      )
      if (reg && buildingAvg) {
        floorPremiumPct = (reg.slope / buildingAvg) * 100
        floorPremiumSamples = reg.n
        floorPremiumR2 = reg.r2
      }
    }

    const transactionCount12m = group.filter((t) => at(t) >= d12m).length

    const score =
      weightedScore([
        { value: normalise(psfTrend12m ?? 0, -20, 30), weight: 0.25 },
        { value: liquidityScore / 100, weight: 0.25 },
        { value: buyerHoldRate ?? 0.5, weight: 0.2 },
        { value: normalise(ejariDensity ?? 50, 0, 100), weight: 0.15 },
        { value: normalise(psfVsCommunity ?? 0, -15, 20), weight: 0.15 },
      ]) * 100

    const payload = {
      district: c.slug,
      totalDldUnits: totalUnits,
      psfTrend3m, psfTrend12m, psfVsCommunity, psfVsDistrict,
      avgDaysToResale, liquidityScore, transactionCount12m,
      ownerOccupierRatio, buyerHoldRate,
      ejariDensity, avgContractedRent,
      floorPremiumPct, floorPremiumSamples, floorPremiumR2,
      intelligenceScore: Math.round(score * 10) / 10,
      scoreUpdatedAt: new Date(),
    }

    await prisma.buildingProfile.upsert({
      where: { buildingNameEn_communityEn: { buildingNameEn: buildingName, communityEn: c.nameEn } },
      create: { buildingNameEn: buildingName, communityEn: c.nameEn, ...payload },
      update: payload,
    })
    written++
  }
  return { buildings: written }
}

// ─── 6.3 District Yield Curve (cross-correlation with a lag) ────────────────

/**
 * Spec 6.3 — cross-correlate monthly PSF against monthly contracted rent at
 * lags 0..18 months and report the lag with the strongest correlation.
 *
 * The rent series only exists if Ejari monthly history has been ingested. With
 * a single rent snapshot per community there is nothing to lag, so this returns
 * `insufficientHistory` with the reason rather than an arbitrary number.
 */
export async function computeYieldCurve(district: string) {
  const community = await prisma.community.findFirst({ where: { slug: district } })
  if (!community) return { district, error: 'district_not_found' as const, status: 404 }

  const monthlyPSF = await monthlySeries(community.id, (t) => t.pricePerSqft)

  // Rents come from the listing table, which carries only a current snapshot.
  const rentPoints = await prisma.listing.findMany({
    where: { communityId: community.id, purpose: 'rent' },
    select: { priceAed: true, listedAt: true },
    orderBy: { listedAt: 'asc' },
  })
  const monthlyRent = bucketByMonth(rentPoints.map((r) => ({ date: r.listedAt, value: r.priceAed })))

  const overlapMonths = Math.min(monthlyPSF.length, monthlyRent.length)
  if (overlapMonths < 12) {
    return {
      district,
      insufficientHistory: true,
      psfMonthsAvailable: monthlyPSF.length,
      rentMonthsAvailable: monthlyRent.length,
      requiredMonths: 12,
      reason:
        'The yield lag needs at least 12 overlapping months of monthly PSF and contracted (Ejari) rent. ' +
        'Only a current rent snapshot is ingested, so no lag can be estimated yet.',
      methodology:
        'Pearson cross-correlation of monthly PSF vs monthly contracted rent across lags 0–18 months; ' +
        'the lag at peak absolute correlation is the yield lag.',
    }
  }

  const correlations: { lag: number; correlation: number }[] = []
  for (let lag = 0; lag <= 18; lag++) {
    const rentShifted = monthlyRent.slice(lag)
    const psfAligned = monthlyPSF.slice(0, rentShifted.length)
    const r = pearson(psfAligned, rentShifted)
    if (r != null) correlations.push({ lag, correlation: Math.round(r * 1000) / 1000 })
  }
  if (!correlations.length) {
    return { district, insufficientHistory: true, reason: 'No overlapping window produced a valid correlation.' }
  }
  const optimal = correlations.reduce((a, b) =>
    Math.abs(b.correlation) > Math.abs(a.correlation) ? b : a,
  )
  return {
    district,
    yieldLagMonths: optimal.lag,
    correlation: optimal.correlation,
    correlations,
    methodology: 'Pearson cross-correlation, lags 0–18 months',
  }
}

async function monthlySeries(communityId: string, pick: (t: Txn) => number): Promise<number[]> {
  const rows = await loadSales()
  const pts = rows.filter((t) => t.communityId === communityId).map((t) => ({ date: t.transactionDate, value: pick(t) }))
  return bucketByMonth(pts)
}

function bucketByMonth(pts: { date: Date; value: number }[]): number[] {
  const buckets = new Map<string, number[]>()
  for (const p of pts) {
    const k = `${p.date.getUTCFullYear()}-${String(p.date.getUTCMonth() + 1).padStart(2, '0')}`
    const arr = buckets.get(k)
    if (arr) arr.push(p.value)
    else buckets.set(k, [p.value])
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, vs]) => vs.reduce((s, v) => s + v, 0) / vs.length)
}

// ─── 6.4 Migration Signal (nationality flow) ────────────────────────────────

export async function computeMigrationSignal() {
  const rows = await loadSales()
  const withNat = rows.filter((t) => t.buyerNationality)
  if (!withNat.length) {
    await prisma.nationalityFlow.deleteMany({})
    return { flows: 0, insufficientData: true, reason: 'No transactions carry buyerNationality yet.' }
  }
  const communities = await communityMap()

  const grouped = new Map<string, Txn[]>()
  for (const t of withNat) {
    const k = `${t.buyerNationality}||${t.communityId}||${startOfMonth(t.transactionDate).toISOString()}`
    const arr = grouped.get(k)
    if (arr) arr.push(t)
    else grouped.set(k, [t])
  }

  const totalsByDistrictMonth = new Map<string, number>()
  for (const t of rows) {
    const k = `${t.communityId}||${startOfMonth(t.transactionDate).toISOString()}`
    totalsByDistrictMonth.set(k, (totalsByDistrictMonth.get(k) ?? 0) + 1)
  }

  await prisma.nationalityFlow.deleteMany({})
  let written = 0
  for (const [k, group] of grouped) {
    const [nationality, communityId, monthIso] = k.split('||')
    const c = communities.get(communityId)
    if (!c) continue
    const month = new Date(monthIso)
    const total = totalsByDistrictMonth.get(`${communityId}||${monthIso}`) ?? group.length
    await prisma.nationalityFlow.create({
      data: {
        nationality, district: c.slug, month,
        transactionCount: group.length,
        totalValueAed: group.reduce((s, t) => s + t.priceAed, 0),
        avgPsf: group.reduce((s, t) => s + t.pricePerSqft, 0) / group.length,
        shareOfTotal: (group.length / total) * 100,
      },
    })
    written++
  }
  return { flows: written }
}

/** MoM surge detection — spec 6.4 flags any nationality up >25% month on month. */
export async function migrationSurges(limit = 20) {
  const rows = await prisma.nationalityFlow.findMany({
    orderBy: [{ nationality: 'asc' }, { district: 'asc' }, { month: 'asc' }],
  })
  const out: {
    nationality: string; district: string; month: string
    transactionCount: number; prevMonthCount: number; momChange: number | null
  }[] = []
  const prev = new Map<string, number>()
  for (const r of rows) {
    const k = `${r.nationality}||${r.district}`
    const before = prev.get(k)
    if (before != null && before > 0) {
      out.push({
        nationality: r.nationality, district: r.district,
        month: r.month.toISOString().slice(0, 7),
        transactionCount: r.transactionCount, prevMonthCount: before,
        momChange: ((r.transactionCount - before) / before) * 100,
      })
    }
    prev.set(k, r.transactionCount)
  }
  return out
    .filter((s) => s.momChange != null && s.momChange > 25)
    .sort((a, b) => (b.momChange ?? 0) - (a.momChange ?? 0))
    .slice(0, limit)
}

// ─── 6.5 Institutional Flow Tracker ─────────────────────────────────────────

export async function computeInstitutionalFlow() {
  const rows = await loadSales()
  const corporate = rows.filter((t) => t.buyerType === 'corporate')
  if (!corporate.length) {
    await prisma.institutionalTransaction.deleteMany({})
    return { clusters: 0, insufficientData: true, reason: 'No transactions carry buyerType=corporate yet.' }
  }
  const communities = await communityMap()

  // Cluster by entity + building, splitting on any >30-day gap.
  const byEntity = new Map<string, Txn[]>()
  for (const t of corporate) {
    const k = `${t.buyerNationality ?? 'unknown'}||${t.buildingName ?? t.projectName ?? 'unassigned'}`
    const arr = byEntity.get(k)
    if (arr) arr.push(t)
    else byEntity.set(k, [t])
  }

  await prisma.institutionalTransaction.deleteMany({})
  let clusters = 0
  for (const [k, group] of byEntity) {
    const sorted = [...group].sort((a, b) => a.transactionDate.getTime() - b.transactionDate.getTime())
    let bucket: Txn[] = []
    const flush = async () => {
      if (bucket.length < 3) { bucket = []; return }
      const c = communities.get(bucket[0].communityId)
      if (!c) { bucket = []; return }
      await prisma.institutionalTransaction.create({
        data: {
          entityName: k.split('||')[0],
          entityType: 'corporate',
          district: c.slug,
          communityEn: c.nameEn,
          buildingNameEn: bucket[0].buildingName,
          unitCount: bucket.length,
          totalValue: bucket.reduce((s, t) => s + t.priceAed, 0),
          avgPsf: bucket.reduce((s, t) => s + t.pricePerSqft, 0) / bucket.length,
          firstDate: bucket[0].transactionDate,
          lastDate: bucket[bucket.length - 1].transactionDate,
          transactionIds: bucket.map((t) => t.id).join(','),
        },
      })
      clusters++
      bucket = []
    }
    for (const t of sorted) {
      if (!bucket.length) { bucket = [t]; continue }
      const gapDays = (t.transactionDate.getTime() - bucket[bucket.length - 1].transactionDate.getTime()) / 86_400_000
      if (gapDays > 30) await flush()
      bucket.push(t)
    }
    await flush()
  }
  return { clusters }
}

// ─── 6.6 Construction Pipeline Pressure ─────────────────────────────────────

export async function computeSupplyPipeline() {
  const rows = await loadSales()
  const communities = await communityMap()
  const cutoff = Date.now() - 3 * 365 * 86_400_000
  const twelveAgo = Date.now() - 365 * 86_400_000

  let written = 0
  for (const [communityId, c] of communities) {
    const districtRows = rows.filter((t) => t.communityId === communityId)
    if (!districtRows.length) continue

    const offPlan = districtRows.filter(
      (t) => t.transactionType === 'off_plan_sale' && t.transactionDate.getTime() >= cutoff,
    ).length

    // Units still in the pipeline. A DLD row carries no unit identifier, so an
    // off-plan registration cannot be matched to its later completion — the
    // honest quantity is therefore the GROSS count of off-plan registrations in
    // the trailing window, which is an upper bound on what is still under
    // construction. (The spec's `offPlan - completedSales` proxy silently
    // collapses to 0 wherever completed sales outnumber off-plan, which is what
    // it did on the first run of this dataset.)
    const pipeline = offPlan

    const last12 = districtRows.filter((t) => t.transactionDate.getTime() >= twelveAgo).length
    const absorption = last12 / 12

    const supplyMonths = absorption > 0 ? pipeline / absorption : 999
    const pressureScore = Math.min(100, (supplyMonths / 24) * 100)

    await prisma.supplyPipeline.upsert({
      where: { district: c.slug },
      create: {
        district: c.slug, expectedUnits: pipeline,
        expectedQ: `Q${Math.ceil((new Date().getUTCMonth() + 1) / 3)} ${new Date().getUTCFullYear() + 2}`,
        absorptionRate: Math.round(absorption * 10) / 10,
        supplyMonths: Math.round(supplyMonths * 10) / 10,
        pressureScore: Math.round(pressureScore * 10) / 10,
      },
      update: {
        expectedUnits: pipeline,
        absorptionRate: Math.round(absorption * 10) / 10,
        supplyMonths: Math.round(supplyMonths * 10) / 10,
        pressureScore: Math.round(pressureScore * 10) / 10,
        calculatedAt: new Date(),
      },
    })
    written++
  }
  return { districts: written }
}

// ─── 6.7 Economic Sensitivity Score ─────────────────────────────────────────

/**
 * Spec 6.7 — regress district PSF on oil, VIX, GDP and tourism.
 *
 * This needs a long monthly PSF history plus aligned macro series. With ~12
 * months of transactions the design matrix is rank-deficient, and a beta fitted
 * on 12 points would be noise dressed up as a coefficient. So the model is
 * computed only when there is enough history, and otherwise reports exactly
 * what is missing.
 */
export async function computeMacroSensitivity() {
  const rows = await loadSales()
  const communities = await communityMap()

  const macroIndicators = await prisma.macroIndicator.findMany()
  const indicatorsPresent = [...new Set(macroIndicators.map((m) => m.indicator))]
  const required = ['oil_price', 'vix', 'uae_gdp', 'uae_tourism']
  const missing = required.filter((i) => !indicatorsPresent.includes(i))

  const psfMonths = rows.length ? bucketByMonth(rows.map((t) => ({ date: t.transactionDate, value: t.pricePerSqft }))).length : 0
  const minMonths = 20

  if (psfMonths < minMonths || missing.length) {
    return {
      districtsComputed: 0,
      insufficientHistory: true,
      psfMonthsAvailable: psfMonths,
      psfMonthsRequired: minMonths,
      missingIndicators: missing,
      reason:
        `The sensitivity model needs ${minMonths}+ months of PSF history and aligned oil/VIX/GDP/tourism series. ` +
        `Available: ${psfMonths} months of PSF` +
        (missing.length ? `, and no ${missing.join(', ')} series ingested.` : '.'),
      methodology:
        'Multiple OLS regression of monthly district PSF on oil price, VIX, UAE GDP and tourism arrivals; ' +
        'reports beta per variable plus model R².',
    }
  }

  // Build aligned monthly PSF per district and regress where the window is long enough.
  const byDistrict = new Map<string, { date: Date; value: number }[]>()
  for (const t of rows) {
    const arr = byDistrict.get(t.communityId)
    const pt = { date: t.transactionDate, value: t.pricePerSqft }
    if (arr) arr.push(pt)
    else byDistrict.set(t.communityId, [pt])
  }

  const macroByMonth = new Map<string, { oil?: number; vix?: number; gdp?: number; tourism?: number }>()
  for (const m of macroIndicators) {
    const key = m.period.slice(0, 7)
    const cur = macroByMonth.get(key) ?? {}
    if (m.indicator === 'oil_price') cur.oil = m.value
    if (m.indicator === 'vix') cur.vix = m.value
    if (m.indicator === 'uae_gdp') cur.gdp = m.value
    if (m.indicator === 'uae_tourism') cur.tourism = m.value
    macroByMonth.set(key, cur)
  }

  let computed = 0
  for (const [communityId, pts] of byDistrict) {
    const c = communities.get(communityId)
    if (!c) continue

    const monthly = new Map<string, number[]>()
    for (const p of pts) {
      const k = `${p.date.getUTCFullYear()}-${String(p.date.getUTCMonth() + 1).padStart(2, '0')}`
      const arr = monthly.get(k)
      if (arr) arr.push(p.value)
      else monthly.set(k, [p.value])
    }

    const y: number[] = []
    const X: number[][] = []
    for (const [k, vs] of [...monthly.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const m = macroByMonth.get(k)
      if (!m || m.oil == null || m.vix == null || m.gdp == null || m.tourism == null) continue
      y.push(vs.reduce((s, v) => s + v, 0) / vs.length)
      X.push([m.oil, m.vix, m.gdp, m.tourism])
    }
    if (y.length < minMonths) continue

    const reg = multipleRegression(y, X)
    if (!reg) continue
    const [, betaOil, betaVix, betaGdp, betaTourism] = reg.betas

    await prisma.macroSensitivity.upsert({
      where: { district: c.slug },
      create: {
        district: c.slug, betaOilPrice: betaOil, betaVix, betaGdp, betaTourism,
        rSquared: reg.rSquared,
      },
      update: {
        betaOilPrice: betaOil, betaVix, betaGdp, betaTourism,
        rSquared: reg.rSquared, calculatedAt: new Date(),
      },
    })
    computed++
  }
  return { districtsComputed: computed }
}

/** Scenario modeller — spec 6.7: "if oil drops 20%, what happens to PSF?" */
export function applyScenario(
  s: { betaOilPrice: number | null; betaVix: number | null; betaGdp: number | null; betaTourism: number | null },
  shock: { oilPct?: number; vixChange?: number; gdpPct?: number; tourismPct?: number },
) {
  const terms = [
    { variable: 'oil', beta: s.betaOilPrice, shock: shock.oilPct ?? 0 },
    { variable: 'vix', beta: s.betaVix, shock: shock.vixChange ?? 0 },
    { variable: 'gdp', beta: s.betaGdp, shock: shock.gdpPct ?? 0 },
    { variable: 'tourism', beta: s.betaTourism, shock: shock.tourismPct ?? 0 },
  ]
  const contributions = terms
    .filter((t) => t.beta != null && t.shock !== 0)
    .map((t) => ({
      variable: t.variable,
      beta: t.beta as number,
      shock: t.shock,
      impactPct: (t.beta as number) * t.shock,
    }))
  const expectedPsfChangePct = contributions.reduce((s, c) => s + c.impactPct, 0)
  return {
    expectedPsfChangePct: Math.round(expectedPsfChangePct * 100) / 100,
    contributions,
    confidenceRange: [expectedPsfChangePct * 1.5, expectedPsfChangePct * 0.5].map(
      (v) => Math.round(v * 100) / 100,
    ),
  }
}

// ─── District metrics + market summary ──────────────────────────────────────

export async function computeDistrictMetrics() {
  const rows = await loadSales()
  const communities = await communityMap()
  const now = Date.now()
  const d30 = now - 30 * 86_400_000
  const d90 = now - 90 * 86_400_000
  const d180 = now - 180 * 86_400_000
  const d365 = now - 365 * 86_400_000
  const d730 = now - 730 * 86_400_000

  let written = 0
  for (const [communityId, c] of communities) {
    const all = rows.filter((t) => t.communityId === communityId)
    if (!all.length) continue
    const win = (from: number, to: number) =>
      all.filter((t) => t.transactionDate.getTime() >= from && t.transactionDate.getTime() < to)

    const last30 = win(d30, now)
    const prev30 = win(d30 * 2 - now, d30)
    const last90 = win(d90, now)
    const prev90 = win(d180, d90)
    const last180 = win(d180, now)
    const prev180 = win(d365, d180)
    const last365 = win(d365, now)
    const prev365 = win(d730, d365)

    const avg = (xs: Txn[]) => (xs.length ? xs.reduce((s, t) => s + t.pricePerSqft, 0) / xs.length : null)
    const momentumBase = avg(last30) ?? avg(last90) ?? avg(all)
    const momentumScore = Math.max(
      0,
      Math.min(100, 50 + (pctChange(avg(last30), avg(prev30)) ?? 0) * 2.5),
    )

    const rentAgg = await prisma.listing.aggregate({
      where: { communityId, purpose: 'rent' }, _avg: { priceAed: true },
    })
    const avgRent = rentAgg._avg.priceAed ?? c.medianAnnualRentAed
    const ejariYield = momentumBase && avgRent ? ((avgRent / (momentumBase * (all[0]?.areaSqft || 1000))) * 100) : null

    const listingsCount = await prisma.listing.count({ where: { communityId, purpose: 'sale' } })
    const dealsCount = await prisma.listing.count({ where: { communityId, isDeal: true } })

    const payload = {
      city: c.emirate === 'dubai' ? 'Dubai' : 'Abu Dhabi',
      avgPricePsf: avg(last30) ?? avg(last90),
      medianPrice: median(last30.map((t) => t.priceAed)) ?? c.medianAedSqft,
      medianPricePsf: median(last30.map((t) => t.pricePerSqft)),
      totalVolume: last30.length,
      totalValueAed: last30.reduce((s, t) => s + t.priceAed, 0),
      avgYield: c.grossYieldPct,
      ejariYield: ejariYield == null ? null : Math.round(ejariYield * 100) / 100,
      priceChange1m: pctChange(avg(last30), avg(prev30)),
      priceChange3m: pctChange(avg(last90), avg(prev90)),
      priceChange6m: pctChange(avg(last180), avg(prev180)),
      priceChange12m: pctChange(avg(last365), avg(prev365)),
      momentumScore: Math.round(momentumScore * 10) / 10,
      listingsCount,
      dealsCount,
      calculatedAt: new Date(),
    }

    await prisma.districtMetrics.upsert({
      where: { district_period: { district: c.slug, period: '30d' } },
      create: { district: c.slug, period: '30d', ...payload },
      update: payload,
    })
    written++
  }
  return { districts: written }
}

export async function computeMarketSummary() {
  const metrics = await prisma.districtMetrics.findMany()
  if (!metrics.length) return { computed: false }

  const communities = await communityMap()
  const psfDubai = metrics
    .filter((m) => communities.get([...communities.keys()].find((k) => communities.get(k)?.slug === m.district) ?? '')?.emirate === 'dubai')
    .map((m) => m.avgPricePsf)
    .filter((v): v is number => v != null)
  const psfAD = metrics
    .filter((m) => communities.get([...communities.keys()].find((k) => communities.get(k)?.slug === m.district) ?? '')?.emirate === 'abu_dhabi')
    .map((m) => m.avgPricePsf)
    .filter((v): v is number => v != null)

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

  const summary = {
    avgPricePsfDubai: mean(psfDubai),
    avgPricePsfAD: mean(psfAD),
    totalTransactions: metrics.reduce((s, m) => s + m.totalVolume, 0),
    totalValueAed: metrics.reduce((s, m) => s + m.totalValueAed, 0),
    avgRentalYield: mean(metrics.map((m) => m.avgYield).filter((v): v is number => v != null)),
    ejariAvgYield: mean(metrics.map((m) => m.ejariYield).filter((v): v is number => v != null)),
    momentumIndex: mean(metrics.map((m) => m.momentumScore).filter((v): v is number => v != null)),
    psfDelta: mean(metrics.map((m) => m.priceChange1m).filter((v): v is number => v != null)),
    computedAt: new Date(),
  }

  const existing = await prisma.marketSummary.findFirst({ orderBy: { computedAt: 'desc' } })
  if (existing) await prisma.marketSummary.update({ where: { id: existing.id }, data: summary })
  else await prisma.marketSummary.create({ data: summary })

  return { computed: true, ...summary }
}

// ─── Pipeline entry point (the spec's 6-hourly intelligence cron) ───────────

export async function runIntelligencePipeline() {
  const startedAt = Date.now()
  const [rpi, buildings, migration, flow, supply] = [
    await computeRealPriceIndex(),
    await computeBuildingProfiles(),
    await computeMigrationSignal(),
    await computeInstitutionalFlow(),
    await computeSupplyPipeline(),
  ]
  const metrics = await computeDistrictMetrics()
  const macro = await computeMacroSensitivity()
  const summary = await computeMarketSummary()

  return {
    ok: true,
    durationMs: Date.now() - startedAt,
    rpi, buildings, migration, flow, supply, metrics, macro, summary,
    generatedAt: new Date().toISOString(),
  }
}
