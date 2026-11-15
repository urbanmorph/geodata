import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchWardIndex, _resetWardIndexCache } from '../src/ward-index';

describe('fetchWardIndex', () => {
  beforeEach(() => _resetWardIndexCache());

  it('fetches a city\'s ward index once and reuses it', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rows: [] }) });
    vi.stubGlobal('fetch', f);
    await fetchWardIndex('wards_ahmedabad');
    await fetchWardIndex('wards_ahmedabad');
    expect(f).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledWith('/ward-index/wards_ahmedabad.json');
  });

  it('gives null for a missing index or a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    expect(await fetchWardIndex('wards_x')).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await fetchWardIndex('wards_y')).toBeNull();
  });

  it('only ward layers have an index', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(await fetchWardIndex('lgd_states')).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});
