// The bottom sheet swaps its content in place, so focus would fall to <body>.
// Each sheet marks its title with SHEET_TITLE (focusable from script, not a
// Tab stop); after rendering, focusSheet moves focus there, or to a given
// control (Back returns to the row the person came from) when it exists.
export const SHEET_TITLE = 'data-sheet-title tabindex="-1"';

export function focusSheet(root: ParentNode, selector?: string): void {
  const el = (selector && root.querySelector<HTMLElement>(selector)) || root.querySelector<HTMLElement>('[data-sheet-title]');
  el?.focus({ preventScroll: true });
}
