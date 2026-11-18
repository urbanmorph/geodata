// A route or boundary being marked with the GPS (walked, or corner by corner),
// kept for its map on every reading, so a phone that kills the backgrounded tab
// doesn't lose the walk: reloading the map brings the corners back. Cleared once
// the shape is saved or discarded. Session storage: it lives with the tab.
import type { LngLat } from '../geo/measure';

export interface SavedWalk {
  mode: 'line' | 'polygon';
  how: 'walk' | 'corners';
  verts: LngLat[];
  /** A walk was still being recorded (it comes back paused, to resume). */
  walking: boolean;
}

const key = (mapId: string): string => `collect:walk:${mapId}`;

/** Keeps the walk (an empty one clears it). Never throws: storage may refuse. */
export function saveWalk(store: Storage, mapId: string, w: SavedWalk): void {
  try {
    if (w.verts.length) store.setItem(key(mapId), JSON.stringify(w));
    else store.removeItem(key(mapId));
  } catch { /* private mode or full: the walk still works, it just isn't kept */ }
}

export function clearWalk(store: Storage, mapId: string): void {
  try { store.removeItem(key(mapId)); } catch { /* nothing kept */ }
}

const isLngLat = (v: unknown): v is LngLat =>
  Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

export function loadWalk(store: Storage, mapId: string): SavedWalk | null {
  try {
    const w = JSON.parse(store.getItem(key(mapId)) ?? 'null') as Partial<SavedWalk> | null;
    if (!w || (w.mode !== 'line' && w.mode !== 'polygon') || (w.how !== 'walk' && w.how !== 'corners')) return null;
    if (!Array.isArray(w.verts) || !w.verts.length || !w.verts.every(isLngLat)) return null;
    return { mode: w.mode, how: w.how, verts: w.verts, walking: w.walking === true };
  } catch {
    return null;
  }
}
