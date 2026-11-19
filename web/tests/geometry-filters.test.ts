import { describe, it, expect } from 'vitest';
import { featureFilter, type FilterSpecification } from '@maplibre/maplibre-gl-style-spec';
import { DATA_BASE_FILTERS, POLYGON_GEOM_FILTER, OVERVIEW_MARKER } from '../src/map-paint';
import { combineFilters } from '../../shared/choropleth.mjs';

// A MapLibre fill layer closes and fills any LineString it is given, so a
// railway's two parallel tracks drew as a green band between them. Fills draw
// polygons only; lines keep stroking both lines and polygon edges; circles
// draw points only.

// Vector-tile geometry types: 1 point, 2 line, 3 polygon.
const feature = (type: 1 | 2 | 3, properties: Record<string, unknown> = {}) => ({ type, properties }) as never;
const draws = (filter: FilterSpecification | null | undefined, type: 1 | 2 | 3, props = {}) =>
  !filter || featureFilter(filter).filter({ zoom: 10 }, feature(type, props));

const filters = DATA_BASE_FILTERS as Record<string, FilterSpecification | undefined>;

describe('each data layer draws only the geometry it is meant for', () => {
  it('fill draws polygons, never lines or points', () => {
    expect(draws(filters.fill, 3)).toBe(true);
    expect(draws(filters.fill, 2)).toBe(false);
    expect(draws(filters.fill, 1)).toBe(false);
  });

  it('fill still draws overview polygons (their edges are what the outline layers skip)', () => {
    expect(draws(filters.fill, 3, { [OVERVIEW_MARKER]: 1 })).toBe(true);
  });

  it('line and halo stroke lines and polygon edges', () => {
    for (const id of ['line', 'line-halo']) {
      expect(draws(filters[id], 2), id).toBe(true);
      expect(draws(filters[id], 3), id).toBe(true);
    }
  });

  it('the invisible line hit area (lines lost their fill, which was their click target) covers lines only', () => {
    expect(draws(filters['line-hit'], 2)).toBe(true);
    expect(draws(filters['line-hit'], 3)).toBe(false);
    expect(draws(filters['line-hit'], 1)).toBe(false);
    expect(draws(filters['line-hit'], 2, { [OVERVIEW_MARKER]: 1 })).toBe(true);
  });

  it('points draw points only', () => {
    expect(draws(filters.point, 1)).toBe(true);
    expect(draws(filters.point, 2)).toBe(false);
    expect(draws(filters.point, 3)).toBe(false);
  });

  it("a reader's filter keeps the fill to polygons", () => {
    const user: FilterSpecification = ['==', ['get', 'kind'], 'rail'];
    const f = combineFilters(filters.fill, user) as FilterSpecification;
    expect(draws(f, 3, { kind: 'rail' })).toBe(true);
    expect(draws(f, 2, { kind: 'rail' })).toBe(false);
  });

  it('the polygon filter is a valid filter on its own (locate highlight and no-data hatch reuse it)', () => {
    expect(draws(POLYGON_GEOM_FILTER, 3)).toBe(true);
    expect(draws(POLYGON_GEOM_FILTER, 2)).toBe(false);
  });
});
