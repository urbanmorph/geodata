// @vitest-environment happy-dom
// prefers-reduced-motion: one CSS block in the shared tokens stops animations
// and transitions (spinners stay as a static ring, the locate ping stops, the
// filter panel appears without sliding); the loaders stop cycling their verbs;
// /preview scrolls without smooth scrolling.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error — plain .mjs build helper, no type declarations
import { TOKENS } from '../scripts/shared-chrome.mjs';
import { inlineLoader } from '../src/loading';
import { scrollBehavior } from '../src/util';

function setReduced(on: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: on && q === '(prefers-reduced-motion: reduce)', media: q }));
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('reduced motion', () => {
  it('the shared tokens stop every animation and transition under prefers-reduced-motion', () => {
    const block = TOKENS.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n  \}/)?.[1] ?? '';
    expect(block).toMatch(/\*, \*::before, \*::after \{[^}]*animation: none !important;[^}]*transition: none !important;/);
    expect(block).toMatch(/scroll-behavior: auto !important/);
  });

  it('every page with an animation gets the tokens', () => {
    for (const f of ['index.template.html', 'preview.template.html']) {
      const html = readFileSync(resolve(__dirname, '..', f), 'utf8');
      expect(html, f).toContain('<!-- TOKENS -->');
    }
  });

  it('the loader keeps one verb instead of cycling them', () => {
    vi.useFakeTimers();
    setReduced(true);
    const el = document.createElement('div');
    inlineLoader(el, ['one', 'two', 'three']);
    const first = el.textContent;
    vi.advanceTimersByTime(1500);
    expect(el.textContent).toBe(first);
  });

  it('without the preference the verbs still cycle', () => {
    vi.useFakeTimers();
    setReduced(false);
    const el = document.createElement('div');
    inlineLoader(el, ['one', 'two']);
    const first = el.textContent;
    vi.advanceTimersByTime(1500);
    expect(el.textContent).not.toBe(first);
  });

  it('scrolls jump instead of gliding', () => {
    setReduced(true);
    expect(scrollBehavior()).toBe('auto');
    setReduced(false);
    expect(scrollBehavior()).toBe('smooth');
    expect(readFileSync(resolve(__dirname, '../src/preview.ts'), 'utf8')).not.toMatch(/behavior: 'smooth'/);
  });
});
