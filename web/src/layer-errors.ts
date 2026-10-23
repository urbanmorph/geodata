// What the viewer says when a layer can't load: plainly, when it is the connection
// (bharatlas loads its maps and data from the internet); the technical reason otherwise.
import { isConnectionError } from '../../shared/connection';

export function layerLoadErrorText(err: unknown, online = navigator.onLine): string {
  if (isConnectionError(err, online)) return "No connection: this layer needs the internet to load. Try again when you're back online.";
  return `failed to load layer: ${(err as Error)?.message ?? String(err)}`;
}

/** Turns the map's "loading map…" indicator (#map-loading) into the reason it failed. */
export function showLayerError(container: HTMLElement, err: unknown, online = navigator.onLine): void {
  let el = container.querySelector<HTMLElement>('#map-loading');
  if (!el) {
    el = document.createElement('div');
    el.id = 'map-loading';
    container.appendChild(el);
  }
  el.textContent = layerLoadErrorText(err, online);
}
