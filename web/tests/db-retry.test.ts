// A failed DuckDB-WASM start (CDN blip) is not cached: the next count or export tries again.
import { describe, it, expect, vi } from 'vitest';

const selectBundle = vi.fn();
vi.mock('@duckdb/duckdb-wasm', () => ({
  selectBundle: (...a: unknown[]) => selectBundle(...a),
  getJsDelivrBundles: () => ({}),
  ConsoleLogger: class {},
  LogLevel: { WARNING: 2 },
  AsyncDuckDB: class { instantiate = async () => {}; },
}));

describe('getDb', () => {
  it('retries after a failed start', async () => {
    vi.stubGlobal('Worker', class { terminate() {} });
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: vi.fn() }));
    selectBundle.mockRejectedValueOnce(new Error('cdn down')).mockResolvedValue({ mainWorker: 'w.js', mainModule: 'm.wasm' });
    const { getDb } = await import('../src/db');
    await expect(getDb()).rejects.toThrow('cdn down');
    await expect(getDb()).resolves.toBeTruthy();
    expect(selectBundle).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});
