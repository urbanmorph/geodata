import { describe, it, expect } from 'vitest';
import { filterCards, cardVisibility, type CardLike } from '../src/catalog-filter';

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

describe('catalog-filter — cardVisibility (search × active-pill interaction)', () => {
  // Mirrors the home-grid bug from PR #99 follow-up: typing "over" with
  // Environment active returned "No matches" because the Overture match
  // lives in Infrastructure. New rule: when a query is active, the pill
  // scope is bypassed so search results are never silently hidden.
  const cats = cards.map((c) => c.category);

  it('empty query, no active pill: respects matches as-is', () => {
    const matches = cards.map(() => true);
    const v = cardVisibility(matches, cats, 'all', '');
    expect(v.every((x: boolean) => x)).toBe(true);
  });

  it('empty query, active pill: scopes to that category', () => {
    const matches = cards.map(() => true);
    const v = cardVisibility(matches, cats, 'people', '');
    expect(v.filter(Boolean).length).toBe(1); // only the pincode card
    expect(v[6]).toBe(true);
  });

  it('non-empty query: ignores active pill, returns every match', () => {
    // Simulate searching "over" — only the env card matches by index.
    // With active pill = 'people', earlier behaviour would have returned
    // 0 visible; new behaviour returns the env card regardless.
    const matches = cards.map((c, i) => i === 7); // wildlife is index 7
    const v = cardVisibility(matches, cats, 'people', 'wild');
    expect(v[7]).toBe(true);
    expect(v.filter(Boolean).length).toBe(1);
  });

  it('non-empty query with whitespace only: treated as empty (pill still scopes)', () => {
    const matches = cards.map(() => true);
    const v = cardVisibility(matches, cats, 'people', '   ');
    expect(v.filter(Boolean).length).toBe(1);
  });

  it('respects matches: cards that did not match the query stay hidden', () => {
    // Only 2 cards "match" the simulated query.
    const matches = cards.map((c, i) => i === 0 || i === 7);
    const v = cardVisibility(matches, cats, 'all', 'whatever');
    expect(v.filter(Boolean).length).toBe(2);
    expect(v[0]).toBe(true);
    expect(v[7]).toBe(true);
  });
});

describe('catalog-filter — community pill (provenance filter)', () => {
  // Community submissions inherit a content category (environment / etc.)
  // for sectioning, so a "community" pill can't just match data-category.
  // It must match on provenance. When activeCat='community', show only
  // cards with provenance='community' regardless of content category.
  const mixed: CardLike[] = [
    { category: 'environment',   primary: 'wildlife',         body: '...', provenance: 'curated' },
    { category: 'environment',   primary: 'goa landuse',      body: '...', provenance: 'community' },
    { category: 'infrastructure', primary: 'roads',           body: '...', provenance: 'curated' },
    { category: 'infrastructure', primary: 'bangalore lanes', body: '...', provenance: 'community' },
  ];

  it("activeCat='community' shows only provenance='community' cards", () => {
    const matches = mixed.map(() => true);
    const v = cardVisibility(matches, mixed, 'community', '');
    expect(v).toEqual([false, true, false, true]);
  });

  it("activeCat='community' bypasses content-category scoping across all categories", () => {
    const matches = mixed.map(() => true);
    const v = cardVisibility(matches, mixed, 'community', '');
    // Both community cards visible — one in environment, one in infrastructure.
    expect(v[1]).toBe(true);
    expect(v[3]).toBe(true);
  });

  it("activeCat='community' + search query: still respects search matches", () => {
    // Search hit only on the Goa card (index 1).
    const matches = mixed.map((_c, i) => i === 1);
    const v = cardVisibility(matches, mixed, 'community', 'goa');
    expect(v).toEqual([false, true, false, false]);
  });

  it("activeCat='environment' (content category) still uses category match, not provenance", () => {
    const matches = mixed.map(() => true);
    const v = cardVisibility(matches, mixed, 'environment', '');
    // Both environment cards visible regardless of provenance.
    expect(v).toEqual([true, true, false, false]);
  });
});
