export function lngLatToTile(lng: number, lat: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x: Math.min(Math.max(x, 0), n - 1), y: Math.min(Math.max(y, 0), n - 1) };
}

/** The longitude and latitude of point (px, py) of tile z/x/y (tile coordinates, 0 to
 *  `extent`). The latitude goes through Mercator: a straight line between the tile's north
 *  and south edges is up to ~12 m off in a zoom-10 tile and ~200 m in a zoom-8 one, mid-tile. */
export function tilePointToLngLat(z: number, x: number, y: number, px: number, py: number, extent: number): [number, number] {
  const n = 2 ** z;
  return [((x + px / extent) / n) * 360 - 180, tileToLat(y + py / extent, n)];
}

function tileToLat(y: number, n: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
}
