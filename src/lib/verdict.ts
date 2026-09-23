// Verdict generation and risk flags (spec Part 2.4 / 2.5).
// Both are pure functions of the computed intelligence so the wording can never
// drift from the numbers shown beside it.

export interface VerdictInput {
  district: string
  beds: number
  propertyType: string
  askingPrice: number
  fairValueLow: number
  fairValueHigh: number
  grossYield: number
  investmentScore: number
  transactionCount: number
  districtTrend12m: number
}

export type RiskFlag = { type: 'warn' | 'ok'; text: string }

export interface RiskFlagInput {
  serviceCharge?: number
  districtAvgServiceCharge?: number
  districtMomentum?: number
  psfVsDistrictDelta?: number
  developerOnTimeRate?: number
  grossYield?: number
  cityAvgYield?: number
  transactionCount?: number
}

const fmtM = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : Math.round(n).toLocaleString('en-US')

export function generateVerdict(d: VerdictInput): string {
  const fairValueMid = (d.fairValueLow + d.fairValueHigh) / 2
  const vsAsk = ((d.askingPrice - fairValueMid) / fairValueMid) * 100
  const position =
    vsAsk < -5
      ? `priced ${Math.abs(vsAsk).toFixed(0)}% below fair value`
      : vsAsk > 5
        ? `priced ${vsAsk.toFixed(0)}% above fair value`
        : 'within fair value range'

  const bedLabel = d.beds === 0 ? 'studio' : `${d.beds}-bed`

  return (
    `This ${bedLabel} ${d.propertyType.toLowerCase()} in ${d.district} is ${position}. ` +
    `Based on ${d.transactionCount} comparable DLD transactions, fair value is ` +
    `AED ${fmtM(d.fairValueLow)}–${fmtM(d.fairValueHigh)}. ` +
    `At AED ${fmtM(d.askingPrice)}, it offers a ${d.grossYield.toFixed(1)}% gross yield ` +
    `against a district average PSF trend of ${d.districtTrend12m > 0 ? '+' : ''}` +
    `${d.districtTrend12m.toFixed(1)}% over 12 months. ` +
    `Investment score: ${d.investmentScore}/100.`
  )
}

// Each rule only fires when its input is actually present, so a thin data set
// produces fewer flags rather than a flag invented from a missing value.
export function getRiskFlags(d: RiskFlagInput): RiskFlag[] {
  const flags: RiskFlag[] = []

  if (
    d.serviceCharge != null &&
    d.districtAvgServiceCharge != null &&
    d.serviceCharge > d.districtAvgServiceCharge * 1.15
  ) {
    flags.push({ type: 'warn', text: 'Service charge above district average' })
  }

  if (d.districtMomentum != null && d.districtMomentum < 45) {
    flags.push({ type: 'warn', text: 'District PSF momentum is below neutral' })
  }

  if (d.psfVsDistrictDelta != null && d.psfVsDistrictDelta > 15) {
    flags.push({ type: 'warn', text: 'Asking PSF significantly above district avg' })
  }

  if (d.psfVsDistrictDelta != null && d.psfVsDistrictDelta < -5) {
    flags.push({ type: 'ok', text: 'PSF below district average — potential value opportunity' })
  }

  if (d.developerOnTimeRate != null && d.developerOnTimeRate > 88) {
    flags.push({
      type: 'ok',
      text: `Developer has ${d.developerOnTimeRate}% on-time delivery rate`,
    })
  }

  if (d.grossYield != null && d.cityAvgYield != null && d.grossYield > d.cityAvgYield + 1) {
    flags.push({ type: 'ok', text: 'Yield above city average — strong income potential' })
  }

  if (d.transactionCount != null && d.transactionCount < 5) {
    flags.push({ type: 'warn', text: 'Fewer than 5 recent comps — lower data confidence' })
  }

  return flags
}
