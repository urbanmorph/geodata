// The "keep these links on all your devices" controls in "Your submissions" on
// /preview (submission-sync.ts does the work). Wording follows collect's sync.
import type { createSubmissionSync } from './submission-sync';
import { isConnectionError } from '../../shared/connection';

type Sync = Pick<ReturnType<typeof createSubmissionSync>, 'state' | 'turnOn' | 'turnOff' | 'addPasskey' | 'unlockWithPasskey'>;

/** Shown when an old sync link (#sync=…) was opened: links are no longer adopted. */
export const SYNC_LINK_NOTE = 'Sync links no longer work. Use Unlock with your passkey instead.';

const NOTICE =
  "Keeps an <strong>encrypted copy</strong> of the links and tokens of your submissions on bharatlas, so your other devices can have them too: unlock it there with your passkey. bharatlas can't read it and doesn't know whose it is. It's deleted after <strong>12 months</strong> without use, or as soon as you turn sync off.";

/** What went wrong, in plain words: a cancelled passkey, a lost connection, or the reason given. */
const errorText = (ex: unknown) => {
  if ((ex as Error)?.name === 'NotAllowedError') return 'Passkey cancelled.';
  if (isConnectionError(ex, navigator.onLine)) return "Couldn't reach bharatlas's sync service. Check your connection and try again.";
  return (ex as Error)?.message || 'Something went wrong.';
};

/** Draws the controls into `box`; `onChange` runs after the list may have changed (sync, unlock). */
export function renderSubmissionSync(box: HTMLElement, sync: Sync, opts: { passkeys: boolean; onChange: () => void }, note = ''): void {
  const again = (msg = '') => renderSubmissionSync(box, sync, opts, msg);
  const act = (button: HTMLButtonElement, run: () => Promise<void>) => {
    button.onclick = async () => {
      button.disabled = true;
      try {
        await run();
        opts.onChange();
        again();
      } catch (ex) {
        again(errorText(ex));
      }
    };
  };
  const st = sync.state();
  const noteHtml = '<p class="subs-sync-note" id="subs-sync-note" role="status"></p>';

  if (!st) {
    box.innerHTML =
      `<h3>Keep these links on all your devices <span class="hint">(optional)</span></h3>` +
      `<p class="hint">${NOTICE}</p>` +
      `<button type="button" class="btn btn--fill" id="subs-sync-on">Turn on sync</button>` +
      (opts.passkeys
        ? `<button type="button" class="btn btn--line" id="subs-pk-unlock">Unlock with your passkey</button>` +
          `<p class="hint">Already synced on another device, or in collect? Use the passkey you added there.</p>`
        : '') +
      noteHtml;
    act(box.querySelector<HTMLButtonElement>('#subs-sync-on')!, () => sync.turnOn());
    const unlock = box.querySelector<HTMLButtonElement>('#subs-pk-unlock');
    if (unlock) act(unlock, () => sync.unlockWithPasskey());
  } else {
    const when = st.synced_at
      ? new Date(st.synced_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
      : 'not yet';
    box.innerHTML =
      `<h3>Sync is on <span class="hint">(last synced ${when})</span></h3>` +
      (opts.passkeys
        ? st.passkey
          ? `<p class="hint">Passkey added. On another device, choose <strong>Unlock with your passkey</strong> to bring these links there.</p>`
          : `<button type="button" class="btn btn--line" id="subs-pk-add">Add a passkey</button><p class="hint">Then, on another device, choose <strong>Unlock with your passkey</strong> (Face ID or fingerprint) to bring these links there.</p>`
        : `<p class="hint">Other devices unlock the synced copy with a passkey, which this browser can't make. Add one from a browser that can.</p>`) +
      `<button type="button" class="btn btn--line" id="subs-sync-off">Turn off sync and delete the synced copy</button>` +
      noteHtml;
    const add = box.querySelector<HTMLButtonElement>('#subs-pk-add');
    if (add) act(add, () => sync.addPasskey());
    const off = box.querySelector<HTMLButtonElement>('#subs-sync-off')!;
    let armed = false;
    off.onclick = async () => {
      if (!armed) {
        armed = true;
        off.textContent = 'Tap again: this turns sync off on all your devices';
        return;
      }
      off.disabled = true;
      try {
        await sync.turnOff();
        again();
      } catch (ex) {
        again(errorText(ex));
      }
    };
  }
  box.querySelector('#subs-sync-note')!.textContent = note;
}
