// @vitest-environment happy-dom
// The bottom sheet (point details, Manage, capture) collapses with a swipe down
// on its handle and comes back with a swipe up, as on any phone or iPad sheet.
// It used to respond only to a tap on a thin strip, so an iPad user dragging it
// down saw nothing happen.
import { describe, it, expect, vi } from 'vitest';
import { swipeIntent, wireSheetSwipe } from '../src/sheet-swipe';

describe('swipeIntent', () => {
  it('a drag down collapses an open sheet; a drag up opens a collapsed one', () => {
    expect(swipeIntent(60, false)).toBe('collapse');
    expect(swipeIntent(-60, true)).toBe('expand');
  });
  it('small movements are taps, and drags the wrong way do nothing', () => {
    expect(swipeIntent(8, false)).toBeNull();
    expect(swipeIntent(-60, false)).toBeNull();
    expect(swipeIntent(60, true)).toBeNull();
  });
});

describe('wireSheetSwipe', () => {
  const pointer = (type: string, y: number) => new PointerEvent(type, { clientY: y, bubbles: true, pointerId: 1 });
  function setup(collapsed = false) {
    document.body.innerHTML = `<div id="app"><div class="sheet${collapsed ? ' collapsed' : ''}"><button class="grab"></button><div class="body">x</div></div></div>`;
    const toggle = vi.fn();
    wireSheetSwipe(document.getElementById('app')!, toggle);
    return { grab: document.querySelector('.grab') as HTMLElement, toggle };
  }

  it('swiping the handle down collapses the sheet', () => {
    const { grab, toggle } = setup();
    grab.dispatchEvent(pointer('pointerdown', 400));
    grab.dispatchEvent(pointer('pointerup', 470));
    expect(toggle).toHaveBeenCalledWith(grab);
  });

  it('a swipe is not also counted as a tap (no double toggle)', () => {
    const { grab } = setup();
    grab.dispatchEvent(pointer('pointerdown', 400));
    grab.dispatchEvent(pointer('pointerup', 470));
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    grab.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
  });

  it('a tap is left to the existing click handler', () => {
    const { grab, toggle } = setup();
    grab.dispatchEvent(pointer('pointerdown', 400));
    grab.dispatchEvent(pointer('pointerup', 403));
    expect(toggle).not.toHaveBeenCalled();
  });
});
