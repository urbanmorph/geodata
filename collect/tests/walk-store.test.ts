// A boundary walked with the GPS lives only in the page: if the phone kills the
// tab while it's in the background (a call, another app), the walk was lost.
// Its corners are now kept for the map on each reading and restored on reload.
import { describe, it, expect } from 'vitest';
import { saveWalk, loadWalk, clearWalk, type SavedWalk } from '../src/capture/walk-store';
import { createTrace } from '../src/capture/trace';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k),
    clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; },
  };
}
const walk: SavedWalk = { mode: 'polygon', how: 'walk', verts: [[77.59, 12.97], [77.5901, 12.97], [77.5901, 12.9701]], walking: true };

describe('the walk kept on the phone', () => {
  it('comes back for the same map, and only that map', () => {
    const s = memoryStorage();
    saveWalk(s, 'map1', walk);
    expect(loadWalk(s, 'map1')).toEqual(walk);
    expect(loadWalk(s, 'map2')).toBeNull();
  });

  it('is gone once cleared (saved or discarded)', () => {
    const s = memoryStorage();
    saveWalk(s, 'map1', walk);
    clearWalk(s, 'map1');
    expect(loadWalk(s, 'map1')).toBeNull();
  });

  it('an empty walk clears what was kept', () => {
    const s = memoryStorage();
    saveWalk(s, 'map1', walk);
    saveWalk(s, 'map1', { ...walk, verts: [] });
    expect(loadWalk(s, 'map1')).toBeNull();
  });

  it('ignores a copy it cannot use', () => {
    const s = memoryStorage();
    s.setItem('collect:walk:map1', 'not json');
    expect(loadWalk(s, 'map1')).toBeNull();
    s.setItem('collect:walk:map1', JSON.stringify({ mode: 'point', how: 'walk', verts: [[1, 2]] }));
    expect(loadWalk(s, 'map1')).toBeNull();
    s.setItem('collect:walk:map1', JSON.stringify({ ...walk, verts: [[1, 'x']] }));
    expect(loadWalk(s, 'map1')).toBeNull();
  });

  it('a storage that refuses (private mode, full) never breaks the walk', () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); }, removeItem: () => { throw new Error('denied'); } } as unknown as Storage;
    expect(() => saveWalk(broken, 'm', walk)).not.toThrow();
    expect(loadWalk(broken, 'm')).toBeNull();
    expect(() => clearWalk(broken, 'm')).not.toThrow();
  });
});

describe('a walk picked up again', () => {
  it('starts from the kept corners, paused until the walker resumes', () => {
    const t = createTrace(walk.verts);
    expect(t.points()).toEqual(walk.verts);
    expect(t.paused()).toBe(true);
    t.resume();
    expect(t.add({ lng: 77.5905, lat: 12.9705, accuracy: 5, t: 0 })).toBe('added');
    expect(t.points()).toHaveLength(4);
  });
});
