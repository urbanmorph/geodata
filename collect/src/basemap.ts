import type { StyleSpecification } from 'maplibre-gl';

// CARTO Positron raster (same source web's positron basemap uses) — no API key.
export const BASEMAP: StyleSpecification = {
  version: 8,
  sources: {
    carto: {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      attribution: '© CARTO · © OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'carto', type: 'raster', source: 'carto' }],
};

export const INDIA_CENTER: [number, number] = [78.9, 22];
