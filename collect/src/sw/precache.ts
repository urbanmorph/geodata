import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { Plugin } from 'vite';

/**
 * What the offline worker saves on install: the landing page, the map app shell
 * (c.html, served for every /c/… link, so saved as /c/), every hashed build file
 * and the loose files listed (the map needs the India outline). The version
 * changes whenever any of them does, so a deploy installs a new worker.
 */
export async function precacheList(dist: string, files: string[]) {
  const paths = (await readdir(dist, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => `/${relative(dist, join(e.parentPath, e.name))}`)
    .sort();
  const assets = paths.filter((p) => p.startsWith('/assets/'));
  const missing = files.filter((f) => !paths.includes(f));
  if (missing.length) throw new Error(`offline worker: ${missing.join(', ')} not in the build`);
  const hash = createHash('sha256');
  for (const p of ['/index.html', '/c.html', ...files, ...assets]) hash.update(p).update(await readFile(join(dist, p)));
  return { version: hash.digest('hex').slice(0, 16), pages: ['/', '/c/'], files, assets };
}

/** Writes dist/sw.js after the build: src/sw/sw.js with its precache list prepended. */
export function serviceWorker(files: string[]): Plugin {
  let outDir = '';
  return {
    name: 'collect:service-worker',
    apply: 'build',
    configResolved: (config) => void (outDir = resolve(config.root, config.build.outDir)),
    async closeBundle() {
      const list = await precacheList(outDir, files);
      const source = await readFile(new URL('./sw.js', import.meta.url), 'utf8');
      await writeFile(join(outDir, 'sw.js'), `self.__PRECACHE__=${JSON.stringify(list)};\n${source}`);
      this.info?.(`sw.js ${list.version}: ${list.assets.length} build files`);
    },
  };
}
