// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { mountSchemaBuilder } from '../src/schema-builder';

// Regression guard for the inline field editor: clicking a saved field opens an
// editor UNDER that row, and saving updates THAT field only (an earlier version
// wrote the edit to the wrong field and left the target untouched).

const host = (): HTMLElement => {
  const d = document.createElement('div');
  document.body.appendChild(d);
  return d;
};
const q = <T extends Element>(root: ParentNode, sel: string) => root.querySelector(sel) as T;

beforeEach(() => { document.body.innerHTML = ''; });

function addSelectField(root: HTMLElement, label: string, opts: string): void {
  q<HTMLInputElement>(root, '#sb-add .ff-label').value = label;
  const t = q<HTMLSelectElement>(root, '#sb-add .ff-type');
  t.value = 'select';
  t.dispatchEvent(new Event('change'));
  q<HTMLTextAreaElement>(root, '#sb-add .ff-opts').value = opts;
  q<HTMLButtonElement>(root, '#sb-add-btn').click();
}

describe('mountSchemaBuilder inline edit', () => {
  it('edits the clicked field in place, keeps its key, and leaves others untouched', () => {
    const root = host();
    const b = mountSchemaBuilder(root, [{ key: 'name', label: 'Name', type: 'text', required: true }]);

    addSelectField(root, 'Condition', 'Good\nBad');
    expect(b.getFields().map((f) => f.label)).toEqual(['Name', 'Condition']);
    const condKey = b.getFields()[1].key;

    // open the inline editor for field #1
    q<HTMLButtonElement>(root, '.sb-name[data-edit="1"]').click();
    const card = q<HTMLElement>(root, '[data-editcard="1"]');
    expect(card).toBeTruthy();
    // it renders directly UNDER row #1 (not at the bottom)
    expect(card.previousElementSibling!.querySelector('.sb-name[data-edit="1"]')).toBeTruthy();
    // and is prefilled with the field's values
    expect(q<HTMLInputElement>(card, '.ff-label').value).toBe('Condition');
    expect(q<HTMLTextAreaElement>(card, '.ff-opts').value).toBe('Good\nBad');

    // change it and save
    q<HTMLInputElement>(card, '.ff-label').value = 'Condition v2';
    q<HTMLTextAreaElement>(card, '.ff-opts').value = 'Good\nBad\nUgly';
    q<HTMLButtonElement>(card, '.sb-save').click();

    const fields = b.getFields();
    expect(fields).toHaveLength(2);
    expect(fields[0]).toMatchObject({ label: 'Name', type: 'text', required: true }); // untouched
    expect(fields[1].label).toBe('Condition v2');
    expect(fields[1].options).toEqual(['Good', 'Bad', 'Ugly']);
    expect(fields[1].key).toBe(condKey); // key stable across the edit
    expect(root.querySelector('[data-editcard]')).toBeNull(); // editor closed
  });

  it('cancel discards inline edits and closes the editor', () => {
    const root = host();
    const b = mountSchemaBuilder(root, [{ key: 'name', label: 'Name', type: 'text' }]);
    q<HTMLButtonElement>(root, '.sb-name[data-edit="0"]').click();
    const card = q<HTMLElement>(root, '[data-editcard="0"]');
    q<HTMLInputElement>(card, '.ff-label').value = 'Changed but cancelled';
    q<HTMLButtonElement>(card, '.sb-cancel').click();
    expect(b.getFields()[0].label).toBe('Name');
    expect(root.querySelector('[data-editcard]')).toBeNull();
  });

  it('a second click on the same field closes its editor (toggle)', () => {
    const root = host();
    mountSchemaBuilder(root, [{ key: 'name', label: 'Name', type: 'text' }]);
    q<HTMLButtonElement>(root, '.sb-name[data-edit="0"]').click();
    expect(root.querySelector('[data-editcard="0"]')).toBeTruthy();
    q<HTMLButtonElement>(root, '.sb-name[data-edit="0"]').click();
    expect(root.querySelector('[data-editcard="0"]')).toBeNull();
  });

  it('hides the add-card while an inline editor is open (one form at a time)', () => {
    const root = host();
    mountSchemaBuilder(root, [{ key: 'name', label: 'Name', type: 'text' }]);
    const addCard = q<HTMLElement>(root, '#sb-add');
    expect(addCard.style.display).toBe('');
    q<HTMLButtonElement>(root, '.sb-name[data-edit="0"]').click();
    expect(addCard.style.display).toBe('none');
    q<HTMLButtonElement>(root, '[data-editcard="0"] .sb-cancel').click();
    expect(addCard.style.display).toBe('');
  });
});
