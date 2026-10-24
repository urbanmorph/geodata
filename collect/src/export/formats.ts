// Client-side exporters for a collection's records: GeoJSON, CSV, KML.
// Input is the /records FeatureCollection features (properties carry the author
// fields plus _status / _contributor / _admin_ctx). Output is a plain string the
// UI turns into a Blob download — no server round-trip, no new dependency.

import { representativeCoord } from '../geo/admin-ctx';
import { ringArea } from '../geo/measure';

export interface ExportFeature {
  geometry: { type?: string; coordinates?: unknown } | null;
  properties: Record<string, unknown>;
}

/** When the point was added: the phone's capture time, else when it was saved. */
const addedAt = (p: Record<string, unknown>): string => String(p._captured_at ?? p._created_at ?? '');

/** A field's value as downloaded: a Photo answer is its links, not its ids. */
function answer(p: Record<string, unknown>, k: string): unknown {
  const photos = (p._photos as Array<{ field: string; url: string }> | undefined)?.filter((x) => x.field === k);
  return photos?.length ? photos.map((x) => x.url) : p[k];
}

/** Columns collect adds: notes a person accepted from the photo, and an area's size. */
function derived(f: ExportFeature): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const n = f.properties._ai as { status?: string; review?: string; description?: string; tags?: string[]; model?: string } | null | undefined;
  // The owner's copy has every note (accepted only counts); others only get accepted ones.
  if (n && (n.review === 'accepted' || n.status === undefined)) {
    out.photo_description = n.description ?? '';
    out.photo_tags = (n.tags ?? []).join(' | ');
    out.photo_notes_model = n.model ?? '';
  }
  if (f.geometry?.type === 'Polygon') out.area_sq_m = Math.round(ringArea((f.geometry.coordinates as [number, number][][])[0]));
  return out;
}

// Author fields + contributor/status/added_at + flattened admin context; drop _internal keys.
function tidyProps(f: ExportFeature, fieldKeys: string[]): Record<string, unknown> {
  const p = f.properties;
  const out: Record<string, unknown> = {};
  for (const k of fieldKeys) { const v = answer(p, k); if (v != null) out[k] = v; }
  for (const [k, v] of Object.entries(derived(f))) if (!(k in out)) out[k] = v;
  if (p._contributor) out.contributor = p._contributor;
  if (p._source) out.source = p._source;
  if (p._status) out.status = p._status;
  const added = addedAt(p);
  if (added && !('added_at' in out)) out.added_at = added;
  const ctx = p._admin_ctx as Record<string, string> | null | undefined;
  if (ctx) for (const [k, v] of Object.entries(ctx)) if (!(k in out)) out[k] = v;
  return out;
}

export function toGeoJSON(features: ExportFeature[], fieldKeys: string[]): string {
  const fc = {
    type: 'FeatureCollection',
    features: features.map((f) => ({ type: 'Feature', geometry: f.geometry, properties: tidyProps(f, fieldKeys) })),
  };
  return JSON.stringify(fc, null, 2);
}

const DERIVED = ['photo_description', 'photo_tags', 'photo_notes_model', 'area_sq_m'];

function csvCell(v: unknown): string {
  if (v == null) return '';
  const s = Array.isArray(v) ? v.join('|') : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(features: ExportFeature[], fieldKeys: string[]): string {
  const extras = DERIVED.filter((k) => !fieldKeys.includes(k) && features.some((f) => k in derived(f)));
  const cols = ['lng', 'lat', 'geometry_type', ...fieldKeys, ...extras, 'contributor', 'source', 'status', 'added_at', 'state', 'district'];
  const lines = [cols.map(csvCell).join(',')];
  for (const f of features) {
    const p = f.properties || {};
    const d = derived(f);
    const c = representativeCoord(f.geometry);
    const ctx = (p._admin_ctx as Record<string, string>) || {};
    const row = [
      c ? c[0] : '', c ? c[1] : '', f.geometry?.type ?? '',
      ...fieldKeys.map((k) => answer(p, k)), ...extras.map((k) => d[k]),
      p._contributor ?? '', p._source ?? '', p._status ?? '', addedAt(p), ctx.state ?? '', ctx.district ?? '',
    ];
    lines.push(row.map(csvCell).join(','));
  }
  return lines.join('\n');
}

function xml(v: unknown): string {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function coordStr(c: number[]): string { return `${c[0]},${c[1]}`; }
function ringStr(ring: number[][]): string { return ring.map(coordStr).join(' '); }
function geomKml(g: ExportFeature['geometry']): string {
  const geom = g as { type?: string; coordinates?: number[] & number[][] & number[][][] };
  if (!geom?.type) return '';
  if (geom.type === 'Point') return `<Point><coordinates>${coordStr(geom.coordinates as number[])}</coordinates></Point>`;
  if (geom.type === 'LineString') return `<LineString><coordinates>${ringStr(geom.coordinates as number[][])}</coordinates></LineString>`;
  if (geom.type === 'Polygon') {
    return `<Polygon><outerBoundaryIs><LinearRing><coordinates>${ringStr((geom.coordinates as number[][][])[0])}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
  }
  return '';
}

export function toKML(features: ExportFeature[], fieldKeys: string[], name: string): string {
  const marks = features.map((f) => {
    const p = f.properties || {};
    const title = (typeof p.name === 'string' && p.name)
      || fieldKeys.map((k) => p[k]).find((v) => typeof v === 'string' && v) || 'point';
    const tidy = tidyProps(f, fieldKeys);
    const data = Object.entries(tidy)
      .map(([k, v]) => `<Data name="${xml(k)}"><value>${xml(Array.isArray(v) ? v.join('|') : v)}</value></Data>`)
      .join('');
    return `<Placemark><name>${xml(title)}</name><ExtendedData>${data}</ExtendedData>${geomKml(f.geometry)}</Placemark>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${xml(name)}</name>${marks}</Document></kml>`;
}
