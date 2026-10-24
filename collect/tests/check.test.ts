// The data check behind the form builder: for one field definition and a set
// of values (a file's column before "Create", a map's points after), how many
// fit, why the rest don't, and what would be lost. One check, the same one the
// server applies, so what the builder allows is what gets saved.
import { describe, it, expect } from 'vitest';
import { checkField, summarizeErrors } from '../src/import/check';
import type { Field } from '../src/schema/validate-record';

const sel = (options: string[], extra: Partial<Field> = {}): Field => ({ key: 's', label: 'Surface', type: 'select', options, ...extra });

describe('checkField', () => {
  it('counts how many rows fit, and groups the ones that do not by reason', () => {
    const c = checkField(sel(['Good', 'Bad']), ['Good', 'Bad', 'Missing', 'Missing', 'Odd', '']);
    expect(c).toMatchObject({ total: 6, filled: 5, fit: 3 });
    expect(c.problems).toEqual([
      { reason: '"Missing" is not an allowed option', count: 2 },
      { reason: '"Odd" is not an allowed option', count: 1 },
    ]);
  });

  it('counts how many rows use each value, so used options can be locked', () => {
    const c = checkField({ key: 'o', label: 'Obstructions', type: 'multiselect', options: ['Garbage', 'Pole', 'Barricade'] },
      ['Garbage|Pole', 'Garbage', '', 'Pole']);
    expect(c.fit).toBe(4); // an empty cell fits an optional field
    expect(c.filled).toBe(3);
    expect(c.uses).toEqual({ Garbage: 2, Pole: 2 });
  });

  it('a required field reports its blank rows', () => {
    const c = checkField(sel(['Good'], { required: true }), ['Good', '', '  ']);
    expect(c.fit).toBe(1);
    expect(c.problems).toEqual([{ reason: 'is required', count: 2 }]);
  });

  it('a Date field given date-times imports them but says the time is dropped', () => {
    const c = checkField({ key: 'd', label: 'Day', type: 'date' }, ['2026-05-04T09:30', '2026-05-05', '2026-05-06 18:00']);
    expect(c.fit).toBe(3);
    expect(c.warnings).toEqual([{ reason: 'the time is dropped (only the date is kept)', count: 2 }]);
  });

  it('works on saved points as well as file cells (lists and numbers, not strings)', () => {
    const c = checkField({ key: 'o', label: 'Obstructions', type: 'multiselect', options: ['Garbage'] }, [['Garbage'], ['Garbage', 'Pole']]);
    expect(c.fit).toBe(1);
    expect(c.problems).toEqual([{ reason: '"Pole" is not an allowed option', count: 1 }]);
    expect(checkField({ key: 'n', label: 'Cars', type: 'number', integer: true }, [3, 4.5, '7']).problems)
      .toEqual([{ reason: 'must be a whole number', count: 1 }]);
  });
});

describe('summarizeErrors', () => {
  it('groups row errors into reasons with counts, most common first', () => {
    const errs = [
      { row: 1, error: 'Surface: "Missing" is not an allowed option', source: {} },
      { row: 4, error: 'no geometry (needs a geometry or lng/lat columns)', source: {} },
      { row: 7, error: 'Surface: "Missing" is not an allowed option', source: {} },
    ];
    expect(summarizeErrors(errs)).toEqual([
      { reason: 'Surface: "Missing" is not an allowed option', count: 2 },
      { reason: 'no geometry (needs a geometry or lng/lat columns)', count: 1 },
    ]);
  });
});
