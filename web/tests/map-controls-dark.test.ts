// MapLibre's zoom and compass buttons stayed white in dark mode (#314
// follow-up). They take the panel tokens like every other control, on every
// page with a map (the layer map, embeds and the contribute preview all
// include the shared tokens).
import { describe, it, expect } from 'vitest';
// @ts-expect-error: plain .mjs
import { TOKENS } from '../scripts/shared-chrome.mjs';

const dark = (css: string) => {
  const at = css.indexOf('@media (prefers-color-scheme: dark)');
  return at < 0 ? '' : css.slice(at);
};

describe('map controls in dark mode', () => {
  const css = dark(TOKENS);
  // `:root` raises each rule over MapLibre's own stylesheet, which the bundle
  // injects after the page's inline tokens.
  it('the button group is an elevated panel with a token edge', () => {
    expect(css).toMatch(/:root \.maplibregl-ctrl-group:not\(:empty\) \{[^}]*background: var\(--bg-elevated\)/);
    expect(css).toMatch(/:root \.maplibregl-ctrl-group:not\(:empty\) \{[^}]*box-shadow: 0 0 0 1px var\(--line-bright\)/);
  });
  it('buttons are separated and hovered with tokens', () => {
    expect(css).toMatch(/:root \.maplibregl-ctrl-group button \+ button \{[^}]*border-top-color: var\(--line\)/);
    expect(css).toMatch(/:root \.maplibregl-ctrl-group button:not\(:disabled\):hover \{[^}]*background-color: var\(--bg-card\)/);
  });
  it('the dark icons turn light', () => {
    expect(css).toMatch(/:root \.maplibregl-ctrl-group \.maplibregl-ctrl-icon \{[^}]*filter: invert\(1\)/);
  });
  it('the light theme keeps MapLibre defaults', () => {
    expect(TOKENS.slice(0, TOKENS.indexOf('@media (prefers-color-scheme: dark)'))).not.toContain('maplibregl-ctrl-group');
  });
});
