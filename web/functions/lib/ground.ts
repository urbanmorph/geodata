// GET /api/v1/ground: what is below a point, in one call. Each layer is one
// row of GROUND_LAYERS (which section, contains or nearest, how far, which
// fields, how to decode and say it); the runner reads them all in parallel,
// each under its own time budget, through the engines the API already has:
// /locate's point-in-polygon over PMTiles for `contains`, /nearby's parquet
// bbox search for points, and nearby-geometry's true distance for lines.
// Plus one SoilGrids pixel. A layer that fails or runs out of time is listed
// in `unavailable`; the rest still answer. A new layer (e.g. WRIS groundwater
// level stations) is one more row.
import type { CatalogData, CatalogLayer } from './catalog-api';
import { ncFields } from './catalog-api';
import { locate as locateEngine, type LocateResponse } from './locate';
import { nearby as nearbyEngine } from './nearby';
import { nearbyByGeometry } from './nearby-geometry';
import { soilAt, SOILGRIDS, type SoilProfile, type SoilResult } from './soilgrids';
import { licenceUrl } from '../../../shared/licences.mjs';

type Props = Record<string, unknown>;

export type Section = 'seismic' | 'geology' | 'resources' | 'groundwater' | 'soil' | 'subsidence' | 'underground' | 'watershed';
export const SECTIONS: readonly Section[] = ['seismic', 'geology', 'resources', 'groundwater', 'soil', 'subsidence', 'underground', 'watershed'];

/** Said once per answer: what this is, and what it is not. */
export const DISCLAIMER = 'Screening information from published maps and models of different scales and dates: ' +
  'not a site investigation, and not for engineering, construction or safety decisions. ' +
  'Check each section\'s scale and vintage, and confirm on site (boreholes, utility surveys, soil tests) before relying on it.';

export interface GroundLayer {
  id: string;
  /** One of the profile's sections (SECTIONS for ground). */
  section: string;
  /** contains: the polygon(s) holding the point; nearest: features within radiusKm, nearest first. */
  match: 'contains' | 'nearest';
  radiusKm?: number;
  /** How many nearest features to show (default 3). */
  show?: number;
  /** Points: rows read to summarise (default `show`); the count is exact either way. */
  candidates?: number;
  /** Lines: measure the true distance to the shape (bbox prefilter, then the geometry),
   *  not to the bbox centre, which can be far from a point a long line passes. */
  shape?: true;
  /** A layer that covers only part of India: when nothing is within radiusKm, a
   *  feature within coverageKm means "none within the radius", none means "not covered". */
  coverageKm?: number;
  /** Keep only these properties (the full rows are a /nearby or /locate call away). */
  fields?: string[];
  /** Plain units of the fields shown, for the response's `units`. */
  units?: Record<string, string>;
  decode?: keyof typeof DECODERS;
  /** Median of a numeric field over every feature read, as stats[name]. With perPoint
   *  (the lng and lat fields), readings sharing a coordinate count once, as their median. */
  median?: { field: string; name: string; perPoint?: [string, string] };
  /** The map's scale or resolution and the period its data describe, said with every answer. */
  about?: { scale?: string; vintage?: string; note?: string };
  /** One sentence for the summary, or null. */
  say?: (e: GroundEntry) => string | null | undefined;
}

// ── decoders: source encodings to plain units ────────────────────────────────

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const sig = (v: number, digits = 3) => Number(v.toPrecision(digits));

export const DECODERS = {
  /** GLHYMPS 2.0 (readme, Borealis doi:10.5683/SP2/TTJNIU): logK_Ferr_ is log10 permeability (m2)
   *  x 100, without permafrost; K (m/s) = k x 1e7 for water. Porosity_x is porosity x 100 from
   *  GLHYMPS 1.0; it reads 0 on polygons whose values come from the unconsolidated sediments map
   *  (GUM_K 2) or that have none (GUM_K 0), so 0 means "not given". A logK of 0 marks no value. */
  glhymps(p: Props): Props {
    const logK = num(p.logK_Ferr_);
    const k = logK ? Math.round(logK) / 100 : null;
    const por = num(p.Porosity_x);
    return {
      log10_permeability_m2: k,
      permeability_m2: k === null ? null : sig(10 ** k),
      hydraulic_conductivity_m_per_s: k === null ? null : sig(10 ** k * 1e7),
      porosity_fraction: por ? por / 100 : null,
      ...(por ? {} : { porosity_note: 'not given here: GLHYMPS 2.0 has no porosity for unconsolidated sediments mapped from GUM' }),
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

/** A field of the first feature (contains) or the nearest one, as text; numbers without trailing zeros. */
const first = (e: GroundEntry, key: string): string | null => {
  const v = e.features?.[0]?.[key] ?? e.nearest?.[0]?.properties[key];
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  return String(n).replace(/\s+/g, ' ').trim();
};
const km = (d: number) => `${d < 1 ? d.toFixed(2) : d.toFixed(1)} km`;
const nearestSay = (what: string, nameField = 'name') => (e: GroundEntry) => {
  const n = e.nearest?.[0];
  if (!n) return null;
  const name = first(e, nameField);
  return `${what} ${km(n.distance_km)} away${name ? ` (${name})` : ''}`;
};

const SHC_UNITS = {
  N: 'kg/ha', P: 'kg/ha', K: 'kg/ha', OC: '%', EC: 'dS/m', pH: 'pH',
  S: 'ppm', Zn: 'ppm', Fe: 'ppm', Cu: 'ppm', Mn: 'ppm', B: 'ppm',
};
const LINEAMENT = ['Des', 'l1descript', 'l2descript', 'Level1', 'Level2', 'st_code'];
const GW_QUALITY: Omit<GroundLayer, 'id' | 'section'> = {
  match: 'nearest', radiusKm: 10, coverageKm: 50, show: 1,
  fields: ['GWQ', 'YEAR', 'WELL_TYPE', 'pH', 'TDS', 'HARDNESS', 'FLUORIDE', 'NITRATE', 'ARSENIC', 'IRON', 'CHLORIDE', 'SULPHATE', 'DATA_SOURC'],
  units: { pH: 'pH' },
  about: { scale: 'point samples (wells and handpumps)', vintage: 'sampled 1999 to 2019, mostly 2009 to 2016',
    note: 'concentrations as published (usually mg/L); 0 often means not measured' },
};
const gwQualitySay = (season: string) => (e: GroundEntry) => {
  const n = e.nearest?.[0];
  return n && first(e, 'GWQ') ? `${season} groundwater sample ${km(n.distance_km)} away: ${first(e, 'GWQ')}${first(e, 'YEAR') ? ` (${first(e, 'YEAR')})` : ''}` : null;
};

export const GROUND_LAYERS: GroundLayer[] = [
  // ── seismic ──
  { id: 'seismic_zones', section: 'seismic', match: 'contains', about: { scale: 'national zoning map', vintage: 'BIS IS 1893:2016' },
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
  { id: 'gsi_critical_minerals', section: 'resources', match: 'nearest', radiusKm: 25,
    fields: ['commodity', 'locality', 'occurrence', 'host_rock', 'geology', 'age', 'remarks'], say: nearestSay('Critical mineral occurrence', 'commodity') },
  { id: 'gsi_mineral_deposits', section: 'resources', match: 'nearest', radiusKm: 25,
    fields: ['mineral_or', 'locality', 'reserve', 'grade', 'hostrock', 'formation'], say: nearestSay('Mineral deposit', 'mineral_or') },
  { id: 'gsi_geothermal_springs', section: 'resources', match: 'nearest', radiusKm: 50,
    fields: ['location', 'state', 'district', 'temparatur', 'spring_typ', 'tds'], units: { temparatur: 'deg C', tds: 'mg/L (as published)' },
    say: nearestSay('Hot spring', 'location') },
  { id: 'vedas_oil_wells', section: 'resources', match: 'nearest', radiusKm: 10, fields: ['well_name', 'operator'], say: nearestSay('Oil or gas well', 'well_name') },
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
  { id: 'glhymps_permeability', section: 'groundwater', match: 'contains', decode: 'glhymps',
    about: { scale: 'global, coarse polygons (regional patterns, not a site value)', vintage: 'GLHYMPS 2.0 (2018)' },
    units: { log10_permeability_m2: 'log10 m2', permeability_m2: 'm2', hydraulic_conductivity_m_per_s: 'm/s', porosity_fraction: 'fraction (0-1)' },
    say: (e) => {
      const k = e.decoded?.log10_permeability_m2;
      return typeof k === 'number' ? `Near-surface permeability about 10^${k} m2 (GLHYMPS)` : null;
    } },
  { id: 'atal_bhujal_wells', section: 'groundwater', match: 'nearest', radiusKm: 10, coverageKm: 50, decode: 'monsoon_depths',
    about: { scale: 'monitoring wells in seven states', vintage: '2015 to 2022' },
    fields: ['Well_ID', 'Site_Name', 'Village', 'TYPE', 'Aquifer', 'Well_Depth (meters)'], units: { 'Well_Depth (meters)': 'm' },
    say: (e) => {
      const n = e.nearest?.[0];
      const pre = n?.decoded?.latest_pre_monsoon as { year: number; depth_m_below_ground: number } | null | undefined;
      return n && pre ? `Groundwater ${pre.depth_m_below_ground} m below ground before the ${pre.year} monsoon at an Atal Bhujal well ${km(n.distance_km)} away` : null;
    } },
  // WRIS groundwater level stations, once published, are one row like:
  // { id: 'wris_groundwater_levels', section: 'groundwater', match: 'nearest', radiusKm: 10 },
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
    about: { scale: 'satellite (InSAR) measurement points', vintage: 'Ohenhen et al. 2025; Bengaluru, Chennai, Delhi, Kolkata and Mumbai only' },
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
  { id: 'ndem_floods_1998_2022', section: 'watershed', match: 'contains', about: { scale: 'flood extents mapped from satellite', vintage: '1998 to 2022' },
    say: (e) => (e.status === 'found' ? 'Inside an area NDEM mapped as flooded between 1998 and 2022' : null) },
];

// ── pure helpers ─────────────────────────────────────────────────────────────

const canonical = (p: Props) => JSON.stringify(Object.keys(p).sort().map((k) => [k, p[k]]),
  (_k, v) => (typeof v === 'bigint' ? Number(v) : v));

/** Features with identical properties, once. */
export function dedupeFeatures(features: Props[]): Props[] {
  const seen = new Set<string>();
  return features.filter((f) => {
    const key = canonical(f);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function median(values: unknown[]): number | null {
  const xs = values.map(num).filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** stats[name] = the median of `field`; with perPoint, each coordinate's readings
 *  first reduce to their median (subsidence_megacities repeats some coordinates), and
 *  stats.points / stats.readings say how many of each went in. */
export function medianStats(rows: Props[], m: NonNullable<GroundLayer['median']>): Record<string, number | null> {
  const round2 = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);
  if (!m.perPoint) return { [m.name]: round2(median(rows.map((r) => r[m.field]))) };
  const byPoint = new Map<string, unknown[]>();
  for (const r of rows) {
    const k = `${r[m.perPoint[0]]},${r[m.perPoint[1]]}`;
    (byPoint.get(k) ?? byPoint.set(k, []).get(k)!).push(r[m.field]);
  }
  return {
    [m.name]: round2(median([...byPoint.values()].map((vals) => median(vals)))),
    points: byPoint.size,
    readings: rows.length,
  };
}

const pick = (p: Props, fields?: string[]): Props =>
  fields ? Object.fromEntries(fields.filter((f) => p[f] !== undefined && p[f] !== null && p[f] !== '').map((f) => [f, p[f]])) : p;

// ── the response ─────────────────────────────────────────────────────────────

export interface Credit { name: string; url?: string; publisher?: { name: string; url: string }; licence?: string; licence_url?: string }

export interface NearestItem { distance_km: number; lat: number; lng: number; properties: Props; decoded?: Props }

/** found: something answered. none_within_radius: the layer covers the area but
 *  nothing is within radius_km. not_covered: the layer does not reach this point. */
export type GroundStatus = 'found' | 'none_within_radius' | 'not_covered';

export interface GroundEntry {
  layer_id: string;
  match: 'contains' | 'nearest' | 'pixel';
  status: GroundStatus;
  credit: Credit;
  /** Scale or resolution, the period the data describe, and when bharatlas fetched the layer. */
  about?: { scale?: string; vintage?: string; note?: string; fetched_at?: string };
  non_commercial?: true;
  licence_notice?: string;
  units?: Record<string, string>;
  /** contains */
  features?: Props[];
  decoded?: Props;
  /** nearest */
  radius_km?: number;
  /** How distance_km is measured: to the point (points), or to the nearest part of the line. */
  distance_to?: 'point' | 'line';
  count?: number;
  count_capped?: true;
  nearest?: NearestItem[];
  stats?: Record<string, number | null>;
  /** pixel (SoilGrids) */
  resolution_m?: number;
  depths?: SoilProfile['depths'] | null;
  wrb_class?: string | null;
  reason?: string;
}

export interface GroundResponse {
  point: { lat: number; lng: number };
  summary: string;
  disclaimer: string;
  sections: Record<Section, Record<string, GroundEntry>>;
  /** With open_only: the non-commercial layers left out. */
  omitted_non_commercial?: string[];
  unavailable: Array<{ layer_id: string; reason: string }>;
  attribution: string[];
  timing_ms: number;
  layer_timing_ms: Record<string, number>;
}

export interface GroundDeps {
  locate: typeof locateEngine;
  nearby: typeof nearbyEngine;
  nearbyByGeometry: typeof nearbyByGeometry;
  soil: (r2: R2Bucket, lat: number, lng: number) => Promise<SoilResult>;
}

const DEFAULT_DEPS: GroundDeps = {
  locate: locateEngine, nearby: nearbyEngine, nearbyByGeometry, soil: (r2, lat, lng) => soilAt(r2, undefined, lat, lng),
};
export const LAYER_BUDGET_MS = 6000;
const ZOOM = 14;

export function creditOf(layer: CatalogLayer): Credit {
  const p = layer.attribution?.primary;
  const pub = layer.attribution?.publisher;
  const url = licenceUrl(layer.licence);
  return {
    name: p?.name ?? layer.source, ...(p?.url ? { url: p.url } : {}), ...(pub ? { publisher: pub } : {}),
    ...(layer.licence ? { licence: layer.licence } : {}), ...(url ? { licence_url: url } : {}),
  };
}

/** Answers are for the point snapped to 3 decimal places (about 100 m), so nearby asks share one edge-cached answer. */
export const SNAP_DECIMALS = 3;
export function snapPoint(lat: number, lng: number): { lat: number; lng: number } {
  const f = 10 ** SNAP_DECIMALS;
  return { lat: Math.round(lat * f) / f, lng: Math.round(lng * f) / f };
}

class OutOfTime extends Error {}

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new OutOfTime()), ms); })])
    .finally(() => clearTimeout(timer));
}

type LayerAnswer = Omit<GroundEntry, 'credit' | 'layer_id'>;

async function readContains(spec: GroundLayer, lat: number, lng: number, catalog: CatalogData, r2: R2Bucket, deps: GroundDeps): Promise<LayerAnswer> {
  const r: LocateResponse = await deps.locate(lat, lng, [spec.id], ZOOM, catalog, r2);
  if (r.failed_layers?.includes(spec.id)) throw new Error('tiles could not be read');
  const features = dedupeFeatures(Object.values(r.results).flat()
    .filter((h) => h.layer_id === spec.id).map((h) => pick(h.feature.properties, spec.fields)));
  return {
    match: 'contains', status: features.length ? 'found' : 'not_covered', features,
    ...(spec.decode && features[0] ? { decoded: DECODERS[spec.decode](features[0]) } : {}),
  };
}

async function readNearest(spec: GroundLayer, lat: number, lng: number, catalog: CatalogData, r2: R2Bucket, deps: GroundDeps): Promise<LayerAnswer> {
  const radiusKm = spec.radiusKm!;
  const show = spec.show ?? 3;
  let items: Array<NearestItem & { raw: Props }>;
  let count: number, capped: boolean;
  if (spec.shape) {
    const g = await deps.nearbyByGeometry(lat, lng, radiusKm, spec.id, catalog, r2, { limit: Math.max(show, spec.candidates ?? show) });
    items = g.features.map((f) => ({ distance_km: f.distance_km, lat: f.lat, lng: f.lng, properties: f.properties, raw: f.properties }));
    count = g.total;
    capped = g.capped;
  } else {
    const n = await deps.nearby(lat, lng, radiusKm, spec.id, catalog, r2, spec.candidates ?? show);
    items = n.features.map((f) => ({ distance_km: f._distance_km, lat: f._lat, lng: f._lng, properties: f.properties, raw: f.properties }));
    count = n.total;
    capped = n.total > n.features.length && !!spec.median; // a median over fewer than all
  }
  let status: GroundStatus = count ? 'found' : 'none_within_radius';
  // Only when nothing is near: is the layer anywhere around? (Outside its row groups' bounds this reads only the footer.)
  if (!count && spec.coverageKm && !(await deps.nearby(lat, lng, spec.coverageKm, spec.id, catalog, r2, 1)).total) status = 'not_covered';
  const nearest: NearestItem[] = items.slice(0, show).map(({ raw, ...it }) => ({
    ...it, properties: pick(raw, spec.fields), ...(spec.decode ? { decoded: DECODERS[spec.decode](raw) } : {}),
  }));
  const stats = spec.median ? medianStats(items.map((i) => i.raw), spec.median) : undefined;
  return {
    match: 'nearest', status, radius_km: radiusKm, distance_to: spec.shape ? 'line' : 'point', count,
    ...(capped ? { count_capped: true as const } : {}), nearest,
    ...(stats ? { stats } : {}),
  };
}

function soilEntry(s: SoilResult): GroundEntry {
  const src = SOILGRIDS.source;
  const units = Object.fromEntries(Object.values(SOILGRIDS.properties).map((p) => [p.field, p.unit]));
  return {
    layer_id: 'soilgrids', match: 'pixel', status: s.status === 'ok' ? 'found' : 'not_covered',
    about: { scale: '250 m grid of model predictions (not a field sample)', vintage: 'SoilGrids 2.0 (2020 release)' },
    credit: { name: src.name, url: src.url, licence: src.licence, licence_url: src.licence_url },
    resolution_m: 250, units,
    depths: s.status === 'ok' ? s.soil.depths : null,
    wrb_class: s.status === 'ok' ? s.soil.wrb_class : null,
    ...(s.status === 'ok' ? {} : { reason: s.reason }),
  };
}

function soilSay(e: GroundEntry): string | null {
  const top = e.depths?.['0-5cm'];
  if (!top) return null;
  const bits = [top.clay_pct != null && `${top.clay_pct}% clay`, top.sand_pct != null && `${top.sand_pct}% sand`,
    top.ph_water != null && `pH ${top.ph_water}`].filter(Boolean).join(', ');
  return `Topsoil (0-5 cm, SoilGrids): ${bits}${e.wrb_class ? `; soil group ${e.wrb_class}` : ''}`;
}

/** A raster read at the point (one pixel), e.g. SoilGrids: its answer becomes one entry. */
export interface PixelSource {
  id: string;
  section: string;
  read: (deps: GroundDeps, r2: R2Bucket, lat: number, lng: number) => Promise<SoilResult>;
  entry: (res: Exclude<SoilResult, { status: 'unavailable' }>) => GroundEntry;
  say?: (e: GroundEntry) => string | null;
  credit: string;
}

/** What a profile reads: the layer table, its sections in order, pixel sources, and its words. */
export interface ProfileSpec {
  layers: GroundLayer[];
  sections: readonly string[];
  pixels: PixelSource[];
  disclaimer: string;
  nothing: string;
}

export const GROUND_PROFILE: ProfileSpec = {
  layers: GROUND_LAYERS,
  sections: SECTIONS,
  pixels: [{
    id: 'soilgrids', section: 'soil', read: (deps, r2, lat, lng) => deps.soil(r2, lat, lng),
    entry: soilEntry, say: soilSay, credit: `${SOILGRIDS.source.name} (${SOILGRIDS.source.licence})`,
  }],
  disclaimer: DISCLAIMER,
  nothing: 'Nothing found below this point in the layers checked.',
};

export type ProfileOpts = { budgetMs?: number; waitUntil?: (p: Promise<unknown>) => void; openOnly?: boolean };

/** The subsurface profile at lat/lng. Never throws for one layer: it goes to `unavailable`. */
export function groundAt(
  lat: number, lng: number, catalog: CatalogData, r2: R2Bucket, deps: GroundDeps = DEFAULT_DEPS, opts: ProfileOpts = {},
): Promise<GroundResponse> {
  return profileAt(GROUND_PROFILE, lat, lng, catalog, r2, deps, opts) as Promise<GroundResponse>;
}

/** Any profile at lat/lng: every layer and pixel source read in parallel, each under its own budget. */
export async function profileAt(
  profile: ProfileSpec, lat: number, lng: number, catalog: CatalogData, r2: R2Bucket,
  deps: GroundDeps = DEFAULT_DEPS, opts: ProfileOpts = {},
): Promise<Omit<GroundResponse, 'sections'> & { sections: Record<string, Record<string, GroundEntry>> }> {
  const start = Date.now();
  const budget = opts.budgetMs ?? LAYER_BUDGET_MS;
  const byId = new Map(catalog.layers.map((l) => [l.id, l]));
  const sections: Record<string, Record<string, GroundEntry>> = Object.fromEntries(profile.sections.map((s) => [s, {}]));
  const unavailable: GroundResponse['unavailable'] = [];
  const timing: Record<string, number> = {};
  const said: Array<[number, string]> = [];
  const credits = new Set<string>();
  const omitted: string[] = [];

  const timed = async <T>(id: string, p: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    const work = p();
    try {
      return await within(work, budget);
    } catch (e) {
      if (e instanceof OutOfTime) opts.waitUntil?.(work.catch(() => {}));
      throw e;
    } finally { timing[id] = Date.now() - t0; }
  };
  const failed = (id: string, e: unknown) => {
    if (!(e instanceof OutOfTime)) console.error(`profile: ${id} failed:`, (e as Error)?.message ?? e);
    unavailable.push({ layer_id: id, reason: e instanceof OutOfTime ? `took longer than ${budget} ms` : 'could not be read' });
  };

  const layerJobs = profile.layers.map(async (spec, order) => {
    const layer = byId.get(spec.id);
    if (!layer) { unavailable.push({ layer_id: spec.id, reason: 'not published' }); return; }
    if (opts.openOnly && ncFields(layer).non_commercial) { omitted.push(spec.id); return; }
    try {
      const read = spec.match === 'contains' ? readContains : readNearest;
      const got = await timed(spec.id, () => read(spec, lat, lng, catalog, r2, deps));
      const entry: GroundEntry = {
        layer_id: spec.id, credit: creditOf(layer), ...ncFields(layer),
        about: { ...spec.about, ...(layer.fetched_at ? { fetched_at: layer.fetched_at.slice(0, 10) } : {}) },
        ...got, ...(spec.units ? { units: spec.units } : {}),
      };
      sections[spec.section][spec.id] = entry;
      const line = spec.say?.(entry);
      if (line) said.push([order, line]);
      if (entry.status === 'found') credits.add(`${entry.credit.name} (${layer.licence ?? 'see source'})`);
    } catch (e) {
      failed(spec.id, e);
    }
  });
  // A pixel source speaks just before the first layer of its section.
  const pixelJobs = profile.pixels.map(async (px) => {
    try {
      const got = await timed(px.id, () => px.read(deps, r2, lat, lng));
      if (got.status === 'unavailable') { unavailable.push({ layer_id: px.id, reason: got.reason }); return; }
      const entry = px.entry(got);
      sections[px.section][px.id] = entry;
      const line = px.say?.(entry);
      if (line) said.push([profile.layers.findIndex((l) => l.section === px.section) - 0.5, line]);
      if (entry.status === 'found') credits.add(px.credit);
    } catch (e) {
      failed(px.id, e);
    }
  });
  await Promise.all([...layerJobs, ...pixelJobs]);

  // Answers arrive in any order: lay each section out in the table's order (pixel sources first).
  const pixelIds = new Set(profile.pixels.map((p) => p.id));
  const order = (id: string) => (pixelIds.has(id) ? -1 : profile.layers.findIndex((l) => l.id === id));
  for (const s of profile.sections) {
    sections[s] = Object.fromEntries(Object.entries(sections[s]).sort(([a], [b]) => order(a) - order(b)));
  }
  unavailable.sort((a, b) => order(a.layer_id) - order(b.layer_id));
  said.sort((a, b) => a[0] - b[0]);

  return {
    point: { lat, lng },
    summary: said.length ? said.map(([, s]) => s).join('. ') + '.' : profile.nothing,
    disclaimer: profile.disclaimer,
    sections,
    ...(opts.openOnly ? { omitted_non_commercial: profile.layers.map((l) => l.id).filter((id) => omitted.includes(id)) } : {}),
    unavailable,
    attribution: [...credits],
    timing_ms: Date.now() - start,
    layer_timing_ms: timing,
  };
}
