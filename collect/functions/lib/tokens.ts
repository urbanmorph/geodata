// web's token primitives (web/functions/lib/tokens.ts), used unchanged, plus the
// record-scoped `rec_` token that edits, deletes or de-identifies one's own
// contribution.

import { generateToken, verifyToken } from '../../../web/functions/lib/tokens';

export { generateToken, tokenPrefix, hashToken, verifyToken } from '../../../web/functions/lib/tokens';
export type { Permission } from '../../../web/functions/lib/tokens';

/** Of the rows found by a token's prefix, the first whose stored hash the token
 *  verifies against (each compare is constant-time), or null. */
export async function firstVerified<R>(token: string, rows: R[], hashOf: (r: R) => string): Promise<R | null> {
  for (const r of rows) if (await verifyToken(token, hashOf(r))) return r;
  return null;
}

/** `rec_` + 32 URL-safe chars (~192 bits): web's generator, under its own prefix. */
export function generateRecordToken(): string {
  return `rec_${generateToken('edit').slice('edt_'.length)}`;
}
