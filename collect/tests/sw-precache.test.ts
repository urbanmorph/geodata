import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { precacheList } from '../src/sw/precache';

let dist: string;
const put = (path: string, body = path) => {
  mkdirSync(dirname(join(dist, path)), { recursive: true });
  writeFileSync(join(dist, path), body);
};

beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), 'collect-dist-'));
  for (const p of ['/index.html', '/c.html', '/assets/app-DJmT4Z1m.js', '/assets/main-DEq_NYP-.js', '/india-outline.geojson', '/world-land.geojson', '/og.png']) put(p);
});
afterEach(() => rmSync(dist, { recursive: true, force: true }));

describe('precacheList', () => {
  it('saves the landing, the map app shell (served at /c/), the build files and the listed files', async () => {
    const list = await precacheList(dist, ['/india-outline.geojson']);
    expect(list.pages).toEqual(['/', '/c/']);
    expect(list.assets).toEqual(['/assets/app-DJmT4Z1m.js', '/assets/main-DEq_NYP-.js']);
    expect(list.files).toEqual(['/india-outline.geojson']);
  });

  it('has a version that changes only when something it saves changes', async () => {
    const a = (await precacheList(dist, ['/india-outline.geojson'])).version;
    put('/og.png', 'new image');
    expect((await precacheList(dist, ['/india-outline.geojson'])).version).toBe(a);
    put('/c.html', 'edited');
    expect((await precacheList(dist, ['/india-outline.geojson'])).version).not.toBe(a);
  });

  it('fails the build if a listed file is missing', async () => {
    await expect(precacheList(dist, ['/gone.geojson'])).rejects.toThrow(/gone\.geojson/);
  });
});
