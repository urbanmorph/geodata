// On phones the old search row stacked (flex-direction: column), so a
// flex-basis meant as a desktop width became the search bar's height: it drew
// 340 px tall at 390 px wide (owner, 2026-11-18). The bar now stands alone,
// full width, with no flex parent: it must not carry a flex-basis at all, and
// its height is set outright on desktop and phone.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const tmpl = readFileSync(resolve(__dirname, '../index.template.html'), 'utf8');
const style = tmpl.slice(0, tmpl.indexOf('</style>'));
const rules = [...style.matchAll(/\.search-bar \{([^}]*)\}/g)].map((m) => m[1]);

describe('home search bar on phones', () => {
  it('has a fixed height and no flex-basis that could become its height', () => {
    expect(rules.length).toBe(2); // desktop and phone
    for (const r of rules) {
      expect(r).toMatch(/height: \d+px/);
      expect(r).not.toMatch(/(^|[\s;])flex:/);
    }
  });
});
