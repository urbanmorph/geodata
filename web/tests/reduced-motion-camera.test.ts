// Map camera moves under prefers-reduced-motion. MapLibre (4.x, camera.ts)
// already turns flyTo/easeTo, and fitBounds through them, into a jump when the
// reader asks for less motion, unless a call passes `essential: true`. Checked
// in a real browser (2026-11-19, /view filter fit): 78 move events over 1.3 s
// animated, 1 under reduce. So our calls need no duration override; they must
// just never opt out.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = resolve(__dirname, '..', 'src');

describe('map camera respects reduced motion', () => {
  it('no camera call in web/src marks itself essential (which would animate under reduce)', () => {
    const offenders = readdirSync(SRC)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /\bessential\s*:/.test(readFileSync(resolve(SRC, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the installed MapLibre still turns animations into jumps under prefers-reduced-motion', () => {
    const camera = readFileSync(
      resolve(__dirname, '..', 'node_modules', 'maplibre-gl', 'src', 'ui', 'camera.ts'),
      'utf8',
    );
    // easeTo (and fitBounds with linear: true)
    expect(camera).toContain(
      'if (options.animate === false || (!options.essential && browser.prefersReducedMotion)) options.duration = 0;',
    );
    // flyTo (and fitBounds by default) falls through to jumpTo
    const flyTo = camera.slice(camera.indexOf('flyTo(options: FlyToOptions'));
    expect(flyTo.slice(0, 400)).toContain('!options.essential && browser.prefersReducedMotion');
  });
});
