// token → permission on one collection (spec → "The three links"). The token
// rides the Authorization header; we look it up by prefix within the target
// collection and constant-time verify the hash.

import type { Env } from '../types';
import { tokenPrefix, firstVerified, type Permission } from './tokens';
import { tokensForCollection, getCollection, type CollectionRow } from './db';
import { bad } from './http';

const RANK: Record<Permission, number> = { view: 1, edit: 2, admin: 3 };

export function bearer(req: Request): string | null {
  const h = req.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// The link a token belongs to (its collection_tokens id) and its permission.
export async function linkFor(
  db: Pick<D1Database, 'prepare'>,
  collectionId: string,
  token: string | null,
): Promise<{ id: string; permission: Permission } | null> {
  if (!token) return null;
  const rows = (await tokensForCollection(db, collectionId, tokenPrefix(token))).filter((r) => r.is_active);
  const r = await firstVerified(token, rows, (x) => x.token_hash);
  return r ? { id: r.id, permission: r.permission } : null;
}

export async function permissionFor(
  db: Pick<D1Database, 'prepare'>,
  collectionId: string,
  token: string | null,
): Promise<Permission | null> {
  return (await linkFor(db, collectionId, token))?.permission ?? null;
}

export function atLeast(have: Permission | null, need: Permission): boolean {
  return have !== null && RANK[have] >= RANK[need];
}

/** Whether the request carries this map's admin link. */
export const isAdmin = async (env: Env, req: Request, id: string): Promise<boolean> =>
  atLeast(await permissionFor(env.DB, id, bearer(req)), 'admin');

export type Refuse = (status: number, gate: string, error: string) => Response;
const plainRefuse: Refuse = (status, _gate, error) => bad(status, error);

/** The gate every admin call on a map starts with: the map, or the refusal
 *  (401 'auth' without its admin link, 404 'not_found' when it is gone).
 *  A logging handler passes its own refuse so the gate is recorded. */
export async function adminMap(env: Env, req: Request, id: string, refuse: Refuse = plainRefuse): Promise<CollectionRow | Response> {
  if (!(await isAdmin(env, req, id))) return refuse(401, 'auth', 'unauthorised');
  return (await getCollection(env.DB, id)) ?? refuse(404, 'not_found', 'not found');
}
