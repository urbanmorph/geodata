// "Data year" is typed by hand in two places (the new-map wizard, Edit
// settings) and checked again on the server. One reading for all three, so a
// typo like "2026a" is refused with a message instead of clearing the year.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readDataYear } from '../src/schema/data-year';

describe('readDataYear', () => {
  it('blank means no year', () => {
    expect(readDataYear('')).toEqual({ ok: true, value: null });
    expect(readDataYear('  ')).toEqual({ ok: true, value: null });
    expect(readDataYear(null)).toEqual({ ok: true, value: null });
  });
  it('takes a whole year, as text or a number', () => {
    expect(readDataYear(' 2026 ')).toEqual({ ok: true, value: 2026 });
    expect(readDataYear(1991)).toEqual({ ok: true, value: 1991 });
  });
  it('refuses a typo or an unlikely year, never turning it into "no year"', () => {
    for (const bad of ['2026a', '20.5', 'abc', '1700', '2200', NaN]) {
      const r = readDataYear(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/whole number like 2026/);
    }
  });
});

describe('Edit settings', () => {
  it('checks the year with readDataYear instead of Number()', () => {
    const app = readFileSync(resolve(__dirname, '../src/app.ts'), 'utf8');
    expect(app).not.toMatch(/data_year: yr === '' \? null : Number\(yr\)/);
    expect(app).toMatch(/readDataYear\(/);
  });
});
