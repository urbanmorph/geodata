// MapLibre's zoom and compass buttons stayed white in dark mode (#314
// follow-up). They take the panel tokens like every other control, on every
// page with a map (the layer map, embeds and the contribute preview all
// include the shared tokens).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error: plain .mjs
import { TOKENS, MAP_TOKENS } from '../scripts/shared-chrome.mjs';

const dark = (css: string) => {
  const at = css.indexOf('@media (prefers-color-scheme: dark)');
  return at < 0 ? '' : css.slice(at);
};

describe('map controls in dark mode', () => {
  const css = dark(MAP_TOKENS.slice(TOKENS.length));
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
  // The attribution (i) control stayed a white pill with a dark icon.
  it('the attribution control is a dark panel with readable text and a light icon', () => {
    expect(css).toMatch(/:root \.maplibregl-ctrl\.maplibregl-ctrl-attrib(, :root \.maplibregl-ctrl-attrib\.maplibregl-compact)? \{[^}]*background-color: var\(--bg-elevated\)[^}]*color: var\(--fg\)/);
    expect(css).toMatch(/:root \.maplibregl-ctrl-attrib a \{[^}]*color: var\(--muted-strong\)/);
    expect(css).toMatch(/:root \.maplibregl-ctrl-attrib-button \{[^}]*background-color: transparent[^}]*filter: invert\(1\)/);
  });
  it('the light theme keeps MapLibre defaults', () => {
    expect(TOKENS).not.toContain('maplibregl-ctrl');
  });
  it('ship only on pages with a map (the layer map, the contribute preview, /view)', () => {
    const read = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8');
    for (const f of ['index.html', 'preview.html']) expect(read(f), f).toContain('.maplibregl-ctrl-group');
    expect(read('functions/lib/render-view.ts')).toContain('${MAP_TOKENS}');
    for (const f of ['layers.html', 'about.html', 'docs.html']) expect(read(f), f).not.toContain('maplibregl-ctrl');
  });
});
