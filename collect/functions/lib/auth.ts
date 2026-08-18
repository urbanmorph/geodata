// token → permission on one collection (spec → "The three links"). The token
// rides the Authorization header; we look it up by prefix within the target
// collection and constant-time verify the hash.

import { tokenPrefix, verifyToken, type Permission } from './tokens';
import { tokensForCollection } from './db';

const RANK: Record<Permission, number> = { view: 1, edit: 2, admin: 3 };

export function bearer(req: Request): string | null {
  const h = req.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export async function permissionFor(
  db: Pick<D1Database, 'prepare'>,
  collectionId: string,
  token: string | null,
): Promise<Permission | null> {
  if (!token) return null;
  const rows = await tokensForCollection(db, collectionId, tokenPrefix(token));
  for (const r of rows) {
    if (r.is_active && (await verifyToken(token, r.token_hash))) return r.permission;
  }
  return null;
}

export function atLeast(have: Permission | null, need: Permission): boolean {
  return have !== null && RANK[have] >= RANK[need];
}
