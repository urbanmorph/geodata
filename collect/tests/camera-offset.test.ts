// Under reduced motion MapLibre turns flyTo into jumpTo, which drops `offset`,
// so a point moved to with an offset would land under the crosshair's sheet.
// easeTo keeps the offset (at duration 0), so offset moves use easeTo.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const src = resolve(__dirname, '../src');
const files = readdirSync(src, { recursive: true }).map(String).filter((f) => f.endsWith('.ts'));

describe('camera moves with an offset', () => {
  it('use easeTo, never flyTo', () => {
    const bad = files.flatMap((f) =>
      [...readFileSync(join(src, f), 'utf8').matchAll(/flyTo\(\{[^}]*offset:/g)].map(() => f));
    expect(bad).toEqual([]);
  });
});
