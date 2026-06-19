// Pure helpers behind GET /api/v1/layers/{id}/locate (find-my-location).
//
// The endpoint composes two existing engines — `locate` (contains: point-in-
// polygon over PMTiles) and `nearby` (nearest: parquet bbox/centroid) — and
// branches per layer geometry. These are the geometry-free bits: the compass
// bearing rendered on a "nearest" result, and pulling a single layer's
// containing feature out of the aggregate `locate` response (which groups hits
// by category across many layers).

import type { LocateResponse } from './locate';

const COMPASS_8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
export type Compass = (typeof COMPASS_8)[number];

/** Initial great-circle bearing from A to B, degrees clockwise from north (0-360). */
export function compassBearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Snap any degree value to the nearest of N/NE/E/SE/S/SW/W/NW. */
export function compass8(deg: number): Compass {
  const norm = ((deg % 360) + 360) % 360;
  return COMPASS_8[Math.round(norm / 45) % 8];
}

export function bearingLabel(lat1: number, lng1: number, lat2: number, lng2: number): Compass {
  return compass8(compassBearing(lat1, lng1, lat2, lng2));
}

/** The aggregate `locate` groups hits by category; find this layer's feature. */
export function pickContains(
  resp: LocateResponse,
  layerId: string,
): { properties: Record<string, unknown> } | null {
  for (const hits of Object.values(resp.results)) {
    const hit = hits.find((h) => h.layer_id === layerId);
    if (hit) return hit.feature;
  }
  return null;
}
