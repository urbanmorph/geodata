// The id of the baked data the API answers from (web/public/api-data/: filter stats, value
// indexes): a hash of every file's path and bytes. Written as dist/data-id.txt by the build
// (vite.config.ts); lib/catalog-loader.ts folds it into the data version that keys API
// answers, so they move with the data and stay put across code-only deploys.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const files = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? files(p) : [p];
});

/** A 16-hex-digit hash of every file under `dir` (path and bytes, in path order). */
export function dataId(dir) {
  const h = createHash('sha256');
  if (existsSync(dir)) {
    for (const p of files(dir).sort()) {
      h.update(relative(dir, p)).update('\0').update(readFileSync(p)).update('\0');
    }
  }
  return h.digest('hex').slice(0, 16);
}
