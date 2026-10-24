// The point a finger meant: the nearest one within `radius` px of the tap. A 12px
// dot is smaller than a fingertip, so exact hits alone missed tap after tap.
export interface ScreenPoint { idx: number; x: number; y: number }

export function pickNearest(points: ScreenPoint[], tap: { x: number; y: number }, radius: number): number | null {
  let best: number | null = null;
  let bestD = radius * radius;
  for (const p of points) {
    const d = (p.x - tap.x) ** 2 + (p.y - tap.y) ** 2;
    if (d <= bestD) { bestD = d; best = p.idx; }
  }
  return best;
}
