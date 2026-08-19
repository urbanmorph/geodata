// Pure geometry assembly for the capture screen (Phase 4). The UI collects
// vertices by panning the crosshair and tapping "+ vertex" (no map-tap handler,
// so it never fights the pan gesture); these helpers turn mode + vertices into
// GeoJSON. Points use the live map centre; lines/polygons use the dropped verts.

export type GeomMode = 'point' | 'line' | 'polygon';
export type Coord = [number, number];
export type DrawGeometry =
  | { type: 'Point'; coordinates: Coord }
  | { type: 'LineString'; coordinates: Coord[] }
  | { type: 'Polygon'; coordinates: Coord[][] };

const VALID: GeomMode[] = ['point', 'line', 'polygon'];

/** Declared geometry set → the modes to offer, point-first; always non-empty. */
export function orderedModes(declared: readonly string[]): GeomMode[] {
  const modes = VALID.filter((m) => declared.includes(m));
  return modes.length ? modes : ['point'];
}

/** Build a geometry from the active mode; null when a shape needs more vertices. */
export function drawGeometry(mode: GeomMode, vertices: Coord[], center: Coord): DrawGeometry | null {
  if (mode === 'point') return { type: 'Point', coordinates: center };
  if (mode === 'line') return vertices.length >= 2 ? { type: 'LineString', coordinates: vertices } : null;
  if (mode === 'polygon') {
    return vertices.length >= 3 ? { type: 'Polygon', coordinates: [[...vertices, vertices[0]]] } : null;
  }
  return null;
}
