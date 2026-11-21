// The rasters /api/v1/surface reads at a point (shared/surface_rasters.json, baked by
// scripts/bake_surface_rasters.py): elevation and slope (Copernicus DEM GLO-90),
// population density (WorldPop 2020) and land cover (ESA WorldCover, once published).
import spec from '../../../shared/surface_rasters.json';
import { readPixel, readWindow } from './tiff-pixel';
import { r2Tiff } from './r2-tiff';
import type { PixelResult } from './profile';

export const SURFACE_RASTERS = spec;
type Name = keyof typeof spec.rasters;
const keyOf = (name: Name) => (spec.rasters[name].file as { key?: string } | null)?.key ?? null;

/** km per degree on the sphere the distance helpers use (R = 6371 km). */
const KM_PER_DEG = (6371 * Math.PI) / 180;

/** The area of one pixel (degrees) at a latitude, in km2. */
export function pixelAreaKm2(dLng: number, dLat: number, lat: number): number {
  return dLng * KM_PER_DEG * Math.cos((lat * Math.PI) / 180) * dLat * KM_PER_DEG;
}

/** Slope (degrees) at the centre of a 3 x 3 window (rows north to south) by Horn's
 *  method; dx and dy are the pixel size in metres. A missing neighbour counts as
 *  the centre (the edge of the data); a missing centre gives null. */
export function hornSlope(w: (number | null)[][], dx: number, dy: number): number | null {
  const c = w[1][1];
  if (c === null) return null;
  const z = (r: number, k: number) => w[r][k] ?? c;
  const dzdx = ((z(0, 2) + 2 * z(1, 2) + z(2, 2)) - (z(0, 0) + 2 * z(1, 0) + z(2, 0))) / (8 * dx);
  const dzdy = ((z(2, 0) + 2 * z(2, 1) + z(2, 2)) - (z(0, 0) + 2 * z(0, 1) + z(0, 2))) / (8 * dy);
  return (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
}

const notPublished = (name: Name): PixelResult => ({ status: 'unavailable', reason: `the ${spec.rasters[name].label} file is not published yet` });
const outside: PixelResult = { status: 'none', reason: "outside the raster (India's bounding box, 68-98 E, 6-38 N)" };

/** Elevation (m) and slope (degrees, and percent) at the point. */
export async function demAt(r2: R2Bucket, key: string | null | undefined, lat: number, lng: number): Promise<PixelResult> {
  if (!key) return notPublished('dem');
  const { reader, info: pending } = r2Tiff(r2, key);
  const info = await pending;
  const w = await readWindow(reader, info, lng, lat, 1);
  if (!w) return outside;
  if (w[1][1] === null) return { status: 'none', reason: 'no elevation here (sea, or outside the DEM)' };
  const dx = info.scale[0] * KM_PER_DEG * 1000 * Math.cos((lat * Math.PI) / 180);
  const dy = info.scale[1] * KM_PER_DEG * 1000;
  const slope = hornSlope(w, dx, dy)!;
  return {
    status: 'ok',
    data: { elevation_m: w[1][1], slope_deg: Math.round(slope * 10) / 10, slope_pct: Math.round(Math.tan((slope * Math.PI) / 180) * 1000) / 10 },
  };
}

/** People per km2 at the point, from WorldPop's people per pixel. */
export async function populationAt(r2: R2Bucket, key: string | null | undefined, lat: number, lng: number): Promise<PixelResult> {
  if (!key) return notPublished('worldpop');
  const { reader, info: pending } = r2Tiff(r2, key);
  const info = await pending;
  const v = await readPixel(reader, info, lng, lat);
  if (!v) return outside;
  if (v[0] === null) {
    return { status: 'none', reason: 'no settlement mapped in this pixel (WorldPop places people only in mapped settlements; also water and land outside India)' };
  }
  const people = Math.round(v[0] * 10) / 10;
  return { status: 'ok', data: { population_per_km2: Math.round(v[0] / pixelAreaKm2(info.scale[0], info.scale[1], lat)), people_in_pixel: people } };
}

/** ESA WorldCover class at the point. */
export async function landCoverAt(r2: R2Bucket, key: string | null | undefined, lat: number, lng: number): Promise<PixelResult> {
  if (!key) return notPublished('worldcover');
  const { reader, info: pending } = r2Tiff(r2, key);
  const v = await readPixel(reader, await pending, lng, lat);
  if (!v) return outside;
  const code = v[0];
  const name = code === null ? undefined : (spec.rasters.worldcover.classes as Record<string, string>)[String(code)];
  if (code === null || !name) return { status: 'none', reason: 'no land cover class here' };
  return { status: 'ok', data: { land_cover: name, land_cover_code: code } };
}

/** The pixel sources with their registered files. */
export const SURFACE_PIXELS = {
  worldcover: (r2: R2Bucket, lat: number, lng: number) => landCoverAt(r2, keyOf('worldcover'), lat, lng),
  dem: (r2: R2Bucket, lat: number, lng: number) => demAt(r2, keyOf('dem'), lat, lng),
  worldpop: (r2: R2Bucket, lat: number, lng: number) => populationAt(r2, keyOf('worldpop'), lat, lng),
};

/** The registered files' md5 prefixes, for cache keys. */
export const SURFACE_RASTER_VERSION = (Object.keys(spec.rasters) as Name[])
  .map((n) => `${n}-${(spec.rasters[n].file as { md5?: string } | null)?.md5?.slice(0, 8) ?? 'none'}`).join('.');
