// On phones the search row stacks (flex-direction: column), so a flex-basis
// meant as a desktop width becomes the search bar's height: it drew 340 px
// tall at 390 px wide (owner, 2026-11-18). The phone rule must reset it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const tmpl = readFileSync(resolve(__dirname, '../index.template.html'), 'utf8');

describe('home search bar on phones', () => {
  it('the stacked row does not inherit the desktop flex-basis as height', () => {
    const phone = tmpl.slice(tmpl.indexOf('.search-row { flex-direction: column; }'));
    const rule = phone.slice(0, phone.indexOf('}', phone.indexOf('.search-bar {')) + 1);
    expect(rule).toMatch(/\.search-bar \{[^}]*flex: 0 0 auto/);
  });
});
