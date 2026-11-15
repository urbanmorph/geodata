// v4.7 phase A2: resvg-wasm wrapper for the edge OG renderer.
// Cloudflare Pages Functions bundle the .wasm module statically at deploy
// time — workerd disallows `WebAssembly.instantiate()` from fetched bytes
// for security reasons, so we import the binary directly. Fonts are
// fetched from same-origin static assets and cached per Worker isolate;
// workerd has no system fonts so text renders as nothing without this.

import { initWasm, Resvg } from '@resvg/resvg-wasm';
// @ts-expect-error — Pages' bundler resolves this; Node test env never
// reaches this line because og-render itself is mocked in unit tests.
import wasmModule from '@resvg/resvg-wasm/index_bg.wasm';

let initPromise: Promise<void> | null = null;
let fontPromise: Promise<Uint8Array> | null = null;

async function ensureInit(): Promise<void> {
  if (initPromise) return initPromise;
  // A failed init must not stay cached, or every later render in this
  // isolate fails too (ensureFont resets the same way).
  initPromise = initWasm(wasmModule as WebAssembly.Module).catch((e) => {
    initPromise = null;
    throw e;
  });
  return initPromise;
}

async function ensureFont(origin: string): Promise<Uint8Array> {
  if (fontPromise) return fontPromise;
  fontPromise = (async () => {
    const r = await fetch(`${origin}/og-font.ttf`);
    if (!r.ok) {
      fontPromise = null;
      throw new Error(`failed to load OG font: ${r.status}`);
    }
    return new Uint8Array(await r.arrayBuffer());
  })();
  return fontPromise;
}

export async function renderOgPng(svg: string, origin: string): Promise<Uint8Array> {
  await ensureInit();
  const font = await ensureFont(origin);
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'original' },
    font: {
      fontBuffers: [font],
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
  fontPromise = null;
}
