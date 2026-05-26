/**
 * Ray-casting point-in-polygon for a polygon with optional holes.
 * rings[0] = outer ring, rings[1..n] = holes.
 * Each ring is [[x,y], [x,y], ...] with first == last (closed).
 * Returns true if the point is inside the outer ring and outside all holes.
 */
export function pointInPolygon(
  point: [number, number],
  rings: [number, number][][],
): boolean {
  let inside = ringContains(point, rings[0]);
  for (let i = 1; i < rings.length; i++) {
    if (ringContains(point, rings[i])) inside = false;
  }
  return inside;
}

function ringContains(point: [number, number], ring: [number, number][]): boolean {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
