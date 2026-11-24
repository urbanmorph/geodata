import { defineConfig, type Plugin } from 'vite';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error: plain .mjs
import { renderNotFoundPage } from './scripts/not-found-page.mjs';
import { dataId } from './scripts/data-id.mjs';
// @ts-expect-error: plain .mjs
import { releasePages } from './scripts/releases-page.mjs';

// Re-run prerender.mjs whenever any template or catalog.json changes.
// Vite's HMR then reloads the page automatically.
function prerenderPlugin(): Plugin {
  const run = () => {
    try {
      execSync('node scripts/prerender.mjs', { stdio: 'inherit' });
    } catch (e) {
      console.error('[prerender] failed:', (e as Error).message);
    }
  };
  return {
    name: 'geodata-prerender',
    configureServer(server) {
      run(); // initial build
      const watched = [
        resolve(server.config.root, 'index.template.html'),
        resolve(server.config.root, 'layers.template.html'),
        resolve(server.config.root, 'about.template.html'),
        resolve(server.config.root, 'design.template.html'),
        resolve(server.config.root, 'preview.template.html'),
        resolve(server.config.root, 'scripts', 'prerender.mjs'),
        resolve(server.config.root, '..', 'catalog.json'),
      ];
      watched.forEach((f) => server.watcher.add(f));
      server.watcher.on('change', (file) => {
        if (watched.some((w) => file === w)) {
          console.log('[prerender] regenerating (change in', file.split('/').pop(), ')');
          run();
          server.ws.send({ type: 'full-reload' });
        }
      });
    },
  };
}

// dist/build-id.txt: one new id per build. The Functions read it (lib/catalog-loader.ts)
// into the deploy version that keys the edge cache, so each deploy starts fresh.
function buildIdPlugin(): Plugin {
  return {
    name: 'geodata-build-id',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build-id.txt', source: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}\n` });
      // dist/data-id.txt: the baked data's id (scripts/data-id.mjs); API answer keys follow it, not the build.
      this.emitFile({ type: 'asset', fileName: 'data-id.txt', source: `${dataId(resolve(__dirname, 'public/api-data'))}\n` });
    },
  };
}

// dist/404.html: Pages serves it, with a 404, for any path no file or Function
// answers (instead of the home page at 200), and the edge 404s fill it in
// (functions/lib/not-found.ts). Self-contained, so it needs no Vite entry.
function notFoundPagePlugin(): Plugin {
  return {
    name: 'geodata-404',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '404.html', source: renderNotFoundPage() });
    },
  };
}

// dist/releases.html and dist/releases/<dataset>.html: the release index
// (public/releases/index.json) as pages; functions/releases serves them.
// Built like the 404 page, so they leave no generated file in the tree.
function releasePagesPlugin(): Plugin {
  return {
    name: 'geodata-releases',
    apply: 'build',
    generateBundle() {
      const index = JSON.parse(readFileSync(resolve(__dirname, 'public', 'releases', 'index.json'), 'utf8'));
      const catalog = JSON.parse(readFileSync(resolve(__dirname, '..', 'catalog.json'), 'utf8'));
      const layerIds = new Set(catalog.layers.map((l: { id: string }) => l.id));
      for (const { fileName, html } of releasePages(index, layerIds)) this.emitFile({ type: 'asset', fileName, source: html });
    },
  };
}

export default defineConfig({
  // VITE_* build keys (the ArcGIS key) live in one gitignored file: geodata/.env.local.
  envDir: resolve(__dirname, '..'),
  plugins: [prerenderPlugin(), buildIdPlugin(), notFoundPagePlugin(), releasePagesPlugin()],
  // Proxy paths that aren't served by Vite to a background `wrangler pages dev`
  // on 8788. /api/* are Pages Functions (D1, R2, Turnstile). /c/<id> is the
  // edge-rendered view page. Start wrangler with:
  //   wrangler pages dev dist/ --port=8788
  //
  // IMPORTANT: prefix patterns are MATCHED BY STRING.startsWith — '/c' alone
  // catches '/contribute', '/catalog', etc. Anchor with a trailing slash and
  // use a regex if needed.
  server: {
    proxy: {
      '/api': 'http://localhost:8788',
      '^/c/.+': 'http://localhost:8788',
      '^/og/.+': 'http://localhost:8788',
      '^/view/.+': 'http://localhost:8788',
      // wrangler-served pages (/view, /c, /og, …) reference dist hashed
      // assets like /assets/main-XXX.js. Vite dev doesn't generate those
      // (it serves /src/main.ts instead), so without this line the browser
      // 404s on assets when navigating to any wrangler-proxied path.
      '/assets': 'http://localhost:8788',
    },
  },
  build: {
    target: 'es2022',
    cssCodeSplit: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        layers: resolve(__dirname, 'layers.html'),
        about: resolve(__dirname, 'about.html'),
        design: resolve(__dirname, 'design.html'),
        preview: resolve(__dirname, 'preview.html'),
        privacy: resolve(__dirname, 'privacy.html'),
        terms: resolve(__dirname, 'terms.html'),
        docs: resolve(__dirname, 'docs.html'),
        mcp: resolve(__dirname, 'mcp.html'),
      },
      output: {
        manualChunks(id) {
          // Shared between map + filter; pulling it into its own chunk avoids
          // dragging the map-vendor static import in via the filter side.
          if (id.includes('src/loading')) return 'loader';
          if (id.includes('src/util') || /src\/(catalog|india-bbox)\.ts$/.test(id)) return 'shared';
          // Vite's preload helper in a chunk of its own, for the pages that load code
          // later (home, /preview), not inside whichever module Rollup picks (once
          // validate.ts, pulled onto the home page) or on every page.
          if (id.includes('vite/preload-helper')) return 'preload';
          // Heavy map deps as a separate vendor chunk for clean cache lifetime.
          if (id.includes('maplibre-gl') || id.includes('pmtiles')) return 'map-vendor';
        },
      },
    },
  },
});
