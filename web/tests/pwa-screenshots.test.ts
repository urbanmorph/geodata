// The install dialog (Android, desktop Chrome) shows the manifest's screenshots;
// a declared size that differs from the file makes Chrome drop the image.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Width x height of a WebP (lossy VP8, lossless VP8L or extended VP8X). */
export function webpSize(b: Buffer): [number, number] {
  const kind = b.toString('ascii', 12, 16);
  if (kind === 'VP8X') return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
  if (kind === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return [1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)];
  }
  return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
}

for (const app of ['web', 'collect']) {
  describe(`${app} install screenshots`, () => {
    const pub = resolve(__dirname, '../..', app, 'public');
    const manifest = JSON.parse(readFileSync(resolve(pub, 'manifest.webmanifest'), 'utf8'));
    for (const s of manifest.screenshots) {
      it(`${s.src} is ${s.sizes}`, () => {
        expect(webpSize(readFileSync(resolve(pub, s.src.slice(1)))).join('x')).toBe(s.sizes);
      });
    }
  });
}
