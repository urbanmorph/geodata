import { describe, it, expect } from 'vitest';
import { groupHits } from '../functions/lib/locate';
import type { CatalogLayer } from '../functions/lib/catalog-api';

const layer = (id: string, category = 'admin') => ({ id, level: id, category }) as CatalogLayer;

describe('locate groups hits by category', () => {
  it('a feature the source repeats is answered once (bharatviz_pincodes has every polygon twice)', () => {
    const pin = { pincode: '560001', office_name: 'Bangalore G.P.O.' };
    const { grouped, failed } = groupHits([layer('bharatviz_pincodes', 'postal')], [
      { status: 'fulfilled', value: [{ layer_name: 'x', properties: pin }, { layer_name: 'x', properties: { office_name: 'Bangalore G.P.O.', pincode: '560001' } }] },
    ]);
    expect(failed).toEqual([]);
    expect(grouped.postal).toEqual([{ layer_id: 'bharatviz_pincodes', level: 'bharatviz_pincodes', category: 'postal', feature: { properties: pin } }]);
  });

  it('different features of a layer, and the same feature in two layers, all stay; a failed layer is listed', () => {
    const a = { ward: '1' }, b = { ward: '2' };
    const { grouped, failed } = groupHits([layer('wards_x'), layer('wards_y'), layer('broken')], [
      { status: 'fulfilled', value: [{ layer_name: 'x', properties: a }, { layer_name: 'x', properties: b }] },
      { status: 'fulfilled', value: [{ layer_name: 'y', properties: a }] },
      { status: 'rejected', reason: new Error('R2 down') },
    ]);
    expect(grouped.admin.map((r) => [r.layer_id, r.feature.properties])).toEqual([['wards_x', a], ['wards_x', b], ['wards_y', a]]);
    expect(failed).toEqual(['broken']);
  });
});
