// GET /api/v1/surface: what is on the ground at a point, in one call. SURFACE_LAYERS
// is the table of layers (lib/profile.ts runs it), plus three rasters read at the
// point (land cover, elevation and slope, population). The air above the point is
// mugilu's (an MCP pointer in `air`).
import type { CatalogData } from './catalog-api';
import { SURFACE_PIXELS, SURFACE_RASTERS } from './surface-rasters';
import { edgeNote, SEISMIC_ABOUT, SEISMIC_EDGE_KM } from './ground';
import { fallbackWardLayers, NATIONAL_WARD_LAYERS, wardLayersAt } from './ward-locate';
import { WARD_BBOXES } from './ward-bboxes';
import { wardLine } from './ward-label';
import {
  BASE_DEPS, first, joinOnce, km, nearestSay, num, profileAt,
  type PixelResult, type PixelSource, type ProfileDeps, type ProfileEntry, type ProfileLayer, type ProfileOpts,
  type ProfileResponse, type ProfileSpec, type Props,
} from './profile';

export const SURFACE_SECTIONS = [
  'place', 'land', 'climate', 'water', 'hazards', 'protected', 'access', 'services', 'infrastructure',
] as const;

/** Said once per answer: what this is, and what it is not. */
export const SURFACE_DISCLAIMER = 'Screening information from published maps, models and volunteered data of different scales and dates: ' +
  'not a survey, and not for legal, engineering, construction or safety decisions. ' +
  "Check each section's scale and vintage, and confirm with the authority concerned (land records, the local body, the forest or coastal authority) before relying on it.";

const PLACE = { scale: 'official boundaries (LGD) as published' };
const ADMIN = (id: string, field: string, label: string): ProfileLayer => ({
  id, section: 'place', match: 'contains', about: PLACE, say: (e) => first(e, field) && `${label} ${first(e, field)}`,
});

const nearestOf = (what: string, field: string) => nearestSay(what, field);
/** `name` names it: a field, or a function of the entry. */
const insideOr = (what: string, name: string | ((e: ProfileEntry) => string | null)) => (e: ProfileEntry) => {
  const n = e.nearest?.[0];
  if (!n) return null;
  const it = typeof name === 'string' ? first(e, name) : name(e);
  return n.distance_km === 0 ? `Inside ${what} ${it ?? ''}`.trim() : `${what[0].toUpperCase()}${what.slice(1)} ${km(n.distance_km)} away${it ? ` (${it})` : ''}`;
};
/** A protected area's name; one named only by its kind ("Wildlife Sanctuary", Dadra & Nagar Haveli) says its state. */
const paName = (e: ProfileEntry) => {
  const name = first(e, 'name');
  return name && /^(wildlife |bird )?sanctuary$|^national park$|^(tiger|conservation|community) reserve$/i.test(name) ? joinOnce([name, first(e, 'state')]) : name;
};
const WETLAND = (p: Props) => !/non-wetland/i.test(String(p.descr ?? '')) && !/non-wetland/i.test(String(p.level1 ?? ''));

export const SURFACE_LAYERS: ProfileLayer[] = [
  // ── place: what locate answers ──
  ADMIN('lgd_states', 'STNAME', 'State:'),
  ADMIN('lgd_districts', 'dtname', 'District:'),
  ADMIN('lgd_subdistricts', 'sdtname', 'Sub-district:'),
  { id: 'lgd_blocks', section: 'place', match: 'contains', about: PLACE },
  { id: 'lgd_parliament', section: 'place', match: 'contains', about: PLACE },
  { id: 'lgd_assembly', section: 'place', match: 'contains', about: PLACE, say: (e) => first(e, 'ac_name') && `Assembly constituency ${first(e, 'ac_name')}` },
  { id: 'bharatviz_pincodes', section: 'place', match: 'contains', fields: ['pincode', 'office_name'], about: { scale: 'pincode areas (approximate)' },
    say: (e) => first(e, 'pincode') && `Pincode ${first(e, 'pincode')}` },
  // ── land ──
  { id: 'corestack_lulc_blocks', section: 'land', match: 'contains', about: { scale: 'block-level shares from 10 m IndiaSAT land use', vintage: '2023-24' },
    fields: ['block_name', 'lulc_year', 'built_up_pct', 'cropland_pct', 'trees_pct', 'water_perennial_pct', 'barren_pct', 'shrubs_scrubs_pct', 'cropping_intensity_index'],
    units: { built_up_pct: '% of the block', cropland_pct: '% of the block', trees_pct: '% of the block' },
    say: (e) => num(first(e, 'built_up_pct')) !== null ? `Block land use: ${first(e, 'built_up_pct')}% built-up, ${first(e, 'cropland_pct')}% cropland, ${first(e, 'trees_pct')}% trees` : null },
  { id: 'bhuvan_land_degradation_1516', section: 'land', match: 'contains', about: { scale: '1:50,000', vintage: '2015-16' },
    say: (e) => { const s = first(e, 'DS_1516_L2') ?? first(e, 'DS_1516_L1'); return s && s !== 'Normal' ? `Land degradation: ${s}` : null; } },
  // ── climate zones ──
  { id: 'agro_climatic_zones', section: 'climate', match: 'contains', about: { scale: 'national zones (Planning Commission)' },
    say: (e) => first(e, 'regionname') && `Agro-climatic region: ${first(e, 'regionname')}` },
  { id: 'agro_ecological_zones', section: 'climate', match: 'contains', about: { scale: 'national zones (ICAR-NBSS&LUP)' } },
  { id: 'bm_eco_zones', section: 'climate', match: 'contains', about: { scale: 'national zones' } },
  { id: 'biogeographic_zones', section: 'climate', match: 'contains', fields: ['biogeozone', 'biogeoprov', 'prov_code'], about: { scale: 'national zones (WII)' } },
  // ── water ──
  { id: 'wris_basin', section: 'water', match: 'contains', fields: ['ba_name', 'bacode', 'area_sqkm'], about: { scale: 'national basins (India-WRIS)' } },
  { id: 'wris_subbasin', section: 'water', match: 'contains', fields: ['ba_name', 'sub_basin'], about: { scale: 'sub-basins (India-WRIS)' },
    say: (e) => first(e, 'sub_basin') && `River basin: ${joinOnce([first(e, 'ba_name'), first(e, 'sub_basin')], ', ', (s) => s.replace(/ basin$/, ''))}` },
  { id: 'wris_rivers', section: 'water', match: 'nearest', shape: true, radiusKm: 10, about: { scale: 'river lines (India-WRIS, 1:250,000)' },
    fields: ['rivname', 'major_tributary', 'sub_basin', 'layer'], say: nearestOf('Nearest river', 'rivname') },
  { id: 'wris_waterbodies', section: 'water', match: 'nearest', shape: true, radiusKm: 2, about: { scale: 'water body outlines (India-WRIS)' },
    fields: ['wbname', 'wbcode', 'area_ha', 'district'], units: { area_ha: 'ha' }, say: nearestOf('Nearest water body', 'wbname') },
  { id: 'wris_reservoirs', section: 'water', match: 'nearest', about: { scale: 'reservoir outlines (India-WRIS)' }, shape: true, radiusKm: 25, fields: ['wbname', 'area_ha', 'river_name'], units: { area_ha: 'ha' } },
  { id: 'wris_dams', section: 'water', match: 'nearest', about: { scale: 'dam points (India-WRIS)' }, radiusKm: 25,
    fields: ['dm_name', 'rivcode', 'dm_type', 'dm_cmp_yr', 'dm_height', 'dm_status'], units: { dm_height: 'm' }, say: nearestOf('Nearest dam', 'dm_name') },
  { id: 'bp_wetlands', section: 'water', match: 'nearest', shape: true, radiusKm: 5, keep: WETLAND,
    about: { scale: 'National Wetland Atlas', note: 'outlines marked "non-wetland area" are left out' },
    fields: ['wetname', 'descr', 'level1', 'level2', 'areaha'], units: { areaha: 'ha' } },
  { id: 'bp_ramsar', section: 'water', match: 'nearest', about: { scale: 'Ramsar site outlines' }, shape: true, radiusKm: 50, fields: ['name', 'district', 'state'], say: insideOr('Ramsar wetland', 'name') },
  { id: 'amrit_sarovar_ponds', section: 'water', match: 'nearest', about: { scale: 'pond points (Amrit Sarovar mission)' }, radiusKm: 5, coverageKm: 30, fields: ['Name_of_Sarovar', 'Village', 'Sarovar_Status'] },
  { id: 'india_flood_inventory', section: 'water', match: 'nearest', radiusKm: 25, about: { scale: 'recorded flood events (point locations)' } },
  { id: 'ndem_floods_1998_2022', section: 'water', match: 'contains', allIndia: true, about: { scale: 'flood extents mapped from satellite', vintage: '1998 to 2022' },
    say: (e) => (e.status === 'found' ? 'Inside an area NDEM mapped as flooded between 1998 and 2022' : null) },
  // ── hazards ──
  { id: 'seismic_zones', section: 'hazards', match: 'contains', about: SEISMIC_ABOUT, edgeKm: SEISMIC_EDGE_KM,
    say: (e) => first(e, 'seismic_zo') && `${first(e, 'seismic_zo')}${edgeNote(e)}` },
  { id: 'ndem_landslide_hazard', section: 'hazards', match: 'contains', about: { scale: 'landslide hazard zonation (NDEM)' } },
  { id: 'gsi_landslide_inventory', section: 'hazards', match: 'nearest', radiusKm: 5, about: { scale: 'recorded landslides (GSI)' },
    fields: ['SLIDE_NAME', 'DISTRICT', 'MATERIAL_TYPE', 'MOVEMENT_TYPE', 'ACTIVITY', 'TRIGGERING'],
    say: (e) => (e.count ? `${e.count} recorded landslide${e.count === 1 ? '' : 's'} within ${e.radius_km} km` : null) },
  { id: 'ndem_cyclone_tracks', section: 'hazards', match: 'nearest', shape: true, radiusKm: 100, candidates: 200,
    fields: ['name', 'begin', 'wind_speed', 'pressure'], about: { scale: 'cyclone tracks (NDEM)' },
    say: (e) => (e.count ? `${e.count} cyclone track${e.count === 1 ? '' : 's'} passed within ${e.radius_km} km` : null) },
  { id: 'crz2019_zones', section: 'hazards', match: 'contains', about: { scale: 'Coastal Zone Management Plans (CRZ 2019)' },
    say: (e) => (e.status === 'found' ? 'Inside a Coastal Regulation Zone' : null) },
  // ── protected ──
  { id: 'fsi_recorded_forest_area', section: 'protected', match: 'contains', allIndia: true, about: { scale: 'recorded forest area (FSI)' },
    say: (e) => {
      if (e.status !== 'found') return null;
      const what = first(e, 'name') ?? first(e, 'name_of_rf') ?? first(e, 'division');
      return `Inside an FSI recorded forest area${what ? ` (${what})` : ''}`;
    } },
  { id: 'gs_wildlife', key: 'gs_wildlife_nearest', section: 'protected', match: 'nearest', about: { scale: 'protected area outlines (PM GatiShakti)' }, shape: true, radiusKm: 50,
    fields: ['name', 'category', 'state', 'area_sqkm'], units: { area_sqkm: 'sq km' }, say: insideOr('protected area', paName) },
  { id: 'wildlife_corridors', section: 'protected', match: 'nearest', about: { scale: 'corridor outlines' }, shape: true, radiusKm: 10, fields: ['name', 'type'], say: insideOr('wildlife corridor', 'name') },
  // ── access ──
  { id: 'gs_highways', section: 'access', match: 'nearest', about: { scale: 'national highway lines (PM GatiShakti, MoRTH)' }, shape: true, radiusKm: 25, fields: ['road_name', 'road_type', 'lane_statu', 'category'],
    say: nearestOf('Nearest national highway', 'road_name') },
  { id: 'ir_stations', section: 'access', match: 'nearest', about: { scale: 'station points (CRIS, PM GatiShakti, Wikidata)' }, radiusKm: 25, fields: ['sttnname', 'sttncode', 'category', 'division'],
    say: nearestOf('Nearest railway station', 'sttnname') },
  { id: 'urban_rail_stations', section: 'access', match: 'nearest', about: { scale: 'station points (OpenStreetMap)' }, radiusKm: 5, coverageKm: 30, fields: ['name', 'system', 'lines', 'mode'],
    say: nearestOf('Nearest metro or suburban station', 'name') },
  { id: 'airports', section: 'access', match: 'nearest', radiusKm: 100, show: 1, fields: ['name', 'type', 'iata_code', 'municipality'],
    about: { scale: 'airport points (OurAirports)', note: 'airports with an airport (IATA) code only: heliports, closed fields, flying clubs and airstrips without one are left out' },
    candidates: 100, keep: (p) => /^(large|medium|small)_airport$/.test(String(p.type)) && /^[A-Z]{3}$/.test(String(p.iata_code ?? '').trim()),
    say: nearestOf('Nearest airport', 'name') },
  { id: 'bus_stops', section: 'access', match: 'nearest', radiusKm: 1, coverageKm: 15, fields: ['name', 'city', 'operator'],
    about: { scale: 'bus stops in the cities that publish them' } },
  // ── services ──
  { id: 'nhp_hospitals', section: 'services', match: 'nearest', about: { scale: 'facility points (National Health Portal)' }, radiusKm: 25, show: 1,
    fields: ['Hospital_Name', 'Hospital_Category', 'Hospital_Care_Type', 'District'] },
  { id: 'nic_health', section: 'services', match: 'nearest', about: { scale: 'facility points (NIC HealthGIS)' }, radiusKm: 25, show: 1 },
  { id: 'nin_health_facilities', section: 'services', match: 'nearest', about: { scale: 'facility points (NIN registry, data.gov.in)' }, radiusKm: 25, show: 1, fields: ['health_facility_name', 'facility_type', 'district_name'] },
  { id: 'udise_schools', section: 'services', match: 'nearest', about: { scale: 'school points (UDISE+)' }, radiusKm: 5, fields: ['school_nam', 'sch_cate_1', 'sch_mgmt'],
    say: nearestOf('Nearest school', 'school_nam') },
  { id: 'overture_places_india', section: 'services', match: 'nearest', radiusKm: 1, show: 0, about: { scale: 'places from Overture Maps' },
    say: (e) => (e.count ? `${e.count.toLocaleString('en-IN')} mapped places within 1 km` : null) },
  // ── infrastructure ──
  { id: 'vedas_transmission_lines', section: 'infrastructure', match: 'nearest', about: { scale: 'power line traces (ISRO VEDAS)' }, shape: true, radiusKm: 10, fields: ['name', 'other_tags'],
    say: nearestOf('Nearest power line', 'name') },
  { id: 'vedas_power_plants', section: 'infrastructure', match: 'nearest', about: { scale: 'plant points (ISRO VEDAS)' }, radiusKm: 50, fields: ['plant_name', 'layer', 'inst_cap'], units: { inst_cap: 'MW' },
    say: nearestOf('Nearest power plant', 'plant_name') },
  { id: 'jjm_facilities', section: 'infrastructure', match: 'nearest', about: { scale: 'facility points (Jal Jeevan Mission)' }, radiusKm: 5, fields: ['fac_name', 'fac_cat', 'fac_class', 'hab_name'] },
  { id: 'india_boundary', key: 'india_outline', section: 'infrastructure', match: 'nearest', shape: true, shapeFrom: 'parquet', edge: true, radiusKm: 3000, show: 1,
    fields: [], about: { scale: "India's outline (LGD)", note: 'distance to the coast or to a land border, whichever is nearer' },
    say: (e) => (e.nearest?.[0] ? `${km(e.nearest[0].distance_km)} from India's outline (coast or land border)` : null) },
];

// ── rasters ──
const R = SURFACE_RASTERS.rasters;
const rasterEntry = (name: keyof typeof R, units: Record<string, string>) =>
  (res: Exclude<PixelResult, { status: 'unavailable' }>): Omit<ProfileEntry, 'layer_id' | 'match'> => ({
    status: res.status === 'ok' ? 'found' : 'not_covered',
    credit: R[name].credit,
    about: R[name].about,
    units,
    values: res.status === 'ok' ? res.data : null,
    ...(res.status === 'ok' ? {} : { reason: res.reason }),
  });
const value = (e: ProfileEntry, k: string) => (e.values ? e.values[k] : null) as number | string | null | undefined;

export const SURFACE_PIXEL_SOURCES: PixelSource[] = [
  { id: 'worldcover', section: 'land', entry: rasterEntry('worldcover', { land_cover: 'ESA WorldCover class' }),
    say: (e) => (value(e, 'land_cover') ? `Land cover: ${value(e, 'land_cover')}` : null), credit: `${R.worldcover.credit.name} (CC-BY-4.0)` },
  { id: 'dem', section: 'land', entry: rasterEntry('dem', { elevation_m: R.dem.units, slope_deg: 'degrees', slope_pct: '%' }),
    say: (e) => (value(e, 'elevation_m') !== null && value(e, 'elevation_m') !== undefined
      ? `Elevation ${value(e, 'elevation_m')} m, slope ${value(e, 'slope_deg')} degrees` : null),
    credit: `${R.dem.credit.name} (${R.dem.credit.licence})` },
  { id: 'worldpop', section: 'land', entry: rasterEntry('worldpop', { population_per_km2: 'people per km2', people_in_pixel: 'people in the 3 arcsec pixel' }),
    say: (e) => (value(e, 'population_per_km2') !== undefined && value(e, 'population_per_km2') !== null
      ? `About ${Number(value(e, 'population_per_km2')).toLocaleString('en-IN')} people per km2 (2020)` : null),
    credit: `${R.worldpop.credit.name} (CC-BY-4.0)` },
];

/** The nearest health facility across the three health layers, each with its source. */
function nearestHealth(sections: ProfileResponse['sections']): string[] {
  const names: Record<string, string> = { nhp_hospitals: 'Hospital_Name', nic_health: 'name', nin_health_facilities: 'health_facility_name' };
  const hits = Object.keys(names).map((id) => ({ id, e: sections.services?.[id] })).filter((h) => h.e?.nearest?.[0]);
  if (!hits.length) return [];
  hits.sort((a, b) => a.e!.nearest![0].distance_km - b.e!.nearest![0].distance_km);
  const { id, e } = hits[0];
  const name = first(e!, names[id]) ?? Object.values(e!.nearest![0].properties).find((v) => typeof v === 'string' && v.length > 3);
  return [`Nearest health facility ${km(e!.nearest![0].distance_km)} away${name ? ` (${name}, ${id})` : ` (${id})`}`];
}

/** The fallback ward layers, each named by its own source (SBM has no West Bengal; WB AMRUT covers it). */
const NATIONAL_WARD_SCALE: Record<string, string> = {
  sbm_wards: 'national ward map (SBM)',
  wb_amrut_wards: 'West Bengal ward map (WB AMRUT)',
};

/** A ward layer's row: a city's map, or a fallback one named by its source. Its summary
 *  line names the ward (ward-label.ts, from shared/ward_columns.json). */
const wardRow = (id: string): ProfileLayer => ({
  id, section: 'place', match: 'contains', about: { scale: NATIONAL_WARD_SCALE[id] ?? 'city ward map' },
  say: (e) => (e.features?.[0] ? wardLine(id, e.features[0]) : null),
});

/** The city ward layer(s) whose extent holds the point; the national ward layer elsewhere. */
function wardRows(lat: number, lng: number): ProfileLayer[] {
  const city = wardLayersAt(lng, lat);
  return (city.length ? city : fallbackWardLayers(lng, lat)).map(wardRow);
}

export const SURFACE_PROFILE: ProfileSpec = {
  layers: SURFACE_LAYERS,
  sections: SURFACE_SECTIONS,
  pixels: SURFACE_PIXEL_SOURCES,
  disclaimer: SURFACE_DISCLAIMER,
  nothing: 'Nothing found on the ground here in the layers checked.',
  expand: (lat, lng) => wardRows(lat, lng),
  expandAfter: 'lgd_subdistricts', // the ward after the sub-district, before the constituencies
  expandable: { section: 'place', ids: [...Object.keys(WARD_BBOXES), ...NATIONAL_WARD_LAYERS], row: wardRow },
  conclude: healthUnlessAbroad,
  preface: outsideIndia,
  quiet: quietOutside,
};

/** In no state and OUTSIDE_KM or more from India's outline, the answer says first where the point is.
 *  On land (WorldCover, not water) it is outside India (Kathmandu); on water it is at sea, which may
 *  still be Indian waters (the Gulf of Kutch, off Mumbai, Palk Bay), so only the distance is said.
 *  Nearer the outline a coarse coast or border can leave a point on land in no state (Great Nicobar). */
const OUTSIDE_KM = 5;
const WATER = 80; // ESA WorldCover: permanent water bodies
function whereOutside(sections: ProfileResponse['sections']): { at: 'land' | 'sea'; km: number } | null {
  const state = sections.place?.lgd_states;
  const d = sections.infrastructure?.india_outline?.nearest?.[0]?.distance_km;
  const cover = sections.land?.worldcover; // absent when it could not be read: then nothing is said
  if (!state || state.status === 'found' || d === undefined || d < OUTSIDE_KM || !cover) return null;
  return { at: cover.status === 'found' && value(cover, 'land_cover_code') !== WATER ? 'land' : 'sea', km: d };
}
function outsideIndia(sections: ProfileResponse['sections']): string[] {
  const w = whereOutside(sections);
  if (!w) return [];
  return [w.at === 'land' ? `This point is outside India, ${km(w.km)} from its outline` : `At sea, ${km(w.km)} from India's coast or land border`];
}
/** Said first, the distance is not said again; abroad, India's service lists name only stray
 *  records (a Dhanbad hospital geocoded to Kathmandu), so their lines are left out too. */
const SERVICES = SURFACE_LAYERS.filter((l) => l.section === 'services').map((l) => l.key ?? l.id);
function quietOutside(sections: ProfileResponse['sections']): string[] {
  const w = whereOutside(sections);
  return w ? ['india_outline', ...(w.at === 'land' ? SERVICES : [])] : [];
}
function healthUnlessAbroad(sections: ProfileResponse['sections']): string[] {
  return whereOutside(sections)?.at === 'land' ? [] : nearestHealth(sections);
}

export const SURFACE_DEPS: ProfileDeps = { ...BASE_DEPS, pixels: SURFACE_PIXELS };

/** The air above the point: mugilu answers that (air quality, heat, rain, warnings), not bharatlas. */
export function airPointer(lat: number, lng: number) {
  return {
    note: 'For the air above this point (air quality, heat, rain, fog, official warnings) ask mugilu, the open sky of India.',
    mcp: { server: 'https://mugilu.live/mcp', tool: 'conditions_at', arguments: { place: `${lat},${lng}` } },
  };
}

export type SurfaceResponse = ProfileResponse & { air: ReturnType<typeof airPointer> };

/** What is on the ground at lat/lng. Never throws for one layer: it goes to `unavailable`. */
export async function surfaceAt(
  lat: number, lng: number, catalog: CatalogData, r2: R2Bucket, deps: ProfileDeps = SURFACE_DEPS, opts: ProfileOpts = {},
): Promise<SurfaceResponse> {
  return { ...(await profileAt(SURFACE_PROFILE, lat, lng, catalog, r2, deps, opts)), air: airPointer(lat, lng) };
}
