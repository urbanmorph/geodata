import { defineConfig, type Plugin } from 'vitest/config';

/** A .wasm import is a compiled WebAssembly.Module, as Pages' bundler makes it
 *  in Functions (functions/lib/zstd.ts). */
const wasmModule: Plugin = {
  name: 'wasm-module',
  load(id) {
    if (!id.endsWith('.wasm')) return null;
    return `import { readFileSync } from 'node:fs';
export default new WebAssembly.Module(readFileSync(${JSON.stringify(id)}));`;
  },
};

export default defineConfig({
  plugins: [wasmModule],
  test: {
    include: ['tests/**/*.test.ts'],
    // A fixed fake ArcGIS key, so tests never depend on whether the machine has the real one.
    env: { VITE_ARCGIS_KEY: 'test-arcgis-key' },
    environment: 'node',
    // Through vite, so its .wasm import reaches the plugin above.
    server: { deps: { inline: ['zstd-wasm-decoder'] } },
  },
});
