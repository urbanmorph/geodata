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

export async function apiJson<T = unknown>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await api(path, token, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
  return body as T;
}
