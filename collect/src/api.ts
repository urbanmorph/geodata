// Client-side helpers: parse the collection id + mode + token from the URL
// (token rides the fragment, never sent in a request line), and call the API.

export type Mode = 'capture' | 'admin' | 'view' | 'record';

export interface Ctx {
  id: string;
  mode: Mode;
  token: string;
  recordId?: string;
}

export function parseCtx(): Ctx | null {
  const token = location.hash.replace(/^#/, '');
  const rec = location.pathname.match(/^\/c\/([A-Za-z0-9_-]{6,})\/r\/([A-Za-z0-9_-]{6,})\/?$/);
  if (rec) return { id: rec[1], mode: 'record', token, recordId: rec[2] };
  const m = location.pathname.match(/^\/c\/([A-Za-z0-9_-]{6,})(?:\/(admin|view))?\/?$/);
  if (!m) return null;
  let mode: Mode = 'capture';
  if (m[2] === 'admin' || token.startsWith('adm_')) mode = 'admin';
  else if (m[2] === 'view' || token.startsWith('viw_')) mode = 'view';
  return { id: m[1], mode, token };
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

// For opening a map with no signal: keeps a copy of each successful load and
// returns it only when the request can't be made at all (fetch throws). A real
// answer from the server, such as a link that was turned off, is never masked.
export async function jsonWithOfflineCopy<T>(
  key: string, request: () => Promise<Response>, store: Storage, maxChars = Infinity,
): Promise<{ data: T; offline: boolean }> {
  let res: Response;
  try {
    res = await request();
  } catch {
    const saved = store.getItem(key);
    if (saved) return { data: JSON.parse(saved) as T, offline: true };
    throw new Error("You're offline, and this map hasn't been opened on this device with a connection yet.");
  }
  const data = await readJson<T>(res);
  const copy = JSON.stringify(data);
  try {
    // Too big to keep: drop any older copy too, so offline never shows an outdated one as current.
    if (copy.length > maxChars) store.removeItem(key);
    else store.setItem(key, copy);
  } catch { /* storage full: still works online */ }
  return { data, offline: false };
}
