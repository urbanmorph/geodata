import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { serviceWorker } from './src/sw/precache';

// Two entries: the create-a-map landing (index.html) and the /c app shell
// (c.html, served for every /c/<id>[/admin|/view] by functions/c/[[path]].ts).
// public/ (schema/v1.json) is copied to dist/. dist/ is the Pages output.
export default defineConfig({
  // Writes dist/sw.js, the offline worker. The map style needs the India outline offline too.
  plugins: [serviceWorker(['/india-outline.geojson'])],
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        app: resolve(__dirname, 'c.html'),
      },
    },
  },
  // Two-process local dev: `vite` here + `wrangler pages dev` (functions/D1/R2).
  // Vite proxies API + the app-shell routes to wrangler.
  server: {
    proxy: {
      '/api': 'http://localhost:8789',
      '/schema': 'http://localhost:8789',
      '^/c/.+': 'http://localhost:8789',
    },
  },
});
