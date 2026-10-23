// Esri World Imagery: the satellite basemap in bharatlas and collect, licensed
// through an ArcGIS Location Platform API key (Basemaps privilege only; free up
// to 2M tiles a month, and with pay-as-you-go off it can never cost money).
// Keyless use of Esri's services is not licensed, so with no key there is no
// satellite option at all. The key reaches the browser in every tile URL; that
// is how Esri keys work, which is why its privilege is limited to basemaps.
// Key: VITE_ARCGIS_KEY (geodata/.env.local locally, a GitHub secret in CI);
// it expires 10 Oct 2027 (see ops-dashboard's PWA audit for renewal).
import type { SourceLike } from './liberty';

export const ESRI_IMAGERY_HOST = 'https://ibasemaps-api.arcgis.com';

/** Esri asks for "Powered by Esri" plus the service's own acknowledgements. */
const ATTRIBUTION =
  'Powered by <a href="https://www.esri.com" target="_blank" rel="noopener">Esri</a> · ' +
  'Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community';

/** The satellite tile source for a key, or null without one. Esri's tile order is {z}/{y}/{x}. */
export function esriImagerySource(key: string | undefined): SourceLike | null {
  const token = key?.trim();
  if (!token) return null;
  return {
    type: 'raster',
    tiles: [`${ESRI_IMAGERY_HOST}/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token=${encodeURIComponent(token)}`],
    tileSize: 256,
    maxzoom: 19,
    attribution: ATTRIBUTION,
  };
}
