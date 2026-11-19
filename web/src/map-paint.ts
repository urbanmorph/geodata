// How data is drawn on every map (the layer map and the contribute preview):
// India-green land, chakra-navy edges and points, saffron for a selection.
import type { ExpressionSpecification, FilterSpecification } from 'maplibre-gl';
import { PALETTE } from '../../shared/brand.mjs';

export const DATA_FILL = PALETTE.green;
export const DATA_FILL_OPACITY = 0.18;
export const DATA_LINE = PALETTE.navy;
export const DATA_POINT = PALETTE.navy;
export const DATA_SELECTED = PALETTE.saffron;

// Dense polygon layers tile z0-z8 as a dissolved overview cut into 1-degree
// cells, each feature marked with this property (scripts/bake_land_water.py).
// Stroking them would draw the cell seams as a grid over India.
export const OVERVIEW_MARKER = '_ov';
const NOT_OVERVIEW: FilterSpecification = ['!', ['has', OVERVIEW_MARKER]];

// MapLibre 4 reports Multi* features by their single type; MapLibre 5 names
// them, so both spellings are listed.
const geometryIs = (...types: string[]): FilterSpecification =>
  ['in', ['geometry-type'], ['literal', types.flatMap((t) => [t, `Multi${t}`])]];

/** Polygons only: a fill layer would close and fill a LineString (a railway's
 * two tracks drew as a green band between them). */
export const POLYGON_GEOM_FILTER = geometryIs('Polygon');

/** Each data layer's own filter, under any filter the reader adds:
 * fills draw polygons only, points draw points only; edges (lines and polygon
 * outlines) skip the overview's cell pieces. */
export const DATA_BASE_FILTERS = {
  fill: POLYGON_GEOM_FILTER,
  // An invisible wide stroke under line features: their click and hover
  // target now that the fill no longer covers them.
  'line-hit': geometryIs('LineString'),
  point: geometryIs('Point'),
  line: NOT_OVERVIEW,
  'line-halo': NOT_OVERVIEW,
} satisfies Record<string, FilterSpecification>;

/** A fill's antialiased edge, drawn in its own colour: none on overview
 * features, where two cell pieces meeting on a line drew it twice (a darker
 * grid even with the outline layers filtered). */
export function fillOutlineColor(fill: string | ExpressionSpecification): ExpressionSpecification {
  return ['case', ['has', OVERVIEW_MARKER], 'rgba(0, 0, 0, 0)', fill];
}
