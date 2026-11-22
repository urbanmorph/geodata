// @vitest-environment happy-dom
// The ◎ button asks for the position inside the tap itself: iOS WebKit and
// mobile Chrome drop a geolocation request made after an await (PR #137).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { wireLocate } from '../src/geo/locate-button';

const button = () => {
  document.body.innerHTML = '<button id="locate">◎</button>';
  return document.getElementById('locate') as HTMLButtonElement;
};
const stubGeo = (impl: Geolocation['getCurrentPosition']) =>
  vi.stubGlobal('navigator', { ...navigator, geolocation: { getCurrentPosition: vi.fn(impl) } });
afterEach(() => vi.unstubAllGlobals());

describe('wireLocate', () => {
  it('asks for the position synchronously in the tap, with high accuracy and a timeout', () => {
    const asked = vi.fn();
    stubGeo(asked);
    const b = button();
    wireLocate(b, () => {});
    b.click();
    expect(asked).toHaveBeenCalledTimes(1); // already, before any await
    expect(asked.mock.calls[0][2]).toEqual({ enableHighAccuracy: true, timeout: 8000 });
  });

  it('hands the fix over as [lng, lat]', () => {
    stubGeo((ok) => ok({ coords: { longitude: 77.59, latitude: 12.97 } } as GeolocationPosition));
    const onFix = vi.fn();
    const b = button();
    wireLocate(b, onFix);
    b.click();
    expect(onFix).toHaveBeenCalledWith([77.59, 12.97]);
  });

  it('says so when the position cannot be had, or there is no geolocation', () => {
    stubGeo((_ok, err) => err?.({} as GeolocationPositionError));
    const b = button();
    const onFix = vi.fn();
    wireLocate(b, onFix);
    b.click();
    expect(document.querySelector('.toast')?.textContent).toBe("Couldn't get your location");
    vi.stubGlobal('navigator', { ...navigator, geolocation: undefined });
    b.click();
    expect(document.querySelector('.toast')?.textContent).toBe('Location not available');
    expect(onFix).not.toHaveBeenCalled();
  });
});
