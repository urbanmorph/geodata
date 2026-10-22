// "Your maps" persistence (localStorage, per device). Holds maps you own AND
// maps shared with you (collect / view links you open) — autosaved on open so
// you get one-tap access without keeping the original message. Also holds the
// edit links of records you added (their rec_ token is the only way back to
// edit, delete or de-identify them — there are no accounts).

export type MapRole = 'owner' | 'collect' | 'view';
export interface SavedRecord { id: string; label: string; link: string; at: string; }
export interface SavedMap {
  id: string;
  name: string;
  role: MapRole;
  links: { edit?: string; admin?: string; view?: string };
  records?: SavedRecord[];
  at: string;
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

// Restore from a saved file: union links and records per map (highest role
// wins) rather than keeping whichever copy came first. Malformed rows dropped.
export function mergeMaps(incoming: SavedMap[], existing: SavedMap[]): SavedMap[] {
  const byId = new Map<string, SavedMap>();
  for (const m of [...incoming, ...existing]) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id) continue;
    const links = m.links && typeof m.links === 'object' ? m.links : {};
    const role = m.role && RANK[m.role] ? m.role : roleFromLinks(links);
    const records = Array.isArray(m.records) ? m.records.filter((r) => r && typeof r.id === 'string' && typeof r.link === 'string') : [];
    const e = byId.get(m.id);
    if (!e) {
      byId.set(m.id, { id: m.id, name: m.name || 'Untitled map', role, links: { ...links }, records, at: m.at || '' });
      continue;
    }
    e.links = { ...links, ...e.links };
    if (RANK[role] > RANK[e.role]) e.role = role;
    e.records = [...(e.records ?? []), ...records.filter((r) => !e.records?.some((x) => x.id === r.id))];
  }
  return [...byId.values()];
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

export function myMaps(): SavedMap[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]') as SavedMap[];
    // Back-fill role for entries saved before roles existed.
    return raw.map((m) => (m.role ? m : { ...m, role: roleFromLinks(m.links) }));
  } catch {
    return [];
  }
}

function write(maps: SavedMap[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(capMaps(maps))); } catch { /* per-device convenience only */ }
}
export function replaceMaps(maps: SavedMap[]): void { write(maps); }

// Ask the browser not to evict these links under storage pressure. Called only
// after the user saves something of theirs (a map or a record), never on load.
// Best-effort: some browsers grant silently, Firefox may ask, others ignore it.
function keepStorage(): void {
  try { void navigator.storage?.persist?.(); } catch { /* unsupported */ }
}

// Owner creating a map (all three links).
export function saveOwnedMap(id: string, name: string, links: { edit?: string; admin?: string; view?: string }): void {
  const prev = myMaps().find((m) => m.id === id);
  const maps = myMaps().filter((m) => m.id !== id);
  maps.unshift({ id, name: name || 'Untitled map', role: 'owner', links, records: prev?.records, at: new Date().toISOString() });
  write(maps);
  keepStorage();
}

// Autosave on open: remember the link you hold for a map (owner/collect/view).
export function rememberMap(id: string, name: string, role: MapRole, link: string): void {
  write(applyRemember(myMaps(), id, name, role, link, new Date().toISOString()));
}

export function rememberRecord(mapId: string, mapName: string, rec: Omit<SavedRecord, 'at'>): void {
  write(applyRecord(myMaps(), mapId, mapName, rec, new Date().toISOString()));
  keepStorage();
}

export function forgetRecord(mapId: string, recordId: string): void {
  write(dropRecord(myMaps(), mapId, recordId));
}
