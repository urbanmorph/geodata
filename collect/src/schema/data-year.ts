// A map's "Data year", as typed (wizard, Edit settings) or sent (the API): blank
// is no year; anything else must be a whole year 1800-2100. A typo is refused,
// never read as "no year".
export const DATA_YEAR_ERROR = 'Data year must be a whole number like 2026 (1800 to 2100).';

export function readDataYear(v: unknown): { ok: true; value: number | null } | { ok: false; error: string } {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return { ok: true, value: null };
  const y = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(y) && y >= 1800 && y <= 2100 ? { ok: true, value: y } : { ok: false, error: DATA_YEAR_ERROR };
}
