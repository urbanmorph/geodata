// Single-open overlay state for the /view map chrome.
//
// The map viewer has three secondary surfaces — basemap picker, filter/export,
// download menu — plus a reserved slot for the Find-my-ward FAB (Step 1). They
// used to toggle independently, so on mobile opening one left the others
// stacked behind it. This reducer makes "which surface is open" a single source
// of truth: exactly one, or none, is ever active.
//
// Pure on purpose. The DOM controller that applies this state (open classes,
// scrim, focus, map.resize) lives in map.ts where the elements are; this module
// is just the state machine so it unit-tests without a browser.

export type Surface = 'basemap' | 'filter' | 'download' | 'findward';

export type OverlayState = { active: Surface | null };

export type OverlayAction =
  | { type: 'open'; surface: Surface }
  | { type: 'toggle'; surface: Surface }
  | { type: 'close' };

export const initialOverlayState: OverlayState = { active: null };

export function reduceOverlay(state: OverlayState, action: OverlayAction): OverlayState {
  switch (action.type) {
    case 'open':
      // Idempotent: re-opening the active surface returns the same reference so
      // subscribers can skip a needless re-render.
      return state.active === action.surface ? state : { active: action.surface };
    case 'toggle':
      return { active: state.active === action.surface ? null : action.surface };
    case 'close':
      return state.active === null ? state : { active: null };
    default:
      return state;
  }
}
