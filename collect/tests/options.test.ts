// The category and licence choices in collect come from one table each: the
// form's options, the server's check and the layer picker's group names agree.
import { describe, it, expect } from 'vitest';
import { CATEGORIES, OPEN_LICENCES, CATEGORY_IDS, categoryLabel } from '../src/options';
import { OPEN_LICENCES as ALLOWED } from '../../web/functions/lib/licenses';
import { validateSchemaDoc } from '../src/schema/validate-collection';

describe('options', () => {
  it('offers exactly the licences the server accepts, CC BY 4.0 first (the default)', () => {
    expect(OPEN_LICENCES.map(([id]) => id).sort()).toEqual(ALLOWED.map((l) => l.id).sort());
    expect(OPEN_LICENCES[0][0]).toBe('CC-BY-4.0');
  });
  it('the server accepts every category the form offers, and no other', () => {
    expect(CATEGORY_IDS).toEqual(CATEGORIES.map(([id]) => id));
    const doc = (category: string) => ({ version: 1, geometry: ['point'], fields: [], category });
    for (const id of CATEGORY_IDS) expect(validateSchemaDoc(doc(id)).ok).toBe(true);
    expect(validateSchemaDoc(doc('nope')).ok).toBe(false);
  });
  it('names a catalogue category for the layer picker, falling back to its id', () => {
    expect(categoryLabel('culture')).toBe('Culture & heritage');
    expect(categoryLabel('something-new')).toBe('something-new');
  });
});
