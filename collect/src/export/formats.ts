// Client-side exporters for a collection's records: GeoJSON, CSV, KML.
// Input is the /records FeatureCollection features (properties carry the author
// fields plus _status / _contributor / _admin_ctx). Output is a plain string the
// UI turns into a Blob download — no server round-trip, no new dependency.

import { representativeCoord } from '../geo/admin-ctx';

export interface ExportFeature {
  geometry: { type?: string; coordinates?: unknown } | null;
  properties: Record<string, unknown>;
}

// Author fields + contributor/status + flattened admin context; drop _internal keys.
function tidyProps(p: Record<string, unknown>, fieldKeys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of fieldKeys) if (p[k] != null) out[k] = p[k];
  if (p._contributor) out.contributor = p._contributor;
  if (p._source) out.source = p._source;
  if (p._status) out.status = p._status;
  const ctx = p._admin_ctx as Record<string, string> | null | undefined;
  if (ctx) for (const [k, v] of Object.entries(ctx)) if (!(k in out)) out[k] = v;
  return out;
}

export function toGeoJSON(features: ExportFeature[], fieldKeys: string[]): string {
  const fc = {
    type: 'FeatureCollection',
    features: features.map((f) => ({ type: 'Feature', geometry: f.geometry, properties: tidyProps(f.properties, fieldKeys) })),
  };
  return JSON.stringify(fc, null, 2);
}

function csvCell(v: unknown): string {
  if (v == null) return '';
  const s = Array.isArray(v) ? v.join('|') : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(features: ExportFeature[], fieldKeys: string[]): string {
  const cols = ['lng', 'lat', 'geometry_type', ...fieldKeys, 'contributor', 'source', 'status', 'state', 'district'];
  const lines = [cols.map(csvCell).join(',')];
  for (const f of features) {
    const p = f.properties || {};
    const c = representativeCoord(f.geometry);
    const ctx = (p._admin_ctx as Record<string, string>) || {};
    const row = [
      c ? c[0] : '', c ? c[1] : '', f.geometry?.type ?? '',
      ...fieldKeys.map((k) => p[k]),
      p._contributor ?? '', p._source ?? '', p._status ?? '', ctx.state ?? '', ctx.district ?? '',
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
    const tidy = tidyProps(p, fieldKeys);
    const data = Object.entries(tidy)
      .map(([k, v]) => `<Data name="${xml(k)}"><value>${xml(Array.isArray(v) ? v.join('|') : v)}</value></Data>`)
      .join('');
    return `<Placemark><name>${xml(title)}</name><ExtendedData>${data}</ExtendedData>${geomKml(f.geometry)}</Placemark>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${xml(name)}</name>${marks}</Document></kml>`;
}
