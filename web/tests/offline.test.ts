// Graceful offline fallback for bharatlas.com. Its maps and data load from the
// internet, so it is not an offline app, but losing the connection should say so:
// the site's own offline page instead of the browser's error, and a plain message
// when a layer can't load for lack of a connection.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { layerLoadErrorText } from '../src/layer-errors';
// @ts-expect-error: plain .mjs
import { wordmarkHtml, PALETTE } from '../../shared/brand.mjs';

const pub = (f: string) => readFileSync(resolve(__dirname, '..', 'public', f), 'utf8');
const OFFLINE = pub('offline/index.html');
const SW = pub('sw.js');

describe('offline page', () => {
  it('says why, offers "Try again" and home, and stays out of search', () => {
    expect(OFFLINE).toContain('<meta name="robots" content="noindex">');
    expect(OFFLINE).toMatch(/<h1>You're offline<\/h1>/);
    expect(OFFLINE).toContain('needs a connection');
    expect(OFFLINE).toMatch(/<a [^>]*href=""[^>]*>Try again/);
    expect(OFFLINE).toMatch(/<a [^>]*href="\/"/);
    expect(OFFLINE).toContain('viewport-fit=cover');
    expect(OFFLINE).toContain('prefers-color-scheme: dark');
    expect(pub('sitemap.xml')).not.toContain('offline');
  });
  it('wears the current brand: the shared wordmark, a saffron action with navy text, 44px targets', () => {
    // Self-contained (it shows with no network), so the markup is a copy: this keeps it from drifting.
    expect(OFFLINE).toContain(wordmarkHtml({ size: 28 }));
    expect(OFFLINE).toMatch(/\.go\{[^}]*background:var\(--accent-fill\);color:var\(--on-accent-fill\)/);
    expect(OFFLINE).toContain(`--accent-fill: ${PALETTE.saffron};`);
    expect(OFFLINE).toContain(`--on-accent-fill: ${PALETTE.navy};`);
    expect(OFFLINE).toMatch(/\.links a\{[^}]*min-height:44px/);
  });
});

describe('offline worker', () => {
  it('caches only the offline page and answers only page loads that fail', () => {
    // A directory page: Cloudflare Pages redirects a .html address, which the worker can't cache.
    expect(SW).toMatch(/const OFFLINE = '\/offline\/'/);
    expect(SW).toContain("'navigate'");
    expect(SW.match(/cache\.add\(/g)).toHaveLength(1);
    expect(SW).not.toContain('cache.put(');
  });
  it('ships a new worker whenever the offline page changes (VERSION is its hash)', () => {
    const digest = createHash('sha256').update(OFFLINE).digest('hex').slice(0, 12);
    expect(SW).toContain(`const VERSION = '${digest}'`);
  });
  it('is served no-cache, so browsers always see a new one', () => {
    expect(pub('_headers')).toMatch(/^\/sw\.js\n\s+Cache-Control: no-cache$/m);
  });
  it('is registered on every prerendered page (through install.ts)', () => {
    const install = readFileSync(resolve(__dirname, '..', 'src', 'install.ts'), 'utf8');
    expect(install).toMatch(/import \{ registerOfflinePage \} from '\.\/offline'/);
    expect(install).toContain('registerOfflinePage();');
  });
});

// Runs public/sw.js against a stand-in worker scope: its handlers, a cache and the network.
function runWorker(opts: { online: boolean; preload?: Response | undefined; hasPreloadApi?: boolean }) {
  const listeners: Record<string, (e: unknown) => void> = {};
  const enable = vi.fn(async () => {});
  const network = vi.fn(async () => {
    if (!opts.online) throw new TypeError('Failed to fetch');
    return new Response('from network');
  });
  const offlinePage = new Response('offline page', { headers: { 'content-type': 'text/html' } });
  const scope = {
    addEventListener: (type: string, fn: (e: unknown) => void) => { listeners[type] = fn; },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
    registration: opts.hasPreloadApi === false ? {} : { navigationPreload: { enable } },
  };
  const cachesApi = { keys: async () => [], delete: async () => true, open: async () => ({ add: async () => {} }), match: async () => offlinePage };
  new Function('self', 'caches', 'fetch', SW)(scope, cachesApi, network);
  const activate = async () => {
    let done: Promise<unknown> = Promise.resolve();
    listeners.activate({ waitUntil: (p: Promise<unknown>) => { done = p; } });
    await done;
  };
  const navigate = async () => {
    let answer: Promise<Response> | undefined;
    listeners.fetch({
      request: { method: 'GET', mode: 'navigate', url: 'https://bharatlas.com/view/x' },
      preloadResponse: Promise.resolve(opts.preload),
      respondWith: (r: Promise<Response>) => { answer = r; },
    });
    return answer!;
  };
  return { activate, navigate, enable, network };
}

describe('offline worker: navigation preload', () => {
  it('turns navigation preload on when it activates (where the browser has it)', async () => {
    const w = runWorker({ online: true });
    await w.activate();
    expect(w.enable).toHaveBeenCalledOnce();
    await runWorker({ online: true, hasPreloadApi: false }).activate(); // no error without it
  });
  it('answers a page load with the preloaded response, without a second request', async () => {
    const w = runWorker({ online: true, preload: new Response('preloaded') });
    expect(await (await w.navigate()).text()).toBe('preloaded');
    expect(w.network).not.toHaveBeenCalled();
  });
  it('fetches the page itself when there is no preload', async () => {
    const w = runWorker({ online: true });
    expect(await (await w.navigate()).text()).toBe('from network');
  });
  it('still shows the offline page (503) when the page cannot load', async () => {
    const w = runWorker({ online: false });
    const r = await w.navigate();
    expect(r.status).toBe(503);
    expect(await r.text()).toBe('offline page');
  });
});

describe('a layer that cannot load', () => {
  it('for lack of a connection: says so plainly', () => {
    expect(layerLoadErrorText(new TypeError('Failed to fetch'), true)).toBe(
      "No connection: this layer needs the internet to load. Try again when you're back online.",
    );
    expect(layerLoadErrorText(new Error('anything'), false)).toMatch(/^No connection/);
  });
  it('for any other reason: keeps the technical message', () => {
    expect(layerLoadErrorText(new Error('HTTP 404'), true)).toBe('failed to load layer: HTTP 404');
  });
});
