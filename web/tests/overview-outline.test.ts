import { describe, it, expect } from 'vitest';
import { featureFilter, type FilterSpecification } from '@maplibre/maplibre-gl-style-spec';
import { DATA_BASE_FILTERS, OVERVIEW_MARKER } from '../src/map-paint';
import { popupEntries } from '../src/popup-value';
import { combineFilters } from '../../shared/choropleth.mjs';

// Dense polygon layers (GSI lithology, Bhuvan geomorphology) tile z0-z8 as a
// dissolved overview cut into 1-degree cells (scripts/bake_land_water.py).
// Every overview feature carries `_ov`; stroking those draws the cell seams as
// a grid over India, so the outline layers skip them. Fill stays.

const polygon = (properties: Record<string, unknown>) => ({ type: 3, properties }) as never;
const draws = (filter: FilterSpecification | null | undefined, properties: Record<string, unknown>) =>
  !filter || featureFilter(filter).filter({ zoom: 5 }, polygon(properties));

const overview = { lithologic: 'BASALT', [OVERVIEW_MARKER]: 1 };
const detail = { lithologic: 'BASALT', age: 'Cretaceous' };

describe('overview features are filled but never outlined', () => {
  it('names the marker the bake writes', () => {
    expect(OVERVIEW_MARKER).toBe('_ov');
  });

  it('outline layers skip overview features and stroke detail ones', () => {
    for (const id of ['line', 'line-halo'] as const) {
      expect(draws(DATA_BASE_FILTERS[id], overview), id).toBe(false);
      expect(draws(DATA_BASE_FILTERS[id], detail), id).toBe(true);
    }
  });

  it('fill still draws overview features', () => {
    expect(draws((DATA_BASE_FILTERS as Record<string, FilterSpecification | undefined>).fill, overview)).toBe(true);
  });

  it('a user filter does not bring the outlines back', () => {
    const user: FilterSpecification = ['==', ['get', 'lithologic'], 'BASALT'];
    for (const id of ['line', 'line-halo'] as const) {
      const f = combineFilters(DATA_BASE_FILTERS[id], user) as FilterSpecification;
      expect(draws(f, overview), id).toBe(false);
      expect(draws(f, detail), id).toBe(true);
    }
  });

  it('the popup never lists the marker', () => {
    expect(popupEntries(overview, 10)).toEqual([['lithologic', 'BASALT']]);
  });
});
