// Parse an uploaded file into a common shape for the import mapping step.
// GeoJSON + CSV are pure (unit-tested in node); KML uses DOMParser (browser).

export type ImportFormat = 'geojson' | 'csv' | 'kml';

export interface ParsedFeature {
  geometry: unknown | null; // GeoJSON geometry, or null for CSV (built from lng/lat)
  props: Record<string, string>;
}
export interface Parsed { columns: string[]; features: ParsedFeature[]; }

export function detectFormat(filename: string): ImportFormat | null {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'geojson' || ext === 'json') return 'geojson';
  if (ext === 'csv') return 'csv';
  if (ext === 'kml') return 'kml';
  return null;
}

const asStr = (v: unknown): string => (v == null ? '' : Array.isArray(v) ? v.join('|') : String(v));

export function parseGeoJSON(text: string): Parsed {
  const doc = JSON.parse(text) as { type?: string; features?: unknown[]; properties?: unknown; geometry?: unknown };
  const feats = doc.type === 'FeatureCollection' ? (doc.features || []) : doc.type === 'Feature' ? [doc] : [];
  const columns = new Set<string>();
  const features: ParsedFeature[] = (feats as Array<{ geometry?: unknown; properties?: Record<string, unknown> }>).map((f) => {
    const props: Record<string, string> = {};
    for (const [k, v] of Object.entries(f.properties || {})) { columns.add(k); props[k] = asStr(v); }
    return { geometry: f.geometry ?? null, props };
  });
  return { columns: [...columns], features };
}

// Minimal RFC-4180-ish CSV: quoted cells, "" escape, CR/LF tolerant.
export function parseCSVRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const s = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function parseCSV(text: string): Parsed {
  const rows = parseCSVRows(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (!rows.length) return { columns: [], features: [] };
  const header = rows[0].map((h) => h.trim());
  const features: ParsedFeature[] = rows.slice(1).map((r) => {
    const props: Record<string, string> = {};
    header.forEach((h, i) => { props[h] = (r[i] ?? '').trim(); });
    return { geometry: null, props };
  });
  return { columns: header, features };
}

// KML via DOMParser (browser only). Point / LineString / Polygon; ExtendedData
// Data names + <name> become columns.
export function parseKML(text: string): Parsed {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const columns = new Set<string>();
  const features: ParsedFeature[] = [];
  doc.querySelectorAll('Placemark').forEach((pm) => {
    const props: Record<string, string> = {};
    const nm = pm.querySelector(':scope > name')?.textContent?.trim();
    if (nm) { columns.add('name'); props.name = nm; }
    pm.querySelectorAll('ExtendedData > Data').forEach((d) => {
      const k = d.getAttribute('name');
      if (k) { columns.add(k); props[k] = d.querySelector('value')?.textContent?.trim() || ''; }
    });
    features.push({ geometry: kmlGeometry(pm), props });
  });
  return { columns: [...columns], features };
}

function coordsText(t: string | null | undefined): number[][] {
  return (t || '').trim().split(/\s+/).filter(Boolean).map((pair) => pair.split(',').slice(0, 2).map(Number));
}
function kmlGeometry(pm: Element): unknown | null {
  const pt = pm.querySelector('Point > coordinates');
  if (pt) { const c = coordsText(pt.textContent)[0]; return c ? { type: 'Point', coordinates: c } : null; }
  const ls = pm.querySelector('LineString > coordinates');
  if (ls) return { type: 'LineString', coordinates: coordsText(ls.textContent) };
  const pg = pm.querySelector('Polygon outerBoundaryIs > LinearRing > coordinates');
  if (pg) return { type: 'Polygon', coordinates: [coordsText(pg.textContent)] };
  return null;
}

export function parseImport(text: string, format: ImportFormat): Parsed {
  if (format === 'geojson') return parseGeoJSON(text);
  if (format === 'csv') return parseCSV(text);
  return parseKML(text);
}
