import { defineConfig, type Plugin } from 'vite';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

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
        resolve(server.config.root, 'about.template.html'),
        resolve(server.config.root, 'verify.template.html'),
        resolve(server.config.root, 'submit.template.html'),
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

export default defineConfig({
  plugins: [prerenderPlugin()],
  // Proxy paths that aren't served by Vite to a background `wrangler pages dev`
  // on 8788. /api/* are Pages Functions (D1, R2, Turnstile). /c/<id> is the
  // edge-rendered view page. Start wrangler with:
  //   wrangler pages dev dist/ --port=8788
  server: {
    proxy: {
      '/api': 'http://localhost:8788',
      '/c': 'http://localhost:8788',
    },
  },
  build: {
    target: 'es2022',
    cssCodeSplit: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        about: resolve(__dirname, 'about.html'),
        verify: resolve(__dirname, 'verify.html'),
        submit: resolve(__dirname, 'submit.html'),
      },
      output: {
        manualChunks(id) {
          // Shared between map + filter; pulling it into its own chunk avoids
          // dragging the map-vendor static import in via the filter side.
          if (id.includes('src/loading')) return 'loader';
          if (id.includes('src/util') || id.includes('src/catalog')) return 'shared';
          // Heavy map deps as a separate vendor chunk for clean cache lifetime.
          if (id.includes('maplibre-gl') || id.includes('pmtiles')) return 'map-vendor';
        },
      },
    },
  },
});
