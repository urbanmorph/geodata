// @vitest-environment happy-dom
// The Filter panel's controls say what they are and what state they are in, and
// the search suggestions can be picked from the keyboard.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/db', () => ({
  query: vi.fn(async () => [{ v: 'Pune' }, { v: 'Punjab' }]),
  getDb: vi.fn(async () => ({})),
  exportFilteredParquet: vi.fn(),
  exportFilteredGeoJSON: vi.fn(),
  exportFilteredKML: vi.fn(),
}));
vi.mock('../src/catalog', () => ({ getCatalog: vi.fn(async () => ({ layers: [] })) }));

import { mountFilterPanel } from '../src/filter';
import type { ColumnStats } from '../src/filter-schema';

const cols: ColumnStats[] = [
  { name: 'state', type: 'string', distinct: 3, nullFrac: 0, topValues: [{ v: 'KA', n: 10 }, { v: 'MH', n: 8 }, { v: 'GJ', n: 2 }] },
  { name: 'urban', type: 'bool', distinct: 2, nullFrac: 0 },
  { name: 'pop', type: 'int', distinct: 500, nullFrac: 0, min: 1, max: 9000 },
  { name: 'city', type: 'string', distinct: 300, nullFrac: 0 },
];

const field = (col: string) => document.querySelector<HTMLElement>(`.filter-panel__field[data-col="${col}"]`)!;
let onActive: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
  document.body.innerHTML = '<div id="c"></div>';
  onActive = vi.fn();
  mountFilterPanel(
    { id: 'x', level: 'x', source: 'S', parquet: { url: 'https://r2.example/x.parquet', bytes: 1000 } },
    document.getElementById('c')!, cols, 1000, { onClose: () => {}, onActiveFiltersChange: onActive },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Filter panel accessibility', () => {
  it('facet chips expose their pressed state', () => {
    const chip = field('state').querySelector<HTMLButtonElement>('.filter-chip')!;
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    chip.click();
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    chip.click();
    expect(chip.getAttribute('aria-pressed')).toBe('false');
  });
  it('Yes / No expose their pressed state, one at a time', () => {
    const [yes, no] = field('urban').querySelectorAll<HTMLButtonElement>('.filter-bool__btn');
    yes.click();
    expect([yes.getAttribute('aria-pressed'), no.getAttribute('aria-pressed')]).toEqual(['true', 'false']);
    no.click();
    expect([yes.getAttribute('aria-pressed'), no.getAttribute('aria-pressed')]).toEqual(['false', 'true']);
  });
  it('every input has an accessible name', () => {
    for (const i of document.querySelectorAll<HTMLInputElement>('.filter-panel input')) {
      expect(i.getAttribute('aria-label'), i.outerHTML).toBeTruthy();
    }
    expect(field('pop').querySelectorAll('input')[0].getAttribute('aria-label')).toBe('pop, minimum');
  });
  it('search suggestions are a listbox the arrow keys and Enter can pick from', async () => {
    const input = field('city').querySelector<HTMLInputElement>('input')!;
    expect(input.getAttribute('role')).toBe('combobox');
    input.value = 'pun';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);
    const list = field('city').querySelector('ul')!;
    expect(list.getAttribute('role')).toBe('listbox');
    const opts = list.querySelectorAll('[role="option"]');
    expect(opts).toHaveLength(2);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(input.getAttribute('aria-activedescendant')).toBe(opts[1].id);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(input.value).toBe('Punjab');
    expect(onActive.mock.calls.at(-1)?.[0]).toEqual([{ col: 'city', kind: 'search', q: 'Punjab' }]);
  });
});
