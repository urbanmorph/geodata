// The point-profile runner behind /api/v1/ground and /api/v1/surface: a profile is
// a table of layer rows (which section, contains or nearest, how far, which fields,
// how to decode and say it) plus pixel sources (rasters read at the point). The
// runner reads them all in parallel, each under its own time budget, through the
// engines the API already has: /locate's point-in-polygon over PMTiles for
// `contains`, /nearby's parquet bbox search for points, nearby-geometry's true
// distance for lines and polygons. A layer that fails or runs out of time is
// listed in `unavailable`; the rest still answer. A new layer is one more row.
import type { CatalogData, CatalogLayer } from './catalog-api';
import { ncFields } from './catalog-api';
import { locate as locateEngine, type LocateResponse } from './locate';
import { nearby as nearbyEngine } from './nearby';
import { nearbyByGeometry } from './nearby-geometry';
import { nearbyFromTiles } from './nearby-tiles';
import { licenceUrl } from '../../../shared/licences.mjs';

export type Props = Record<string, unknown>;

export interface ProfileLayer {
  id: string;
  /** The entry's name in its section when one layer is asked twice (e.g. contains, then nearest); default id. */
  key?: string;
  /** One of the profile's sections. */
  section: string;
  /** contains: the polygon(s) holding the point; nearest: features within radiusKm, nearest first. */
  match: 'contains' | 'nearest';
  radiusKm?: number;
  /** How many nearest features to show (default 3). */
  show?: number;
  /** Rows read to summarise or count (default `show`); a point layer's count is exact either way. */
  candidates?: number;
  /** Lines and polygons: measure the true distance to the shape (bbox prefilter, then the
   *  geometry), not to the bbox centre, which can be far from a point a long line passes. */
  shape?: true;
  /** With shape: measure to the outline even when the point is inside (distance to a coast or border). */
  edge?: true;
  /** With shape: read the shapes from the map tiles (default; small reads, cached) or from the
   *  parquet (one row group at a time: for a radius too large for tiles, such as India's outline). */
  shapeFrom?: 'tiles' | 'parquet';
  /** With shape: only rows this keeps count (e.g. skip a layer's "non-wetland area" polygons). */
  keep?: (p: Props) => boolean;
  /** A layer that covers only part of India: when nothing is within radiusKm, a
   *  feature within coverageKm means "none within the radius", none means "not covered". */
  coverageKm?: number;
  /** contains: the layer maps all of India (an inventory such as NDEM's flood extents), so no
   *  polygon at the point means none here (none_within_radius, radius 0), not a gap (not_covered). */
  allIndia?: true;
  /** Keep only these properties (the full rows are a /nearby or /locate call away). */
  fields?: string[];
  /** Plain units of the fields shown, for the response's `units`. */
  units?: Record<string, string>;
  /** Source encodings to plain units, on each feature. */
  decode?: (p: Props) => Props;
  /** Median of a numeric field over every feature read, as stats[name]. With perPoint
   *  (the lng and lat fields), readings sharing a coordinate count once, as their median. */
  median?: { field: string; name: string; perPoint?: [string, string] };
  /** The map's scale or resolution and the period its data describe, said with every answer. */
  about?: { scale?: string; vintage?: string; note?: string };
  /** One sentence for the summary, or null. */
  say?: (e: ProfileEntry) => string | null | undefined;
  /** Related downloads for the entry (e.g. a layer's full readings), from its catalog entry. */
  links?: (layer: CatalogLayer) => Record<string, string>;
}

// ── small helpers ────────────────────────────────────────────────────────────

export const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

/** A value as summary text, cleaned for reading only (the data stays as published):
 *  line breaks collapse, "-" or "NA" is missing, entities decode, a number loses
 *  trailing zeros, and a range whose ends match ("05 °C To 05 °C") says it once. */
export function cleanText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  let s = (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? String(Number(v)) : String(v))
    .replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m])
    .replace(/\s+/g, ' ').trim();
  const range = s.match(/^(.+?)\s+to\s+(.+)$/i);
  if (range && range[1].replace(/^0+(?=\d)/, '') === range[2].replace(/^0+(?=\d)/, '')) s = range[1].replace(/^0+(?=\d)/, '');
  return s === '' || s === '-' || /^n\/?a$/i.test(s) || /^null$/i.test(s) ? null : s;
}

/** A field of the first feature (contains) or the nearest one, as summary text. */
export const first = (e: ProfileEntry, key: string): string | null =>
  cleanText(e.features?.[0]?.[key] ?? e.nearest?.[0]?.properties[key]);
export const km = (d: number) => `${d < 1 ? d.toFixed(2) : d.toFixed(1)} km`;
export const nearestSay = (what: string, nameField = 'name') => (e: ProfileEntry) => {
  const n = e.nearest?.[0];
  if (!n) return null;
  const name = first(e, nameField);
  return `${what} ${km(n.distance_km)} away${name ? ` (${name})` : ''}`;
};

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
export function medianStats(rows: Props[], m: NonNullable<ProfileLayer['median']>): Record<string, number | null> {
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

export interface Credit {
  name: string; url?: string; publisher?: { name: string; url: string }; licence?: string; licence_url?: string;
  /** Wording a source requires to be shown with its data. */
  notice?: string;
}

export interface NearestItem { distance_km: number; lat: number; lng: number; properties: Props; decoded?: Props }

/** found: something answered. none_within_radius: the layer covers the area but
 *  nothing is within radius_km. not_covered: the layer does not reach this point. */
export type ProfileStatus = 'found' | 'none_within_radius' | 'not_covered';

export interface ProfileEntry {
  layer_id: string;
  match: 'contains' | 'nearest' | 'pixel';
  status: ProfileStatus;
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
  /** How distance_km is measured: to the feature point, or to the nearest part of its line or outline. */
  distance_to?: 'point' | 'shape';
  count?: number;
  count_capped?: true;
  nearest?: NearestItem[];
  stats?: Record<string, number | null>;
  links?: Record<string, string>;
  /** pixel: the raster's values at the point (field names carry units) */
  values?: Props | null;
  resolution_m?: number;
  /** pixel (SoilGrids) */
  depths?: Record<string, Record<string, number | null>> | null;
  wrb_class?: string | null;
  reason?: string;
}

export interface ProfileResponse {
  point: { lat: number; lng: number };
  summary: string;
  disclaimer: string;
  sections: Record<string, Record<string, ProfileEntry>>;
  /** With open_only: the non-commercial layers left out. */
  omitted_non_commercial?: string[];
  unavailable: Array<{ layer_id: string; reason: string }>;
  attribution: string[];
  timing_ms: number;
  layer_timing_ms: Record<string, number>;
}

/** What a pixel source answers: values, or why there are none. */
export type PixelResult =
  | { status: 'ok'; data: Props }
  | { status: 'none'; reason: string }
  | { status: 'unavailable'; reason: string };

export interface ProfileDeps {
  locate: typeof locateEngine;
  nearby: typeof nearbyEngine;
  nearbyByGeometry: typeof nearbyByGeometry;
  nearbyFromTiles: typeof nearbyFromTiles;
  /** Pixel sources by id (each profile supplies its own; tests replace them). */
  pixels: Record<string, (r2: R2Bucket, lat: number, lng: number) => Promise<PixelResult>>;
}

/** A raster read at the point: its answer becomes one entry. */
export interface PixelSource {
  id: string;
  section: string;
  entry: (res: Exclude<PixelResult, { status: 'unavailable' }>) => Omit<ProfileEntry, 'layer_id' | 'match'>;
  say?: (e: ProfileEntry) => string | null;
  credit: string;
}

/** What a profile reads: the layer table, its sections in order, pixel sources, and its words. */
export interface ProfileSpec {
  layers: ProfileLayer[];
  sections: readonly string[];
  pixels: PixelSource[];
  disclaimer: string;
  nothing: string;
  /** More rows for this point (e.g. the city ward layer covering it). */
  expand?: (lat: number, lng: number, catalog: CatalogData) => ProfileLayer[];
  /** Summary lines that need several entries (e.g. the nearest hospital across three layers). */
  conclude?: (sections: ProfileResponse['sections']) => string[];
}

/** An entry's vintage where its source gives no date: the answer then dates it by fetched_at, never by silence. */
export const UNDATED = 'not dated by the source (see fetched_at, when bharatlas fetched it)';

export const BASE_DEPS:Omit<ProfileDeps, 'pixels'> = { locate: locateEngine, nearby: nearbyEngine, nearbyByGeometry, nearbyFromTiles };
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

const TOOK_LONGER = 'took longer than';
const COULD_NOT_READ = 'could not be read';

/** True when an answer missed a layer only by chance (a timeout or a failed read), so it is
 *  not worth keeping; a layer that is not published yet is a lasting part of the answer. */
export function partialByChance(r: Pick<ProfileResponse, 'unavailable'>): boolean {
  return r.unavailable.some((u) => u.reason === COULD_NOT_READ || u.reason.startsWith(TOOK_LONGER));
}

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new OutOfTime()), ms); })])
    .finally(() => clearTimeout(timer));
}

type LayerAnswer = Omit<ProfileEntry, 'credit' | 'layer_id'>;

async function readContains(spec: ProfileLayer, lat: number, lng: number, catalog: CatalogData, r2: R2Bucket, deps: ProfileDeps): Promise<LayerAnswer> {
  const r: LocateResponse = await deps.locate(lat, lng, [spec.id], ZOOM, catalog, r2);
  if (r.failed_layers?.includes(spec.id)) throw new Error('tiles could not be read');
  const features = dedupeFeatures(Object.values(r.results).flat()
    .filter((h) => h.layer_id === spec.id).map((h) => pick(h.feature.properties, spec.fields)));
  const none = spec.allIndia ? { status: 'none_within_radius' as const, radius_km: 0 } : { status: 'not_covered' as const };
  return {
    match: 'contains', ...(features.length ? { status: 'found' as const } : none), features,
    ...(spec.decode && features[0] ? { decoded: spec.decode(features[0]) } : {}),
  };
}

/** The columns a nearest entry uses (its fields and its median's), or undefined for all
 *  (no field list, or a decoder that reads columns it does not show). Decoding only these
 *  keeps a wide layer cheap (Soil Health Cards: 15 of 50 columns of a 122,880-row group). */
function columnsOf(spec: ProfileLayer): string[] | undefined {
  if (!spec.fields || spec.decode) return undefined;
  const m = spec.median;
  return [...new Set([...spec.fields, ...(m ? [m.field, ...(m.perPoint ?? [])] : [])])];
}

async function readNearest(spec: ProfileLayer, lat: number, lng: number, catalog: CatalogData, r2: R2Bucket, deps: ProfileDeps): Promise<LayerAnswer> {
  const radiusKm = spec.radiusKm!;
  const show = spec.show ?? 3;
  let items: Array<NearestItem & { raw: Props }>;
  let count: number, capped: boolean;
  if (spec.shape) {
    const read = spec.shapeFrom === 'parquet' ? deps.nearbyByGeometry : deps.nearbyFromTiles;
    const g = await read(lat, lng, radiusKm, spec.id, catalog, r2, {
      limit: Math.max(show, spec.candidates ?? show), ...(spec.edge ? { edge: true } : {}), ...(spec.keep ? { keep: spec.keep } : {}),
    });
    items = g.features.map((f) => ({ distance_km: f.distance_km, lat: f.lat, lng: f.lng, properties: f.properties, raw: f.properties }));
    count = g.total;
    capped = g.capped;
  } else {
    const n = await deps.nearby(lat, lng, radiusKm, spec.id, catalog, r2, spec.candidates ?? show, columnsOf(spec));
    items = n.features.map((f) => ({ distance_km: f._distance_km, lat: f._lat, lng: f._lng, properties: f.properties, raw: f.properties }));
    count = n.total;
    capped = n.total > n.features.length && !!spec.median; // a median over fewer than all
  }
  let status: ProfileStatus = count ? 'found' : 'none_within_radius';
  // Only when nothing is near: is the layer anywhere around? (Outside its row groups' bounds this reads only the footer.)
  if (!count && spec.coverageKm && !(await deps.nearby(lat, lng, spec.coverageKm, spec.id, catalog, r2, 1, [])).total) status = 'not_covered';
  const nearest: NearestItem[] = items.slice(0, show).map(({ raw, ...it }) => ({
    ...it, properties: pick(raw, spec.fields), ...(spec.decode ? { decoded: spec.decode(raw) } : {}),
  }));
  const stats = spec.median ? medianStats(items.map((i) => i.raw), spec.median) : undefined;
  return {
    match: 'nearest', status, radius_km: radiusKm, distance_to: spec.shape ? 'shape' : 'point', count,
    ...(capped ? { count_capped: true as const } : {}), nearest,
    ...(stats ? { stats } : {}),
  };
}

export type ProfileOpts = { budgetMs?: number; waitUntil?: (p: Promise<unknown>) => void; openOnly?: boolean };

/** A profile at lat/lng: every layer and pixel source read in parallel, each under its own budget. */
export async function profileAt(
  profile: ProfileSpec, lat: number, lng: number, catalog: CatalogData, r2: R2Bucket,
  deps: ProfileDeps, opts: ProfileOpts = {},
): Promise<ProfileResponse> {
  const start = Date.now();
  const budget = opts.budgetMs ?? LAYER_BUDGET_MS;
  const byId = new Map(catalog.layers.map((l) => [l.id, l]));
  const layers = [...profile.layers, ...(profile.expand?.(lat, lng, catalog) ?? [])];
  const keyOf = (l: ProfileLayer) => l.key ?? l.id;
  const sections: ProfileResponse['sections'] = Object.fromEntries(profile.sections.map((s) => [s, {}]));
  const unavailable: ProfileResponse['unavailable'] = [];
  const timing: Record<string, number> = {};
  const said: Array<[number, string]> = [];
  const creditOfKey = new Map<string, string>();
  const omitted: string[] = [];

  const timed = async <T>(id: string, p: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    const work = p();
    try {
      return await within(work, budget);
    } catch (e) {
      // A layer past its budget keeps running: hold the request open until it settles, so
      // promises it leaves in the isolate's caches settle in the request that made them.
      if (e instanceof OutOfTime) opts.waitUntil?.(work.catch(() => {}));
      throw e;
    } finally { timing[id] = Date.now() - t0; }
  };
  const failed = (id: string, e: unknown) => {
    if (!(e instanceof OutOfTime)) console.error(`profile: ${id} failed:`, (e as Error)?.message ?? e);
    unavailable.push({ layer_id: id, reason: e instanceof OutOfTime ? `${TOOK_LONGER} ${budget} ms` : COULD_NOT_READ });
  };

  const layerJobs = layers.map(async (spec, order) => {
    const key = keyOf(spec);
    const layer = byId.get(spec.id);
    if (!layer) { unavailable.push({ layer_id: key, reason: 'not published' }); return; }
    if (opts.openOnly && ncFields(layer).non_commercial) { omitted.push(key); return; }
    try {
      const read = spec.match === 'contains' ? readContains : readNearest;
      const got = await timed(key, () => read(spec, lat, lng, catalog, r2, deps));
      const entry: ProfileEntry = {
        layer_id: spec.id, credit: creditOf(layer), ...ncFields(layer),
        about: { vintage: UNDATED, ...spec.about, ...(layer.fetched_at ? { fetched_at: layer.fetched_at.slice(0, 10) } : {}) },
        ...got, ...(spec.units && got.status === 'found' ? { units: spec.units } : {}),
      };
      const links = spec.links?.(layer);
      if (links && Object.keys(links).length) entry.links = links;
      sections[spec.section][key] = entry;
      const line = spec.say?.(entry);
      if (line) said.push([order, line]);
      if (entry.status === 'found') creditOfKey.set(key, `${entry.credit.name} (${layer.licence ?? 'see source'})`);
    } catch (e) {
      failed(key, e);
    }
  });
  // A pixel source speaks just before the first layer of its section, the sources in table order.
  const pixelJobs = profile.pixels.map(async (px, i) => {
    try {
      const read = deps.pixels[px.id];
      if (!read) { unavailable.push({ layer_id: px.id, reason: 'not published' }); return; }
      const got = await timed(px.id, () => read(r2, lat, lng));
      if (got.status === 'unavailable') { unavailable.push({ layer_id: px.id, reason: got.reason }); return; }
      const entry: ProfileEntry = { layer_id: px.id, match: 'pixel', ...px.entry(got) };
      sections[px.section][px.id] = entry;
      const line = px.say?.(entry);
      if (line) said.push([layers.findIndex((l) => l.section === px.section) - 1 + (i + 1) / (profile.pixels.length + 1), line]);
      if (entry.status === 'found') creditOfKey.set(px.id, px.credit);
    } catch (e) {
      failed(px.id, e);
    }
  });
  await Promise.all([...layerJobs, ...pixelJobs]);

  // Answers arrive in any order: lay each section out in the table's order (pixel sources first).
  const pixelAt = new Map(profile.pixels.map((p, i) => [p.id, i - profile.pixels.length]));
  const order = (id: string) => pixelAt.get(id) ?? layers.findIndex((l) => keyOf(l) === id);
  for (const s of profile.sections) {
    sections[s] = Object.fromEntries(Object.entries(sections[s]).sort(([a], [b]) => order(a) - order(b)));
  }
  unavailable.sort((a, b) => order(a.layer_id) - order(b.layer_id));
  said.sort((a, b) => a[0] - b[0]);
  // Credits follow the sections too, so the list is the same however the reads finish.
  const credits = new Set(profile.sections.flatMap((s) => Object.keys(sections[s]))
    .flatMap((k) => creditOfKey.get(k) ?? []));
  const lines = [...said.map(([, s]) => s), ...(profile.conclude?.(sections) ?? [])];

  return {
    point: { lat, lng },
    summary: lines.length ? lines.join('. ') + '.' : profile.nothing,
    disclaimer: profile.disclaimer,
    sections,
    ...(opts.openOnly ? { omitted_non_commercial: layers.map(keyOf).filter((id) => omitted.includes(id)) } : {}),
    unavailable,
    attribution: [...credits],
    timing_ms: Date.now() - start,
    layer_timing_ms: timing,
  };
}
