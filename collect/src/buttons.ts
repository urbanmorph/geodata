// Two button habits: a destructive action asks once more before it runs, and a
// button that sends something stays disabled while it works.
import { toast } from './toast';

/** The first tap swaps the button's text for `prompt`; the second runs `action`.
 *  `action` may call `rearm()` (after a failure, say) so the next tap asks again. */
export function confirmTwice(btn: HTMLButtonElement, prompt: string, action: (rearm: () => void) => unknown): void {
  let armed = false;
  btn.onclick = () => {
    if (!armed) { armed = true; btn.textContent = prompt; return; }
    void action(() => { armed = false; });
  };
}

/** Runs `work` with `btn` disabled. A failure is shown and the button enabled
 *  again; after success it stays disabled unless `reenable`. */
export async function busy(btn: HTMLButtonElement, work: () => Promise<unknown>, reenable = false): Promise<void> {
  btn.disabled = true;
  try {
    await work();
    if (reenable) btn.disabled = false;
  } catch (e) {
    toast((e as Error).message, 'error');
    btn.disabled = false;
  }
}
