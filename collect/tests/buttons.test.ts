// @vitest-environment happy-dom
// Two button habits used across collect: a destructive action asks once more
// (confirmTwice), and a button that sends something stays disabled while it
// works, coming back with the error when it fails (busy).
import { describe, it, expect, vi } from 'vitest';
import { confirmTwice, busy } from '../src/buttons';

const button = (text = 'Delete') => {
  document.body.innerHTML = `<button>${text}</button>`;
  return document.querySelector('button') as HTMLButtonElement;
};
const toastText = () => document.querySelector('.toast')?.textContent;

describe('confirmTwice', () => {
  it('asks on the first tap and acts on the second', () => {
    const b = button();
    const act = vi.fn();
    confirmTwice(b, 'Tap again to delete', act);
    b.click();
    expect(b.textContent).toBe('Tap again to delete');
    expect(act).not.toHaveBeenCalled();
    b.click();
    expect(act).toHaveBeenCalledTimes(1);
  });

  it('can be asked again after a failure (rearm)', () => {
    const b = button();
    const act = vi.fn((rearm: () => void) => rearm());
    confirmTwice(b, 'Sure?', act);
    b.click(); b.click();
    b.click(); // asks again rather than acting
    expect(act).toHaveBeenCalledTimes(1);
    b.click();
    expect(act).toHaveBeenCalledTimes(2);
  });
});

describe('busy', () => {
  it('disables the button while the work runs and leaves it disabled after success', async () => {
    const b = button('Save');
    let seen: boolean | undefined;
    await busy(b, async () => { seen = b.disabled; });
    expect(seen).toBe(true);
    expect(b.disabled).toBe(true);
  });

  it('enables it again after success when asked', async () => {
    const b = button('Save');
    await busy(b, async () => {}, true);
    expect(b.disabled).toBe(false);
  });

  it('shows the error and enables the button again when the work fails', async () => {
    const b = button('Save');
    await busy(b, async () => { throw new Error('HTTP 500'); });
    expect(b.disabled).toBe(false);
    expect(toastText()).toBe('HTTP 500');
  });
});
