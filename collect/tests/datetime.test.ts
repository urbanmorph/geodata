// "Date and time" fields: survey, sensor and complaint data carry timestamps.
// Before this type existed a timestamp column was guessed as a Date field and
// every row failed the date check (silently dropped at "Create map & import").
import { describe, it, expect } from 'vitest';
import { validateRecordProperties, type Field } from '../src/schema/validate-record';

const F: Field[] = [{ key: 'seen', label: 'Seen at', type: 'datetime' }];
const ok = (v: string) => validateRecordProperties(F, { seen: v });

describe('datetime field', () => {
  it('accepts ISO date-times, with or without seconds and offset, and normalises the separator', () => {
    expect(ok('2026-05-04T09:30')).toEqual({ ok: true, properties: { seen: '2026-05-04T09:30' } });
    expect(ok('2026-05-04 09:30:15')).toEqual({ ok: true, properties: { seen: '2026-05-04T09:30:15' } });
    expect(ok('2026-05-04T09:30:00+05:30').ok).toBe(true);
    expect(ok('2026-05-04T04:00:00.000Z').ok).toBe(true);
  });

  it('accepts a date with no time (less precise, nothing lost)', () => {
    expect(ok('2026-05-04')).toEqual({ ok: true, properties: { seen: '2026-05-04' } });
  });

  it('refuses impossible or ambiguous values', () => {
    for (const bad of ['2026-13-04T09:30', '2026-02-30T09:30', '2026-05-04T25:00', '2026-05-04T09:61', '04/05/2026 09:30', 'soon']) {
      const r = ok(bad);
      expect(r.ok, bad).toBe(false);
      expect(!r.ok && r.error).toMatch(/Seen at must be a valid date and time/);
    }
  });
});

describe('editing a saved date-time', () => {
  it("the phone's date-time picker can show local times, not ones with an offset", async () => {
    const { fitsLocalPicker } = await import('../src/schema/dates');
    expect(fitsLocalPicker('2026-05-04T09:30')).toBe(true);
    expect(fitsLocalPicker('2026-05-04T09:30:15')).toBe(true);
    expect(fitsLocalPicker('2026-05-04')).toBe(false);          // a date-only value would show blank
    expect(fitsLocalPicker('2026-05-04T09:30:00+05:30')).toBe(false); // the offset would be lost
  });
});

describe('offsets', () => {
  it('refuses an impossible offset', () => {
    expect(validateRecordProperties(F, { seen: '2026-05-04T09:30+99:99' }).ok).toBe(false);
    expect(validateRecordProperties(F, { seen: '2026-05-04T09:30+05:30' }).ok).toBe(true);
  });
});
