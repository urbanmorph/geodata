// Anonymous token generation, hashing, verification.
// Uses Web Crypto — works in Pages Functions runtime AND in vitest (Node 22).
//
// Token shape: "<prefix>_<32 chars>" — prefix encodes permission tier,
// suffix is 32 random URL-safe characters (~192 bits of entropy).
// Server stores token_prefix (first 8) + sha256(token); plaintext never persisted.

import { randomUrlSafe, sha256Hex } from './crypto';

export type Permission = 'admin' | 'edit' | 'view';

const PREFIX_MAP: Record<Permission, string> = {
  admin: 'adm',
  edit: 'edt',
  view: 'viw',
};

export function generateToken(permission: Permission): string {
  const prefix = PREFIX_MAP[permission];
  if (!prefix) throw new Error('unknown permission: ' + permission);
  return `${prefix}_${randomUrlSafe(32)}`; // 32 x 6 bits: ~192 bits of entropy
}

export function tokenPrefix(token: string): string {
  return token.length > 8 ? token.slice(0, 8) : token;
}

export function hashToken(token: string): Promise<string> {
  return sha256Hex(token);
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
