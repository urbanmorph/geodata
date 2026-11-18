import { describe, it, expect, vi, beforeEach } from 'vitest';

// Cloudflare Pages bundles the .wasm at deploy time; vitest can't follow that
// import. We mock both @resvg/resvg-wasm and the .wasm side-import so the
// thin wrapper is unit-testable. Real WASM execution is covered by the e2e
// curl against `wrangler pages dev` before merge.
const m = vi.hoisted(() => {
  const initWasm = vi.fn().mockResolvedValue(undefined);
  const asPng = vi.fn().mockReturnValue(new Uint8Array([137, 80, 78, 71]));
  const freeImage = vi.fn();
  const freeResvg = vi.fn();
  const render = vi.fn().mockReturnValue({ asPng, free: freeImage });
  const ResvgCtor = vi.fn().mockImplementation(() => ({ render, free: freeResvg }));
  return { initWasm, ResvgCtor, render, asPng, freeImage, freeResvg };
});

vi.mock('@resvg/resvg-wasm', () => ({
  initWasm: m.initWasm,
  Resvg: m.ResvgCtor,
}));
vi.mock('@resvg/resvg-wasm/index_bg.wasm', () => ({ default: {} }));

const fetchMock = vi.fn().mockResolvedValue({
  ok: true,
  status: 200,
  arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
});
vi.stubGlobal('fetch', fetchMock);

import { renderOgPng, __resetForTest } from '../functions/lib/og-render';

// A handler context without env.ASSETS: fonts fall back to a same-origin fetch.
const X = { request: new Request('https://x/og/view/a.png'), env: {} };

beforeEach(() => {
  __resetForTest();
  m.initWasm.mockClear();
  m.ResvgCtor.mockClear();
  m.render.mockClear();
  m.asPng.mockClear();
  m.freeImage.mockClear();
  m.freeResvg.mockClear();
  fetchMock.mockClear();
});

describe('renderOgPng', () => {
  it('returns a Uint8Array (PNG bytes)', async () => {
    const out = await renderOgPng('<svg/>', X);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBeGreaterThan(0);
  });

  it('initialises WASM and font fetch exactly once across calls', async () => {
    await renderOgPng('<svg/>', X);
    await renderOgPng('<svg/>', X);
    await renderOgPng('<svg/>', X);
    expect(m.initWasm).toHaveBeenCalledTimes(1);
    // Three static weights (400 body, 600 title, 800 wordmark): resvg can't
    // apply a variable font's weight axis (scripts/gen_og_fonts.py).
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const w of [400, 600, 800]) expect(fetchMock).toHaveBeenCalledWith(`https://x/og-font-${w}.ttf`);
  });

  it("reads the fonts from the deployment's own files (env.ASSETS) when it has them", async () => {
    const assets = { fetch: vi.fn(async () => new Response(new ArrayBuffer(8))) };
    await renderOgPng('<svg/>', { request: new Request('https://x/og/view/a.png'), env: { ASSETS: assets } });
    expect(assets.fetch).toHaveBeenCalledWith('https://x/og-font-400.ttf');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes the SVG and a fontBuffers config into Resvg', async () => {
    await renderOgPng('<svg id="t"/>', X);
    expect(m.ResvgCtor).toHaveBeenCalledWith(
      '<svg id="t"/>',
      expect.objectContaining({
        fitTo: { mode: 'original' },
        font: expect.objectContaining({
          fontBuffers: expect.any(Array),
          loadSystemFonts: false,
        }),
      }),
    );
  });

  it('throws a clear error when the font fetch fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    await expect(renderOgPng('<svg/>', X)).rejects.toThrow(/OG font.*404/);
  });
});

describe('renderOgPng frees WASM memory and recovers from a failed init', () => {
  it('frees the renderer and the image after each render', async () => {
    await renderOgPng('<svg/>', X);
    expect(m.freeImage).toHaveBeenCalledTimes(1);
    expect(m.freeResvg).toHaveBeenCalledTimes(1);
  });

  it('retries initWasm after a failure instead of failing forever', async () => {
    m.initWasm.mockRejectedValueOnce(new Error('boom'));
    await expect(renderOgPng('<svg/>', X)).rejects.toThrow('boom');
    await expect(renderOgPng('<svg/>', X)).resolves.toBeInstanceOf(Uint8Array);
  });
});
