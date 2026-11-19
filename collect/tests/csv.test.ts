// One CSV cell writer for every download: collect's points and its "rows not
// added" file, and bharatlas's filtered CSV export (shared/csv.mjs). A text cell
// that a spreadsheet would run as a formula gets a leading apostrophe.
import { describe, it, expect } from 'vitest';
import { csvCell } from '../../shared/csv.mjs';

describe('csvCell', () => {
  it('quotes a cell with a comma, quote or line break', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('cr\rhere')).toBe('"cr\rhere"');
  });
  it('writes nothing for null and undefined, and joins a list with |', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(['a', 'b'])).toBe('a|b');
  });
  it('defuses a text cell a spreadsheet would run as a formula', () => {
    for (const s of ['=1+1', '+91 98', '-x', '@SUM(A1)', '\tx']) expect(csvCell(s).startsWith("'") || csvCell(s).startsWith(`"'`)).toBe(true);
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
  });
  it('leaves numbers as they are, negative ones included', () => {
    expect(csvCell(-12.5)).toBe('-12.5');
    expect(csvCell(BigInt(-3))).toBe('-3');
    expect(csvCell(0)).toBe('0');
  });
});
