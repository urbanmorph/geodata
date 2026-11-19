// A short message over the page ("Added ✓"), or an error (kept longer). One live region stays in the page
// and only its text changes, so screen readers announce each message (a region
// inserted with its text already in it is often not read).
let region: HTMLElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let clearTimer: ReturnType<typeof setTimeout> | undefined;

/** How long a message stays: long enough to read (~60 ms a character), and
 *  an error at least 6 s, so it isn't gone before it is understood. */
export function toastMs(msg: string, kind: 'info' | 'error' = 'info'): number {
  return Math.min(12_000, Math.max(kind === 'error' ? 6000 : 2400, msg.length * 60));
}

export function toast(msg: string, kind: 'info' | 'error' = 'info'): void {
  if (!region?.isConnected) {
    region = document.createElement('div');
    region.className = 'toast';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    document.body.appendChild(region);
  }
  const t = region;
  clearTimeout(hideTimer);
  clearTimeout(clearTimer);
  t.textContent = msg;
  requestAnimationFrame(() => t.classList.add('show'));
  hideTimer = setTimeout(() => {
    t.classList.remove('show');
    clearTimer = setTimeout(() => { t.textContent = ''; }, 300);
  }, toastMs(msg, kind));
}
