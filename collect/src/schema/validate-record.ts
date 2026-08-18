// Validate a contributor's submitted properties against a collection's field
// definition (spec → "POST /collections/:id/records", step 2). Required fields
// present, select ∈ options, number numeric, url http(s), date valid; unknown
// keys dropped; soft-deleted fields omitted. Returns the cleaned properties.

export type FieldType =
  | 'text' | 'paragraph' | 'number' | 'select' | 'multiselect' | 'date' | 'url';

export interface Field {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: string[];   // select / multiselect
  min?: number;         // number
  max?: number;         // number
  integer?: boolean;    // number
  maxLength?: number;   // text / paragraph
  deleted?: boolean;    // soft-deleted → never read or written
}

export type ValidateResult =
  | { ok: true; properties: Record<string, unknown> }
  | { ok: false; error: string };

const DEFAULT_MAXLEN: Record<string, number> = { text: 500, paragraph: 5000 };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false; // numbers (incl. 0), booleans, objects are "present"
}

function validDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function validUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const err = (msg: string): ValidateResult => ({ ok: false, error: msg });

export function validateRecordProperties(fields: Field[], input: unknown): ValidateResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return err('properties must be an object');
  }
  const src = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const f of fields) {
    if (f.deleted) continue;                 // soft-deleted → omit entirely
    const v = src[f.key];

    if (isEmpty(v)) {
      if (f.required) return err(`${f.label} is required`);
      continue;                              // optional + empty → omit
    }

    switch (f.type) {
      case 'text':
      case 'paragraph': {
        if (typeof v !== 'string') return err(`${f.label} must be text`);
        const cap = f.maxLength ?? DEFAULT_MAXLEN[f.type];
        if (v.length > cap) return err(`${f.label} is too long (max ${cap})`);
        out[f.key] = v;
        break;
      }
      case 'number': {
        const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
        if (!Number.isFinite(n)) return err(`${f.label} must be a number`);
        if (f.integer && !Number.isInteger(n)) return err(`${f.label} must be a whole number`);
        if (f.min !== undefined && n < f.min) return err(`${f.label} must be at least ${f.min}`);
        if (f.max !== undefined && n > f.max) return err(`${f.label} must be at most ${f.max}`);
        out[f.key] = n;
        break;
      }
      case 'select': {
        if (typeof v !== 'string' || !(f.options ?? []).includes(v)) {
          return err(`${f.label}: "${String(v)}" is not an allowed option`);
        }
        out[f.key] = v;
        break;
      }
      case 'multiselect': {
        if (!Array.isArray(v)) return err(`${f.label} must be a list`);
        const opts = f.options ?? [];
        for (const item of v) {
          if (typeof item !== 'string' || !opts.includes(item)) {
            return err(`${f.label}: "${String(item)}" is not an allowed option`);
          }
        }
        out[f.key] = v;
        break;
      }
      case 'date': {
        if (typeof v !== 'string' || !validDate(v)) {
          return err(`${f.label} must be a valid date (YYYY-MM-DD)`);
        }
        out[f.key] = v;
        break;
      }
      case 'url': {
        if (typeof v !== 'string' || !validUrl(v)) return err(`${f.label} must be an http(s) URL`);
        out[f.key] = v;
        break;
      }
      default:
        return err(`${f.label}: unknown field type`);
    }
  }
  return { ok: true, properties: out };
}
