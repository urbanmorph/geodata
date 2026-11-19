// Link previews (LinkedIn, WhatsApp, X) cache a share image by URL for weeks,
// so the URL carries the image's content hash: a new image is a new URL.
// Used by prerender.mjs and releases-page.mjs for web/public/<name>.png.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const ORIGIN = 'https://bharatlas.com';
const cache = new Map();

export function ogImage(name) {
  if (!cache.has(name)) {
    const hash = createHash('sha256').update(readFileSync(resolve(PUBLIC, `${name}.png`))).digest('hex');
    cache.set(name, `${ORIGIN}/${name}.png?v=${hash.slice(0, 10)}`);
  }
  return cache.get(name);
}
