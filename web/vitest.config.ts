import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // A fixed fake ArcGIS key, so tests never depend on whether the machine has the real one.
    env: { VITE_ARCGIS_KEY: 'test-arcgis-key' },
    environment: 'node',
  },
});
