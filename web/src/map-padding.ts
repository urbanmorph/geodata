// Pure decision for how the map should be padded while a side panel (Filter
// & export on the right, About this layer on the left) is open, so the fitted data frames clear of the panel.
//
// Detect the panel kind by WIDTH relative to the viewport: a full-width panel
// is the mobile bottom sheet (reserve vertical room below the data); a narrow
// panel is the desktop right drawer (reserve room on the right). Keyed off
// width, not the sheet's bottom edge — the sheet floats above the bottom
// toolbar on mobile, so a "touches the viewport bottom" test would misclassify
// it as a side drawer and pad the right by the full panel width, which exceeds
// the canvas and trips MapLibre's "cannot fit within canvas" warning.
//
// Extracted from map.ts so it unit-tests without importing MapLibre.

export type Padding = { top: number; bottom: number; left: number; right: number };

/** The padding of a fit with no panel open. Desktop keeps 60 px at the top for
 *  the controls over the map; on a phone the zoom buttons sit at the right edge,
 *  clear of a fitted India, so top and bottom match and the map is centred
 *  instead of sitting low under empty space. */
export function basePadding(mobile: boolean): Padding {
  return mobile ? { top: 20, bottom: 20, left: 20, right: 20 } : { top: 60, bottom: 20, left: 20, right: 20 };
}

export function paddingForPanelRect(
  r: { width: number; height: number },
  vw: number,
  base = 20,
  side: 'left' | 'right' = 'right',
): Padding {
  if (r.width >= vw * 0.7) {
    return { top: base, bottom: base + r.height, left: base, right: base };
  }
  return { top: base, bottom: base, left: base, right: base, [side]: base + r.width };
}
