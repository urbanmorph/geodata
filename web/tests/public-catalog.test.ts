import { describe, it, expect } from 'vitest';
import { publicCatalogJson } from '../scripts/public-catalog.mjs';

describe('publicCatalogJson (the /catalog.json the site serves)', () => {
  const catalog = {
    version: 1,
    layers: [
      { id: 'a', notes: 'x', source_check: { method: 'http', url: 'u', fingerprint: 'f', checked_at: 't', changed_at: 'c' } },
      { id: 'b', notes: 'y' },
    ],
  };

  it('drops each layer\'s source_check (update-check bookkeeping) and keeps everything else', () => {
    const out = JSON.parse(publicCatalogJson(catalog));
    expect(out).toEqual({ version: 1, layers: [{ id: 'a', notes: 'x' }, { id: 'b', notes: 'y' }] });
  });

  it('leaves the catalog it was given untouched', () => {
    publicCatalogJson(catalog);
    expect(catalog.layers[0]).toHaveProperty('source_check');
  });
});
