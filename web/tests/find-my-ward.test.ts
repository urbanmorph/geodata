import { describe, it, expect, vi } from 'vitest';
import { wardLayerAt, findMyWard } from '../src/find-my-ward';

const locateResp = (wards: string[]) => ({
  results: {
    boundaries: [{ layer_id: 'lgd_states' }],
    'city-wards': wards.map((id) => ({ layer_id: id })),
  },
});

describe('wardLayerAt', () => {
  it('picks the ward layer that covers the point', () => {
    expect(wardLayerAt(locateResp(['wards_ahmedabad']))).toBe('wards_ahmedabad');
  });

  it('returns null where no ward map covers the point', () => {
    expect(wardLayerAt(locateResp([]))).toBeNull();
    expect(wardLayerAt({ results: {} })).toBeNull();
    expect(wardLayerAt(null)).toBeNull();
  });
});

describe('findMyWard', () => {
  const okFetch = (body: unknown) => vi.fn().mockResolvedValue({ ok: true, json: async () => body });

  it('asks for the location synchronously, inside the tap (iPhone drops it after an await)', () => {
    const getCurrentPosition = vi.fn();
    findMyWard({ geolocation: { getCurrentPosition }, fetch: okFetch({}), go: vi.fn(), say: vi.fn() });
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it('opens the ward map at the point, which shows the ward', async () => {
    const go = vi.fn();
    const fetch = okFetch(locateResp(['wards_ahmedabad']));
    await new Promise<void>((done) => {
      findMyWard({
        geolocation: { getCurrentPosition: (ok) => ok({ coords: { latitude: 23.05631, longitude: 72.55842 } }) },
        fetch,
        go: (url) => { go(url); done(); },
        say: vi.fn(),
      });
    });
    expect(fetch).toHaveBeenCalledWith('/api/v1/locate?lat=23.05631&lng=72.55842');
    expect(go).toHaveBeenCalledWith('/view/wards_ahmedabad?at=23.05631,72.55842');
  });

  it('says so when no ward map covers the spot, with a link to everything there', async () => {
    const say = vi.fn();
    await new Promise<void>((done) => {
      findMyWard({
        geolocation: { getCurrentPosition: (ok) => ok({ coords: { latitude: 26.1, longitude: 91.7 } }) },
        fetch: okFetch(locateResp([])),
        go: vi.fn(),
        say: (msg) => { say(msg); if (!msg.startsWith('Finding')) done(); },
      });
    });
    expect(say).toHaveBeenLastCalledWith(expect.stringMatching(/No ward map covers your location yet/));
  });

  it('explains a refused permission', () => {
    const say = vi.fn();
    findMyWard({
      geolocation: { getCurrentPosition: (_ok, err) => err?.({ code: 1, PERMISSION_DENIED: 1 }) },
      fetch: okFetch({}),
      go: vi.fn(),
      say,
    });
    expect(say).toHaveBeenLastCalledWith(expect.stringMatching(/Location permission denied/));
  });
});
