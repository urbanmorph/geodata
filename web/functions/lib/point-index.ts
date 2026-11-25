// The merged point index (scripts/bake_point_index.py): the polygon layers locate and the
// point profiles ask most, in two PMTiles archives at one zoom, so a lookup reads one tile
// of each archive instead of one tile of every layer. `place` carries each feature's popup
// fields; `zones` carries ids only (the parquet row + 1), the fields in a JSON file per layer.
// Share-alike layers are never merged (they keep their own tiles).
//
// The manifest (public/api-data/point-index.json, so it is part of the data version that
// keys API answers) names, per layer, the parquet and tiles the index was built from. A
// layer is answered from the index only while the catalog names the same files: a layer
// rebaked since then, one not in the index, or a zoom coarser than the index's is read from
// its own tiles (locate.ts), as is any layer the index fails to answer.
import manifest from '../../public/api-data/point-index.json';
import type { CatalogLayer } from './catalog-api';
import { cleanProperties, findFeaturesAtPoint, type LocateHit } from './mvt-locate';
import { r2KeyFromUrl } from './r2-keys';
import { lngLatToTile } from './tile-math';
import { InflightShare, READ_TIMEOUT_MS, ResolvedCache, withTimeout } from './isolate-cache';

type FileRef = { url: string; bytes: number | null };

export interface PointIndexLayer {
  archive: string;
  /** The parquet and tiles the layer's features were built from. */
  parquet: FileRef;
  etag?: string;
  pmtiles: string;
  /** Sidecar archives: the layer's popup fields, one entry per parquet row (null: no polygon). */
  props?: FileRef;
}

export interface PointIndexManifest {
  zoom: number;
  archives: Record<string, FileRef>;
  layers: Record<string, PointIndexLayer>;
}

export const POINT_INDEX = manifest as PointIndexManifest;

/** The same R2 object, whichever public address names it. */
const sameKey = (a: string | undefined, b: string | undefined) => !!a && !!b && r2KeyFromUrl(a) === r2KeyFromUrl(b);

/** The index's entry for `layer` when the index can answer it at `zoom`; null otherwise
 *  (not indexed, a coarser zoom, or the catalog names other files than the index was built from). */
export function indexEntry(index: PointIndexManifest, layer: CatalogLayer, zoom: number): PointIndexLayer | null {
  const e = Object.hasOwn(index.layers, layer.id) ? index.layers[layer.id] : undefined;
  if (!e || zoom < index.zoom || !index.archives[e.archive]) return null;
  const fresh = sameKey(e.parquet.url, layer.parquet?.url) && e.parquet.bytes === (layer.parquet?.bytes ?? null)
    && sameKey(e.pmtiles, layer.pmtiles?.url);
  return fresh ? e : null;
}

// One read of a tile per answer: the profiles ask each layer on its own, in parallel, and
// they share the tile (and the archive's header and directory) through `scope`.
const tileReads = new InflightShare<ArrayBuffer | null>();
// The sidecars, parsed, for the isolate (keys are content-versioned, so never stale).
const sidecars = new ResolvedCache<ReadonlyArray<Record<string, unknown> | null>>(32);

export function clearPointIndexCache(): void {
  tileReads.clear();
  sidecars.clear();
}

function keyOf(url: string): string {
  const key = r2KeyFromUrl(url);
  if (!key) throw new Error(`point index: no R2 key in ${url}`);
  return key;
}

/** A sidecar, read as one range (so the colo keeps it: colo-cache.ts) and parsed. */
async function readSidecar(r2: R2Bucket, key: string, bytes: number | null): Promise<ReadonlyArray<Record<string, unknown> | null>> {
  const read = r2.get(key, bytes ? { range: { offset: 0, length: bytes } } : undefined);
  const obj = await withTimeout(read, READ_TIMEOUT_MS, `R2 read ${key}`);
  if (!obj || !('arrayBuffer' in obj)) throw new Error(`R2 key not found: ${key}`);
  return JSON.parse(new TextDecoder().decode(await obj.arrayBuffer()));
}

/** Tile z/x/y of the archive at R2 `key` (null: the archive has none there). */
export type TileReader = (key: string, z: number, x: number, y: number) => Promise<ArrayBuffer | null>;

/** `layerId`'s polygons holding the point, as its own tiles would answer them, from the index. */
export async function indexHits(
  index: PointIndexManifest, entry: PointIndexLayer, layerId: string, lng: number, lat: number,
  r2: R2Bucket, readTile: TileReader, scope?: object,
): Promise<LocateHit[]> {
  const key = keyOf(index.archives[entry.archive].url);
  const z = index.zoom;
  const { x, y } = lngLatToTile(lng, lat, z);
  const data = await tileReads.get(`${key}/${z}/${x}/${y}`, () => readTile(key, z, x, y), scope);
  if (!data) return [];
  const hits = findFeaturesAtPoint(data, z, x, y, lng, lat, layerId);
  if (!entry.props || !hits.length) return hits.map(({ layer_name, properties }) => ({ layer_name, properties }));
  const propsKey = keyOf(entry.props.url);
  const rows = await sidecars.get(propsKey, () => readSidecar(r2, propsKey, entry.props!.bytes), scope);
  return hits.map((h) => {
    const row = h.id === undefined ? undefined : rows[h.id - 1];
    if (!row) throw new Error(`point index: ${layerId} has no fields for feature ${h.id}`);
    return { layer_name: h.layer_name, properties: cleanProperties(row) };
  });
}
