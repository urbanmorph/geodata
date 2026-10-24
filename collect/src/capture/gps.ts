// The phone's GPS while marking on foot. A web app gets no location in the
// background, so the screen is kept on (Screen Wake Lock: Chrome on Android,
// Safari 16.4+) for as long as a walk or a corner is being recorded.
import type { Fix } from './trace';

type Sentinel = { release(): Promise<void>; addEventListener(t: 'release', f: () => void): void };

/** Keep the screen on; call the returned function to let it sleep again. Taken
 *  back after the phone was switched away and returned (the lock is dropped then). */
export function keepScreenOn(): () => void {
  const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<Sentinel> } }).wakeLock;
  if (!wl) return () => {};
  let lock: Sentinel | null = null;
  let on = true;
  const take = (): void => {
    if (!on || document.visibilityState !== 'visible') return;
    wl.request('screen').then((l) => {
      if (!on) { void l.release().catch(() => {}); return; } // stopped while it was being granted
      lock = l;
      l.addEventListener('release', () => { if (lock === l) lock = null; }); // dropped when the app was switched away
    }, () => {});
  };
  const again = (): void => { if (!lock) take(); };
  take();
  document.addEventListener('visibilitychange', again);
  return () => {
    on = false;
    document.removeEventListener('visibilitychange', again);
    void lock?.release().catch(() => {});
    lock = null;
  };
}

/** Readings as they come. Call inside the tap handler (iPhone drops a
 *  location request made after an await). Returns a stop function. */
export function watchFixes(onFix: (f: Fix) => void, onError: (message: string) => void): () => void {
  if (!navigator.geolocation) { onError('Location is not available on this phone.'); return () => {}; }
  // A slow or missed reading is normal on foot (the watch keeps going): say so
  // only when none has come at all. A refused permission is always said.
  let got = false;
  let said = false;
  const id = navigator.geolocation.watchPosition(
    (p) => { got = true; onFix({ lng: p.coords.longitude, lat: p.coords.latitude, accuracy: p.coords.accuracy, t: p.timestamp }); },
    (e) => {
      if (e.code === e.PERMISSION_DENIED) return onError('Location is switched off for collect. Allow it in the browser settings.');
      if (!got && !said) { said = true; onError("Can't get a GPS reading yet. Step into the open."); }
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}
