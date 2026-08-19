// "Your maps" persistence (localStorage, per device). Holds maps you own AND
// maps shared with you (collect / view links you open) — autosaved on open so
// you get one-tap access without keeping the original message.

export type MapRole = 'owner' | 'collect' | 'view';
export interface SavedMap {
  id: string;
  name: string;
  role: MapRole;
  links: { edit?: string; admin?: string; view?: string };
  at: string;
}

const KEY = 'collect:maps';
const RANK: Record<MapRole, number> = { view: 1, collect: 2, owner: 3 };
const SLOT: Record<MapRole, 'edit' | 'admin' | 'view'> = { owner: 'admin', collect: 'edit', view: 'view' };

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

// The link to open for a saved map, and whether it also has an admin link.
export function openLink(m: SavedMap): string | undefined {
  return m.role === 'view' ? m.links.view : (m.links.edit || m.links.admin || m.links.view);
}

export function myMaps(): SavedMap[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]') as SavedMap[];
    // Back-fill role for entries saved before roles existed.
    return raw.map((m) => (m.role ? m : { ...m, role: (m.links?.admin ? 'owner' : m.links?.edit ? 'collect' : 'view') as MapRole }));
  } catch {
    return [];
  }
}

function write(maps: SavedMap[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(maps.slice(0, 100))); } catch { /* per-device convenience only */ }
}
export function replaceMaps(maps: SavedMap[]): void { write(maps); }

// Owner creating a map (all three links).
export function saveOwnedMap(id: string, name: string, links: { edit?: string; admin?: string; view?: string }): void {
  const maps = myMaps().filter((m) => m.id !== id);
  maps.unshift({ id, name: name || 'Untitled map', role: 'owner', links, at: new Date().toISOString() });
  write(maps);
}

// Autosave on open: remember the link you hold for a map (owner/collect/view).
export function rememberMap(id: string, name: string, role: MapRole, link: string): void {
  write(applyRemember(myMaps(), id, name, role, link, new Date().toISOString()));
}
