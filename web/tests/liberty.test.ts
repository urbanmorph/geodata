import { describe, it, expect } from 'vitest';
import { featureFilter, validateStyleMin, type FilterSpecification, type StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { LIBERTY, trimLiberty } from '../../shared/liberty';
import { LIBERTY_STYLE } from '../../shared/liberty-style';

// The shared streets basemap (OpenFreeMap Liberty, OSM data) used by both
// bharatlas's viewer and collect. Its own borders and country/state names are
// removed so the LGD India outline each app draws is the only border.

type Layer = StyleSpecification['layers'][number] & { 'source-layer'?: string; filter?: FilterSpecification };
const layers = LIBERTY.layers as Layer[];

/** Whether a layer would draw a place feature of this class at this zoom. */
function drawsPlace(layer: Layer, placeClass: string, zoom: number): boolean {
  if (layer['source-layer'] !== 'place') return false;
  if ((layer.minzoom ?? 0) > zoom || (layer.maxzoom ?? 24) <= zoom) return false;
  if (!layer.filter) return true;
  const f = featureFilter(layer.filter);
  return f.filter({ zoom }, { type: 1, properties: { class: placeClass, rank: 1, capital: 0 } } as never);
}

describe('Liberty streets basemap, trimmed for India', () => {
  it('draws no borders of its own: no boundary layer is left', () => {
    expect(layers.filter((l) => l['source-layer'] === 'boundary')).toEqual([]);
  });

  it('names no countries, states or provinces at any zoom (the disputed-area labels)', () => {
    for (const placeClass of ['country', 'state', 'province']) {
      for (let zoom = 0; zoom <= 16; zoom++) {
        expect(layers.filter((l) => drawsPlace(l, placeClass, zoom)).map((l) => l.id), `${placeClass} z${zoom}`).toEqual([]);
      }
    }
  });

  it('keeps what a person marking a point needs: roads, buildings, landmarks, and city to village names', () => {
    const sourceLayers = new Set(layers.map((l) => l['source-layer']));
    for (const s of ['transportation', 'transportation_name', 'building', 'poi', 'water', 'landuse']) expect(sourceLayers).toContain(s);
    for (const [placeClass, zoom] of [['city', 8], ['town', 10], ['village', 13], ['suburb', 14]] as const) {
      expect(layers.some((l) => drawsPlace(l, placeClass, zoom)), placeClass).toBe(true);
    }
  });

  it('prefixes every layer and source, so it can sit beside the other basemaps in one style', () => {
    for (const l of layers) expect(l.id).toMatch(/^liberty-/);
    expect(Object.keys(LIBERTY.sources).every((s) => s.startsWith('liberty-'))).toBe(true);
    for (const l of layers) if ('source' in l) expect(LIBERTY.sources).toHaveProperty(l.source as string);
  });

  it('loads only from OpenFreeMap, credits OpenStreetMap and the OSM Liberty design', () => {
    const urls = [LIBERTY.glyphs, LIBERTY.sprite, ...Object.values(LIBERTY.sources).flatMap((s) => [(s as { url?: string }).url, ...((s as { tiles?: string[] }).tiles ?? [])])];
    for (const u of urls.filter(Boolean)) expect(u).toMatch(/^https:\/\/tiles\.openfreemap\.org\//);
    const credit = Object.values(LIBERTY.sources).map((s) => (s as { attribution?: string }).attribution ?? '').join(' ');
    expect(credit).toContain('OpenStreetMap');
    expect(credit).toContain('OSM Liberty');
    for (const s of Object.values(LIBERTY.sources)) expect((s as { attribution?: string }).attribution).toBeTruthy();
  });

  it('is a valid MapLibre style', () => {
    const style = { version: 8, glyphs: LIBERTY.glyphs, sprite: LIBERTY.sprite, sources: LIBERTY.sources, layers: LIBERTY.layers } as StyleSpecification;
    expect(validateStyleMin(style)).toEqual([]);
  });

  it('trims a fresh copy the same way (the update script vendors the upstream style unchanged)', () => {
    const again = trimLiberty(LIBERTY_STYLE);
    expect(again.layers.map((l) => l.id)).toEqual(LIBERTY.layers.map((l) => l.id));
    // Upstream is vendored as is: the trimming happens here, in one tested place.
    expect(LIBERTY_STYLE.layers.some((l) => l.id === 'boundary_2')).toBe(true);
  });
});
