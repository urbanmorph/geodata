// Dark mode: MapLibre's attribution (i) control stayed a white pill with a
// dark icon on collect's maps. It takes the card tokens like the zoom buttons.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');
const darkBlocks = [...css.matchAll(/@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\}\s*\}/g)].map((m) => m[1]).join('\n');

describe('collect map attribution in dark mode', () => {
  it('is a card-coloured panel with readable text and links', () => {
    expect(darkBlocks).toMatch(/\.maplibregl-map \.maplibregl-ctrl-attrib[^{]*\{[^}]*background-color: var\(--card\)[^}]*color: var\(--fg\)/);
    expect(darkBlocks).toMatch(/\.maplibregl-map \.maplibregl-ctrl-attrib a \{[^}]*color: var\(--muted\)/);
  });
  it('shows a light (i) icon', () => {
    expect(darkBlocks).toMatch(/\.maplibregl-map \.maplibregl-ctrl-attrib-button \{[^}]*background-color: transparent[^}]*filter: invert\(1\)/);
  });
});
