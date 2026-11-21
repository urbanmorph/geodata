// SoilGrids 2.0 at a point, for /api/v1/ground: one pixel of the India file
// scripts/bake_soilgrids.py publishes (25 Int16 bands: 8 properties at 3
// depths, then the WRB class), decoded to plain units with ISRIC's conversion
// factors. shared/soilgrids.json is the one table of bands, units and the R2 key.
import spec from '../../../shared/soilgrids.json';
import { readPixel, readTiffInfo, type RangeReader, type TiffInfo } from './tiff-pixel';

export const SOILGRIDS = spec;
type PropKey = keyof typeof spec.properties;

/** Band order in the file: every property at each depth, then the WRB class. */
export function soilBands(): Array<{ property: PropKey | 'wrb'; depth: string | null }> {
  const props = Object.keys(spec.properties) as PropKey[];
  return [...spec.depths.flatMap((depth) => props.map((property) => ({ property, depth }))),
    { property: 'wrb' as const, depth: null }];
}

export interface SoilProfile {
  /** Per depth interval, each property in plain units (field names carry the unit);
   *  null where SoilGrids predicts no properties (it masks built-up land and water). */
  depths: Record<string, Record<string, number | null>> | null;
  /** Most probable WRB reference soil group. */
  wrb_class: string | null;
}

const round = (v: number, f: number) => Math.round((v / f) * 1000) / 1000;

/** The file's raw band values decoded; null when every band is nodata. */
export function decodeSoil(values: (number | null)[]): SoilProfile | null {
  if (values.every((v) => v === null || v === undefined)) return null;
  const depths: SoilProfile['depths'] = {};
  let wrb: string | null = null;
  soilBands().forEach(({ property, depth }, i) => {
    const v = values[i] ?? null;
    if (property === 'wrb') {
      wrb = v === null ? null : spec.wrb[v] ?? null;
      return;
    }
    const p = spec.properties[property];
    (depths[depth!] ??= {})[p.field] = v === null ? null : round(v, p.factor);
  });
  const anyProperty = values.slice(0, -1).some((v) => v !== null && v !== undefined);
  return { depths: anyProperty ? depths : null, wrb_class: wrb };
}

export type SoilResult =
  | { status: 'ok'; soil: SoilProfile }
  | { status: 'none'; reason: string }
  | { status: 'unavailable'; reason: string };

function r2Reader(r2: R2Bucket, key: string): RangeReader {
  return {
    async read(offset, length) {
      const obj = await r2.get(key, { range: { offset, length } });
      if (!obj) throw new Error(`R2 key not found: ${key}`);
      return new Uint8Array(await obj.arrayBuffer());
    },
  };
}

// Parsed headers per R2 key, for the life of the isolate (keys are content-versioned).
const infos = new Map<string, Promise<TiffInfo>>();

/** SoilGrids at lat/lng from the file at `key` (the registered one by default). */
export async function soilAt(
  r2: R2Bucket, key: string | null | undefined = (spec.file as { key: string } | null)?.key, lat: number, lng: number,
): Promise<SoilResult> {
  if (!key) return { status: 'unavailable', reason: 'the SoilGrids file is not published yet' };
  const reader = r2Reader(r2, key);
  let info = infos.get(key);
  if (!info) {
    info = readTiffInfo(reader);
    infos.set(key, info);
    info.catch(() => infos.delete(key));
  }
  const values = await readPixel(reader, await info, lng, lat);
  if (!values) return { status: 'none', reason: 'outside the SoilGrids India file (68-98 E, 6-38 N)' };
  const soil = decodeSoil(values);
  if (!soil) {
    return { status: 'none', reason: 'no SoilGrids prediction here: SoilGrids leaves out water, built-up land and other areas outside its land mask' };
  }
  return { status: 'ok', soil };
}
