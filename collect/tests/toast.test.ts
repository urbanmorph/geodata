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
