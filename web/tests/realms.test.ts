// /layers groups its themes under three realms (below ground, on the ground,
// in the air). Site organisation only: a layer's category (API, MCP) never
// changes. One source of truth: scripts/realms.json, read by scripts/realms.mjs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REALMS, realmOf, realmOverrides } from '../scripts/realms.mjs';

const read = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8');
type Layer = { id: string; level: string; category?: string; provenance?: string };
const catalog = JSON.parse(read('../catalog.json')) as { layers: Layer[]; categories: Record<string, string> };
const curated = catalog.layers.filter((l) => l.provenance !== 'community');
const realmIds = REALMS.map((r: { id: string }) => r.id);

describe('realms', () => {
  it('are below ground, on the ground and in the air, in that order, each with a plain line', () => {
    expect(REALMS.map((r: { name: string }) => r.name)).toEqual(['Below ground', 'On the ground', 'In the air']);
    for (const r of REALMS) {
      expect(r.desc, r.id).toMatch(/^[A-Z][^—]+\.$/);
      expect(r.id, r.id).toMatch(/^[a-z]+$/);
    }
  });

  it('every theme has a default realm', () => {
    const defaults = JSON.parse(read('scripts/realms.json')).categories as Record<string, string>;
    for (const cat of Object.keys(catalog.categories)) expect(realmIds, cat).toContain(defaults[cat]);
  });

  it('every curated layer resolves to exactly one realm', () => {
    for (const l of curated) expect(realmIds, l.id).toContain(realmOf(l));
  });

  it('a level\'s layers share one realm, so each row sits in one place', () => {
    const byLevel = new Map<string, Set<string>>();
    for (const l of curated) (byLevel.get(l.level) ?? byLevel.set(l.level, new Set()).get(l.level)!).add(realmOf(l));
    for (const [lvl, realms] of byLevel) expect([...realms], lvl).toHaveLength(1);
  });

  it('overrides name real realms and well-formed ids, once each; an id already in the catalogue is a curated layer', () => {
    const overrides = realmOverrides();
    const seen = new Set<string>();
    const curatedIds = new Set(curated.map((l) => l.id));
    const allIds = new Set(catalog.layers.map((l) => l.id));
    const pending: string[] = [];
    for (const [id, realm] of overrides) {
      expect(id, 'typo?').toMatch(/^[a-z0-9_]+$/);
      expect(realmIds, id).toContain(realm);
      expect(seen.has(id), `${id} listed twice`).toBe(false);
      seen.add(id);
      if (allIds.has(id)) expect(curatedIds.has(id), id).toBe(true);
      else pending.push(id);
    }
    // Layers being added on other branches may be listed ahead of time.
    if (pending.length) console.warn(`realms.json: not in catalog.json yet: ${pending.join(', ')}`);
  });

  it('puts the owner\'s picks where they asked', () => {
    const byId = new Map(curated.map((l) => [l.id, l]));
    expect(realmOf(byId.get('cgwb_aquifers')!)).toBe('below');
    expect(realmOf(byId.get('seismic_zones')!)).toBe('below');
    expect(realmOf(byId.get('ndem_cyclone_tracks')!)).toBe('air');
    expect(realmOf(byId.get('lgd_districts')!)).toBe('ground');
    // Owner, 2026-11-21: agro-climatic zones are land zones; soil, mines and seismic zones stay below.
    expect(realmOf(byId.get('agro_climatic_zones')!)).toBe('ground');
    for (const id of ['slusi_soil_health', 'osm_mines_caves', 'seismic_zones']) expect(realmOf(byId.get(id)!), id).toBe('below');
    expect(REALMS.find((r: { id: string }) => r.id === 'air').desc).not.toMatch(/climate zones/);
    // Community layers take their theme's default.
    expect(realmOf({ id: 'Ab3dEfGh', category: 'water' })).toBe('ground');
    expect(realmOf({ id: 'x', category: 'no-such-theme' })).toBe('ground');
  });
});
