import { describe, it, expect } from 'vitest';
import { applyRemember, openLink, type SavedMap } from '../src/maps-store';

const T = '2026-08-19T00:00:00Z';

describe('applyRemember', () => {
  it('adds a new shared map with the one link you hold', () => {
    const out = applyRemember([], 'abc', 'Ward trees', 'collect', 'https://x/c/abc#edt_1', T);
    expect(out).toEqual([{ id: 'abc', name: 'Ward trees', role: 'collect', links: { edit: 'https://x/c/abc#edt_1' }, at: T }]);
  });
  it('upgrades role but never downgrades, and refreshes name', () => {
    const owner: SavedMap = { id: 'abc', name: 'Old', role: 'owner', links: { admin: 'A', edit: 'E' }, at: T };
    const stillOwner = applyRemember([owner], 'abc', 'New', 'collect', 'E2', T);
    expect(stillOwner[0].role).toBe('owner'); // collect < owner, no downgrade
    expect(stillOwner[0].name).toBe('New');
    expect(stillOwner[0].links).toEqual({ admin: 'A', edit: 'E2' });

    const view: SavedMap = { id: 'z', name: 'Z', role: 'view', links: { view: 'V' }, at: T };
    const upgraded = applyRemember([view], 'z', 'Z', 'collect', 'E', T);
    expect(upgraded[0].role).toBe('collect'); // collect > view
    expect(upgraded[0].links).toEqual({ view: 'V', edit: 'E' });
  });
});

describe('openLink', () => {
  it('view opens the view link; others prefer edit', () => {
    expect(openLink({ id: '1', name: '', role: 'view', links: { view: 'V' }, at: T })).toBe('V');
    expect(openLink({ id: '1', name: '', role: 'owner', links: { admin: 'A', edit: 'E' }, at: T })).toBe('E');
    expect(openLink({ id: '1', name: '', role: 'collect', links: { edit: 'E' }, at: T })).toBe('E');
  });
});

import { applyRecord, dropRecord, capMaps, mergeMaps, recordLabel, MAX_SHARED } from '../src/maps-store';

describe('applyRecord (a contributor keeps their own record edit link)', () => {
  it('adds the record under its map, creating a collect entry if the map is new', () => {
    const out = applyRecord([], 'm1', 'Trees', { id: 'r1', label: 'Neem', link: 'L1' }, T);
    expect(out[0]).toMatchObject({ id: 'm1', name: 'Trees', role: 'collect', records: [{ id: 'r1', label: 'Neem', link: 'L1', at: T }] });
  });
  it('upserts by record id and keeps the newest first', () => {
    let out = applyRecord([], 'm1', 'Trees', { id: 'r1', label: 'a', link: 'L1' }, T);
    out = applyRecord(out, 'm1', 'Trees', { id: 'r2', label: 'b', link: 'L2' }, T);
    out = applyRecord(out, 'm1', 'Trees', { id: 'r1', label: 'a2', link: 'L1' }, T);
    expect(out[0].records!.map((r) => [r.id, r.label])).toEqual([['r1', 'a2'], ['r2', 'b']]);
  });
  it('does not change the role of a map you own', () => {
    const owner: SavedMap = { id: 'm1', name: 'Trees', role: 'owner', links: { admin: 'A' }, at: T };
    expect(applyRecord([owner], 'm1', 'Trees', { id: 'r1', label: '', link: 'L' }, T)[0].role).toBe('owner');
  });
});

describe('dropRecord', () => {
  it('forgets a deleted record and leaves the map', () => {
    const m = applyRecord([], 'm1', 'Trees', { id: 'r1', label: '', link: 'L' }, T);
    const out = dropRecord(m, 'm1', 'r1');
    expect(out).toHaveLength(1);
    expect(out[0].records).toEqual([]);
  });
});

describe('capMaps', () => {
  const shared = (i: number): SavedMap => ({ id: `s${i}`, name: '', role: 'view', links: { view: 'V' }, at: T });
  it('never drops a map you own or one holding your record links', () => {
    const owned: SavedMap = { id: 'own', name: '', role: 'owner', links: { admin: 'A' }, at: T };
    const mine: SavedMap = { id: 'rec', name: '', role: 'collect', links: { edit: 'E' }, records: [{ id: 'r', label: '', link: 'L', at: T }], at: T };
    const list = [...Array.from({ length: MAX_SHARED + 20 }, (_, i) => shared(i)), owned, mine];
    const out = capMaps(list);
    expect(out.some((m) => m.id === 'own')).toBe(true);
    expect(out.some((m) => m.id === 'rec')).toBe(true);
    expect(out.filter((m) => m.role !== 'owner' && !m.records?.length)).toHaveLength(MAX_SHARED);
  });
  it('keeps order', () => {
    expect(capMaps([shared(1), shared(2)]).map((m) => m.id)).toEqual(['s1', 's2']);
  });
});

describe('mergeMaps (restore from a saved file)', () => {
  it('unions links and records for the same map instead of keeping only one copy', () => {
    const here: SavedMap = { id: 'm', name: 'Here', role: 'collect', links: { edit: 'E' }, records: [{ id: 'r1', label: '', link: 'L1', at: T }], at: T };
    const file: SavedMap = { id: 'm', name: 'File', role: 'owner', links: { admin: 'A' }, records: [{ id: 'r2', label: '', link: 'L2', at: T }], at: T };
    const [m] = mergeMaps([file], [here]);
    expect(m.role).toBe('owner');
    expect(m.links).toEqual({ edit: 'E', admin: 'A' });
    expect(m.records!.map((r) => r.id).sort()).toEqual(['r1', 'r2']);
  });
  it('ignores malformed entries', () => {
    expect(mergeMaps([null, { foo: 1 }, { id: 'x', links: {} }] as unknown as SavedMap[], [])).toEqual([
      expect.objectContaining({ id: 'x', role: 'view' }),
    ]);
  });
});

describe('recordLabel', () => {
  it('uses the first text value, else a fallback', () => {
    expect(recordLabel({ name: '  Big neem  ', n: 3 }, 'point')).toBe('Big neem');
    expect(recordLabel({ n: 3 }, 'point')).toBe('Your point');
    expect(recordLabel({ name: 'x'.repeat(200) }, 'area')).toHaveLength(80);
  });
});
