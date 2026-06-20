// Move focus out of a region before it's hidden from assistive tech.
//
// Setting `aria-hidden="true"` (or `inert`) on an ancestor of the currently
// focused element is blocked by the browser and hides a focused control from
// AT users ("Blocked aria-hidden on an element because its descendant retained
// focus"). Our overlays close from a button inside themselves (#map-close, the
// locate sheet's share button), so the focused control is always a descendant.
// Blur it first — focus drops to <body>, and the revealed catalog is fully
// keyboard-reachable from there.
export function blurFocusWithin(container: Element, doc: Document = document): boolean {
  const active = doc.activeElement as HTMLElement | null;
  if (active && container.contains(active)) {
    active.blur();
    return true;
  }
  return false;
}
