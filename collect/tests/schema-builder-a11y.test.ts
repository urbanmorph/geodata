// @vitest-environment happy-dom
// The form builder: every control has a name, whatever answer type is picked
// (the per-type extras were labels sitting next to unnamed controls).
import { describe, it, expect, beforeEach } from 'vitest';
import { mountSchemaBuilder } from '../src/schema-builder';

const named = (el: Element): boolean =>
  !!(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.closest('label') ||
    (el.id && document.querySelector(`label[for="${el.id}"]`)));

beforeEach(() => { document.body.innerHTML = ''; });

describe('form builder controls are named', () => {
  for (const type of ['text', 'paragraph', 'number', 'select', 'multiselect', 'date', 'datetime', 'url', 'photo']) {
    it(`with "${type}" picked`, () => {
      const root = document.createElement('div');
      document.body.appendChild(root);
      mountSchemaBuilder(root, [{ key: 'name', label: 'Name', type: 'text' }]);
      const t = root.querySelector<HTMLSelectElement>('#sb-add .ff-type')!;
      t.value = type;
      t.dispatchEvent(new Event('change'));
      const unnamed = [...root.querySelectorAll('input, select, textarea')].filter((c) => !named(c)).map((c) => c.className);
      expect(unnamed).toEqual([]);
    });
  }
});
