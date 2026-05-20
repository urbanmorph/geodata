// Tiny helpers used by the /api/submit endpoint. Pure functions where possible
// so they unit-test without a live request / D1.

const URLSAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function nanoid(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += URLSAFE[b & 0x3f];
  return out;
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

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

function todayUTC(now: () => Date): string {
  const d = now();
  return d.toISOString().slice(0, 10);
}

export async function ipHashFor(
  request: Request,
  salt: string,
  now: () => Date = () => new Date(),
): Promise<string> {
  const ip =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown';
  const material = `${ip}|${todayUTC(now)}|${salt}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
