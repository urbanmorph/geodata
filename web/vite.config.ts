import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        // map code in its own chunk so the catalog page loads zero JS to render
        manualChunks(id) {
          if (id.includes('maplibre-gl') || id.includes('pmtiles')) return 'map';
        },
      },
    },
  },
});
