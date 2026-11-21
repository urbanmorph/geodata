// v4.7 phase A2: resvg-wasm wrapper for the edge OG renderer.
// Cloudflare Pages Functions bundle the .wasm module statically at deploy
// time — workerd disallows `WebAssembly.instantiate()` from fetched bytes
// for security reasons, so we import the binary directly. Fonts are
// read from the deployment's static files (env.ASSETS) and cached per isolate;
// workerd has no system fonts so text renders as nothing without this.

import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { OG_FONT_FILES } from './og-template';
import { fetchAsset, type AssetCtx } from './catalog-loader';
import { ResolvedCache } from './isolate-cache';
// @ts-expect-error — Pages' bundler resolves this; Node test env never
// reaches this line because og-render itself is mocked in unit tests.
import wasmModule from '@resvg/resvg-wasm/index_bg.wasm';

let initPromise: Promise<void> | null = null;
const fontCache = new ResolvedCache<Uint8Array[]>();

async function ensureInit(): Promise<void> {
  if (initPromise) return initPromise;
  // A failed init must not stay cached, or every later render in this
  // isolate fails too.
  initPromise = initWasm(wasmModule as WebAssembly.Module).catch((e) => {
    initPromise = null;
    throw e;
  });
  return initPromise;
}

// Fonts are fetched (request I/O), so only loaded fonts are shared across
// requests (isolate-cache.ts). initWasm above is not request I/O, and may run
// only once, so it keeps its shared promise.
function ensureFont(ctx: AssetCtx): Promise<Uint8Array[]> {
  return fontCache.get('', () => Promise.all(
    OG_FONT_FILES.map(async (f) => {
      const r = await fetchAsset(ctx, `/${f}`);
      if (!r.ok) throw new Error(`failed to load OG font ${f}: ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    }),
  ), ctx.request);
}

export async function renderOgPng(svg: string, ctx: AssetCtx): Promise<Uint8Array> {
  await ensureInit();
  const fonts = await ensureFont(ctx);
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'original' },
    font: {
      fontBuffers: fonts,
      defaultFontFamily: 'DM Sans',
      sansSerifFamily: 'DM Sans',
      loadSystemFonts: false,
    },
  });
  // Resvg objects live in WASM memory: free them, or each render leaks.
  const image = resvg.render();
  try {
    return image.asPng();
  } finally {
    image.free();
    resvg.free();
  }
}

export function __resetForTest(): void {
  initPromise = null;
  fontCache.clear();
}
