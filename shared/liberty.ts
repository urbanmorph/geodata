// The streets basemap shared by bharatlas's viewer and collect: OpenFreeMap
// "Liberty" (OpenStreetMap roads, buildings, landmarks and place names), trimmed
// for India. The upstream style draws the international borders and names the
// countries, states and provinces around them, including Pakistan's provinces
// inside India's claim. Those layers are removed here, so the LGD India outline
// each app draws on top is the only border. No key, no account; tiles, sprite and
// fonts come from tiles.openfreemap.org (allowed in both apps' CSP).
//
// liberty-style.ts is the upstream style vendored unchanged (update-liberty.mjs);
// everything India-specific happens in trimLiberty, below, and is tested in
// web/tests/liberty.test.ts. No imports: this folder sits outside both apps'
// node_modules, so the types here are structural.
import { LIBERTY_STYLE } from './liberty-style';

export type LayerLike = { id: string; type: string; source?: string; 'source-layer'?: string; filter?: unknown } & Record<string, unknown>;
export type SourceLike = { type: string; url?: string; tiles?: string[]; attribution?: string } & Record<string, unknown>;
/** A MapLibre style, as far as this module needs it (upstream carries more: version, name, metadata…). */
export type StyleLike = {
  sources: Record<string, SourceLike>;
  layers: LayerLike[];
  sprite: string;
  glyphs: string;
} & Record<string, unknown>;

/** Place classes that name countries and regions: never drawn (see above). */
const REGION_CLASSES = ['country', 'state', 'province'];
const PREFIX = 'liberty-';

const CREDIT =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> · ' +
  '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> · ' +
  'Data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors · ' +
  'Style: <a href="https://github.com/maputnik/osm-liberty" target="_blank" rel="noopener">OSM Liberty</a> (CC BY 4.0)';
const RELIEF_CREDIT = 'Relief: <a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a>';

const notARegion = ['!', ['in', ['get', 'class'], ['literal', REGION_CLASSES]]];

/** Liberty without its borders and region names, with every id prefixed so it can share one style with other basemaps. */
export function trimLiberty(style: StyleLike): StyleLike {
  const sourceId = (id: string) => PREFIX + id;
  const sources = Object.fromEntries(
    Object.entries(style.sources).map(([id, s]) => [
      sourceId(id),
      { ...s, attribution: s.type === 'vector' ? CREDIT : RELIEF_CREDIT },
    ]),
  );
  const layers = style.layers
    .filter((l) => l['source-layer'] !== 'boundary')
    .map((l) => {
      const out: LayerLike = { ...l, id: PREFIX + l.id };
      if (l.source) out.source = sourceId(l.source);
      if (l['source-layer'] === 'place') out.filter = l.filter ? ['all', l.filter, notARegion] : notARegion;
      return out;
    });
  return { sources, layers, sprite: style.sprite, glyphs: style.glyphs };
}

export const LIBERTY: StyleLike = trimLiberty(LIBERTY_STYLE);
