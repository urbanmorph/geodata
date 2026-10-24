// Dates and date-times as collect stores them: ISO 8601 only, so a value means
// the same thing to everyone who downloads it. A date written 04/05/2026 could
// be 4 May or 5 April, so it is never read as a date (see looksLikeLocalDate).

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/;
const LOCAL_DATE = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}(?:[ T].*)?$/;

function realDay(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** YYYY-MM-DD and a real calendar day. */
export function isDate(s: string): boolean {
  const m = DATE.exec(s);
  return !!m && realDay(+m[1], +m[2], +m[3]);
}

/** A valid ISO date-time, normalised to the T separator; null if not one. */
export function normalizeDateTime(s: string): string | null {
  const m = DATETIME.exec(s);
  if (!m || !realDay(+m[1], +m[2], +m[3]) || +m[4] > 23 || +m[5] > 59 || (m[6] !== undefined && +m[6] > 59)) return null;
  if (m[8] && m[8] !== 'Z' && (+m[8].slice(1, 3) > 14 || +m[8].slice(4) > 59)) return null; // offsets run -12:00 to +14:00
  return s.replace(' ', 'T');
}

/** The date part of a valid date-time (what a Date field keeps of it). */
export function datePart(s: string): string | null {
  return normalizeDateTime(s) ? s.slice(0, 10) : null;
}

/** Whether a phone's date-time picker can show this value as it is. A date-only
 *  value or one with an offset would show blank or lose the offset, so the
 *  record editor shows those in a text box instead. */
export function fitsLocalPicker(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s);
}

/** 04/05/2026, 4.5.26 and the like: a date whose day/month order is unclear. */
export function looksLikeLocalDate(s: string): boolean {
  return LOCAL_DATE.test(s);
}
