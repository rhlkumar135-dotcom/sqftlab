// sqftLab Glossary — File 7, Part 17.2
// Every term A–Y used across the platform, with definition, why-it-matters,
// data source, and optional worked example.

export interface GlossaryTerm {
  slug: string
  letter: string
  term: string
  definition: string
  whyMatters?: string
  source?: string
  example?: string
  tier?: 'pro' | 'elite'
  seeAlso?: string[]
  aliases?: string[]
}

export const GLOSSARY: GlossaryTerm[] = [
  // ── A ──────────────────────────────────────────────────────────────────────
  {
    slug: 'adrec',
    letter: 'A',
    term: 'ADREC (Abu Dhabi Real Estate Centre)',
    definition:
      `The official Abu Dhabi government authority responsible for regulating and registering all real estate transactions in Abu Dhabi. Equivalent to Dubai's DLD. sqftLab pulls Abu Dhabi transaction data from ADREC via the Madhmoun open data platform at no cost.`,
    whyMatters: `Without ADREC data, sqftLab would be Dubai-only. ADREC gives sqftLab complete UAE coverage.`,
    source: 'ADREC · Madhmoun platform',
  },
  {
    slug: 'aed',
    letter: 'A',
    term: 'AED (Arab Emirates Dirham)',
    definition:
      `The official currency of the United Arab Emirates. All sqftLab prices, PSF values, and yields are denominated in AED by default. The platform offers conversion to USD, GBP, EUR, and INR using live exchange rates, cached for 5 minutes. 1 USD ≈ 3.67 AED (pegged rate since 1997).`,
    whyMatters: `International investors think in their home currency first. The AED/USD peg makes UAE property uniquely stable for USD-based investors.`,
    source: 'ExchangeRate-API open endpoint',
  },
  {
    slug: 'aed-sqft',
    letter: 'A',
    term: 'AED/sqft (Price Per Square Foot)',
    definition:
      `The UAE's standard unit of property value — transaction value in AED divided by floor area in square feet. It is sqftLab's primary price metric because it normalises for size. See PSF for the full explanation and worked example.`,
    whyMatters: `Absolute price misleads; PSF makes a 500 sqft studio and a 2,000 sqft apartment directly comparable.`,
    source: 'DLD transactions · Dubai Pulse API',
    seeAlso: ['psf'],
  },
  {
    slug: 'absorption-rate',
    letter: 'A',
    term: 'Absorption Rate',
    definition:
      `The number of property units sold per month in a given district or community, calculated from DLD transaction records. Used in sqftLab's Construction Pipeline Pressure model: dividing expected new supply (off-plan units under construction) by the monthly absorption rate gives "supply months" — how long it would take the market to absorb the incoming supply at the current sales pace.`,
    whyMatters: `A district with 12 months of supply incoming and an absorption rate of 50 units/month means the market won't be oversupplied. A district with 24 months of supply is a risk flag.`,
    source: 'DLD transactions · Dubai Pulse API',
  },
  {
    slug: 'alert',
    letter: 'A',
    term: 'Alert (Deal Alert)',
    definition:
      `A user-configured rule that triggers a notification when sqftLab detects a matching property event. Types: a listing appearing more than X% below district average PSF; a district's PSF dropping below a threshold; a transaction volume spike in a watched district. Delivered via email and push notification.`,
    whyMatters: `Below-market listings appear and disappear within hours. Automated alerts mean you see them before anyone else.`,
    tier: 'pro',
    seeAlso: ['deal'],
  },

  // ── B ──────────────────────────────────────────────────────────────────────
  {
    slug: 'beta-coefficient',
    letter: 'B',
    term: 'Beta Coefficient (Macro Sensitivity)',
    definition:
      `A statistical measure of how sensitive a district's PSF is to changes in a specific macroeconomic variable. In sqftLab's Economic Sensitivity Score, four beta coefficients are computed per district using multiple regression: oil price beta, VIX beta, GDP beta, and tourism beta.`,
    whyMatters: `Quantified macro sensitivity lets investors stress-test their portfolio. "If oil falls 20%, how much does my holding lose?"`,
    source: 'FCSC + World Bank + Yahoo Finance (VIX) + DLD',
    example: `Palm Jumeirah beta (oil) = 0.82 → a 10% rise in oil revenue correlates with an ~8.2% rise in Palm PSF over the following two quarters.`,
    seeAlso: ['economic-sensitivity-score', 'vix'],
  },
  {
    slug: 'building-intelligence-profile',
    letter: 'B',
    term: 'Building Intelligence Profile',
    definition:
      `sqftLab's proprietary per-building scoring system. Evaluates every building in Dubai across 7 metrics: PSF velocity, liquidity score, owner-occupier ratio, buyer hold rate, Ejari density, floor premium curve, and PSF vs community position. Produces a composite score of 0–100. Two buildings in the same community can score very differently.`,
    whyMatters: `District-level data tells you about an area. Building-level data tells you about the specific asset you are buying.`,
    source: 'DLD transactions + Ejari contracts',
    tier: 'pro',
    seeAlso: ['liquidity-score', 'buyer-hold-rate', 'floor-premium-curve', 'ejari-density'],
  },
  {
    slug: 'buyer-hold-rate',
    letter: 'B',
    term: 'Buyer Hold Rate',
    definition:
      `The percentage of DLD-registered buyers in a specific building who held their property for more than 12 months before reselling. Computed by matching purchase and resale transactions for the same unit (approximate unit matching by sqft cluster within the same building). High hold rate (>70%) = owners are confident in the asset. Low hold rate (<40%) = speculative flipping, less stable ownership base.`,
    whyMatters: `A building where 80% of buyers hold for 2+ years is fundamentally different from one where half the buyers flip within a year — even if the headline PSF is identical.`,
    source: 'DLD transactions · Dubai Pulse API',
    seeAlso: ['owner-occupier-ratio', 'building-intelligence-profile'],
  },
  {
    slug: 'buyer-type',
    letter: 'B',
    term: 'Buyer Type',
    definition:
      `DLD transaction field indicating whether the buyer is an individual (natural person) or a corporate entity (company, fund, LLC). Corporate buyers are the basis for sqftLab's Institutional Flow Tracker — clustering corporate purchases of 3+ units in the same building within 30 days as institutional accumulation.`,
    source: 'DLD transactions · Dubai Pulse API',
    seeAlso: ['institutional-flow-tracker'],
  },

  // ── C ──────────────────────────────────────────────────────────────────────
  {
    slug: 'choropleth-map',
    letter: 'C',
    term: 'Choropleth Map',
    definition:
      `A map where geographic areas (districts) are shaded in proportion to a data variable. sqftLab's map view uses a choropleth layer to show PSF intensity, momentum scores, yield percentages, or deal density by district. Darker shade = higher value of the selected metric.`,
    whyMatters: `Spatial patterns in data are invisible in tables. A choropleth makes "where is the heat moving?" immediately obvious.`,
    seeAlso: ['mapbox-gl-js'],
  },
  {
    slug: 'cpi',
    letter: 'C',
    term: 'CPI (Consumer Price Index)',
    definition:
      `UAE inflation measure published monthly by the Federal Competitiveness and Statistics Centre (FCSC). sqftLab uses the Housing sub-index of the UAE CPI to compute inflation-adjusted PSF — showing whether property prices are genuinely appreciating in real terms or merely keeping pace with price level increases.`,
    whyMatters: `If Dubai PSF rises 8% in a year when UAE CPI rises 6%, real appreciation is only 2%. sqftLab is the only free UAE platform that shows this distinction.`,
    source: 'UAE FCSC · monthly CSV',
    seeAlso: ['cpi-adjusted-psf', 'fcsc'],
  },
  {
    slug: 'cpi-adjusted-psf',
    letter: 'C',
    term: 'CPI-Adjusted PSF',
    definition:
      `Price per square foot expressed in constant (inflation-adjusted) terms, rebased to January 2020 = 100. Formula: nominal PSF × (CPI Jan 2020 / CPI current month). The toggle on sqftLab's PSF trend charts switches between nominal and CPI-adjusted views.`,
    source: 'DLD transactions + UAE FCSC CPI data',
    seeAlso: ['cpi', 'psf'],
  },
  {
    slug: 'comps',
    letter: 'C',
    term: 'Comps (Comparable Sales)',
    definition:
      `DLD-registered sales transactions used as reference data points for estimating a subject property's fair value. sqftLab selects comps using: same district, same property type, sqft within ±20% of subject, within the last 12–24 months. A minimum of 3 comps is required to show a fair value range. The more comps, the higher the confidence.`,
    whyMatters: `Estate agents often cherry-pick comps to justify their asking price. sqftLab uses all eligible DLD comps algorithmically with no human selection bias.`,
    source: 'DLD transactions · Dubai Pulse API',
    seeAlso: ['fair-value', 'trimmed-mean'],
  },
  {
    slug: 'community',
    letter: 'C',
    term: 'Community',
    definition:
      `A named residential development within a district. Example: Jumeirah Village Circle (JVC) is a community within the Al Barsha South district. sqftLab uses DLD's official community taxonomy (the area_name_en field in DLD transaction records).`,
  },
  {
    slug: 'construction-pipeline-pressure',
    letter: 'C',
    term: 'Construction Pipeline Pressure',
    definition:
      `sqftLab's supply-side intelligence model. Estimates the number of off-plan units expected to reach completion in each district by comparing off-plan DLD registrations against buildings that have already produced resale transactions. Divides expected new units by historical monthly absorption to produce a "supply months" figure and a 0–100 pressure score.`,
    whyMatters: `Oversupplied districts face downward PSF pressure as new supply floods the resale market. Knowing this 12–18 months ahead is a genuine competitive advantage.`,
    source: 'DLD off-plan registrations · Dubai Pulse API',
    seeAlso: ['supply-months', 'supply-pressure-score', 'absorption-rate'],
  },

  // ── D ──────────────────────────────────────────────────────────────────────
  {
    slug: 'datalabel',
    letter: 'D',
    term: 'DataLabel',
    definition:
      `sqftLab's UI component displayed beneath every key metric. Shows the data source, transaction count, time period, and "last updated X minutes ago" timestamp. The ⓘ icon opens a tooltip with the full methodology explanation and a link to the relevant glossary term.`,
    whyMatters: `sqftLab is the only UAE property platform that shows its working. Every number is traceable to its source.`,
  },
  {
    slug: 'deal',
    letter: 'D',
    term: 'Deal (Below-Market Listing)',
    definition:
      `A property listing where the asking price per square foot is more than 12% below the 30-day average PSF from DLD-registered sales in the same district and property category. sqftLab detects deals by comparing scraped listing PSF against district average PSF.`,
    whyMatters: `A true deal is defined against actual transaction data — not against other asking prices. Only DLD-sourced PSF gives you this benchmark.`,
    source: 'Bayut / PropertyFinder / Dubizzle + DLD via Dubai Pulse API',
    seeAlso: ['psf', 'alert'],
  },
  {
    slug: 'dld',
    letter: 'D',
    term: 'DLD (Dubai Land Department)',
    definition:
      `The official government authority responsible for all property registration in Dubai. Every sale, mortgage, off-plan registration, and gift in Dubai is registered with DLD. 1.1M+ transactions are available via the Dubai Pulse API. The bedrock data source of sqftLab.`,
    source: 'Dubai Pulse API · api.dubaipulse.gov.ae',
    seeAlso: ['dubai-pulse-api', 'transaction'],
  },
  {
    slug: 'dubai-pulse-api',
    letter: 'D',
    term: 'Dubai Pulse API',
    definition:
      `The open data API operated by the Smart Dubai Government Establishment, providing access to DLD transaction data, off-plan registrations, and related datasets. Requires free registration at dubaipulse.gov.ae; credentials delivered by email. The single most important data source for sqftLab — unlock this first.`,
    source: 'Free with registration · api.dubaipulse.gov.ae',
    seeAlso: ['dld'],
  },

  // ── E ──────────────────────────────────────────────────────────────────────
  {
    slug: 'ejari',
    letter: 'E',
    term: 'Ejari',
    definition:
      `Arabic for "my rent." The UAE government's official rental contract registration system, managed by the Real Estate Regulatory Agency (RERA) under DLD. All residential tenancy contracts in Dubai must be registered in Ejari. sqftLab uses Ejari data to source contracted rental values (what tenants are actually paying) rather than listing rents (what landlords are asking).`,
    whyMatters: `Listing rents are aspirational. Ejari rents are what the market actually clears at — often 10–20% different.`,
    source: 'Ejari via DLD API Gateway',
    seeAlso: ['rera', 'gross-yield', 'ejari-density'],
  },
  {
    slug: 'ejari-density',
    letter: 'E',
    term: 'Ejari Density',
    definition:
      `In sqftLab's Building Intelligence Profile: the number of active Ejari rental contracts per 100 DLD-registered units in a specific building. High density (>60) = predominantly rental building, good for yield. Low density (<25) = predominantly owner-occupied, good for stability.`,
    whyMatters: `Knowing whether a building is rental-dominated or owner-occupied changes the investment thesis entirely.`,
    source: 'Ejari contracts + DLD unit count',
    seeAlso: ['ejari', 'building-intelligence-profile'],
  },
  {
    slug: 'economic-sensitivity-score',
    letter: 'E',
    term: 'Economic Sensitivity Score',
    definition:
      `sqftLab's macro-driven district intelligence model. Uses multiple regression across 20 quarters of DLD data and macroeconomic indicators to produce beta coefficients showing how sensitive each district's PSF is to oil prices, the AED/USD rate, UAE GDP growth, and global risk (VIX). Includes a scenario modelling tool: drag a slider, see the expected PSF impact with confidence intervals.`,
    source: 'DLD + FCSC + World Bank + IMF + Yahoo Finance',
    tier: 'pro',
    seeAlso: ['beta-coefficient', 'vix', 'world-bank-api', 'imf'],
  },
  {
    slug: 'exchangerate-api',
    letter: 'E',
    term: 'ExchangeRate-API',
    definition:
      `The free open endpoint used by sqftLab for live currency conversion. URL: open.er-api.com/v6/latest/AED. No key required. Cached for 5 minutes. Provides AED rates against USD, GBP, EUR, INR, and PKR. Powers the global FX toggle in the sqftLab ticker.`,
    source: 'ExchangeRate-API open endpoint',
    seeAlso: ['aed'],
  },

  // ── F ──────────────────────────────────────────────────────────────────────
  {
    slug: 'fair-value',
    letter: 'F',
    term: 'Fair Value',
    definition:
      `sqftLab's estimate of a property's market value based on comparable DLD transactions, not on listing prices or agent opinions. Expressed as a range (low to high) derived from the trimmed median PSF of comps multiplied by the subject property's square footage. A property priced below the fair value range = potential opportunity. Above = buyer beware.`,
    whyMatters: `Estate agents set asking prices. DLD transaction records reveal what buyers actually paid for comparable properties. Fair value uses the latter.`,
    source: 'DLD comps · Dubai Pulse API',
    seeAlso: ['comps', 'trimmed-mean', 'verdict'],
  },
  {
    slug: 'fcsc',
    letter: 'F',
    term: 'FCSC (Federal Competitiveness and Statistics Centre)',
    definition:
      `UAE government body publishing official CPI, GDP, population, and economic statistics. sqftLab downloads monthly CPI data to compute inflation-adjusted PSF. Available free at fcsa.gov.ae.`,
    seeAlso: ['cpi', 'cpi-adjusted-psf'],
  },
  {
    slug: 'floor-premium-curve',
    letter: 'F',
    term: 'Floor Premium Curve',
    definition:
      `sqftLab's unique per-building analysis derived from linear regression of DLD transaction PSF against floor numbers for all units ever sold in a specific building. Output: "Each additional floor adds X% to PSF in this building."`,
    whyMatters: `No other UAE platform publishes floor premium data. It directly informs offer strategy — if you are on floor 8 and the building average premium is 0.9%/floor, floor 12 should cost about 3.6% more.`,
    source: 'DLD transactions with floor_number field · Dubai Pulse API',
    example: `0.85%/floor means floor 20 vs floor 5 = 15 × 0.85% = 12.75% higher PSF expected.`,
    seeAlso: ['building-intelligence-profile'],
  },

  // ── G ──────────────────────────────────────────────────────────────────────
  {
    slug: 'gross-yield',
    letter: 'G',
    term: 'Gross Yield',
    definition:
      `Annual rental income divided by property purchase price, expressed as a percentage. Formula: (Annual Rent / Purchase Price) × 100. sqftLab pre-fills the annual rent from Ejari-registered contracted rents in the same district and property type.`,
    source: 'Ejari + DLD',
    example: `AED 90,000 rent / AED 1,200,000 price = 7.5% gross yield.`,
    seeAlso: ['net-yield', 'yield-calculator', 'ejari'],
  },
  {
    slug: 'golden-visa',
    letter: 'G',
    term: 'Golden Visa (UAE)',
    definition:
      `A long-term UAE residency visa available to property investors. AED 750,000 minimum investment = 2-year property investor visa. AED 2,000,000 minimum investment = 10-year Golden Visa. sqftLab's eligibility checker shows which visa threshold a property's price qualifies for.`,
    source: 'Official GDRFA regulations',
  },

  // ── H ──────────────────────────────────────────────────────────────────────
  {
    slug: 'haversine-distance',
    letter: 'H',
    term: 'Haversine Distance',
    definition:
      `The mathematical formula used to calculate the straight-line distance between two GPS coordinates on the Earth's surface. sqftLab uses Haversine to compute distances from a property or district centroid to the nearest metro station, school, hospital, and mall — feeding the Neighbourhood Score calculation.`,
    source: 'OpenStreetMap POI coordinates',
    seeAlso: ['neighbourhood-score', 'poi'],
  },

  // ── I ──────────────────────────────────────────────────────────────────────
  {
    slug: 'imf',
    letter: 'I',
    term: 'IMF (International Monetary Fund)',
    definition:
      `Provides UAE GDP growth forecasts via its free Data Mapper API. sqftLab fetches IMF World Economic Outlook projections for the UAE quarterly. Used in the Economic Sensitivity Score as the forward-looking GDP variable.`,
    source: 'IMF Data API · imf.org (no key required)',
    seeAlso: ['economic-sensitivity-score', 'world-bank-api'],
  },
  {
    slug: 'institutional-flow-tracker',
    letter: 'I',
    term: 'Institutional Flow Tracker',
    definition:
      `sqftLab's extraordinary product #5. Identifies bulk purchases by corporate entities in DLD transaction records (buyer_type = Corporate) and clusters them: same entity, same building, within 30 days, 3+ units = an institutional accumulation event. Tracks which buildings and districts "smart money" (funds, family offices, developers) is quietly accumulating — before retail buyers notice.`,
    whyMatters: `Institutional buyers have deeper research. Their accumulation in a district is one of the strongest leading indicators of future price appreciation.`,
    source: 'DLD corporate buyer transactions · Dubai Pulse API',
    tier: 'elite',
    seeAlso: ['buyer-type'],
  },
  {
    slug: 'investment-score',
    letter: 'I',
    term: 'Investment Score',
    definition:
      `sqftLab's composite 0–100 score for any property, produced at the end of the 8-step Property Intelligence Pipeline. Weighted from 5 components: PSF vs fair value (25%), rental yield (25%), price momentum (20%), neighbourhood score (15%), and building intelligence (15%).`,
    whyMatters: `Score bands: 80–100 Strong buy (green) · 65–79 Good value (teal) · 50–64 Neutral (amber) · 0–49 Caution (red).`,
    source: 'All sqftLab data sources combined',
    tier: 'pro',
    example: `A 2-bed in Business Bay scoring 71 lands in the "Good value" band.`,
    seeAlso: ['verdict', 'fair-value', 'momentum-index', 'neighbourhood-score', 'building-intelligence-profile'],
  },
  {
    slug: 'isr',
    letter: 'I',
    term: 'ISR (Incremental Static Regeneration)',
    definition:
      `Pages are pre-rendered at build time for the top 25 districts (fast, SEO-friendly) and regenerated in the background every hour for all others. Users always see a cached page — never a slow server render.`,
  },

  // ── L ──────────────────────────────────────────────────────────────────────
  {
    slug: 'liquidity-score',
    letter: 'L',
    term: 'Liquidity Score',
    definition:
      `Component of sqftLab's Building Intelligence Profile. Measures how quickly units in a specific building are resold after purchase. Computed from median days between buy and resale transactions for matched units in that building. 0–100 scale: 90 = highly liquid (units trade frequently, easy to exit). 10 = illiquid (few resales, hard to find a buyer).`,
    whyMatters: `A property is only as good as your ability to exit. High liquidity is invisible until you need to sell.`,
    source: 'DLD transactions · Dubai Pulse API',
    seeAlso: ['building-intelligence-profile'],
  },

  // ── M ──────────────────────────────────────────────────────────────────────
  {
    slug: 'mapbox-gl-js',
    letter: 'M',
    term: 'Mapbox GL JS',
    definition:
      `The mapping library used for sqftLab's interactive district map view. Free tier: 50,000 map loads per month. Used in the heatmap page's "Map view" toggle to render a choropleth of district data over a real Dubai / Abu Dhabi street map. Lazily loaded — only when the user switches from the default SVG grid view.`,
    seeAlso: ['choropleth-map'],
  },
  {
    slug: 'migration-signal',
    letter: 'M',
    term: 'Migration Signal',
    definition:
      `sqftLab's demand-side leading indicator product. Cross-references the buyer nationality field in DLD transactions with monthly nationality flow data to detect when a specific nationality's property buying activity in a district spikes month-over-month by more than 25%. Historically, nationality concentration surges precede PSF increases in affected districts by 1–3 quarters.`,
    whyMatters: `It tells you where demand pressure is building before it shows up in prices — a genuine forward-looking signal.`,
    source: 'DLD buyer nationality field · Dubai Pulse API',
    tier: 'pro',
  },
  {
    slug: 'momentum-index',
    letter: 'M',
    term: 'Momentum Index (Momentum Score)',
    definition:
      `A composite indicator (0–100) of how strongly a district's property market is trending. Weighted blend of: 3-month PSF change (40%), 12-month PSF change (30%), and 3-month transaction volume change (30%).`,
    whyMatters: `80–100 = strong bullish · 50–80 = trending positive · 20–50 = neutral · 0–20 = declining. Displayed on the heat map and KPI strip.`,
    source: 'DLD transactions · computed by the sqftLab intelligence cron',
    seeAlso: ['psf', 'investment-score'],
  },

  // ── N ──────────────────────────────────────────────────────────────────────
  {
    slug: 'neighbourhood-score',
    letter: 'N',
    term: 'Neighbourhood Score',
    definition:
      `sqftLab's composite location quality index (0–100) per district or property. Four sub-dimensions, each scored 0–25. Transport: metro/bus stops within 1km. Education: schools within 2km. Healthcare: hospitals and clinics within 3km. Lifestyle: malls, parks, gyms within 1km.`,
    whyMatters: `Location quality explains PSF differentials within the same district better than almost any other variable.`,
    source: 'OpenStreetMap Overpass API + OpenRouteService walk times',
    seeAlso: ['poi', 'haversine-distance', 'openstreetmap', 'openrouteservice'],
  },
  {
    slug: 'net-yield',
    letter: 'N',
    term: 'Net Yield',
    definition:
      `Rental income after deducting all operating costs, divided by purchase price. Formula: (Annual Rent − Service Charges − Management Fee − Maintenance) / Purchase Price × 100. sqftLab's yield calculator uses Ejari-sourced rent and prompts for actual service charge and management fee inputs.`,
    source: 'Ejari + DLD + user inputs',
    seeAlso: ['gross-yield', 'yield-calculator'],
  },
  {
    slug: 'nominatim',
    letter: 'N',
    term: 'Nominatim',
    definition:
      `OpenStreetMap's free geocoding service. sqftLab uses Nominatim to convert district names and property addresses to GPS coordinates, and to reverse-geocode listing coordinates to their official DLD district name. No API key required. Rate limit: 1 request per second.`,
    source: 'nominatim.openstreetmap.org',
    seeAlso: ['openstreetmap'],
  },

  // ── O ──────────────────────────────────────────────────────────────────────
  {
    slug: 'off-plan',
    letter: 'O',
    term: 'Off-Plan',
    definition:
      `A property sold before construction is complete (sometimes before it begins). Off-plan transactions are registered with DLD just like completed-property sales. DLD off-plan data powers sqftLab's Construction Pipeline Pressure model and Building Intelligence supply analysis.`,
    whyMatters: `Off-plan volume tells you how much supply is coming into a district 18–36 months from now.`,
    source: 'DLD off-plan registrations · Dubai Pulse API',
    seeAlso: ['construction-pipeline-pressure'],
  },
  {
    slug: 'openrouteservice',
    letter: 'O',
    term: 'OpenRouteService',
    definition:
      `Free routing API providing walking and driving times between coordinates. sqftLab uses it to compute "X minutes walk to nearest metro" for the Transport component of the Neighbourhood Score. Free tier: 2,000 requests per day.`,
    source: 'openrouteservice.org',
    seeAlso: ['neighbourhood-score'],
  },
  {
    slug: 'openstreetmap',
    letter: 'O',
    term: 'OpenStreetMap (OSM)',
    definition:
      `The free, open-source world map database. sqftLab queries OSM's Overpass API to retrieve all UAE points of interest — metro stations, schools, hospitals, malls, parks, mosques, gyms — for the Neighbourhood Score and nearby POI listings on district detail pages. No API key required.`,
    source: 'overpass-api.de',
    seeAlso: ['poi', 'neighbourhood-score', 'nominatim'],
  },
  {
    slug: 'owner-occupier-ratio',
    letter: 'O',
    term: 'Owner-Occupier Ratio',
    definition:
      `In sqftLab's Building Intelligence Profile: the percentage of DLD-registered units in a building that have appeared in only one transaction (purchased once, never resold or re-registered). A high ratio indicates stable, long-term ownership rather than speculative or investment-driven turnover.`,
    source: 'DLD transactions · Dubai Pulse API',
    seeAlso: ['building-intelligence-profile', 'buyer-hold-rate'],
  },

  // ── P ──────────────────────────────────────────────────────────────────────
  {
    slug: 'poi',
    letter: 'P',
    term: 'POI (Point of Interest)',
    definition:
      `A geographically located amenity or facility. sqftLab fetches POIs from OpenStreetMap: metro stations, bus stops, schools, hospitals, clinics, shopping malls, supermarkets, parks, and gyms. POIs are stored in the database and used to compute Neighbourhood Scores and populate the "Nearby" section on district and property detail pages.`,
    source: 'OpenStreetMap Overpass API',
    seeAlso: ['openstreetmap', 'neighbourhood-score'],
  },
  {
    slug: 'psf',
    letter: 'P',
    term: 'PSF (Price Per Square Foot)',
    definition:
      `The most common unit of property value measurement in the UAE. Calculated as: transaction value (AED) ÷ property area (square feet). sqftLab uses PSF as its primary price metric because it normalises for property size, allowing direct comparison between a 500 sqft studio and a 2,000 sqft apartment in the same building.`,
    whyMatters: `Absolute price misleads. AED 900,000 for 500 sqft (AED 1,800/sqft) is very different from AED 900,000 for 1,200 sqft (AED 750/sqft). PSF is the fair comparison unit.`,
    source: 'DLD transactions · Dubai Pulse API',
    aliases: ['AED/sqft', 'price per square foot'],
    seeAlso: ['fair-value', 'cpi-adjusted-psf', 'real-price-index'],
  },

  // ── R ──────────────────────────────────────────────────────────────────────
  {
    slug: 'real-price-index',
    letter: 'R',
    term: 'Real Price Index (RPI)',
    definition:
      `sqftLab's proprietary daily property price index. Computed from the trimmed mean (5th–95th percentile) of DLD-registered sales PSF, per district × property type × bedroom count, refreshed hourly. The first free, daily, transaction-based UAE property price index.`,
    whyMatters: `Unlike REIDIN or JLL indices it is updated daily not quarterly, free not $15K+/year, and the methodology is publicly documented.`,
    source: 'DLD transactions · Dubai Pulse API',
    tier: 'pro',
    seeAlso: ['trimmed-mean', 'psf', 'comps'],
  },
  {
    slug: 'rera',
    letter: 'R',
    term: 'RERA (Real Estate Regulatory Agency)',
    definition:
      `The regulatory arm of DLD responsible for licensing real estate agents, managing Ejari, and overseeing the off-plan market in Dubai. All Dubai listings must carry a RERA permit number. sqftLab validates listing RERA permit numbers against the Dubai REST permit lookup API.`,
    source: 'Dubai REST API',
    seeAlso: ['ejari', 'dld'],
  },

  // ── S ──────────────────────────────────────────────────────────────────────
  {
    slug: 'sse',
    letter: 'S',
    term: 'SSE (Server-Sent Events)',
    definition:
      `The web protocol used by sqftLab to push real-time data updates from the server to the browser without polling. The browser connects once and receives a continuous stream of JSON updates whenever the data cron publishes new data. One-directional (server → client), works over HTTP/2, and needs no extra infrastructure.`,
    whyMatters: `A KPI card showing "data from 10 minutes ago" is useful; a live ticker scrolling stale data is not. SSE keeps the live surfaces honest.`,
    source: '/api/stream/market',
  },
  {
    slug: 'supply-months',
    letter: 'S',
    term: 'Supply Months',
    definition:
      `The number of months it would take the market to absorb the current pipeline of under-construction off-plan units at the current monthly sales absorption rate. Formula: Expected new units ÷ Monthly absorption.`,
    whyMatters: `Below 12 = healthy. Above 18 = oversupply risk.`,
    source: 'DLD off-plan + sales transactions · Dubai Pulse API',
    example: `2,400 units expected in Business Bay ÷ 160 sales/month = 15 months of supply.`,
    seeAlso: ['absorption-rate', 'supply-pressure-score'],
  },
  {
    slug: 'supply-pressure-score',
    letter: 'S',
    term: 'Supply Pressure Score',
    definition:
      `A 0–100 index summarising construction pipeline risk for a district. 0 = no oversupply concern. 100 = severe oversupply risk. Displayed as a gauge on district detail pages and as a heat map layer.`,
    source: 'DLD off-plan registrations · Dubai Pulse API',
    seeAlso: ['supply-months', 'construction-pipeline-pressure'],
  },

  // ── T ──────────────────────────────────────────────────────────────────────
  {
    slug: 'transaction',
    letter: 'T',
    term: 'Transaction (DLD Transaction)',
    definition:
      `A registered property event in the DLD database. Types: Sales (completed resale), Mortgage (financed purchase), Gift (transfer without payment), and Off Plan (pre-completion sale). Each record includes area sqft, transaction value, PSF, district, community, building, property type, buyer nationality, buyer type, and registration date. These records are the bedrock of all sqftLab intelligence.`,
    source: 'DLD via Dubai Pulse API',
    seeAlso: ['dld', 'off-plan', 'buyer-type'],
  },
  {
    slug: 'trimmed-mean',
    letter: 'T',
    term: 'Trimmed Mean',
    definition:
      `A statistical averaging method that removes extreme outliers before computing the average. sqftLab trims the bottom 5% and top 5% of PSF values from any set of comparable transactions before computing the Real Price Index or fair value range.`,
    whyMatters: `One off-market transaction at AED 500/sqft in a district averaging AED 1,800/sqft would wreck a simple average. Trimming protects the signal.`,
    source: 'DLD transactions · Dubai Pulse API',
    seeAlso: ['real-price-index', 'fair-value'],
  },

  // ── V ──────────────────────────────────────────────────────────────────────
  {
    slug: 'verdict',
    letter: 'V',
    term: 'Verdict',
    definition:
      `The auto-generated plain-English summary at the end of sqftLab's Property Intelligence Report. Combines all 8 pipeline outputs into one paragraph covering the price versus fair value, the transaction count behind the estimate, gross yield, the district 12-month trend, and the investment score — followed by 2–4 risk flags.`,
    whyMatters: `Every number in the report is technical. The verdict is the one paragraph a non-analyst can act on.`,
    tier: 'pro',
    seeAlso: ['investment-score', 'fair-value'],
  },
  {
    slug: 'vix',
    letter: 'V',
    term: 'VIX (CBOE Volatility Index)',
    definition:
      `A measure of expected global stock market volatility, often called the "fear index." High VIX = global risk-off environment. sqftLab uses VIX as a macro variable in the Economic Sensitivity Score, proxying global investor risk appetite — which correlates with demand for UAE luxury property.`,
    whyMatters: `When VIX spikes above 30, UAE luxury PSF has historically dipped 4–8% within 90 days.`,
    source: 'Yahoo Finance (no key, free)',
    seeAlso: ['economic-sensitivity-score', 'beta-coefficient'],
  },

  // ── W ──────────────────────────────────────────────────────────────────────
  {
    slug: 'world-bank-api',
    letter: 'W',
    term: 'World Bank API',
    definition:
      `Free, open data API providing UAE economic indicators: GDP (current USD), GDP per capita, population, and inflation rate. sqftLab fetches quarterly indicators to use as macro variables in the Economic Sensitivity Score. No API key required.`,
    source: 'api.worldbank.org',
    seeAlso: ['economic-sensitivity-score', 'imf'],
  },

  // ── Y ──────────────────────────────────────────────────────────────────────
  {
    slug: 'yield-curve',
    letter: 'Y',
    term: 'Yield Curve (District Yield Curve)',
    definition:
      `sqftLab's extraordinary product #3. Maps the time lag between PSF movements and rental yield changes in a district over 48 months using cross-correlation analysis. Identifies the optimal PSF entry point to maximise yield on entry. Expressed as a lag month count and a Pearson correlation coefficient showing confidence.`,
    source: 'DLD transactions + Ejari rental contracts',
    tier: 'pro',
    example: `"In Downtown Dubai, rental yield bottoms out 9 months after PSF peaks."`,
    seeAlso: ['gross-yield', 'real-price-index', 'ejari'],
  },
  {
    slug: 'yield-calculator',
    letter: 'Y',
    term: 'Yield Calculator',
    definition:
      `sqftLab's Pro-tier tool that computes gross yield, net yield, annual cash flow, break-even years, and a 5-year projection for any property. Inputs: purchase price, annual rent (pre-filled from Ejari district averages), occupancy %, service charges, management fee, and optional financing parameters. All results update live as inputs change.`,
    source: 'Ejari contracted rents + user inputs',
    tier: 'pro',
    seeAlso: ['gross-yield', 'net-yield', 'ejari'],
  },
]

export const GLOSSARY_LETTERS = Array.from(
  new Set(GLOSSARY.map((t) => t.letter)),
).sort()

export function termBySlug(slug: string): GlossaryTerm | undefined {
  return GLOSSARY.find((t) => t.slug === slug)
}

export function termName(slug: string): string {
  return termBySlug(slug)?.term ?? slug
}
