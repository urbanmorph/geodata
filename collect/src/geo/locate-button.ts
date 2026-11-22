// The ◎ "Use my location" button on the capture map and the record editor.
import { toast } from '../toast';

/** Wires `btn` to ask for the person's position and hand it to `onFix` as
 *  [lng, lat]. The request runs synchronously inside the tap: iOS WebKit and
 *  mobile Chrome silently drop one made after an await (PR #137). */
export function wireLocate(btn: HTMLButtonElement, onFix: (lngLat: [number, number]) => void): void {
  btn.onclick = () => {
    if (!navigator.geolocation) return toast('Location not available', 'error');
    navigator.geolocation.getCurrentPosition(
      (pos) => onFix([pos.coords.longitude, pos.coords.latitude]),
      () => toast("Couldn't get your location", 'error'),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  };
}
