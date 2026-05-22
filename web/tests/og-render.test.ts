import { describe, it, expect, vi, beforeEach } from 'vitest';

// Cloudflare Pages bundles the .wasm at deploy time; vitest can't follow that
// import. We mock both @resvg/resvg-wasm and the .wasm side-import so the
// thin wrapper is unit-testable. Real WASM execution is covered by the e2e
// curl against `wrangler pages dev` before merge.
const m = vi.hoisted(() => {
  const initWasm = vi.fn().mockResolvedValue(undefined);
  const asPng = vi.fn().mockReturnValue(new Uint8Array([137, 80, 78, 71]));
  const render = vi.fn().mockReturnValue({ asPng });
  const ResvgCtor = vi.fn().mockImplementation(() => ({ render }));
  return { initWasm, ResvgCtor, render, asPng };
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

beforeEach(() => {
  __resetForTest();
  m.initWasm.mockClear();
  m.ResvgCtor.mockClear();
  m.render.mockClear();
  m.asPng.mockClear();
  fetchMock.mockClear();
});

describe('renderOgPng', () => {
  it('returns a Uint8Array (PNG bytes)', async () => {
    const out = await renderOgPng('<svg/>', 'https://x');
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBeGreaterThan(0);
  });

  it('initialises WASM and font fetch exactly once across calls', async () => {
    await renderOgPng('<svg/>', 'https://x');
    await renderOgPng('<svg/>', 'https://x');
    await renderOgPng('<svg/>', 'https://x');
    expect(m.initWasm).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://x/og-font.ttf');
  });

  it('passes the SVG and a fontBuffers config into Resvg', async () => {
    await renderOgPng('<svg id="t"/>', 'https://x');
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
    await expect(renderOgPng('<svg/>', 'https://x')).rejects.toThrow(/OG font.*404/);
  });
});
