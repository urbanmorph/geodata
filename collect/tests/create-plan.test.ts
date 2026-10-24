// The guided "Make a new map": starting templates, what people mark, how they
// collect, and the form the steps add up to.
import { describe, it, expect } from 'vitest';
import { TEMPLATES, templateById } from '../src/create/templates';
import { modeChoices, withPhotoQuestion, schemaDocFor, MARKS } from '../src/create/plan';
import { validateSchemaDoc } from '../src/schema/validate-collection';
import { photosOnlyAllowed } from '../src/schema/modes';

describe('starting templates', () => {
  it('offers the five starting points in order', () => {
    expect(TEMPLATES.map((t) => t.title)).toEqual(['Footpaths and walking', 'Trees', 'Farms and fields', 'Garbage spots', 'Something else']);
  });

  it('every template makes a valid form in every mode it allows', () => {
    for (const t of TEMPLATES) {
      for (const m of modeChoices(t.geometry).filter((c) => !c.disabled)) {
        const r = validateSchemaDoc(schemaDocFor({ geometry: t.geometry, fields: withPhotoQuestion(t.fields, m.id), mode: m.id, category: t.category }));
        expect(r.ok, `${t.id}/${m.id}: ${!r.ok && r.error}`).toBe(true);
      }
    }
  });

  it('farms are areas, with up to 3 photos from different sides', () => {
    const farm = templateById('farms')!;
    expect(farm.geometry).toEqual(['polygon']);
    expect(farm.fields.find((f) => f.type === 'photo')).toMatchObject({ max_photos: 3 });
  });

  it('every template asks for a photo', () => {
    for (const t of TEMPLATES) expect(t.fields.some((f) => f.type === 'photo'), t.id).toBe(true);
  });
});

describe('what people mark', () => {
  it('offers places, routes and areas, in plain words', () => {
    expect(MARKS.map((m) => [m.id, m.label])).toEqual([['point', 'Places'], ['line', 'Routes'], ['polygon', 'Areas']]);
  });
});

describe('how people collect', () => {
  it('offers three modes; just photos only for places', () => {
    expect(modeChoices(['point']).map((c) => [c.id, !!c.disabled])).toEqual([['form', false], ['form_ai', false], ['photos_ai', false]]);
    const areas = modeChoices(['polygon']);
    expect(areas[2].disabled).toBe(true);
    expect(areas[2].why).toMatch(/places only/);
    expect(photosOnlyAllowed(['point'])).toBe(true);
  });

  it('an AI mode adds a Photo question when the form has none', () => {
    const fields = [{ key: 'name', label: 'Name', type: 'text' }];
    expect(withPhotoQuestion(fields, 'form')).toBe(fields);
    const withPhoto = withPhotoQuestion(fields, 'form_ai');
    expect(withPhoto.map((f) => f.type)).toEqual(['photo', 'text']);
    expect(withPhotoQuestion(withPhoto, 'photos_ai')).toBe(withPhoto);
  });

  it('builds the form document, leaving out the mode for a plain form', () => {
    expect(schemaDocFor({ geometry: ['point'], fields: [], mode: 'form', category: 'other' })).toEqual({ version: 1, geometry: ['point'], fields: [], category: 'other' });
    expect(schemaDocFor({ geometry: ['point'], fields: [], mode: 'form_ai', category: 'other', dataSaver: true })).toMatchObject({ mode: 'form_ai', data_saver: true });
  });
});
