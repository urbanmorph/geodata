// GET /api/v1/ground: what is below a point, in one call. GROUND_LAYERS is the
// table of layers (lib/profile.ts runs it), plus one SoilGrids pixel. A new
// layer (e.g. WRIS groundwater level stations) is one more row.
import type { CatalogData } from './catalog-api';
import { soilAt, SOILGRIDS, type SoilProfile } from './soilgrids';
import {
  BASE_DEPS, first, km, nearestSay, num, profileAt,
  type PixelResult, type ProfileDeps, type ProfileEntry, type ProfileLayer, type ProfileOpts, type ProfileResponse, type ProfileSpec, type Props,
} from './profile';

export type Section = 'seismic' | 'geology' | 'resources' | 'groundwater' | 'soil' | 'subsidence' | 'underground' | 'watershed';
export const SECTIONS: readonly Section[] = ['seismic', 'geology', 'resources', 'groundwater', 'soil', 'subsidence', 'underground', 'watershed'];

/** Said once per answer: what this is, and what it is not. */
export const DISCLAIMER = 'Screening information from published maps and models of different scales and dates: ' +
  'not a site investigation, and not for engineering, construction or safety decisions. ' +
  'Check each section\'s scale and vintage, and confirm on site (boreholes, utility surveys, soil tests) before relying on it.';


// ── decoders: source encodings to plain units ────────────────────────────────


export const DECODERS = {
  /** GLHYMPS 2.0 (readme, Borealis doi:10.5683/SP2/TTJNIU): logK_Ferr_ is log10 permeability (m2)
   *  x 100, without permafrost; a logK of 0 marks no value (GUM_K 0). The map is global and
   *  coarse: one polygon of sediments from the Global Unconsolidated Sediments Map (GUM_K 2,
   *  Porosity_x 0 as published) holds Delhi, Majuli and Kolkata alike. So the profile gives
   *  only a class, by Bear (1972): pervious from 1e-11 m2, semi-pervious to 1e-15, impervious
   *  below. The published columns stay in `features`. */
  glhymps(p: Props): Props {
    const logK = num(p.logK_Ferr_);
    const k = logK ? Math.round(logK) / 100 : null;
    return {
      log10_permeability_m2: k,
      permeability_class: k === null ? null : k >= -11 ? 'pervious' : k >= -15 ? 'semi-pervious' : 'impervious',
    };
  },
  /** Columns named "<Pre|Post>-monsoon_<year> (meters below ground level)": the latest reading of each season. */
  monsoon_depths(p: Props): Props {
    const latest = (season: string) => {
      let best: { year: number; depth_m_below_ground: number } | null = null;
      for (const [k, v] of Object.entries(p)) {
        const m = k.match(/^(Pre|Post)-monsoon_(\d{4})\b/i);
        const d = num(v);
        if (!m || m[1].toLowerCase() !== season || d === null) continue;
        const year = Number(m[2]);
        if (!best || year > best.year) best = { year, depth_m_below_ground: d };
      }
      return best;
    };
    return { latest_pre_monsoon: latest('pre'), latest_post_monsoon: latest('post') };
  },
} satisfies Record<string, (p: Props) => Props>;

// ── what each layer contributes ──────────────────────────────────────────────

const SHC_UNITS = {
  N: 'kg/ha', P: 'kg/ha', K: 'kg/ha', OC: '%', EC: 'dS/m', pH: 'pH',
  S: 'ppm', Zn: 'ppm', Fe: 'ppm', Cu: 'ppm', Mn: 'ppm', B: 'ppm',
};
const LINEAMENT = ['Des', 'l1descript', 'l2descript', 'Level1', 'Level2', 'st_code'];
const GW_QUALITY: Omit<ProfileLayer, 'id' | 'section'> = {
  match: 'nearest', radiusKm: 10, coverageKm: 50, show: 1,
  fields: ['GWQ', 'YEAR', 'WELL_TYPE', 'pH', 'TDS', 'HARDNESS', 'FLUORIDE', 'NITRATE', 'ARSENIC', 'IRON', 'CHLORIDE', 'SULPHATE', 'DATA_SOURC'],
  units: { pH: 'pH' },
  about: { scale: 'point samples (wells and handpumps)', vintage: 'sampled 1999 to 2019, mostly 2009 to 2016',
    note: 'concentrations as published (usually mg/L); 0 often means not measured' },
};
const gwQualitySay = (season: string) => (e: ProfileEntry) => {
  const n = e.nearest?.[0];
  return n && first(e, 'GWQ') ? `${season} groundwater sample ${km(n.distance_km)} away: ${first(e, 'GWQ')}${first(e, 'YEAR') ? ` (${first(e, 'YEAR')})` : ''}` : null;
};

/** Plan F1: the zones are the 2016 code's. A 2025 revision (with a Zone VI along the Himalaya)
 *  was issued in November 2025 and reported withdrawn by BIS in March 2026, so 2016 applies. */
export const SEISMIC_ABOUT = {
  scale: 'national zoning map', vintage: 'BIS IS 1893 (Part 1):2016',
  note: 'the 2016 zones II to V; the 2025 revision, which added a Zone VI along the Himalaya, was reported withdrawn in March 2026',
};

export const GROUND_LAYERS: ProfileLayer[] = [
  // ── seismic ──
  { id: 'seismic_zones', section: 'seismic', match: 'contains', about: SEISMIC_ABOUT,
    say: (e) => first(e, 'seismic_zo') && `${first(e, 'seismic_zo')}${first(e, 'intensity_') ? ` (${first(e, 'intensity_')})` : ''}` },
  { id: 'gem_active_faults', section: 'seismic', match: 'nearest', shape: true, radiusKm: 50,
    about: { scale: 'regional fault traces (75 in India)', vintage: 'GEM GAF-DB, June 2021' },
    fields: ['name', 'slip_type', 'net_slip_rate', 'average_dip', 'activity_confidence', 'last_movement', 'catalog_name'],
    units: { net_slip_rate: 'mm/yr', average_dip: 'degrees' }, say: nearestSay('Nearest mapped active fault') },
  { id: 'gsi_lineaments_250k', section: 'seismic', match: 'nearest', shape: true, radiusKm: 25, about: { scale: '1:250,000' },
    fields: LINEAMENT, say: nearestSay('Nearest GSI lineament', 'l1descript') },
  { id: 'bhuvan_lineaments_50k', section: 'seismic', match: 'nearest', shape: true, radiusKm: 10, about: { scale: '1:50,000', vintage: '2005-06 imagery' },
    fields: LINEAMENT, say: nearestSay('Nearest NRSC lineament', 'Des') },
  { id: 'ngdr_earthquakes', section: 'seismic', match: 'nearest', radiusKm: 50, show: 5,
    about: { scale: 'epicentres (location error varies)', vintage: 'records 1897 to 2019' },
    fields: ['yr', 'mo', 'dt', 'mw', 'magmb', 'depth_km', 'source'],
    units: { mw: 'moment magnitude', magmb: 'body-wave magnitude', depth_km: 'km' },
    say: (e) => {
      const n = e.nearest?.[0];
      if (!n) return null;
      const mag = first(e, 'mw') ?? first(e, 'magmb');
      const bits = [mag && `M ${mag}`, first(e, 'yr')].filter(Boolean).join(', ');
      return `Nearest recorded earthquake ${km(n.distance_km)} away${bits ? ` (${bits})` : ''}; ${e.count} within ${e.radius_km} km`;
    } },
  // ── geology ──
  { id: 'gsi_lithology_50k', section: 'geology', match: 'contains', about: { scale: '1:50,000' },
    say: (e) => {
      const rock = first(e, 'lithologic');
      const about = [first(e, 'age'), first(e, 'group_name')].filter(Boolean).join(', ');
      return rock && `Rock: ${rock}${about ? ` (${about})` : ''}`;
    } },
  { id: 'gsi_geology_2m', section: 'geology', match: 'contains', about: { scale: '1:2,000,000 (coarse; a fallback where 1:50,000 lithology is missing)' } },
  { id: 'bhuvan_geomorphology_50k', section: 'geology', match: 'contains', about: { scale: '1:50,000', vintage: '2005-06 imagery' },
    say: (e) => first(e, 'Des') && `Landform: ${first(e, 'Des')}` },
  { id: 'gsi_drilling_boreholes', section: 'geology', match: 'nearest', radiusKm: 25, about: { scale: 'exploration boreholes' },
    fields: ['borehole_name', 'commodity_name', 'length_m', 'rl_collar_m', 'water_level', 'date_starting', 'stage_of_investigation', 'source_of_data'],
    units: { length_m: 'm', rl_collar_m: 'm', water_level: 'm' }, say: nearestSay('Nearest GSI exploration borehole', 'borehole_name') },
  // ── resources ──
  { id: 'gsi_coal_blocks', section: 'resources', match: 'nearest', shape: true, radiusKm: 10, about: { scale: 'block outlines' },
    fields: ['block_name', 'cf_name', 'category', 'status', 'resources', 'company', 'area'], units: { resources: 'million tonnes (as published)', area: 'sq km' },
    say: (e) => { const n = e.nearest?.[0]; return n && (n.distance_km === 0 ? `Inside coal block ${first(e, 'block_name')}` : `Coal block ${km(n.distance_km)} away (${first(e, 'block_name')})`); } },
  { id: 'gsi_hydrocarbon_blocks', section: 'resources', match: 'nearest', shape: true, radiusKm: 25, about: { scale: 'block outlines' },
    fields: ['block_name', 'basin_name', 'bid_round', 'block_area', 'operator', 'field_name', 'status'],
    say: (e) => { const n = e.nearest?.[0]; return n && (n.distance_km === 0 ? `Inside hydrocarbon block ${first(e, 'block_name')}` : null); } },
  { id: 'gsi_critical_minerals', section: 'resources', match: 'nearest', about: { scale: 'occurrence points (GSI)' }, radiusKm: 25,
    fields: ['commodity', 'locality', 'occurrence', 'host_rock', 'geology', 'age', 'remarks'], say: nearestSay('Critical mineral occurrence', 'commodity') },
  { id: 'gsi_mineral_deposits', section: 'resources', match: 'nearest', about: { scale: 'deposit points (GSI)' }, radiusKm: 25,
    fields: ['mineral_or', 'locality', 'reserve', 'grade', 'hostrock', 'formation'], say: nearestSay('Mineral deposit', 'mineral_or') },
  { id: 'gsi_geothermal_springs', section: 'resources', match: 'nearest', about: { scale: 'spring points (GSI)' }, radiusKm: 50,
    fields: ['location', 'state', 'district', 'temparatur', 'spring_typ', 'tds'], units: { temparatur: 'deg C', tds: 'mg/L (as published)' },
    say: nearestSay('Hot spring', 'location') },
  { id: 'vedas_oil_wells', section: 'resources', match: 'nearest', about: { scale: 'well points (ISRO VEDAS)' }, radiusKm: 10, fields: ['well_name', 'operator'], say: nearestSay('Oil or gas well', 'well_name') },
  // ── groundwater ──
  { id: 'cgwb_aquifers', section: 'groundwater', match: 'contains', about: { scale: 'principal aquifer map (regional)' },
    say: (e) => first(e, 'aquifer0') && `Aquifer: ${first(e, 'aquifer0')}${first(e, 'aquifers') ? `, ${first(e, 'aquifers')}` : ''}` },
  { id: 'cgwb_gw_extraction', section: 'groundwater', match: 'contains', about: { scale: 'per assessment unit (block, mandal or taluk)', vintage: 'CGWB 2020 assessment' },
    units: { sgw_dev_pe: '% (stage of groundwater extraction)' },
    say: (e) => {
      const stage = num(first(e, 'sgw_dev_pe'));
      return first(e, 'class') && `Groundwater extraction: ${first(e, 'class')}${stage ? ` (${Math.round(stage)}% of the annual extractable resource${first(e, 'block') ? `, ${first(e, 'block')} block` : ''})` : ''}`;
    } },
  { id: 'bhuvan_gw_prospects', section: 'groundwater', match: 'contains', about: { scale: '1:50,000' } },
  { id: 'glhymps_permeability', section: 'groundwater', match: 'contains', decode: DECODERS.glhymps,
    about: { scale: 'global, coarse polygons (regional patterns, not a site value)', vintage: 'GLHYMPS 2.0 (2018)',
      note: 'a class only: one polygon can span hundreds of km; Porosity_x is 0 where the values come from the unconsolidated sediments map (GUM_K 2), as published' },
    units: { log10_permeability_m2: 'log10 m2 (the polygon\'s value, not the site\'s)', permeability_class: 'Bear (1972): pervious from 1e-11 m2, semi-pervious to 1e-15 m2, impervious below' },
    say: (e) => {
      const c = e.decoded?.permeability_class;
      return typeof c === 'string' ? `Permeability class (GLHYMPS, global and coarse): ${c}` : null;
    } },
  { id: 'atal_bhujal_wells', section: 'groundwater', match: 'nearest', radiusKm: 10, coverageKm: 50, decode: DECODERS.monsoon_depths,
    about: { scale: 'monitoring wells in seven states', vintage: '2015 to 2022' },
    fields: ['Well_ID', 'Site_Name', 'Village', 'TYPE', 'Aquifer', 'Well_Depth (meters)'], units: { 'Well_Depth (meters)': 'm' },
    say: (e) => {
      const n = e.nearest?.[0];
      const pre = n?.decoded?.latest_pre_monsoon as { year: number; depth_m_below_ground: number } | null | undefined;
      return n && pre ? `Groundwater ${pre.depth_m_below_ground} m below ground before the ${pre.year} monsoon at an Atal Bhujal well ${km(n.distance_km)} away` : null;
    } },
  { id: 'wris_groundwater_levels', section: 'groundwater', match: 'nearest', radiusKm: 10,
    about: { scale: 'monitoring stations (CGWB and state ground water departments)', vintage: 'manual readings to 2024',
      note: 'depths are metres below ground; a positive trend means the water table is getting deeper' },
    fields: ['station_name', 'station_code', 'station_type', 'agency_name', 'last_reading', 'last_depth_m',
      'premonsoon_depth_m', 'premonsoon_year', 'postmonsoon_depth_m', 'postmonsoon_year', 'premonsoon_trend_m_per_yr', 'trend_n_years', 'years_of_record'],
    units: { last_depth_m: 'm below ground', premonsoon_depth_m: 'm below ground', postmonsoon_depth_m: 'm below ground', premonsoon_trend_m_per_yr: 'm/yr (positive: deeper)' },
    links: (layer) => {
      const readings = (layer.notes ?? '').match(/https:\/\/\S+?Manual_Readings[\w.]*\.parquet/)?.[0];
      return readings ? { readings } : ({} as Record<string, string>);
    },
    say: (e) => {
      const n = e.nearest?.[0];
      const pre = num(first(e, 'premonsoon_depth_m'));
      if (!n || pre === null) return null;
      const trend = num(first(e, 'premonsoon_trend_m_per_yr'));
      const t = trend === null ? '' : `, ${trend > 0 ? 'falling' : 'rising'} ${Math.abs(trend)} m/yr`;
      return `Water table ${pre} m below ground before the ${first(e, 'premonsoon_year')} monsoon at a WRIS station ${km(n.distance_km)} away${t}`;
    } },
  { id: 'gw_quality_premonsoon', section: 'groundwater', ...GW_QUALITY, say: gwQualitySay('Pre-monsoon') },
  { id: 'gw_quality_postmonsoon', section: 'groundwater', ...GW_QUALITY, say: gwQualitySay('Post-monsoon') },
  { id: 'mi6_wells_districts', section: 'groundwater', match: 'contains', about: { scale: 'per district', vintage: '6th Minor Irrigation Census, 2017-18' },
    fields: ['district', 'state', 'dugwell', 'shallow_tw', 'medium_tw', 'deep_tw', 'total', 'in_use', 'dugwell_share', 'in_use_share'],
    say: (e) => num(first(e, 'total')) ? `${num(first(e, 'total'))!.toLocaleString('en-IN')} wells and tubewells in ${first(e, 'district')} district (2017-18 census)` : null },
  // ── soil ──
  { id: 'slusi_soil_health', section: 'soil', match: 'nearest', radiusKm: 5, coverageKm: 25, show: 1,
    about: { scale: 'field samples (Soil Health Cards)' },
    fields: ['cycle', 'date', 'village_1', 'N', 'P', 'K', 'OC', 'pH', 'EC', 'S', 'Zn', 'Fe', 'Cu', 'Mn', 'B'], units: SHC_UNITS,
    say: (e) => {
      const n = e.nearest?.[0];
      if (!n) return null;
      const bits = [first(e, 'pH') && `pH ${first(e, 'pH')}`, first(e, 'OC') && `organic carbon ${first(e, 'OC')}%`].filter(Boolean).join(', ');
      return `Soil Health Card sample ${km(n.distance_km)} away${first(e, 'cycle') ? ` (${first(e, 'cycle')})` : ''}${bits ? `: ${bits}` : ''}`;
    } },
  // ── subsidence ──
  { id: 'subsidence_megacities', section: 'subsidence', match: 'nearest', radiusKm: 0.5, coverageKm: 10, candidates: 1000,
    // Plan F4, checked in the published file: 36,241 rows repeat a coordinate (Delhi 27,858, Kolkata 8,383;
    // never across cities, never with the same value, spread over each city rather than along a frame edge).
    about: { scale: 'satellite (InSAR) measurement points', vintage: 'Ohenhen et al. 2025; Bengaluru, Chennai, Delhi, Kolkata and Mumbai only',
      note: 'in Delhi and Kolkata some coordinates repeat with slightly different rates, as published (likely several measurement points at one position); each coordinate counts once, as the median of its readings' },
    fields: ['VLM_cm_per_yr', 'city'], units: { VLM_cm_per_yr: 'cm/yr of vertical land motion; negative means sinking', median_VLM_cm_per_yr: 'cm/yr' },
    median: { field: 'VLM_cm_per_yr', name: 'median_VLM_cm_per_yr', perPoint: ['Longitude', 'Latitude'] },
    say: (e) => {
      const m = e.stats?.median_VLM_cm_per_yr;
      return typeof m === 'number'
        ? `Ground ${m < 0 ? 'sinking' : 'rising'} about ${Math.abs(m)} cm/yr (median of ${e.stats?.points ?? e.count} satellite points within ${(e.radius_km ?? 0) * 1000} m)`
        : null;
    } },
  // ── underground ──
  { id: 'osm_tunnels', section: 'underground', match: 'nearest', shape: true, radiusKm: 1, about: { scale: 'mapped by OpenStreetMap volunteers (incomplete)' },
    fields: ['name', 'tunnel', 'highway', 'railway', 'waterway', 'layer', 'ref'], say: nearestSay('Tunnel') },
  { id: 'osm_underground_utilities', section: 'underground', match: 'nearest', shape: true, radiusKm: 1,
    about: { scale: 'mapped by OpenStreetMap volunteers (very incomplete: never rely on it before digging)' },
    fields: ['name', 'man_made', 'power', 'substance', 'location', 'voltage', 'diameter', 'operator'], say: nearestSay('Buried pipeline or cable') },
  { id: 'osm_mines_caves', section: 'underground', match: 'nearest', radiusKm: 5, about: { scale: 'mapped by OpenStreetMap volunteers (incomplete)' },
    fields: ['name', 'man_made', 'historic', 'natural', 'resource'], say: nearestSay('Mine shaft, adit or cave') },
  // ── watershed ──
  { id: 'core_mws_water_balance', section: 'watershed', match: 'contains', about: { scale: 'micro-watershed', vintage: '2017-18 to 2024-25' } },
  { id: 'core_mws_drought', section: 'watershed', match: 'contains', about: { scale: 'micro-watershed', vintage: 'to 2022 or 2024 by tehsil' } },
  { id: 'ndem_floods_1998_2022', section: 'watershed', match: 'contains', allIndia: true, about: { scale: 'flood extents mapped from satellite', vintage: '1998 to 2022' },
    say: (e) => (e.status === 'found' ? 'Inside an area NDEM mapped as flooded between 1998 and 2022' : null) },
];

/** SoilGrids at the point, as a pixel source answer. */
export async function soilPixel(r2: R2Bucket, lat: number, lng: number): Promise<PixelResult> {
  const s = await soilAt(r2, undefined, lat, lng);
  return s.status === 'ok' ? { status: 'ok', data: s.soil as unknown as Props } : s;
}

function soilEntry(s: Exclude<PixelResult, { status: 'unavailable' }>): Omit<ProfileEntry, 'layer_id' | 'match'> {
  const src = SOILGRIDS.source;
  const units = Object.fromEntries(Object.values(SOILGRIDS.properties).map((p) => [p.field, p.unit]));
  const soil = s.status === 'ok' ? s.data as unknown as SoilProfile : null;
  return {
    status: soil ? 'found' : 'not_covered',
    about: { scale: '250 m grid of model predictions (not a field sample)', vintage: 'SoilGrids 2.0 (2020 release)' },
    credit: { name: src.name, url: src.url, licence: src.licence, licence_url: src.licence_url },
    resolution_m: 250, units,
    depths: soil ? soil.depths : null,
    wrb_class: soil ? soil.wrb_class : null,
    ...(s.status !== 'ok' ? { reason: s.reason }
      : soil?.depths ? {} : { reason: 'no SoilGrids soil properties here: SoilGrids leaves out built-up land and water (the WRB soil group is still mapped)' }),
  };
}

function soilSay(e: ProfileEntry): string | null {
  const top = e.depths?.['0-5cm'];
  if (!top) return e.wrb_class ? `Soil group (SoilGrids, WRB): ${e.wrb_class}; no soil properties mapped here (built-up land or water)` : null;
  const bits = [top.clay_pct != null && `${top.clay_pct}% clay`, top.sand_pct != null && `${top.sand_pct}% sand`,
    top.ph_water != null && `pH ${top.ph_water}`].filter(Boolean).join(', ');
  return `Topsoil (0-5 cm, SoilGrids): ${bits}${e.wrb_class ? `; soil group ${e.wrb_class}` : ''}`;
}

export const GROUND_PROFILE: ProfileSpec = {
  layers: GROUND_LAYERS,
  sections: SECTIONS,
  pixels: [{ id: 'soilgrids', section: 'soil', entry: soilEntry, say: soilSay, credit: `${SOILGRIDS.source.name} (${SOILGRIDS.source.licence})` }],
  disclaimer: DISCLAIMER,
  nothing: 'Nothing found below this point in the layers checked.',
};

export const GROUND_DEPS: ProfileDeps = { ...BASE_DEPS, pixels: { soilgrids: soilPixel } };

export type GroundResponse = ProfileResponse;

/** The subsurface profile at lat/lng. Never throws for one layer: it goes to `unavailable`. */
export function groundAt(
  lat: number, lng: number, catalog: CatalogData, r2: R2Bucket, deps: ProfileDeps = GROUND_DEPS, opts: ProfileOpts = {},
): Promise<GroundResponse> {
  return profileAt(GROUND_PROFILE, lat, lng, catalog, r2, deps, opts);
}
