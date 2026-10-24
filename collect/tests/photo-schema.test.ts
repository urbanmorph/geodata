// Photo questions and collection modes in the form (schema_doc). A Photo
// question holds up to 3 photo ids; a map is collected in one of three modes,
// and "Just photos, AI fills the form" is for places only.
import { describe, it, expect } from 'vitest';
import { validateSchemaDoc, validateCollectionEdit } from '../src/schema/validate-collection';
import { validateRecordProperties, type Field } from '../src/schema/validate-record';
import { modeOf, photoFields, aiFillable, photosOnlyAllowed } from '../src/schema/modes';

const doc = (extra: Record<string, unknown> = {}, fields: Field[] = [{ key: 'pic', label: 'Photo', type: 'photo', max_photos: 3 }]) =>
  ({ version: 1, geometry: ['point'], fields, ...extra });

describe('photo questions in the form', () => {
  it('accepts a Photo question with 1 to 3 photos, defaulting to 3', () => {
    const r = validateSchemaDoc(doc({}, [{ key: 'pic', label: 'Photo', type: 'photo' }, { key: 'two', label: 'Two', type: 'photo', max_photos: 2 }]));
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.value.fields as Field[]).map((f) => f.max_photos)).toEqual([3, 2]);
  });

  it('refuses another photo count, or the setting on another type', () => {
    expect(validateSchemaDoc(doc({}, [{ key: 'pic', label: 'Photo', type: 'photo', max_photos: 4 }])).ok).toBe(false);
    expect(validateSchemaDoc(doc({}, [{ key: 'pic', label: 'Photo', type: 'photo', max_photos: '2' as unknown as number }])).ok).toBe(false);
    expect(validateSchemaDoc(doc({}, [{ key: 'n', label: 'N', type: 'text', max_photos: 2 }])).ok).toBe(false);
  });

  it('a point keeps photo ids, at most the question allows', () => {
    const f: Field[] = [{ key: 'pic', label: 'Photo', type: 'photo', max_photos: 2, required: true }];
    expect(validateRecordProperties(f, { pic: ['ph_aaaaaaaaaaaa'] })).toEqual({ ok: true, properties: { pic: ['ph_aaaaaaaaaaaa'] } });
    expect(validateRecordProperties(f, { pic: ['ph_a', 'ph_b', 'ph_c'] }).ok).toBe(false);
    expect(validateRecordProperties(f, { pic: ['https://evil.example/x.jpg'] }).ok).toBe(false);
    expect(validateRecordProperties(f, { pic: 'ph_aaaaaaaaaaaa' }).ok).toBe(false);
    expect(validateRecordProperties(f, {}).ok).toBe(false); // required
  });

  it('can leave other required questions for the reviewer (photos-only capture)', () => {
    const f: Field[] = [
      { key: 'pic', label: 'Photo', type: 'photo', required: true },
      { key: 'kind', label: 'Kind', type: 'select', options: ['A', 'B'], required: true },
    ];
    expect(validateRecordProperties(f, { pic: ['ph_aaaaaaaaaaaa'] }).ok).toBe(false);
    expect(validateRecordProperties(f, { pic: ['ph_aaaaaaaaaaaa'] }, { photosOnly: true }).ok).toBe(true);
    expect(validateRecordProperties(f, {}, { photosOnly: true }).ok).toBe(false); // the photo is still needed
  });
});

describe('collection modes', () => {
  it('a map without a mode is filled in as a form (existing maps unchanged)', () => {
    expect(modeOf({})).toBe('form');
    expect(modeOf({ mode: 'form_ai' })).toBe('form_ai');
  });

  it('accepts the three modes and refuses others', () => {
    expect(validateSchemaDoc(doc({ mode: 'form' })).ok).toBe(true);
    expect(validateSchemaDoc(doc({ mode: 'form_ai' })).ok).toBe(true);
    expect(validateSchemaDoc(doc({ mode: 'photos_ai' })).ok).toBe(true);
    expect(validateSchemaDoc(doc({ mode: 'magic' })).ok).toBe(false);
  });

  it('AI modes need a Photo question', () => {
    const r = validateSchemaDoc(doc({ mode: 'form_ai' }, [{ key: 'n', label: 'Name', type: 'text' }]));
    expect(!r.ok && r.error).toMatch(/Photo question/);
  });

  it('photos only is for places only', () => {
    expect(photosOnlyAllowed(['point'])).toBe(true);
    expect(photosOnlyAllowed(['point', 'polygon'])).toBe(false);
    const r = validateSchemaDoc({ ...doc({ mode: 'photos_ai' }), geometry: ['point', 'polygon'] });
    expect(!r.ok && r.error).toMatch(/places only/);
  });

  it('keeps data_saver as true or false only', () => {
    const r = validateSchemaDoc(doc({ data_saver: true }));
    expect(r.ok && r.value.data_saver).toBe(true);
    expect(validateSchemaDoc(doc({ data_saver: 'yes' })).ok).toBe(false);
  });

  it('the mode and data saver can change later in Manage, under the same rules', () => {
    const schema = doc();
    const ok = validateCollectionEdit({ mode: 'photos_ai', data_saver: true }, { hasRecords: true, currentLicense: 'CC-BY-4.0', schema });
    expect(ok.ok && ok.value.schema).toEqual({ mode: 'photos_ai', data_saver: true });
    const noPhoto = validateCollectionEdit({ mode: 'form_ai' }, { hasRecords: false, currentLicense: 'CC-BY-4.0', schema: doc({}, [{ key: 'n', label: 'N', type: 'text' }]) });
    expect(noPhoto.ok).toBe(false);
  });

  it('finds the photo questions, and what the model may fill (never numbers)', () => {
    const fields: Field[] = [
      { key: 'pic', label: 'Photo', type: 'photo' },
      { key: 'kind', label: 'Kind', type: 'select', options: ['A'] },
      { key: 'tags', label: 'Tags', type: 'multiselect', options: ['x'] },
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'width', label: 'Width', type: 'number' },
      { key: 'when', label: 'When', type: 'date' },
      { key: 'gone', label: 'Gone', type: 'select', options: ['A'], deleted: true },
    ];
    expect(photoFields(fields).map((f) => f.key)).toEqual(['pic']);
    expect(fields.filter(aiFillable).map((f) => f.key)).toEqual(['kind', 'tags', 'name']);
  });
});
