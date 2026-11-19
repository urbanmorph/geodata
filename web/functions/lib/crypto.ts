// The two crypto helpers the functions share: SHA-256 as hex, and random
// URL-safe ids (submission ids, share tokens). Web Crypto only, so they run in
// Workers and in vitest alike.

const URLSAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** `length` random characters from the 64 URL-safe ones (6 bits each). */
export function randomUrlSafe(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += URLSAFE[b & 0x3f];
  return out;
}

/** SHA-256 of a string (UTF-8) or bytes, as 64 hex characters. */
export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const warned = new Set<string>();

/** The IP_SALT secret, or `fallback` when it is unset. The fallback is in this
 *  public repo, so hashes made with it can be reversed by trying every IPv4
 *  address: an unset secret is reported (once per isolate) in the Worker log. */
export function ipSalt(salt: string | undefined, fallback: string): string {
  if (salt) return salt;
  if (!warned.has(fallback)) {
    warned.add(fallback);
    console.error(`IP_SALT is not set: IP hashes use ${fallback ? `the public fallback "${fallback}"` : 'no salt'}, so they can be reversed. Set the IP_SALT secret.`);
  }
  return fallback;
}

