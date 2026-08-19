// Reference layers (Phase 4/5): let an author attach ONE curated bharatlas layer
// as a read-only overlay to orient contributors (ward boundaries on a footpath
// survey, forest boundaries on a tree census). Rendered as pmtiles via MapLibre —
// the same stack /view uses. A capture aid, never part of a record's geometry.

import maplibregl from 'maplibre-gl';
import { Protocol, PMTiles } from 'pmtiles';

const ACCENT = '#4f46e5';

let protocol: Protocol | null = null;
function proto(): Protocol {
  if (!protocol) {
    protocol = new Protocol();
    maplibregl.addProtocol('pmtiles', protocol.tile);
  }
  return protocol;
}

/** Add the chosen layer as a low-key overlay. source-layer = first vector layer. */
export async function addReferenceOverlay(map: maplibregl.Map, pmtilesUrl: string): Promise<void> {
  if (map.getSource('ref')) return;
  const p = proto();
  const pm = new PMTiles(pmtilesUrl);
  p.add(pm);
  const meta = (await pm.getMetadata()) as { vector_layers?: Array<{ id: string }> };
  const sourceLayer = meta?.vector_layers?.[0]?.id;
  if (!sourceLayer) return;
  const header = await pm.getHeader();
  map.addSource('ref', { type: 'vector', url: `pmtiles://${pmtilesUrl}`, minzoom: header.minZoom, maxzoom: header.maxZoom });
  map.addLayer({ id: 'ref-fill', type: 'fill', source: 'ref', 'source-layer': sourceLayer, filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': ACCENT, 'fill-opacity': 0.07 } });
  map.addLayer({ id: 'ref-line', type: 'line', source: 'ref', 'source-layer': sourceLayer, paint: { 'line-color': ACCENT, 'line-width': 1.2, 'line-opacity': 0.5 } });
  map.addLayer({ id: 'ref-pt', type: 'circle', source: 'ref', 'source-layer': sourceLayer, filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 3, 'circle-color': ACCENT, 'circle-opacity': 0.55 } });
}

export function setReferenceVisible(map: maplibregl.Map, on: boolean): void {
  for (const id of ['ref-fill', 'ref-line', 'ref-pt']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }
}
