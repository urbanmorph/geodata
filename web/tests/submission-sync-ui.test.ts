// @vitest-environment happy-dom
// The "keep these links on all your devices" controls in "Your submissions".
import { describe, it, expect, vi } from 'vitest';
import { renderSubmissionSync, SYNC_LINK_NOTE } from '../src/submission-sync-ui';

function fakeSync(on = false) {
  let state: { secret: string; synced_at?: string; passkey?: { id: string; writeKey: string } } | null = on ? { secret: 's', synced_at: '2026-10-23T10:00:00Z' } : null;
  return {
    state: () => state,

    turnOn: vi.fn(async () => { state = { secret: 's', synced_at: '2026-10-23T10:00:00Z' }; }),
    turnOff: vi.fn(async () => { state = null; }),
    addPasskey: vi.fn(async () => { state = { ...state!, passkey: { id: 'p', writeKey: 'w' } }; }),
    unlockWithPasskey: vi.fn(async () => { state = { secret: 's', synced_at: 'x' }; }),
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('sync controls', () => {
  it('off: offers to turn it on, says what is kept and where, and offers the passkey from another device', () => {
    document.body.innerHTML = '<div id="box"></div>';
    renderSubmissionSync(document.getElementById('box')!, fakeSync() as never, { passkeys: true, onChange: () => {} });
    const text = document.body.textContent!;
    expect(document.querySelector('#subs-sync-on')).not.toBeNull();
    expect(document.querySelector('#subs-pk-unlock')).not.toBeNull();
    expect(text).toContain("can't read it");
    expect(text).toContain('12 months');
    expect(text).toMatch(/collect/); // the passkey made in collect works here too
  });

  // Sync is passkey-only (#322): no sync link is adopted, so none is shown (it
  // would also put the secret on screen). The way to another device is the passkey.
  it('turning on shows no sync link or secret, and points to the passkey', async () => {
    document.body.innerHTML = '<div id="box"></div>';
    const sync = fakeSync();
    const onChange = vi.fn();
    renderSubmissionSync(document.getElementById('box')!, sync as never, { passkeys: true, onChange });
    (document.querySelector('#subs-sync-on') as HTMLButtonElement).click();
    await flush();
    expect(sync.turnOn).toHaveBeenCalled();
    expect(onChange).toHaveBeenCalled();
    expect(document.querySelector('#subs-sync-link')).toBeNull();
    expect(document.querySelector('input')).toBeNull();
    expect(document.body.textContent).not.toMatch(/sync link|open it on/i);
    expect(document.querySelector('#subs-pk-add')).not.toBeNull();
    expect(document.body.textContent).toContain('Unlock with your passkey');
  });

  it('with a passkey added, says to unlock with it on another device', () => {
    document.body.innerHTML = '<div id="box"></div>';
    const sync = fakeSync(true);
    sync.state()!.passkey = { id: 'p', writeKey: 'w' };
    renderSubmissionSync(document.getElementById('box')!, sync as never, { passkeys: true, onChange: () => {} });
    expect(document.body.textContent).toMatch(/On another device, choose Unlock with your passkey/);
    expect(document.body.textContent).not.toMatch(/sync link/i);
  });

  it('an opened old sync link: says it no longer works and to use the passkey', () => {
    document.body.innerHTML = '<div id="box"></div>';
    renderSubmissionSync(document.getElementById('box')!, fakeSync() as never, { passkeys: true, onChange: () => {} }, SYNC_LINK_NOTE);
    expect(document.querySelector('#subs-sync-note')!.textContent).toBe(SYNC_LINK_NOTE);
    expect(SYNC_LINK_NOTE).toMatch(/passkey/);
  });

  it('turning off needs a second tap, then deletes the synced copy', async () => {
    document.body.innerHTML = '<div id="box"></div>';
    const sync = fakeSync(true);
    renderSubmissionSync(document.getElementById('box')!, sync as never, { passkeys: false, onChange: () => {} });
    const off = () => document.querySelector('#subs-sync-off') as HTMLButtonElement;
    off().click();
    await flush();
    expect(sync.turnOff).not.toHaveBeenCalled();
    expect(off().textContent).toMatch(/Tap again/);
    off().click();
    await flush();
    expect(sync.turnOff).toHaveBeenCalled();
    expect(document.querySelector('#subs-sync-on')).not.toBeNull();
  });

  it('a failure is shown, not swallowed; a cancelled passkey says so plainly', async () => {
    document.body.innerHTML = '<div id="box"></div>';
    const sync = fakeSync();
    sync.unlockWithPasskey.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
    renderSubmissionSync(document.getElementById('box')!, sync as never, { passkeys: true, onChange: () => {} });
    (document.querySelector('#subs-pk-unlock') as HTMLButtonElement).click();
    await flush();
    expect(document.querySelector('#subs-sync-note')!.textContent).toBe('Passkey cancelled.');
  });

  it('without passkey support, no passkey buttons', () => {
    document.body.innerHTML = '<div id="box"></div>';
    renderSubmissionSync(document.getElementById('box')!, fakeSync() as never, { passkeys: false, onChange: () => {} });
    expect(document.querySelector('#subs-pk-unlock')).toBeNull();
  });

  it('a lost connection says so in plain words, not "Failed to fetch"', async () => {
    document.body.innerHTML = '<div id="box"></div>';
    const sync = fakeSync();
    sync.turnOn.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderSubmissionSync(document.getElementById('box')!, sync as never, { passkeys: false, onChange: () => {} });
    (document.querySelector('#subs-sync-on') as HTMLButtonElement).click();
    await flush();
    expect(document.querySelector('#subs-sync-note')!.textContent).toBe(
      "Couldn't reach bharatlas's sync service. Check your connection and try again.",
    );
  });
});

