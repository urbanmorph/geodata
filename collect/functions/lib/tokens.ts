// web's token primitives (web/functions/lib/tokens.ts), used unchanged, plus the
// record-scoped `rec_` token that edits, deletes or de-identifies one's own
// contribution.

import { generateToken } from '../../../web/functions/lib/tokens';

export { generateToken, tokenPrefix, hashToken, verifyToken } from '../../../web/functions/lib/tokens';
export type { Permission } from '../../../web/functions/lib/tokens';

/** `rec_` + 32 URL-safe chars (~192 bits): web's generator, under its own prefix. */
export function generateRecordToken(): string {
  return `rec_${generateToken('edit').slice('edt_'.length)}`;
}
