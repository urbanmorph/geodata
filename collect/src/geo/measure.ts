// Distances and areas on the ground, for marking routes and fields.
export type LngLat = [number, number];

const R = 6_371_008.8; // mean Earth radius, metres
const rad = (d: number) => (d * Math.PI) / 180;

export function metresBetween(a: LngLat, b: LngLat): number {
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Area of a ring in square metres (spherical excess; open or closed ring). */
export function ringArea(ring: LngLat[]): number {
  const pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
  if (pts.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    sum += rad(x2 - x1) * (2 + Math.sin(rad(y1)) + Math.sin(rad(y2)));
  }
  return Math.abs((sum * R * R) / 2);
}

export const SQ_M_PER_ACRE = 4046.8564224;
const GUNTAS_PER_ACRE = 40;

/** "1 acre 10 guntas", "5 guntas", or "60 m²" when under a gunta. */
export function formatArea(m2: number): string {
  if (m2 < SQ_M_PER_ACRE / GUNTAS_PER_ACRE) return `${Math.round(m2)} m²`;
  const guntasTotal = Math.round((m2 / SQ_M_PER_ACRE) * GUNTAS_PER_ACRE);
  const acres = Math.floor(guntasTotal / GUNTAS_PER_ACRE);
  const guntas = guntasTotal % GUNTAS_PER_ACRE;
  const parts = [];
  if (acres) parts.push(`${acres} acre${acres === 1 ? '' : 's'}`);
  if (guntas) parts.push(`${guntas} gunta${guntas === 1 ? '' : 's'}`);
  return parts.join(' ');
}

/** Length of a line in metres. */
export function lineLength(pts: LngLat[]): number {
  let m = 0;
  for (let i = 1; i < pts.length; i++) m += metresBetween(pts[i - 1], pts[i]);
  return m;
}

export function formatLength(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(m >= 10_000 ? 0 : 1)} km` : `${Math.round(m)} m`;
}

/** Fewer points along the same path: drops points within `toleranceM` of the
 *  line between their neighbours (Douglas-Peucker on a local flat projection). */
export function simplify(pts: LngLat[], toleranceM: number): LngLat[] {
  if (pts.length < 3) return pts.slice();
  const lat0 = rad(pts[0][1]);
  const xy = pts.map(([lng, lat]) => [rad(lng) * Math.cos(lat0) * R, rad(lat) * R]);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = xy[a], [bx, by] = xy[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let far = -1, farD = toleranceM;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = xy[i];
      const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > farD) { far = i; farD = d; }
    }
    if (far >= 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
