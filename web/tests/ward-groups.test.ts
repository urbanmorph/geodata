import { describe, it, expect } from 'vitest';
import { buildWardTable } from '../functions/lib/view-dataset';
import { wardTitle } from '../src/locate-format';

// Greater Bengaluru: 5 corporations each number wards from 1. The sidecar keys
// rows by (corporation, number) and carries groupCol / groupLabel.
const idx = {
  id: 'wards_bengaluru_gba', place: 'Bengaluru', nameLabel: 'Area', numberCol: 'ward_id',
  groupCol: 'Corporation', groupLabel: 'Corporation',
  rows: [
    { group: 'Central', no: '1', name: 'Shivajinagar' },
    { group: 'North', no: '1', name: 'Kempapura' },
    { group: 'West', no: '1', name: 'Malleshwaram' },
  ],
};

describe('grouped ward lists (GBA)', () => {
  it('the table shows each ward with its corporation', () => {
    const { html, jsonLd } = buildWardTable(idx as any);
    expect(html).toContain('<th scope="col">Corporation</th>');
    expect(html).toContain('<td>West</td><td>1</td><td>Malleshwaram</td>');
    const names = (jsonLd!.itemListElement as { name: string }[]).map((e) => e.name);
    expect(names).toContain('Ward 1 (West): Malleshwaram');
    expect(jsonLd!.numberOfItems).toBe(3);
  });

  it('My ward picks the ward in the located corporation, not the first Ward 1', () => {
    expect(wardTitle({ ward_id: '1', Corporation: 'West' }, idx as any)).toEqual(
      { title: 'Ward 1', sub: 'West Corporation · Malleshwaram' });
    expect(wardTitle({ ward_id: '1', Corporation: 'North' }, idx as any)?.sub).toBe('North Corporation · Kempapura');
  });

  it('ungrouped sidecars behave as before', () => {
    const plain = { ...idx, groupCol: undefined, groupLabel: undefined, rows: [{ no: '5', name: 'Ameerpet' }] };
    expect(wardTitle({ ward_id: '5' }, plain as any)).toEqual({ title: 'Ward 5', sub: 'Ameerpet' });
    expect(buildWardTable(plain as any).html).not.toContain('Corporation');
  });
});
