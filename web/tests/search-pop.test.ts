import { describe, it, expect } from 'vitest';
import { rankHits, hitsHtml, moveActive, type Hit } from '../src/search-pop';

const hits: Hit[] = [
  { title: 'Districts (2024)', sub: '785 districts · LGD', href: '/view/lgd_districts' },
  { title: 'Ahmedabad (AMC) Wards', sub: '48 wards · OpenCity', href: '/view/wards_ahmedabad' },
  { title: 'Urban wards, all India', sub: '70,417 wards', href: '/view/sbm_wards' },
];

describe('rankHits', () => {
  it('keeps matches only, title matches first, then catalogue order, capped', () => {
    const r = rankHits(hits, [true, true, true], 'ahmedabad', 2);
    expect(r.map((h) => h.href)).toEqual(['/view/wards_ahmedabad', '/view/lgd_districts']);
    expect(rankHits(hits, [false, true, false], 'x', 5)).toHaveLength(1);
  });
});

describe('hitsHtml', () => {
  it('renders options with ids, escaped, and a link to all matches when there are more', () => {
    // 5 matching rows holding 7 layers: the link counts layers.
    const html = hitsHtml(hits.slice(0, 2), { rows: 5, layers: 7 }, 'ward <b>');
    expect(html.match(/role="option"/g)).toHaveLength(2);
    expect(html).toContain('id="search-hit-0"');
    expect(html).toContain('href="/view/lgd_districts"');
    expect(html).toContain('See all 7 matching layers');
    expect(html).not.toContain('<b>');
  });

  it('no link when every matching row is shown, however many layers they hold', () => {
    expect(hitsHtml(hits.slice(0, 2), { rows: 2, layers: 6 }, 'x')).not.toContain('See all');
  });

  it('says so when nothing matches', () => {
    expect(hitsHtml([], { rows: 0, layers: 0 }, 'zzz')).toContain('No layer matches');
  });
});

describe('moveActive', () => {
  it('moves down and up, wrapping, starting from none', () => {
    expect(moveActive(-1, 'ArrowDown', 3)).toBe(0);
    expect(moveActive(2, 'ArrowDown', 3)).toBe(0);
    expect(moveActive(0, 'ArrowUp', 3)).toBe(2);
    expect(moveActive(-1, 'ArrowUp', 3)).toBe(2);
    expect(moveActive(1, 'Tab', 3)).toBe(1);
    expect(moveActive(-1, 'ArrowDown', 0)).toBe(-1);
  });
});
