// Shared request helpers for the function tests: build an API request, read a
// JSON answer, make a map.
import * as h from '../../../functions/lib/handlers';
import type { Env } from '../../../functions/types';

export const O = 'https://collect.test';

/** A request to /api/collect/v1<path>. A Uint8Array body goes as bytes (image/jpeg
 *  unless a content-type is given); anything else goes as JSON. */
export function req(method: string, path: string, token = '', body?: unknown, headers: Record<string, string> = {}): Request {
  const hd: Record<string, string> = { ...headers };
  if (token) hd.authorization = `Bearer ${token}`;
  let b: BodyInit | undefined;
  if (body instanceof Uint8Array) { b = body; hd['content-type'] ??= 'image/jpeg'; }
  else if (body !== undefined) { b = JSON.stringify(body); hd['content-type'] = 'application/json'; }
  else hd['content-type'] ??= 'application/json';
  return new Request(`${O}/api/collect/v1${path}`, { method, headers: hd, body: b });
}

export const j = async (r: Response) => ({ status: r.status, body: (await r.json()) as Record<string, any> });

export type MapOpts = {
  name?: string;
  purpose?: string;
  fields?: unknown;
  mode?: string;
  moderation?: number;
  geometry?: string[];
  /** Extra keys for schema_doc. */
  schema?: Record<string, unknown>;
  /** Extra top-level keys for the create body. */
  extra?: Record<string, unknown>;
};

const NAME_FIELD = [{ key: 'name', label: 'Name', type: 'text', required: true }];

/** POST /collections with test defaults ("Ward trees", one required Name field). */
export const createMap = (env: Env, o: MapOpts = {}) => h.createCollection(env, req('POST', '/collections', '', {
  name: o.name ?? 'Ward trees', purpose: o.purpose ?? 'Street trees', license: 'CC-BY-4.0',
  ...(o.moderation === undefined ? {} : { moderation: o.moderation }),
  schema_doc: { version: 1, geometry: o.geometry ?? ['point'], fields: o.fields ?? NAME_FIELD, ...(o.mode ? { mode: o.mode } : {}), ...o.schema },
  ...o.extra,
}));

/** Makes a map and returns its id and links; throws if the create is refused. */
export async function makeMap(env: Env, o: MapOpts = {}) {
  const r = await j(await createMap(env, o));
  if (r.status !== 200) throw new Error(`create refused: ${r.status} ${JSON.stringify(r.body)}`);
  const t = r.body.tokens as Record<string, string>;
  return { id: r.body.id as string, admin: t.admin, edit: t.edit, view: t.view };
}
