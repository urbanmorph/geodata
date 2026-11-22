// @vitest-environment happy-dom
// Every question on a form has a name a screen reader announces: a <label for>
// on its control (unique ids), a named group for chips and photos, and chips
// that say whether they are picked.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fieldsHtml, setPressed, wireChips, fillAnswers, readAnswers } from '../src/form-fields';
import type { Field } from '../src/schema/validate-record';

const FIELDS: Field[] = [
  { key: 'name', label: 'Name', type: 'text', required: true, hint: 'As on the board' },
  { key: 'notes', label: 'Notes', type: 'paragraph' },
  { key: 'girth', label: 'Girth', type: 'number' },
  { key: 'seen', label: 'Seen', type: 'date' },
  { key: 'at', label: 'At', type: 'datetime' },
  { key: 'link', label: 'Link', type: 'url' },
  { key: 'kind', label: 'Kind', type: 'select', options: ['Neem', 'Peepal'] },
  { key: 'tags', label: 'Tags', type: 'multiselect', options: ['Old', 'Young'] },
  { key: 'pic', label: 'Photo', type: 'photo' },
] as Field[];

const nameOf = (el: Element): string => {
  const by = el.getAttribute('aria-labelledby');
  if (by) return by.split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
  return (el.getAttribute('aria-label') || document.querySelector(`label[for="${el.id}"]`)?.textContent || '').trim();
};

describe('fieldsHtml', () => {
  document.body.innerHTML = `<form>${fieldsHtml(FIELDS)}</form>`;

  it('labels every control by its question, with unique ids', () => {
    const controls = [...document.querySelectorAll('input, select, textarea')];
    expect(controls).toHaveLength(7);
    for (const c of controls) expect(nameOf(c), c.outerHTML).toMatch(/^(Name \*|Notes|Girth|Seen|At|Link|Kind)$/);
    const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the data-k hooks the form reads answers from', () => {
    for (const f of FIELDS) expect(document.querySelector(`[data-k="${f.key}"]`), f.key).not.toBeNull();
  });

  it('ties a hint to its control', () => {
    const name = document.querySelector('[data-k="name"]')!;
    expect(document.getElementById(name.getAttribute('aria-describedby')!)!.textContent).toBe('As on the board');
  });

  it('names the chip and photo groups, and chips start unpressed', () => {
    for (const k of ['tags', 'pic']) {
      const g = document.querySelector(`[data-k="${k}"]`)!;
      expect(g.getAttribute('role')).toBe('group');
      expect(nameOf(g)).toBe(k === 'tags' ? 'Tags' : 'Photo');
    }
    for (const c of document.querySelectorAll('.chip')) expect(c.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('setPressed', () => {
  it('keeps the look (.on) and the state (aria-pressed) together', () => {
    const b = document.createElement('button');
    setPressed(b, true);
    expect(b.classList.contains('on')).toBe(true);
    expect(b.getAttribute('aria-pressed')).toBe('true');
    setPressed(b, !b.classList.contains('on'));
    expect(b.classList.contains('on')).toBe(false);
    expect(b.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('the other collect forms', () => {
  const app = readFileSync(resolve(__dirname, '../src/app.ts'), 'utf8');
  it('no <label> without for sits in front of a control (settings form)', () => {
    expect(app).not.toMatch(/<label>[^<]*(<span[^>]*>[^<]*<\/span>)?\s*<\/label>\s*<(input|select|textarea)\b/);
  });
  it('the import column pickers are named by their field', () => {
    for (const m of app.matchAll(/<select data-(map|field)=[^>]*>/g)) expect(m[0]).toContain('aria-label=');
  });
  it('no fake menus (role=menu promises arrow keys the base map list does not have)', () => {
    expect(app).not.toMatch(/aria-haspopup|role="menu|menuitem/);
  });
});

describe('filling a form and reading it back', () => {
  const F: Field[] = [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'kind', label: 'Kind', type: 'multiselect', options: ['Neem', 'Peepal', 'Banyan'] },
    { key: 'seen', label: 'Seen', type: 'datetime' },
    { key: 'at', label: 'At', type: 'datetime' },
    { key: 'pic', label: 'Photo', type: 'photo' },
  ];
  const mount = () => { document.body.innerHTML = `<form>${fieldsHtml(F)}</form>`; return document.body.querySelector('form') as HTMLElement; };

  it('wireChips makes each chip toggle its pressed state', () => {
    const root = mount();
    wireChips(root);
    const chip = root.querySelector<HTMLElement>('.chip')!;
    chip.click();
    expect([chip.classList.contains('on'), chip.getAttribute('aria-pressed')]).toEqual([true, 'true']);
    chip.click();
    expect([chip.classList.contains('on'), chip.getAttribute('aria-pressed')]).toEqual([false, 'false']);
  });

  it('fillAnswers presses saved chips and fills values; readAnswers returns the same answers', () => {
    const root = mount();
    const saved = { name: 'Neem by gate', kind: ['Neem', 'Banyan'], seen: '2026-11-01T10:30', at: '2026-11-01T10:30:00+05:30' };
    fillAnswers(root, F, saved);
    expect([...root.querySelectorAll('.chip')].map((c) => c.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'true']);
    expect(readAnswers(root, F)).toEqual(saved);
  });

  it('shows a date-time the picker cannot hold (an offset) as text, so it is kept', () => {
    const root = mount();
    fillAnswers(root, F, { seen: '2026-11-01T10:30', at: '2026-11-01T10:30:00+05:30' });
    expect((root.querySelector('#fld-seen') as HTMLInputElement).type).toBe('datetime-local');
    expect((root.querySelector('#fld-at') as HTMLInputElement).type).toBe('text');
  });

  it('leaves unanswered questions empty and out of the answers', () => {
    const root = mount();
    fillAnswers(root, F, { name: null });
    expect(readAnswers(root, F)).toEqual({});
  });
});
