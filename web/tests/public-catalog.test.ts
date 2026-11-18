import { describe, it, expect } from 'vitest';
import { publicCatalogJson, layerVersions } from '../scripts/public-catalog.mjs';

describe('publicCatalogJson (the /catalog.json the site serves)', () => {
  const catalog = {
    version: 1,
    layers: [
      { id: 'a', notes: 'x', source_check: { method: 'http', url: 'u', fingerprint: 'f', checked_at: 't', changed_at: 'c' },
        refresh: { class: 'slow', check: 'weekly', rebuild: 'on_change', release: 'on_rebuild', audit: 'a',
          audited_at: null, next_due: null } },
      { id: 'b', notes: 'y' },
    ],
  };

  it('drops each layer\'s source_check and refresh (internal bookkeeping) and keeps everything else', () => {
    const out = JSON.parse(publicCatalogJson(catalog));
    expect(out).toEqual({ version: 1, layers: [{ id: 'a', notes: 'x', versions: [] }, { id: 'b', notes: 'y', versions: [] }] });
  });

  it('leaves the catalog it was given untouched', () => {
    publicCatalogJson(catalog);
    expect(catalog.layers[0]).toHaveProperty('source_check');
    expect(catalog.layers[0]).toHaveProperty('refresh');
  });

  it('lists each layer\'s releases as versions, newest first, from the release index', () => {
    const index = { releases: [
      { code: 'bharatlas-a-2026.12', dataset: 'a', released: '2026-12-01', sha256: 's2',
        url: 'https://bharatlas.com/releases/bharatlas-a-2026.12/', w3id_proposed: 'https://w3id.org/bharatlas/a/2026.12' },
      { code: 'bharatlas-cw-2026.11', dataset: 'cw', released: '2026-11-15', sha256: 'c1',
        url: 'https://bharatlas.com/releases/bharatlas-cw-2026.11/', w3id_proposed: 'https://w3id.org/bharatlas/cw/2026.11' },
      { code: 'bharatlas-a-2026.11', dataset: 'a', released: '2026-11-20', sha256: 's1',
        url: 'https://bharatlas.com/releases/bharatlas-a-2026.11/', w3id_proposed: 'https://w3id.org/bharatlas/a/2026.11' },
    ] };
    const out = JSON.parse(publicCatalogJson(catalog, index));
    expect(out.layers[0].versions).toEqual([
      { code: 'bharatlas-a-2026.12', released: '2026-12-01', sha256: 's2',
        w3id: 'https://w3id.org/bharatlas/a/2026.12', url: 'https://bharatlas.com/releases/bharatlas-a-2026.12/' },
      { code: 'bharatlas-a-2026.11', released: '2026-11-20', sha256: 's1',
        w3id: 'https://w3id.org/bharatlas/a/2026.11', url: 'https://bharatlas.com/releases/bharatlas-a-2026.11/' },
    ]);
    expect(out.layers[1].versions).toEqual([]);
    expect(layerVersions(index, 'cw')).toHaveLength(1);
  });
});
