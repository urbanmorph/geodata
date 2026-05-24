import { describe, it, expect } from 'vitest';
import { filterCards, type CardLike } from '../src/catalog-filter';

// Fixture mirrors real prerender shape: each card carries a high-signal
// "primary" haystack (title + level + aliases) and a low-signal "body"
// (description + license + tags). The two-tier matcher uses primary
// first; only when zero primary matches exist does it fall through to
// body. This stops "villages" from surfacing Districts/Sub-districts/
// Blocks whose descriptions merely mention villages.
const cards: CardLike[] = [
  { category: 'administrative', primary: 'states lgd state',          body: 'pan-india state and union territory boundaries' },
  { category: 'administrative', primary: 'districts lgd district',    body: 'every district in india. joins to states, subdistricts, blocks and villages' },
  { category: 'administrative', primary: 'sub-districts lgd subdistrict', body: 'tehsils, talukas and sub-divisions. the layer below a district. joins to blocks and villages' },
  { category: 'administrative', primary: 'blocks lgd block',          body: 'community-development blocks. the administrative unit that groups villages' },
  { category: 'administrative', primary: 'villages lgd village',      body: 'every revenue village in india. the finest admin polygon' },
  { category: 'administrative', primary: 'greater bengaluru wards lgd ward', body: '369 final wards across 5 corporations, notified nov 2025' },
  { category: 'people',         primary: 'pincodes bharatviz pincode', body: '63,864 pincode polygons. pin code postal code zip' },
  { category: 'environment',    primary: 'wildlife sanctuaries gs wildlife', body: 'national park sanctuary reserve forest' },
];

describe('catalog-filter — filterCards', () => {
  it('empty query: every card matches; counts mirror raw category totals', () => {
    const r = filterCards(cards, '');
    expect(r.matches.every((m) => m)).toBe(true);
    expect(r.totalMatches).toBe(cards.length);
    expect(r.countsByCategory.get('administrative')).toBe(6);
    expect(r.countsByCategory.get('people')).toBe(1);
    expect(r.countsByCategory.get('environment')).toBe(1);
  });

  it('whitespace-only query is treated as empty', () => {
    const r = filterCards(cards, '   ');
    expect(r.totalMatches).toBe(cards.length);
  });

  it('"villages": primary hit on Villages — Districts/Sub-districts/Blocks NOT surfaced even though body mentions villages', () => {
    const r = filterCards(cards, 'villages');
    const visibleIds = cards.flatMap((c, i) => r.matches[i] ? [c.primary] : []);
    expect(visibleIds).toEqual(['villages lgd village']);
    expect(r.totalMatches).toBe(1);
    expect(r.countsByCategory.get('administrative')).toBe(1);
  });

  it('"tehsil": no primary match anywhere — falls back to body — Sub-districts surfaces', () => {
    const r = filterCards(cards, 'tehsil');
    const visible = cards.flatMap((c, i) => r.matches[i] ? [c.primary] : []);
    expect(visible).toEqual(['sub-districts lgd subdistrict']);
    expect(r.totalMatches).toBe(1);
  });

  it('"wards bengaluru": multi-token primary match — only Bengaluru wards', () => {
    const r = filterCards(cards, 'wards bengaluru');
    const visible = cards.flatMap((c, i) => r.matches[i] ? [c.primary] : []);
    expect(visible).toEqual(['greater bengaluru wards lgd ward']);
  });

  it('multi-token: every token must hit the same tier (all-primary or all-body)', () => {
    // "lgd village" — both tokens in primary of Villages only.
    const r = filterCards(cards, 'lgd village');
    const visible = cards.flatMap((c, i) => r.matches[i] ? [c.primary] : []);
    expect(visible).toEqual(['villages lgd village']);
  });

  it('zero-match query: returns no visible cards, empty counts', () => {
    const r = filterCards(cards, 'xyzzy_unmatchable');
    expect(r.totalMatches).toBe(0);
    expect(r.matches.every((m) => !m)).toBe(true);
    expect(r.countsByCategory.size).toBe(0);
  });

  it('body-fallback case still aggregates counts by category', () => {
    // "sanctuary" appears only in environment body.
    const r = filterCards(cards, 'sanctuary');
    expect(r.totalMatches).toBe(1);
    expect(r.countsByCategory.get('environment')).toBe(1);
    expect(r.countsByCategory.get('administrative')).toBeUndefined();
  });
});
