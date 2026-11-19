// The addresses of collect's map pages, one definition for the app (api.ts
// parseCtx), the Function that serves them (functions/c/[[path]].ts) and the
// links kept in Your maps (maps-store.ts): /c/<id>, /c/<id>/admin, /c/<id>/view
// and /c/<id>/r/<record id>.
const MAP_PATH = /^\/c\/([A-Za-z0-9_-]{6,})(?:\/(admin|view)|\/r\/([A-Za-z0-9_-]{6,}))?\/?$/;

export interface MapPath { id: string; page?: 'admin' | 'view'; recordId?: string }

/** The map (and page or record) an address opens, or null when it isn't one. */
export function parseMapPath(pathname: string): MapPath | null {
  const m = MAP_PATH.exec(pathname);
  if (!m) return null;
  return { id: m[1], ...(m[2] ? { page: m[2] as 'admin' | 'view' } : {}), ...(m[3] ? { recordId: m[3] } : {}) };
}
