import { describe, it, expect } from 'vitest';
import {
  reduceOverlay,
  initialOverlayState,
  type OverlayState,
} from '../src/view-overlays';

// The /view map chrome had three independently-toggled surfaces (basemap,
// download, filter), so opening one left the others stacked behind it on
// mobile. reduceOverlay makes "which surface is open" single-source-of-truth:
// exactly one (or none) is ever active. This is the regression guard for the
// stacking bug.

describe('reduceOverlay', () => {
  it('starts with nothing open', () => {
    expect(initialOverlayState).toEqual({ active: null });
  });

  it('open(X) makes X the only active surface', () => {
    expect(reduceOverlay(initialOverlayState, { type: 'open', surface: 'filter' })).toEqual({
      active: 'filter',
    });
  });

  it('opening a second surface closes the first (no stacking)', () => {
    const filterOpen = reduceOverlay(initialOverlayState, { type: 'open', surface: 'filter' });
    const basemapOpen = reduceOverlay(filterOpen, { type: 'open', surface: 'basemap' });
    expect(basemapOpen).toEqual({ active: 'basemap' });
  });

  it('open(X) when X is already active is a no-op that keeps the same reference', () => {
    const open: OverlayState = { active: 'download' };
    expect(reduceOverlay(open, { type: 'open', surface: 'download' })).toBe(open);
  });

  it('toggle(X) opens X when closed and closes X when it is the active one', () => {
    const opened = reduceOverlay(initialOverlayState, { type: 'toggle', surface: 'filter' });
    expect(opened).toEqual({ active: 'filter' });
    const closed = reduceOverlay(opened, { type: 'toggle', surface: 'filter' });
    expect(closed).toEqual({ active: null });
  });

  it('toggle(Y) while X is open switches to Y (still single-open)', () => {
    const filterOpen: OverlayState = { active: 'filter' };
    expect(reduceOverlay(filterOpen, { type: 'toggle', surface: 'basemap' })).toEqual({
      active: 'basemap',
    });
  });

  it('close() clears whatever is open', () => {
    const open: OverlayState = { active: 'basemap' };
    expect(reduceOverlay(open, { type: 'close' })).toEqual({ active: null });
  });

  it('close() when nothing is open keeps the same reference (no needless render)', () => {
    expect(reduceOverlay(initialOverlayState, { type: 'close' })).toBe(initialOverlayState);
  });

  it('reserves a findward surface for the Find-my-ward FAB (Step 1)', () => {
    expect(reduceOverlay(initialOverlayState, { type: 'open', surface: 'findward' })).toEqual({
      active: 'findward',
    });
  });
});
