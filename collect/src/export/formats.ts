// Client-side exporters for a collection's records: GeoJSON, CSV, KML.
// Input is the /records FeatureCollection features (properties carry the author
// fields plus _status / _contributor / _admin_ctx). Output is a plain string the
// UI turns into a Blob download — no server round-trip, no new dependency.

import { representativeCoord } from '../geo/admin-ctx';
import { noteColumns, areaColumn, addedAt, DERIVED_COLUMNS } from './derived';
import { csvCell } from '../../../shared/csv.mjs';
import { escXml, geometryToKML, kmlHead, KML_TAIL } from '../../../shared/kml.mjs';

export interface ExportFeature {
  geometry: { type?: string; coordinates?: unknown } | null;
  properties: Record<string, unknown>;
}


/** A field's value as downloaded: a Photo answer is its links, not its ids. */
function answer(p: Record<string, unknown>, k: string): unknown {
  const photos = (p._photos as Array<{ field: string; url: string }> | undefined)?.filter((x) => x.field === k);
  return photos?.length ? photos.map((x) => x.url) : p[k];
}

/** Columns collect adds (derived.ts): accepted notes from the photo, an area's size. */
function derived(f: ExportFeature): Record<string, unknown> {
  const n = f.properties._ai as { status?: string; review?: string; description?: string; tags?: string[]; model?: string } | null | undefined;
  // The owner's copy has every note (accepted only counts); others only get accepted ones.
  return { ...noteColumns(n && (n.review === 'accepted' || n.status === undefined) ? n : null), ...areaColumn(f.geometry) };
}
const added = (p: Record<string, unknown>): string => addedAt(p._captured_at, p._created_at);

// Author fields + contributor/status/added_at + flattened admin context; drop _internal keys.
function tidyProps(f: ExportFeature, fieldKeys: string[]): Record<string, unknown> {
  const p = f.properties;
  const out: Record<string, unknown> = {};
  for (const k of fieldKeys) { const v = answer(p, k); if (v != null) out[k] = v; }
  for (const [k, v] of Object.entries(derived(f))) if (!(k in out)) out[k] = v;
  if (p._contributor) out.contributor = p._contributor;
  if (p._source) out.source = p._source;
  if (p._status) out.status = p._status;
  const when = added(p);
  if (when && !('added_at' in out)) out.added_at = when;
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

export function toCSV(features: ExportFeature[], fieldKeys: string[]): string {
  const extras = DERIVED_COLUMNS.filter((k) => !fieldKeys.includes(k) && features.some((f) => k in derived(f)));
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
      p._contributor ?? '', p._source ?? '', p._status ?? '', added(p), ctx.state ?? '', ctx.district ?? '',
    ];
    lines.push(row.map(csvCell).join(','));
  }
  return lines.join('\n');
}

export function toKML(features: ExportFeature[], fieldKeys: string[], name: string): string {
  const text = (v: unknown): string => escXml(String(v ?? ''));
  const marks = features.map((f) => {
    const p = f.properties || {};
    const title = (typeof p.name === 'string' && p.name)
      || fieldKeys.map((k) => p[k]).find((v) => typeof v === 'string' && v) || 'point';
    const data = Object.entries(tidyProps(f, fieldKeys))
      .map(([k, v]) => `<Data name="${text(k)}"><value>${text(Array.isArray(v) ? v.join('|') : v)}</value></Data>`)
      .join('');
    return `<Placemark><name>${text(title)}</name><ExtendedData>${data}</ExtendedData>${geometryToKML(f.geometry)}</Placemark>`;
  }).join('');
  return kmlHead(name) + marks + KML_TAIL;
}
