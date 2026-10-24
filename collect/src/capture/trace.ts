// GPS for marking a boundary or a route on foot, with no data needed.
//   Walk around it: a trace that skips poor and crowded readings and closes
//     itself once the walker is back near where they started.
//   Stand at each corner: a few seconds of readings averaged into one corner.
import { metresBetween, ringArea, type LngLat } from '../geo/measure';

export interface Fix { lng: number; lat: number; accuracy: number; t: number; }

export const POOR_ACCURACY_M = 25; // readings worse than this are skipped
const MIN_STEP_M = 3;              // and readings closer than this to the last one
const CLOSE_M = 8;                 // back within this of the start = closed
const MIN_ROUND_M = 30;            // after having gone at least this far from it

export type TraceResult = 'added' | 'poor' | 'too-close' | 'paused';

export interface Trace {
  add(f: Fix): TraceResult;
  points(): LngLat[];
  /** Back near the start after going round (for an area). */
  closed(): boolean;
  area(): number;
  pause(): void;
  resume(): void;
  paused(): boolean;
  undo(): void;
}

export function createTrace(): Trace {
  const pts: LngLat[] = [];
  let farthest = 0;
  let isPaused = false;
  return {
    add(f) {
      if (isPaused) return 'paused';
      if (!(f.accuracy <= POOR_ACCURACY_M)) return 'poor';
      const p: LngLat = [f.lng, f.lat];
      if (pts.length && metresBetween(pts[pts.length - 1], p) < MIN_STEP_M) return 'too-close';
      pts.push(p);
      if (pts.length > 1) farthest = Math.max(farthest, metresBetween(pts[0], p));
      return 'added';
    },
    points: () => pts.slice(),
    closed: () => pts.length >= 4 && farthest >= MIN_ROUND_M && metresBetween(pts[0], pts[pts.length - 1]) <= CLOSE_M,
    area: () => ringArea(pts),
    pause() { isPaused = true; },
    resume() { isPaused = false; },
    paused: () => isPaused,
    undo() { pts.pop(); },
  };
}

/** One corner from several readings: the accuracy-weighted mean of the good ones. */
export function averageFix(fixes: Fix[]): Fix | null {
  const good = fixes.filter((f) => f.accuracy <= POOR_ACCURACY_M);
  if (!good.length) return null;
  let w = 0, lng = 0, lat = 0;
  for (const f of good) {
    const k = 1 / Math.max(1, f.accuracy) ** 2;
    w += k; lng += f.lng * k; lat += f.lat * k;
  }
  const best = Math.min(...good.map((f) => f.accuracy));
  // Averaging n independent readings narrows the error by about √n.
  return { lng: lng / w, lat: lat / w, accuracy: best / Math.sqrt(good.length), t: good[good.length - 1].t };
}
