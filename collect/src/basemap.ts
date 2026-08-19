import type { StyleSpecification } from 'maplibre-gl';

// Basemap options an author can choose per collection. Raster styles, no API key.
export type BasemapId = 'positron' | 'satellite' | 'topo';

export const BASEMAPS: { id: BasemapId; name: string }[] = [
  { id: 'positron', name: 'Light' },
  { id: 'satellite', name: 'Satellite' },
  { id: 'topo', name: 'Topographic' },
];

function raster(id: string, tiles: string[], attribution: string, maxzoom?: number): StyleSpecification {
  const source: Record<string, unknown> = { type: 'raster', tiles, tileSize: 256, attribution };
  if (maxzoom) source.maxzoom = maxzoom;
  return { version: 8, sources: { [id]: source }, layers: [{ id, type: 'raster', source: id }] } as StyleSpecification;
}

const STYLES: Record<BasemapId, StyleSpecification> = {
  positron: raster(
    'basemap',
    ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png`),
    '© CARTO · © OpenStreetMap contributors',
  ),
  satellite: raster(
    'basemap',
    ['https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    '© Esri, Maxar, Earthstar Geographics',
    19,
  ),
  topo: raster(
    'basemap',
    ['a', 'b', 'c'].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
    '© OpenTopoMap (CC-BY-SA) · © OpenStreetMap contributors',
    17,
  ),
};

export function styleFor(id?: string | null): StyleSpecification {
  return STYLES[(id as BasemapId)] ?? STYLES.positron;
}

// Back-compat default (positron).
export const BASEMAP = STYLES.positron;
export const INDIA_CENTER: [number, number] = [78.9, 22];
