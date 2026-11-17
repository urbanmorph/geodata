import { describe, it, expect } from 'vitest';
import { filterCards, type CardLike } from '../src/catalog-filter';

// Fixture mirrors real prerender shape: each card carries a high-signal
// "primary" haystack (title + level + aliases) and a low-signal "body"
// (description + license + tags). The two-tier matcher uses primary
// first; only when zero primary matches exist does it fall through to
// body. This stops "villages" from surfacing Districts/Sub-districts/
// Blocks whose descriptions merely mention villages.
const cards: CardLike[] = [
  { primary: 'states lgd state',          body: 'pan-india state and union territory boundaries' },
  { primary: 'districts lgd district',    body: 'every district in india. joins to states, subdistricts, blocks and villages' },
  { primary: 'sub-districts lgd subdistrict', body: 'tehsils, talukas and sub-divisions. the layer below a district. joins to blocks and villages' },
  { primary: 'blocks lgd block',          body: 'community-development blocks. the administrative unit that groups villages' },
  { primary: 'villages lgd village',      body: 'every revenue village in india. the finest admin polygon' },
  { primary: 'greater bengaluru wards lgd ward', body: '369 final wards across 5 corporations, notified nov 2025' },
  { primary: 'pincodes bharatviz pincode', body: '63,864 pincode polygons. pin code postal code zip' },
  { primary: 'wildlife sanctuaries gs wildlife', body: 'national park sanctuary reserve forest' },
];

describe('catalog-filter — filterCards', () => {
  it('empty query: every card matches', () => {
    const r = filterCards(cards, '');
    expect(r.matches.every((m) => m)).toBe(true);
    expect(r.totalMatches).toBe(cards.length);
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

  it('zero-match query: returns no visible cards', () => {
    const r = filterCards(cards, 'xyzzy_unmatchable');
    expect(r.totalMatches).toBe(0);
    expect(r.matches.every((m) => !m)).toBe(true);
  });

  it('body-fallback matches count as rows', () => {
    // "sanctuary" appears only in environment body.
    const r = filterCards(cards, 'sanctuary');
    expect(r.totalMatches).toBe(1);
  });
});

// "ward 9 ahmedabad": no card holds "9", but the Ahmedabad ward map is what the
// person wants (the answer card above names ward 9). When nothing matches with
// the bare numbers, retry without them.
describe('filterCards: numbers fall back', () => {
  const cards: CardLike[] = [
    { primary: 'ahmedabad ward map wards', body: '' },
    { primary: 'districts (2024)', body: '' },
  ];

  it('drops bare-number tokens when nothing matches with them', () => {
    expect(filterCards(cards, 'ward 9 ahmedabad').matches).toEqual([true, false]);
  });

  it('keeps numbers that do match (years in titles)', () => {
    expect(filterCards(cards, 'districts 2024').matches).toEqual([false, true]);
    expect(filterCards(cards, 'districts 2011').matches).toEqual([false, true]);
  });
});
