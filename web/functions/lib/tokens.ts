// Anonymous token generation, hashing, verification.
// Uses Web Crypto — works in Pages Functions runtime AND in vitest (Node 22).
//
// Token shape: "<prefix>_<32 chars>" — prefix encodes permission tier,
// suffix is 32 random URL-safe characters (~192 bits of entropy).
// Server stores token_prefix (first 8) + sha256(token); plaintext never persisted.

export type Permission = 'admin' | 'edit' | 'view';

const PREFIX_MAP: Record<Permission, string> = {
  admin: 'adm',
  edit: 'edt',
  view: 'viw',
};

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function generateToken(permission: Permission): string {
  const prefix = PREFIX_MAP[permission];
  if (!prefix) throw new Error('unknown permission: ' + permission);
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let out = '';
  // 6 bits per char from a 64-char alphabet — convert each byte to a char.
  // We just take the low 6 bits of each random byte. ~192 bits of entropy total.
  for (const b of bytes) out += ALPHABET[b & 0x3f];
  return `${prefix}_${out}`;
}

export function tokenPrefix(token: string): string {
  return token.length > 8 ? token.slice(0, 8) : token;
}

export async function hashToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Constant-time hash comparison via SHA-256 of the candidate token.
 * Returns false on any mismatch including length differences.
 */
export async function verifyToken(candidate: string, expectedHash: string): Promise<boolean> {
  if (!candidate || typeof candidate !== 'string') return false;
  const actualHash = await hashToken(candidate);
  if (actualHash.length !== expectedHash.length) return false;
  // Constant-time compare on the hex strings (already same length).
  let diff = 0;
  for (let i = 0; i < actualHash.length; i++) {
    diff |= actualHash.charCodeAt(i) ^ expectedHash.charCodeAt(i);
  }
  return diff === 0;
}
