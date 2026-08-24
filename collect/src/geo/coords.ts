// Flatten any GeoJSON geometry's `coordinates` to its [lng, lat] leaf pairs —
// used to fit the map camera over a set of features (points, lines, polygons,
// and their Multi* variants all nest arrays to different depths).
export function geometryLngLats(coords: unknown, out: [number, number][] = []): [number, number][] {
  if (!Array.isArray(coords)) return out;
  if (typeof coords[0] === 'number') out.push(coords as [number, number]);
  else for (const c of coords) geometryLngLats(c, out);
  return out;
}
