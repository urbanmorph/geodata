// A short message over the page ("Added ✓"). One live region stays in the page
// and only its text changes, so screen readers announce each message (a region
// inserted with its text already in it is often not read).
let region: HTMLElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let clearTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(msg: string): void {
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
  }, 2400);
}
