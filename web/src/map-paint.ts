// How data is drawn on every map (the layer map and the contribute preview):
// India-green land, chakra-navy edges and points, saffron for a selection.
import type { FilterSpecification } from 'maplibre-gl';
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

/** Each data layer's own filter, under any filter the reader adds:
 * points draw points only; edges skip the overview's cell pieces. */
export const DATA_BASE_FILTERS = {
  point: ['==', ['geometry-type'], 'Point'],
  line: NOT_OVERVIEW,
  'line-halo': NOT_OVERVIEW,
} satisfies Record<string, FilterSpecification>;
