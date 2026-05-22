// Basemap registry for the map viewer.
// All entries are free + no API key. Carto basemaps allowed for low-traffic
// open-source projects; attribution required (handled by MapLibre via the
// source's `attribution` field).

import type { RasterSourceSpecification } from 'maplibre-gl';

export type BasemapId = 'osm' | 'positron' | 'voyager';

export type Basemap = {
  id: BasemapId;
  name: string;
  hint: string;
  source: RasterSourceSpecification;
};

const CARTO_ATTRIB =
  '© <a href="https://carto.com/attribution/">CARTO</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

export const BASEMAPS: Basemap[] = [
  {
    id: 'osm',
    name: 'OpenStreetMap',
    hint: 'standard · most detail',
    source: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
  },
  {
    id: 'positron',
    name: 'Carto Light',
    hint: 'minimal · best for polygon contrast',
    source: {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        'https://d.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      attribution: CARTO_ATTRIB,
    },
  },
  {
    id: 'voyager',
    name: 'Carto Voyager',
    hint: 'light · subtle colour',
    source: {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
        'https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
        'https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
        'https://d.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      attribution: CARTO_ATTRIB,
    },
  },
];

export const DEFAULT_BASEMAP: BasemapId = 'positron';

const STORAGE_KEY = 'bharatlas:basemap';

export function getStoredBasemap(storage: Storage = globalThis.localStorage): BasemapId {
  try {
    const v = storage.getItem(STORAGE_KEY);
    if (v && BASEMAPS.some((b) => b.id === v)) return v as BasemapId;
  } catch {
    // localStorage may be unavailable (private mode, SSR) — fall through.
  }
  return DEFAULT_BASEMAP;
}

export function setStoredBasemap(id: BasemapId, storage: Storage = globalThis.localStorage): void {
  try {
    storage.setItem(STORAGE_KEY, id);
  } catch {
    // Best-effort: a failure to persist shouldn't break the swap.
  }
}

export function getBasemap(id: BasemapId): Basemap {
  return BASEMAPS.find((b) => b.id === id) || BASEMAPS[0];
}
