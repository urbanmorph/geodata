// GeoJSON features -> KML, one placemark at a time (no dependency). Shared by
// the browser's filtered export (web/src/db.ts) and the API's streamed export
// (web/functions/lib/parquet-export.ts). Keep in sync with
// scripts/bake_extracts.py KML section.

// Try most-specific first (village name) so a feature's KML <name> matches
// the level you're looking at, not its parent.
const NAME_KEYS = [
  'vilname11', 'vilnam_soi', 'vname',     // village
  'blkname11', 'blkname', 'block_name',   // block
  'sdtname', 'subdt_name',                // sub-district
  'dtname',                                // district
  'stname', 'STNAME',                     // state
  'wardname', 'ward_name', 'WARD_NAME',   // city ward
  'NAME', 'name',                          // generic fallback
];

/** Text for a KML element or attribute. */
export function escXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const coordPair = (c) => `${c[0]},${c[1]}`;
const ring = (r) => `<LinearRing><coordinates>${r.map(coordPair).join(' ')}</coordinates></LinearRing>`;
const line = (l) => `<LineString><coordinates>${l.map(coordPair).join(' ')}</coordinates></LineString>`;

function polygon(p) {
  const [outer, ...inners] = p;
  return `<Polygon><outerBoundaryIs>${ring(outer)}</outerBoundaryIs>${inners
    .map((i) => `<innerBoundaryIs>${ring(i)}</innerBoundaryIs>`)
    .join('')}</Polygon>`;
}

export function geometryToKML(g) {
  if (!g || typeof g !== 'object' || !('type' in g)) return '';
  switch (g.type) {
    case 'Point': return `<Point><coordinates>${coordPair(g.coordinates)}</coordinates></Point>`;
    case 'LineString': return line(g.coordinates);
    case 'Polygon': return polygon(g.coordinates);
    case 'MultiPolygon': return `<MultiGeometry>${g.coordinates.map(polygon).join('')}</MultiGeometry>`;
    case 'MultiLineString': return `<MultiGeometry>${g.coordinates.map(line).join('')}</MultiGeometry>`;
    case 'GeometryCollection': return `<MultiGeometry>${g.geometries.map(geometryToKML).join('')}</MultiGeometry>`;
    default: return '';
  }
}

export function kmlHead(layerName) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document><name>${escXml(layerName)}</name>`;
}

export const KML_TAIL = `</Document>
</kml>`;

/** A placemark up to its geometry: name and attributes (the API's export
 *  writes the geometry after it in pieces, then </Placemark>). */
export function kmlPlacemarkHead(properties) {
  const props = properties || {};
  const name = NAME_KEYS.map((k) => props[k]).find((v) => v != null) ?? '';
  const extData = Object.entries(props)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `<Data name="${escXml(k)}"><value>${escXml(typeof v === 'object' ? JSON.stringify(v) : String(v))}</value></Data>`)
    .join('');
  return `<Placemark><name>${escXml(String(name))}</name><ExtendedData>${extData}</ExtendedData>`;
}

export function kmlPlacemark(f) {
  return `${kmlPlacemarkHead(f.properties)}${geometryToKML(f.geometry)}</Placemark>`;
}

export function featuresToKML(feats, layerName) {
  return kmlHead(layerName) + feats.map(kmlPlacemark).join('') + KML_TAIL;
}
