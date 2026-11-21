// Home page "Find my ward": locate the visitor, find the ward map that covers
// them, and open it at their point (/view/<id>?at=lat,lng shows the ward).
// The location is requested synchronously in the tap: iOS WebKit and mobile
// Chrome silently drop a request made after an await or dynamic import.
import { shareUrl } from './locate-actions';

type LocateResponse = { results?: Record<string, { layer_id?: string }[] | undefined> } | null;

/** The ward layer that covers the located point, or null. */
export function wardLayerAt(resp: LocateResponse): string | null {
  return resp?.results?.['city-wards']?.[0]?.layer_id ?? null;
}

// The slice of navigator.geolocation this uses (tests pass a fake).
type Geo = {
  getCurrentPosition(
    ok: (p: { coords: { latitude: number; longitude: number } }) => void,
    err?: (e: { code: number; PERMISSION_DENIED: number }) => void,
    opts?: PositionOptions,
  ): void;
};

type Deps = {
  geolocation: Geo;
  fetch: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  go: (url: string) => void;
  say: (message: string) => void;
};

/**
 * Wire the home button. The click handler calls findMyWard, and so
 * getCurrentPosition, synchronously: keep any await or import() out of it.
 */
export function wireFindMyWard(btn: HTMLElement, status: HTMLElement, deps: Omit<Deps, 'say' | 'geolocation'> & { geolocation?: Geo }): void {
  const say = (message: string) => { status.hidden = false; status.textContent = message; };
  btn.addEventListener('click', () => {
    const { geolocation } = deps;
    if (!geolocation) return say("Your browser can't share your location. Search your area instead.");
    findMyWard({ ...deps, geolocation, say });
  });
}

export function findMyWard({ geolocation, fetch, go, say }: Deps): void {
  say('Finding your ward…');
  geolocation.getCurrentPosition(
    async ({ coords }) => {
      const lat = Number(coords.latitude.toFixed(5));
      const lng = Number(coords.longitude.toFixed(5));
      try {
        const r = await fetch(`/api/v1/locate?lat=${lat}&lng=${lng}`);
        const layer = r.ok ? wardLayerAt((await r.json()) as LocateResponse) : null;
        if (layer) go(shareUrl('', layer, lat, lng));
        else say('No ward map covers your location yet. Search your city or area instead.');
      } catch {
        say("Couldn't look up your ward. Try again.");
      }
    },
    (err) =>
      say(err.code === err.PERMISSION_DENIED
        ? 'Location permission denied. Allow it in your browser, or search your area instead.'
        : "Couldn't get your location. Try again, or search your area instead."),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
  );
}
