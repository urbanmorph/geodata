// Swipe a bottom sheet's handle down to collapse it, up to bring it back (as on
// any phone or iPad sheet). A tap is left to the existing click handler; a swipe
// swallows the click that follows it, so the sheet never toggles twice.

const SWIPE_PX = 30; // shorter than this is a tap

export function swipeIntent(dy: number, collapsed: boolean): 'collapse' | 'expand' | null {
  if (Math.abs(dy) < SWIPE_PX) return null;
  if (dy > 0 && !collapsed) return 'collapse';
  if (dy < 0 && collapsed) return 'expand';
  return null;
}

export function wireSheetSwipe(root: HTMLElement, toggle: (grab: HTMLElement) => void): void {
  let start: { y: number; grab: HTMLElement } | null = null;
  let swallowClick = false;
  root.addEventListener('pointerdown', (e) => {
    const grab = (e.target as HTMLElement).closest<HTMLElement>('.grab');
    start = grab ? { y: e.clientY, grab } : null;
    swallowClick = false;
  });
  root.addEventListener('pointerup', (e) => {
    if (!start) return;
    const { grab, y } = start;
    start = null;
    const collapsed = !!grab.closest('.sheet')?.classList.contains('collapsed');
    if (swipeIntent(e.clientY - y, collapsed)) { swallowClick = true; toggle(grab); }
  });
  root.addEventListener('pointercancel', () => { start = null; });
  // Capture phase: runs before the tap handler and stops it for a swipe.
  root.addEventListener('click', (e) => {
    if (!swallowClick || !(e.target as HTMLElement).closest('.grab')) return;
    swallowClick = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
}
