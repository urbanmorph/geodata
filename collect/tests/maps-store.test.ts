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
