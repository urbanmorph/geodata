import { describe, it, expect } from 'vitest';
import { paddingForPanelRect } from '../src/map-padding';

// The viewer re-frames the map when the Filter & export panel is open, padding
// the side the panel occupies. The mobile bottom sheet is full-width; the
// desktop drawer is narrow on the right. Detect by WIDTH — an earlier version
// keyed off the sheet touching the viewport bottom, but once the sheet floats
// above the bottom toolbar that test misfired and padded the RIGHT by the full
// panel width (wider than the canvas), tripping MapLibre's "cannot fit within
// canvas" warning. Regression guard for that.

describe('paddingForPanelRect', () => {
  const base = 20;

  it('no panel → uniform base padding', () => {
    // width 0 is treated as "no occupying panel" by callers; helper still pads.
    expect(paddingForPanelRect({ width: 0, height: 0 }, 390, base)).toEqual({
      top: base, bottom: base, left: base, right: base,
    });
  });

  it('full-width mobile bottom sheet → pads the BOTTOM by its height, never the right', () => {
    const p = paddingForPanelRect({ width: 390, height: 440 }, 390, base);
    expect(p).toEqual({ top: base, bottom: base + 440, left: base, right: base });
    // The bug was right = base + 390 (wider than the 390px canvas).
    expect(p.right).toBe(base);
  });

  it('narrow desktop right drawer → pads the RIGHT by its width', () => {
    expect(paddingForPanelRect({ width: 360, height: 600 }, 1100, base)).toEqual({
      top: base, bottom: base, left: base, right: base + 360,
    });
  });

  it('width at the 70%-of-viewport threshold counts as a bottom sheet', () => {
    const p = paddingForPanelRect({ width: 280, height: 300 }, 400, base); // 280 === 0.7*400
    expect(p.bottom).toBe(base + 300);
    expect(p.right).toBe(base);
  });

  it('defaults base to 20 when omitted', () => {
    expect(paddingForPanelRect({ width: 360, height: 600 }, 1100).right).toBe(20 + 360);
  });
});
