// Reuse web's token primitives unchanged (Phase 1 → promote to shared/ at
// Phase 2). Adds the record-scoped `rec_` token used for edit / delete /
// de-identify of one's own contribution.

export { generateToken, tokenPrefix, hashToken, verifyToken } from '../../../web/functions/lib/tokens';
export type { Permission } from '../../../web/functions/lib/tokens';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** `rec_` + 32 URL-safe chars (~192 bits), same shape as the collection tokens. */
export function generateRecordToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b & 0x3f];
  return `rec_${out}`;
}
