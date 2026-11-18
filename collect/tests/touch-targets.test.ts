// On a phone every tap target is at least 44 x 44 px. The small controls keep
// their look on desktop; on touch screens they grow, or (photo remove, the back
// arrow, MapLibre's zoom) get an invisible 44 px hit area around the same icon.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');
const app = readFileSync(resolve(__dirname, '../src/app.ts'), 'utf8');
const touch = css.match(/@media \(pointer: coarse\), \(max-width: 640px\) \{([\s\S]*?)\n\}/)?.[1] ?? '';

describe('touch targets', () => {
  it('has one touch block', () => expect(touch).not.toBe(''));

  it('buttons use the site font, not the browser default (Arial)', () => {
    expect(css).toMatch(/\nbutton, \.btn \{\s*font: inherit;/);
  });

  for (const sel of ['.chip', '.tabs button', '.seg button', '.link-box button', '.btn-sm']) {
    it(`${sel} is at least 44 px tall on touch screens`, () => {
      const rule = touch.match(new RegExp(`([^{}]*)\\{[^}]*min-height: 44px`, 'g'))?.join(' ') ?? '';
      expect(rule).toContain(sel);
    });
  }

  it('icon controls get a 44 px hit area without growing', () => {
    for (const sel of ['.photo-rm::after', '.topbar > a:first-child', '.maplibregl-ctrl-group button::after']) expect(touch).toContain(sel);
  });

  it('the Manage header buttons use the class, not an inline 36 px height', () => {
    expect(app).not.toMatch(/style="min-height:36px/);
    expect(app).toMatch(/<button id="edit-form" class="btn-sm">/);
  });
});
