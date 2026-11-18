// Design audit (Nov 2026), round 2, collect: links show the same focus ring as
// buttons (L5), and "Install app" no longer sits between the intro and the
// main action (L6).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');
const landing = readFileSync(resolve(__dirname, '../src/landing.ts'), 'utf8');

describe('collect focus ring', () => {
  it('links and summaries get the 2 px accent outline, not the browser default', () => {
    const rule = css.match(/([^}]*)\{ outline: 2px solid var\(--accent-strong\); outline-offset: 2px; \}/)?.[1] ?? '';
    expect(rule).toContain('a:focus-visible');
    expect(rule).toContain('summary:focus-visible');
  });
});

describe('collect home: one primary action up top', () => {
  it('Install app comes after your maps and sync, not above "Make a new map"', () => {
    const home = landing.slice(landing.indexOf('function home('));
    const slot = home.indexOf('id="install-slot"');
    expect(slot).toBeGreaterThan(home.indexOf('id="start"'));
    expect(slot).toBeGreaterThan(home.indexOf('id="sync"'));
  });
});
