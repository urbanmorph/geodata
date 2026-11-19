// @vitest-environment happy-dom
// Toasts are announced by screen readers: one live region that stays in the page
// and changes its text (a region added with its text already in it is often not read).
import { describe, it, expect, vi } from 'vitest';
import { toast } from '../src/toast';

describe('toast', () => {
  it('reuses one polite status region for every message', () => {
    vi.useFakeTimers();
    toast('Added ✓');
    const first = document.querySelector('.toast')!;
    expect(first.getAttribute('role')).toBe('status');
    expect(first.getAttribute('aria-live')).toBe('polite');
    expect(first.textContent).toBe('Added ✓');
    toast('Saved on this phone ✓');
    expect(document.querySelectorAll('.toast')).toHaveLength(1);
    expect(document.querySelector('.toast')).toBe(first);
    expect(first.textContent).toBe('Saved on this phone ✓');
  });
  it('hides after a moment but stays in the page, empty', () => {
    vi.advanceTimersByTime(5000);
    const t = document.querySelector('.toast')!;
    expect(t.classList.contains('show')).toBe(false);
    expect(t.textContent).toBe('');
    vi.useRealTimers();
  });
});

// A short "Added ✓" can go in a moment; an error has to be read (and a long
// one takes longer to read), so errors stay about 6 s, longer still if long.
describe('how long a toast stays', () => {
  const shownFor = (msg: string, kind?: 'error'): number => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame'] });
    toast(msg, kind);
    vi.advanceTimersByTime(20); // the frame that shows it
    const t = document.querySelector('.toast')!;
    let ms = 20;
    while (t.classList.contains('show') && ms < 30_000) { vi.advanceTimersByTime(100); ms += 100; }
    vi.useRealTimers();
    return ms;
  };
  it('a short note: about 2.4 s', () => {
    const ms = shownFor('Added ✓');
    expect(ms).toBeGreaterThan(2000);
    expect(ms).toBeLessThanOrEqual(2600);
  });
  it('an error: at least 6 s', () => {
    expect(shownFor("Couldn't save", 'error')).toBeGreaterThanOrEqual(5900);
  });
  it('a long message: about 60 ms a character', () => {
    expect(shownFor('x'.repeat(150))).toBeGreaterThanOrEqual(8900);
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
describe('error toasts in collect', () => {
  it("every caught error is shown as an error, not a passing note", () => {
    const app = readFileSync(resolve(__dirname, '../src/app.ts'), 'utf8');
    expect(app).not.toMatch(/toast\(\(e as Error\)\.message\)/);
    expect(app).not.toMatch(/toast\(loadErrorText\(e\)\)/);
    expect(app).not.toMatch(/onError: toast\b/);
  });
});
