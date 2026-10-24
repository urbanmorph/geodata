// @vitest-environment happy-dom
// The form builder when it knows the data: a file's columns before "Create",
// or the map's saved points after (Manage → Edit form). Every field shows how
// many rows fit; options the data uses are locked (new ones can be added);
// each type says how many rows it would refuse; a date-time column turned into
// Date-only says the time is dropped. After Create, fields are hidden rather
// than removed, and a type that saved points don't fit can't be picked.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountSchemaBuilder, type BuilderField } from '../src/schema-builder';

const host = (): HTMLElement => { const d = document.createElement('div'); document.body.appendChild(d); return d; };
const q = <T extends Element>(root: ParentNode, sel: string) => root.querySelector(sel) as T;
const all = (root: ParentNode, sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];
beforeEach(() => { document.body.innerHTML = ''; });

const COLUMNS: Record<string, string[]> = {
  surface: ['Good', 'Bad', 'Bad', 'Uneven', 'Missing', ''],
  seen: ['2026-05-04 09:30', '2026-05-04 10:00', '2026-05-05 08:15', '', '', ''],
  cars: ['3', '4', 'many', '2', '', '1'],
};
const data = { noun: 'row', values: (f: BuilderField) => COLUMNS[f.key] ?? Array(6).fill('') };
const SURFACE: BuilderField = { key: 'surface', label: 'Surface', type: 'select', options: ['Good', 'Bad', 'Uneven'] };
const open = (root: HTMLElement, i: number) => { q<HTMLButtonElement>(root, `.sb-name[data-edit="${i}"]`).click(); return q<HTMLElement>(root, `[data-editcard="${i}"]`); };

describe('builder with the file data', () => {
  it('each field says how many rows fit, and why the rest do not', () => {
    const root = host();
    mountSchemaBuilder(root, [SURFACE, { key: 'cars', label: 'Cars', type: 'number' }], { data });
    const status = all(root, '.sb-check').map((e) => e.textContent!.replace(/\s+/g, ' ').trim());
    expect(status[0]).toMatch(/1 of 6 rows won't fit: "Missing" is not an allowed option \(1\)/);
    expect(status[1]).toMatch(/1 of 6 rows won't fit: must be a number \(1\)/);
  });

  it('options the data uses are locked; unused ones can be removed; new ones added', () => {
    const root = host();
    const b = mountSchemaBuilder(root, [{ ...SURFACE, options: ['Good', 'Bad', 'Uneven', 'Spare'] }], { data });
    const card = open(root, 0);
    const chip = (o: string) => all(card, '.opt-chip').find((c) => c.dataset.opt === o)!;
    expect(chip('Bad').textContent).toContain('2');
    expect(chip('Bad').querySelector('[data-rmopt]')).toBeNull();      // used: locked
    chip('Spare').querySelector<HTMLButtonElement>('[data-rmopt]')!.click(); // unused: removable
    q<HTMLTextAreaElement>(card, '.ff-opts').value = 'Encroached';
    q<HTMLButtonElement>(card, '.sb-save').click();
    expect(b.getFields()[0].options).toEqual(['Good', 'Bad', 'Uneven', 'Encroached']);
  });

  it('values in the data but not in the list can be added with one tap', () => {
    const root = host();
    const b = mountSchemaBuilder(root, [SURFACE], { data });
    const card = open(root, 0);
    q<HTMLButtonElement>(card, '[data-addopt="Missing"]').click();
    q<HTMLButtonElement>(card, '.sb-save').click();
    expect(b.getFields()[0].options).toEqual(['Good', 'Bad', 'Uneven', 'Missing']);
    expect(q<HTMLElement>(root, '.sb-check').textContent).toMatch(/all 6 rows fit/);
  });

  it('each type says how many rows it would refuse; switching to a choice fills the options from the data', () => {
    const root = host();
    const b = mountSchemaBuilder(root, [{ key: 'surface', label: 'Surface', type: 'text' }], { data });
    const card = open(root, 0);
    const type = q<HTMLSelectElement>(card, '.ff-type');
    expect([...type.options].find((o) => o.value === 'number')!.textContent).toMatch(/5 rows won't fit/);
    type.value = 'select';
    type.dispatchEvent(new Event('change'));
    q<HTMLButtonElement>(card, '.sb-save').click();
    expect(b.getFields()[0]).toMatchObject({ type: 'select', options: ['Good', 'Bad', 'Uneven', 'Missing'] });
  });

  it('turning a date-time column into Date says the time is dropped', () => {
    const root = host();
    mountSchemaBuilder(root, [{ key: 'seen', label: 'Seen', type: 'date' }], { data });
    expect(q<HTMLElement>(root, '.sb-check').textContent).toMatch(/the time is dropped .*\(3\)/);
  });

  it('a note from the guesser is shown, but never saved into the form', () => {
    const root = host();
    const b = mountSchemaBuilder(root, [{ key: 'd', label: 'Surveyed', type: 'text', note: 'day and month order is unclear' }], { data });
    expect(root.textContent).toContain('day and month order is unclear');
    expect(b.getFields()[0]).not.toHaveProperty('note');
  });

  it('tells the page whenever the form changes', () => {
    const root = host();
    const onChange = vi.fn();
    mountSchemaBuilder(root, [SURFACE], { data, onChange });
    const card = open(root, 0);
    q<HTMLButtonElement>(card, '[data-addopt="Missing"]').click();
    q<HTMLButtonElement>(card, '.sb-save').click();
    expect(onChange).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ options: ['Good', 'Bad', 'Uneven', 'Missing'] })]));
  });
});

describe('builder after Create (saved points)', () => {
  const points = { noun: 'point', values: (f: BuilderField) => COLUMNS[f.key] ?? Array(6).fill(undefined) };

  it('existing fields are hidden, not removed, and keep their key', () => {
    const root = host();
    const b = mountSchemaBuilder(root, [SURFACE], { data: points, existing: true });
    expect(q(root, '[data-rm="0"]')).toBeNull();
    q<HTMLButtonElement>(root, '[data-hide="0"]').click();
    expect(b.getFields()[0]).toMatchObject({ key: 'surface', deleted: true });
    q<HTMLButtonElement>(root, '[data-hide="0"]').click();
    expect(b.getFields()[0].deleted).toBeUndefined();
  });

  it("a type the saved points don't fit can't be picked", () => {
    const root = host();
    mountSchemaBuilder(root, [{ key: 'surface', label: 'Surface', type: 'text' }], { data: points, existing: true });
    const card = open(root, 0);
    const opt = (v: string) => [...q<HTMLSelectElement>(card, '.ff-type').options].find((o) => o.value === v)!;
    expect(opt('number').disabled).toBe(true);
    expect(opt('paragraph').disabled).toBe(false);
  });

  it('a field added after Create can still be removed', () => {
    const root = host();
    const b = mountSchemaBuilder(root, [SURFACE], { data: points, existing: true });
    q<HTMLInputElement>(root, '#sb-add .ff-label').value = 'Width';
    q<HTMLButtonElement>(root, '#sb-add-btn').click();
    q<HTMLButtonElement>(root, '[data-rm="1"]').click();
    expect(b.getFields().map((f) => f.key)).toEqual(['surface']);
  });
});
