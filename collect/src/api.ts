// Client-side helpers: parse the collection id + mode + token from the URL
// (token rides the fragment, never sent in a request line), and call the API.

import { keepOfflineCopy } from './offline-copies';
import { parseMapPath } from './map-path';

export type Mode = 'capture' | 'admin' | 'view' | 'record';

export interface Ctx {
  id: string;
  mode: Mode;
  token: string;
  recordId?: string;
}

export function parseCtx(): Ctx | null {
  const token = location.hash.replace(/^#/, '');
  const p = parseMapPath(location.pathname);
  if (!p) return null;
  if (p.recordId) return { id: p.id, mode: 'record', token, recordId: p.recordId };
  let mode: Mode = 'capture';
  if (p.page === 'admin' || token.startsWith('adm_')) mode = 'admin';
  else if (p.page === 'view' || token.startsWith('viw_')) mode = 'view';
  return { id: p.id, mode, token };
}

export async function api(path: string, token: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init?.body) headers.set('content-type', 'application/json');
  return fetch(`/api/collect/v1${path}`, { ...init, headers });
}

/** A server's refusal, with its HTTP status so the page can explain it. */
export class ApiError extends Error {
  /** The whole reply (e.g. attempt_id, or how many rows an import added before failing). */
  constructor(message: string, readonly status: number, readonly body: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
  }
}

// The JSON body of a response, or its error message thrown.
async function readJson<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((body as { error?: string }).error || `HTTP ${res.status}`, res.status, body as Record<string, unknown>);
  return body as T;
}

export const LINK_OFF =
  "This collect link no longer works. The map's owner may have turned the link off or deleted the map. Ask the person who shared it for a new link.";

/** Why a map couldn't open, in plain words. The server answers 401 for a turned-off
 *  link and for a map that doesn't exist alike, so it never reveals which maps exist. */
export function loadErrorText(e: unknown): string {
  if (e instanceof ApiError && e.status === 401) return LINK_OFF;
  return (e as Error)?.message || 'Something went wrong.';
}

export async function apiJson<T = unknown>(path: string, token: string, init?: RequestInit): Promise<T> {
  return readJson<T>(await api(path, token, init));
}

/** How long a load waits for the network before using the copy on the phone. */
export const NETWORK_WAIT_MS = 3500;

// For opening a map with no signal: keeps a copy of each successful load and
// returns it when the request can't be made at all (fetch throws), or when it
// takes longer than NETWORK_WAIT_MS (a stalled connection; the request carries
// on and refreshes the copy for next time). A real answer from the server in
// time, such as a link that was turned off, is never masked.
export async function jsonWithOfflineCopy<T>(
  key: string, request: () => Promise<Response>, store: Storage, maxChars = Infinity,
): Promise<{ data: T; offline: boolean }> {
  const saved = (): string | null => { try { return store.getItem(key); } catch { return null; } };
  const keep = async (res: Response): Promise<T> => {
    const data = await readJson<T>(res);
    const copy = JSON.stringify(data);
    // Too big to keep: drop any older copy too, so offline never shows an outdated one as current.
    if (copy.length > maxChars) { try { store.removeItem(key); } catch { /* blocked storage */ } }
    else keepOfflineCopy(store, key, copy);
    return data;
  };
  const fresh = request().then(keep);
  const have = saved();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = have === null ? null : new Promise<'slow'>((r) => { timer = setTimeout(() => r('slow'), NETWORK_WAIT_MS); });
  try {
    const first = await (slow ? Promise.race([fresh, slow]) : fresh);
    if (first !== 'slow') return { data: first as T, offline: false };
    fresh.catch(() => {}); // carries on in the background; a late refusal changes nothing
    return { data: JSON.parse(have!) as T, offline: true };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (have !== null) return { data: JSON.parse(have) as T, offline: true };
    throw new Error("You're offline, and this map hasn't been opened on this device with a connection yet.");
  } finally {
    clearTimeout(timer);
  }
}
