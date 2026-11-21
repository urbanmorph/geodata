import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { serviceWorker } from './src/sw/precache';
import { renderNotFoundPage } from './src/not-found';
import { injectTokens } from '../shared/tokens.mjs';

// 404.html is static: its body (collect's header and the message) is filled in here.
const notFoundPage: Plugin = {
  name: 'collect:not-found',
  transformIndexHtml: (html, { path }) => (path === '/404.html' ? renderNotFoundPage(html) : html),
};

// The design tokens (shared/tokens.mjs, shared with bharatlas.com) go into
// styles.css at its /* @design-tokens */ marker, in dev and in the build.
const designTokens: Plugin = {
  name: 'collect:design-tokens',
  enforce: 'pre',
  transform: (code, id) => (id.split('?')[0].endsWith('/src/styles.css') ? injectTokens(code) : undefined),
};

// Three entries: the create-a-map landing (index.html), the /c app shell
// (c.html, served for every /c/<id>[/admin|/view] by functions/c/[[path]].ts)
// and the 404 (404.html, which Pages serves for any unknown address).
// public/ (schema/v1.json) is copied to dist/. dist/ is the Pages output.
export default defineConfig({
  // VITE_* build keys (the ArcGIS key) live in one gitignored file: geodata/.env.local.
  envDir: resolve(__dirname, '..'),
  // Writes dist/sw.js, the offline worker. The map style needs the India outline offline too.
  plugins: [designTokens, notFoundPage, serviceWorker(['/india-outline.geojson'])],
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        app: resolve(__dirname, 'c.html'),
        notFound: resolve(__dirname, '404.html'),
      },
      output: {
        // MapLibre in its own chunk: an app change leaves its file (and every
        // phone's cached copy of it) untouched, so a deploy doesn't resend it.
        manualChunks: (id: string) => (/[\\/]node_modules[\\/]maplibre-gl[\\/]/.test(id) ? 'maplibre' : undefined),
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
