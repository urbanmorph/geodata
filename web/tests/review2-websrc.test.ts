// Fixes from the second web review (Nov 2026). Wiring without a seam of its own
// is pinned on the source, as review-websrc.test.ts does.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8');
/** Source with // and /* comments removed, so only code and strings remain. */
const code = (f: string) => src(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
/** The body of a top-level function in a source file. */
const fnBody = (file: string, name: string) => {
  const s = code(file);
  const start = s.search(new RegExp(`function ${name}\\(`));
  expect(start, `${name} in ${file}`).toBeGreaterThan(-1);
  return s.slice(start, s.indexOf('\n}\n', start));
};

describe('closing the map while it first loads', () => {
  it('a show that resumes after the map was closed opens nothing', () => {
    const show = fnBody('src/main.ts', 'showMap');
    expect(show).toMatch(/const show = \+\+shows;/);
    expect(show).toMatch(/await loadMap\(\);\s*if \(show !== shows\) return;/);
    expect(fnBody('src/main.ts', 'hideMap')).toMatch(/shows\+\+;/);
  });
});

describe('"Zoom to it" frames the feature once', () => {
  it('a new pick drops the previous idle handler instead of stacking them', () => {
    const m = code('src/map.ts');
    expect(m).toMatch(/if \(zoomFitOnIdle\) map\.off\('idle', zoomFitOnIdle\);/);
    expect(m).not.toMatch(/map\.once\('idle', \(\) => \{\s*if \(!map\) return;\s*try \{\s*const feats/);
  });
});
