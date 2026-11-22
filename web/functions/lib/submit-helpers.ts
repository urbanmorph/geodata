// Tiny helpers used by the /api/submit endpoint (and collect, via its
// reuse.ts). Pure functions where possible so they unit-test without a live
// request / D1.
import { ipSalt, randomUrlSafe, sha256Hex } from './crypto';
import { rateKeySource } from './api-ratelimit';

export { ipSalt, sha256Hex };

/** The salt for hashing a submitter's or voter's IP (submit and rate share it). */
export const submitterSalt = (env: { IP_SALT?: string }): string => ipSalt(env.IP_SALT, 'geodata-v1');

export const nanoid = (length: number): string => randomUrlSafe(length);

const FALLBACK_NAME = 'upload.bin';
const MAX_NAME_LEN = 100;

export function sanitizeFilename(name: string): string {
  if (!name || !name.trim()) return FALLBACK_NAME;
  let s = name.replace(/[\x00-\x1F\x7F]/g, '_');
  s = s.replace(/[\\/]+/g, '_');
  s = s.replace(/^[._-]+/, '').replace(/_+/g, '_');
  if (!s) return FALLBACK_NAME;
  if (s.length <= MAX_NAME_LEN) return s;
  const dot = s.lastIndexOf('.');
  if (dot < 0 || s.length - dot > 10) return s.slice(0, MAX_NAME_LEN);
  const ext = s.slice(dot);
  const stem = s.slice(0, MAX_NAME_LEN - ext.length);
  return stem + ext;
}

/** The client (CF-Connecting-IP only, never X-Forwarded-For), as one IPv4
 *  address or one IPv6 /64: a host holds a whole /64, so hashing the full
 *  address let it mint new rate-limit buckets. */
function clientOf(request: Request): string {
  return rateKeySource(request.headers.get('cf-connecting-ip') || 'unknown');
}

export async function ipHashFor(
  request: Request,
  salt: string,
  now: () => Date = () => new Date(),
): Promise<string> {
  // On Cloudflare Pages CF-Connecting-IP is always set; the missing case falls
  // through to 'unknown' so a single shared bucket absorbs any anomaly rather
  // than attackers minting fresh hashes via XFF rotation.
  return sha256Hex(`${clientOf(request)}|${now().toISOString().slice(0, 10)}|${salt}`);
}

/** The same IP hash without the date: for one vote per IP for good (ratings).
 *  ipHashFor's daily hash is for daily limits; reused for votes, it let the
 *  same IP vote again every day (review 2026-11-18). */
export async function ipHashStable(request: Request, salt: string): Promise<string> {
  return sha256Hex(`${clientOf(request)}|vote|${salt}`);
}

/** The optional "Data year" field: a four-digit year from 1800 to next year,
 *  null when blank, or an Error saying what is wrong (parseInt took "20x9" as 20). */
export function parseDataYear(raw: string, now = new Date()): number | null | Error {
  if (!raw) return null;
  const max = now.getUTCFullYear() + 1;
  const y = /^\d{4}$/.test(raw) ? Number(raw) : NaN;
  return y >= 1800 && y <= max ? y : new Error(`data_year must be a year from 1800 to ${max}`);
}
