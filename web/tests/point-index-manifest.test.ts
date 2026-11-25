// The deployment's point index manifest (scripts/bake_point_index.py writes it): well formed,
// no share-alike layer merged, every layer one the catalog has. A layer rebaked since the bake
// is not an error (lib/point-index.ts reads it from its own tiles until the bake runs again);
// it is listed here so the bake can be re-run.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { POINT_INDEX, indexEntry } from '../functions/lib/point-index';
import type { CatalogLayer } from '../functions/lib/catalog-api';

const catalog = JSON.parse(readFileSync(new URL('../../catalog.json', import.meta.url), 'utf8')) as { layers: CatalogLayer[] };
const byId = new Map(catalog.layers.map((l) => [l.id, l]));
const SHARE_ALIKE = /odbl|share-?alike|(^|[^a-z])sa([^a-z]|$)/i; // scripts/bake_point_index.py share_alike

describe('the point index manifest', () => {
  const layers = Object.entries(POINT_INDEX.layers);

  it('is at zoom 12, its archives and field files on the data domain', () => {
    expect(POINT_INDEX.zoom).toBe(12);
    for (const a of Object.values(POINT_INDEX.archives)) expect(a.url).toMatch(/^https:\/\/data\.bharatlas\.com\/point-index\/[a-z]+\.[0-9a-f]{8}\.pmtiles$/);
    for (const [, e] of layers) {
      expect(POINT_INDEX.archives[e.archive]).toBeDefined();
      if (e.props) expect(e.props.url).toMatch(/^https:\/\/data\.bharatlas\.com\/point-index\/props\/[a-z0-9_]+\.[0-9a-f]{8}\.json$/);
    }
  });

  it('merges no share-alike layer (ODbL, CC-BY-SA)', () => {
    expect(layers.filter(([id]) => SHARE_ALIKE.test(byId.get(id)?.licence ?? ''))).toEqual([]);
  });

  it('names only layers the catalog has', () => {
    expect(layers.filter(([id]) => !byId.has(id)).map(([id]) => id)).toEqual([]);
  });

  it('an archive with ids only gives every layer its field file', () => {
    const idsOnly = new Set(layers.filter(([, e]) => e.props).map(([, e]) => e.archive));
    expect(layers.filter(([, e]) => idsOnly.has(e.archive) && !e.props).map(([id]) => id)).toEqual([]);
  });

  // Not a failure: such a layer is answered from its own tiles, as before the index.
  const stale = layers.filter(([id]) => byId.has(id) && !indexEntry(POINT_INDEX, byId.get(id)!, 14)).map(([id]) => id);
  if (stale.length) console.warn(`point index: rebaked since the bake, re-run scripts/bake_point_index.py: ${stale.join(', ')}`);
});
