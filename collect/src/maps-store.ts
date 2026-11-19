// "Your maps" persistence (localStorage, per device). Holds maps you own AND
// maps shared with you (collect / view links you open) — autosaved on open so
// you get one-tap access without keeping the original message. Also holds the
// edit links of records you added (their rec_ token is the only way back to
// edit, delete or de-identify them — there are no accounts).

import { dropOfflineCopies } from './offline-copies';

export type MapRole = 'owner' | 'collect' | 'view';
export interface SavedRecord { id: string; label: string; link: string; at: string; }
export interface SavedMap {
  id: string;
  name: string;
  role: MapRole;
  links: { edit?: string; admin?: string; view?: string };
  records?: SavedRecord[];
  at: string;
  /** Admin links replaced on some device: they no longer work, and sync must not bring them back. */
  retired?: string[];
}

const KEY = 'collect:maps';
// Only maps that are a mere convenience (opened from someone's view/collect
// link, nothing of yours inside) are capped; owned maps and maps holding your
// record links are never dropped.
export const MAX_SHARED = 100;
const RANK: Record<MapRole, number> = { view: 1, collect: 2, owner: 3 };
const SLOT: Record<MapRole, 'edit' | 'admin' | 'view'> = { owner: 'admin', collect: 'edit', view: 'view' };

const roleFromLinks = (l: SavedMap['links'] | undefined): MapRole => (l?.admin ? 'owner' : l?.edit ? 'collect' : 'view');

// Pure upsert core (testable): merge by id, never downgrade role, keep name fresh.
export function applyRemember(maps: SavedMap[], id: string, name: string, role: MapRole, link: string, now: string): SavedMap[] {
  const list = maps.slice();
  const e = list.find((m) => m.id === id);
  if (e) {
    if (name) e.name = name;
    e.links = { ...e.links, [SLOT[role]]: link };
    if (RANK[role] > RANK[e.role]) e.role = role;
    return list;
  }
  list.unshift({ id, name: name || 'Untitled map', role, links: { [SLOT[role]]: link }, at: now });
  return list;
}

// Remember a record you added (pure). The map entry is created as 'collect' if
// it isn't saved yet; an existing entry keeps its role.
export function applyRecord(
  maps: SavedMap[], mapId: string, mapName: string, rec: Omit<SavedRecord, 'at'>, now: string,
): SavedMap[] {
  const list = maps.map((m) => ({ ...m }));
  let e = list.find((m) => m.id === mapId);
  if (!e) {
    e = { id: mapId, name: mapName || 'Untitled map', role: 'collect', links: {}, at: now };
    list.unshift(e);
  }
  e.records = [{ ...rec, at: now }, ...(e.records ?? []).filter((r) => r.id !== rec.id)];
  return list;
}

export function dropRecord(maps: SavedMap[], mapId: string, recordId: string): SavedMap[] {
  return maps.map((m) => (m.id === mapId ? { ...m, records: (m.records ?? []).filter((r) => r.id !== recordId) } : m));
}

export function capMaps(maps: SavedMap[]): SavedMap[] {
  let shared = 0;
  return maps.filter((m) => m.role === 'owner' || (m.records?.length ?? 0) > 0 || ++shared <= MAX_SHARED);
}

const COLLECT_HOST = 'collect.bharatlas.com';
const MAP_PATH = /^\/c\/[A-Za-z0-9_-]{6,}(?:\/(?:admin|view)|\/r\/[A-Za-z0-9_-]{6,})?\/?$/;

/** Whether a saved link opens a collect map: collect's own host (or this page's,
 *  for a preview or local development), over https (http only on localhost),
 *  and a /c/ map path. A synced copy is data from
 *  elsewhere, so anything else (another site, javascript:) is dropped. */
export function isCollectLink(link: unknown, here = typeof location === 'undefined' ? COLLECT_HOST : location.host): boolean {
  if (typeof link !== 'string') return false;
  let u: URL;
  try { u = new URL(link); } catch { return false; }
  const secure = u.protocol === 'https:' || (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(u.host));
  const ours = secure && (u.host === COLLECT_HOST || u.host === here);
  return ours && MAP_PATH.test(u.pathname);
}

// Restore from a saved file, or sync: union links and records per map (highest
// role wins) rather than keeping whichever copy came first; a link retired on
// any device is dropped everywhere. Malformed rows, and links that don't open a
// collect map, are dropped.
export function mergeMaps(incoming: SavedMap[], existing: SavedMap[]): SavedMap[] {
  const byId = new Map<string, SavedMap>();
  const candidates = new Map<string, SavedMap['links'][]>(); // every copy's links, first copy first
  for (const m of [...incoming, ...existing]) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id) continue;
    const links = m.links && typeof m.links === 'object' ? m.links : {};
    const role = m.role && RANK[m.role] ? m.role : roleFromLinks(links);
    const records = Array.isArray(m.records) ? m.records.filter((r) => r && typeof r.id === 'string' && isCollectLink(r.link)) : [];
    const retired = Array.isArray(m.retired) ? m.retired.filter((l) => typeof l === 'string') : [];
    candidates.set(m.id, [...(candidates.get(m.id) ?? []), links]);
    const e = byId.get(m.id);
    if (!e) {
      byId.set(m.id, { id: m.id, name: m.name || 'Untitled map', role, links: {}, records, at: m.at || '', ...(retired.length ? { retired } : {}) });
      continue;
    }
    if (RANK[role] > RANK[e.role]) e.role = role;
    e.records = [...(e.records ?? []), ...records.filter((r) => !e.records?.some((x) => x.id === r.id))];
    if (retired.length) e.retired = [...new Set([...(e.retired ?? []), ...retired])];
  }
  for (const e of byId.values()) {
    for (const links of candidates.get(e.id)!) {
      for (const slot of ['edit', 'admin', 'view'] as const) {
        const l = links[slot];
        if (isCollectLink(l) && !e.links[slot] && !e.retired?.includes(l!)) e.links[slot] = l;
      }
    }
  }
  return [...byId.values()];
}

// The admin link was replaced (Manage, Share): keep the new one, retire the old
// one(s) so a synced or restored copy never brings them back (pure).
export function applyAdminReplace(maps: SavedMap[], id: string, name: string, oldLink: string, newLink: string, now: string): SavedMap[] {
  const old = maps.find((m) => m.id === id)?.links.admin; // read first: applyRemember updates the entry in place
  const list = applyRemember(maps, id, name, 'owner', newLink, now);
  const e = list.find((m) => m.id === id)!;
  e.retired = [...new Set([...(e.retired ?? []), oldLink, ...(old && old !== newLink ? [old] : [])])];
  return list;
}

// A short label for a record in "Your points": its first text value.
export function recordLabel(props: Record<string, unknown>, noun: string): string {
  const first = Object.values(props).find((v): v is string => typeof v === 'string' && v.trim() !== '');
  return first ? first.trim().slice(0, 80) : `Your ${noun}`;
}

// The link to open for a saved map, and whether it also has an admin link.
export function openLink(m: SavedMap): string | undefined {
  return m.role === 'view' ? m.links.view : (m.links.edit || m.links.admin || m.links.view);
}

// Where a contributor goes back to from their own point's page: the map link
// saved on this device, else home (their rec_ token can't open the map).
export function backLink(maps: SavedMap[], id: string): string {
  const m = maps.find((x) => x.id === id);
  return (m && openLink(m)) || '/';
}

export function myMaps(): SavedMap[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]') as SavedMap[];
    // Back-fill role for entries saved before roles existed.
    return raw.map((m) => (m.role ? m : { ...m, role: roleFromLinks(m.links) }));
  } catch {
    return [];
  }
}

export const MAPS_CHANGED = 'collect:maps-changed';

/** Saves the list; false when this device's storage refused it. The offline
 *  copies of maps give way first: this list is the only copy of admin links. */
function write(maps: SavedMap[]): boolean {
  const json = JSON.stringify(capMaps(maps));
  let ok = false;
  try {
    try { localStorage.setItem(KEY, json); } catch { dropOfflineCopies(localStorage); localStorage.setItem(KEY, json); }
    ok = true;
  } catch { /* storage blocked or still full: the caller says so where it matters */ }
  // Lets keyring sync (when the user turned it on) push the change.
  if (ok && typeof window !== 'undefined') window.dispatchEvent(new Event(MAPS_CHANGED));
  return ok;
}
export function replaceMaps(maps: SavedMap[]): void { write(maps); }

// Ask the browser not to evict these links under storage pressure. Called only
// after the user saves something of theirs (a map or a record), never on load.
// Best-effort: some browsers grant silently, Firefox may ask, others ignore it.
function keepStorage(): void {
  try { void navigator.storage?.persist?.(); } catch { /* unsupported */ }
}

// Owner creating a map (all three links). False when it couldn't be saved on
// this device: the page then shows the admin link to keep by hand.
export function saveOwnedMap(id: string, name: string, links: { edit?: string; admin?: string; view?: string }): boolean {
  const all = myMaps();
  const prev = all.find((m) => m.id === id);
  const maps = all.filter((m) => m.id !== id);
  maps.unshift({ id, name: name || 'Untitled map', role: 'owner', links, records: prev?.records, at: new Date().toISOString() });
  const ok = write(maps);
  keepStorage();
  return ok;
}

export function replaceAdminLink(id: string, name: string, oldLink: string, newLink: string): void {
  write(applyAdminReplace(myMaps(), id, name, oldLink, newLink, new Date().toISOString()));
  keepStorage();
}

// Autosave on open: remember the link you hold for a map (owner/collect/view).
export function rememberMap(id: string, name: string, role: MapRole, link: string): void {
  write(applyRemember(myMaps(), id, name, role, link, new Date().toISOString()));
}

export function rememberRecord(mapId: string, mapName: string, rec: Omit<SavedRecord, 'at'>): void {
  // The owner editing a point opens it with the admin link: that isn't one of their additions.
  if (/#adm_/.test(rec.link)) return;
  write(applyRecord(myMaps(), mapId, mapName, rec, new Date().toISOString()));
  keepStorage();
}

export function forgetRecord(mapId: string, recordId: string): void {
  write(dropRecord(myMaps(), mapId, recordId));
}
