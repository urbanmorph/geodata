// MapLibre (most of the map page's download) gets a chunk of its own, so its
// file name, and the phone's cached copy, stay the same across app changes.
import { describe, it, expect } from 'vitest';
import config from '../vite.config';

type ChunkFn = (id: string) => string | undefined;
const chunkFor = (config as { build: { rollupOptions: { output: { manualChunks: ChunkFn } } } }).build.rollupOptions.output.manualChunks;

describe('build chunks', () => {
  it('puts MapLibre in its own chunk', () => {
    expect(chunkFor('/repo/collect/node_modules/maplibre-gl/dist/maplibre-gl.js')).toBe('maplibre');
  });
  it('leaves app code and other packages to the default split', () => {
    expect(chunkFor('/repo/collect/src/app.ts')).toBeUndefined();
    expect(chunkFor('/repo/collect/node_modules/pmtiles/dist/index.js')).toBeUndefined();
  });
});
