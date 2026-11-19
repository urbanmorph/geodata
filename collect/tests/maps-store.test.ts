import { describe, it, expect } from 'vitest';
import { applyRemember, openLink, backLink, type SavedMap } from '../src/maps-store';

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

import { applyRecord, dropRecord, capMaps, mergeMaps, recordLabel, isCollectLink, MAX_SHARED } from '../src/maps-store';

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

// Real collect links: mergeMaps keeps only links that open a collect map.
const C = 'https://collect.bharatlas.com/c/mapabc';
const E = `${C}#edt_1`, A = `${C}/admin#adm_1`, L1 = `${C}/r/rec001#rec_1`, L2 = `${C}/r/rec002#rec_2`;

describe('mergeMaps (restore from a saved file)', () => {
  it('unions links and records for the same map instead of keeping only one copy', () => {
    const here: SavedMap = { id: 'm', name: 'Here', role: 'collect', links: { edit: E }, records: [{ id: 'r1', label: '', link: L1, at: T }], at: T };
    const file: SavedMap = { id: 'm', name: 'File', role: 'owner', links: { admin: A }, records: [{ id: 'r2', label: '', link: L2, at: T }], at: T };
    const [m] = mergeMaps([file], [here]);
    expect(m.role).toBe('owner');
    expect(m.links).toEqual({ edit: E, admin: A });
    expect(m.records!.map((r) => r.id).sort()).toEqual(['r1', 'r2']);
  });
  // Forgetting a point on one device must not be undone by the next sync, which
  // brings back the other devices' copies (they still list it).
  it('a point forgotten on any device stays forgotten after a merge', () => {
    const synced: SavedMap = { id: 'm', name: 'X', role: 'collect', links: { edit: E }, records: [{ id: 'r1', label: '', link: L1, at: T }, { id: 'r2', label: '', link: L2, at: T }], at: T };
    const here = dropRecord(mergeMaps([synced], []), 'm', 'r1');
    expect(here[0].forgotten).toEqual(['r1']);
    const [m] = mergeMaps([synced], here);
    expect(m.records!.map((r) => r.id)).toEqual(['r2']);
    expect(m.forgotten).toEqual(['r1']);
    // ...and the other device, merging this one's copy, drops it too.
    const [there] = mergeMaps(here, [synced]);
    expect(there.records!.map((r) => r.id)).toEqual(['r2']);
  });
  it('a copy saved before forgetting existed (no forgotten list) still merges', () => {
    const old = { id: 'm', name: 'X', role: 'collect', links: { edit: E }, records: [{ id: 'r1', label: '', link: L1, at: T }], at: T } as SavedMap;
    const [m] = mergeMaps([old], []);
    expect(m.records).toHaveLength(1);
    expect(m.forgotten).toBeUndefined();
  });
  it('ignores malformed entries', () => {
    expect(mergeMaps([null, { foo: 1 }, { id: 'x', links: {} }] as unknown as SavedMap[], [])).toEqual([
      expect.objectContaining({ id: 'x', role: 'view' }),
    ]);
  });
  // A synced copy is data from elsewhere: a link in it that isn't a collect map
  // link (another site, javascript:, a look-alike host) never becomes a button.
  it('drops links and record links that do not open a collect map', () => {
    const bad = ['https://evil.example/c/mapabc#edt_1', 'javascript:alert(1)', 'https://collect.bharatlas.com.evil.example/c/mapabc',
      'https://collect.bharatlas.com/elsewhere', 'http://collect.bharatlas.com/c/mapabc#edt_1', 'not a url'];
    for (const link of bad) {
      const [m] = mergeMaps([{ id: 'm', name: 'X', role: 'owner', links: { edit: link, admin: A }, records: [{ id: 'r', label: '', link, at: T }], at: T }], []);
      expect(m.links).toEqual({ admin: A });
      expect(m.records).toEqual([]);
    }
  });
  it('keeps this origin\'s own links (local development)', () => {
    expect(isCollectLink('http://localhost:5173/c/mapabc/view#viw_1', 'localhost:5173')).toBe(true);
    expect(isCollectLink('https://collect.bharatlas.com/c/mapabc/r/rec001#rec_1', 'localhost:5173')).toBe(true);
    expect(isCollectLink('http://localhost:5173/c/mapabc#x', 'collect.bharatlas.com')).toBe(false);
  });
});

describe('recordLabel', () => {
  it('uses the first text value, else a fallback', () => {
    expect(recordLabel({ name: '  Big neem  ', n: 3 }, 'point')).toBe('Big neem');
    expect(recordLabel({ n: 3 }, 'point')).toBe('Your point');
    expect(recordLabel({ name: 'x'.repeat(200) }, 'area')).toHaveLength(80);
  });
});

describe('backLink: where a contributor goes back to from their own point', () => {
  const maps: SavedMap[] = [
    { id: 'm1', name: 'Trees', role: 'collect', links: { edit: 'https://collect.bharatlas.com/c/m1#edt_x' }, at: '2026-08-19T00:00:00Z' },
    { id: 'm2', name: 'Only my points', role: 'collect', links: {}, at: '2026-08-19T00:00:00Z' },
  ];
  it('is the map link saved on this device', () => {
    expect(backLink(maps, 'm1')).toBe('https://collect.bharatlas.com/c/m1#edt_x');
  });
  it('is the home page when no map link is saved (a rec_ token cannot open the map)', () => {
    expect(backLink(maps, 'm2')).toBe('/');
    expect(backLink(maps, 'nope')).toBe('/');
  });
});

import { applyAdminReplace } from '../src/maps-store';

describe('a replaced admin link (Manage, Share, Replace admin link)', () => {
  const T0 = '2026-11-01T00:00:00Z';
  const adm = (n: string) => `${C}/admin#adm_${n}`;
  const [A0, A1, A2] = ['A0', 'A1', 'A2'].map(adm);
  const owned = (admin: string, retired?: string[]): SavedMap =>
    ({ id: 'm', name: 'Trees', role: 'owner', links: { admin, edit: E }, at: T0, ...(retired ? { retired } : {}) });

  it('saves the new admin link and remembers the old one as retired', () => {
    const [m] = applyAdminReplace([owned(A1)], 'm', 'Trees', A1, A2, T);
    expect(m.links).toEqual({ admin: A2, edit: E });
    expect(m.role).toBe('owner');
    expect(m.retired).toEqual([A1]);
  });
  it('retires the link this page was opened with even if another one was saved', () => {
    const [m] = applyAdminReplace([owned(A0)], 'm', 'Trees', A1, A2, T);
    expect(m.links.admin).toBe(A2);
    expect(m.retired?.sort()).toEqual([A0, A1]);
  });
  it('saves the map as owned when this device had not saved it', () => {
    const [m] = applyAdminReplace([], 'm', 'Trees', A1, A2, T);
    expect(m).toMatchObject({ id: 'm', role: 'owner', links: { admin: A2 }, retired: [A1] });
  });
  it('sync never brings the old link back: a retired link loses to the new one, whichever side has it', () => {
    const here = applyAdminReplace([owned(A1)], 'm', 'Trees', A1, A2, T)[0];
    const otherDevice = owned(A1);
    for (const [a, b] of [[[otherDevice], [here]], [[here], [otherDevice]]] as SavedMap[][][]) {
      const [m] = mergeMaps(a, b);
      expect(m.links.admin).toBe(A2);
      expect(m.retired).toEqual([A1]);
    }
  });
  it('a device that only has the old link drops it once it learns it was retired', () => {
    const [m] = mergeMaps([{ ...owned(A1), links: { edit: E }, retired: [A1] }], [owned(A1)]);
    expect(m.links.admin).toBeUndefined();
    expect(m.links.edit).toBe(E);
  });
});
