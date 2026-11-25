import { findTile, PMTiles, ResolvedValueCache, zxyToTileId } from 'pmtiles';
import { R2Source } from './r2-source';
import { lngLatToTile } from './tile-math';
import { findFeaturesAtPoint } from './mvt-locate';
import type { CatalogData, CatalogLayer } from './catalog-api';
import { r2KeyFromUrl } from './r2-keys';
import type { AsyncBuffer } from 'hyparquet';
import { coalesced, type ByteRange } from './parquet-coalesce';
import { ByteLru } from './isolate-cache';
import { indexEntry, indexHits, POINT_INDEX, type IndexShare, type PointIndexManifest } from './point-index';

export { DEFAULT_LOCATE_LAYERS } from './locate-layers';

export interface LocateResult {
  layer_id: string;
  level: string;
  category: string;
  feature: { properties: Record<string, unknown> };
}

export interface LocateResponse {
  point: { lat: number; lng: number };
  zoom: number;
  results: Record<string, LocateResult[]>;
  queried_layers: string[];
  /** Layers that could not be read (R2 or tile failure): their absence from
   *  `results` says nothing about the point. Absent when every layer answered. */
  failed_layers?: string[];
  timing_ms: number;
}

export interface LocateOpts {
  /** The merged point index (default: the deployment's, point-index.ts). */
  index?: PointIndexManifest;
  /** Calls passing the same scope (one answer's) share their reads of an index tile. */
  scope?: object;
  /** How a call waits on such a read another call started (the profiles pause the layer's clock). */
  wait?: <T>(p: Promise<T>) => Promise<T>;
}

export async function locate(
  lat: number,
  lng: number,
  layerIds: string[],
  zoom: number,
  catalog: CatalogData,
  r2: R2Bucket,
  opts: LocateOpts = {},
): Promise<LocateResponse> {
  const start = Date.now();
  const index = opts.index ?? POINT_INDEX;
  const share = { scope: opts.scope ?? {}, wait: opts.wait };

  const layers = layerIds
    .map((id) => catalog.layers.find((l) => l.id === id))
    .filter((l): l is CatalogLayer => !!l && !!l.pmtiles);

  const settled = await Promise.allSettled(
    layers.map((layer) => answerLayer(layer, zoom, lng, lat, r2, index, share)),
  );

  const grouped: Record<string, LocateResult[]> = {};
  const failed: string[] = [];
  for (let i = 0; i < layers.length; i++) {
    const s = settled[i];
    if (s.status === 'rejected') {
      failed.push(layers[i].id);
      console.error(`locate: ${layers[i].id} failed:`, (s.reason as Error)?.message ?? s.reason);
      continue;
    }
    if (!s.value.length) continue;
    const layer = layers[i];
    for (const hit of s.value) {
      const cat = layer.category;
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push({
        layer_id: layer.id,
        level: layer.level,
        category: cat,
        feature: { properties: hit.properties },
      });
    }
  }

  return {
    point: { lat, lng },
    zoom,
    results: grouped,
    queried_layers: layers.map((l) => l.id),
    ...(failed.length ? { failed_layers: failed } : {}),
    timing_ms: Date.now() - start,
  };
}

// One reader per R2 key per isolate, so the archive's header and directory
// cache survive between requests (keys are versioned, so a rebake is a new key).
// ResolvedValueCache, not pmtiles' default SharedPromiseCache: that one keeps
// the pending header/directory promise, which never settles once the request
// that started the read has ended (isolate-cache.ts).
// Its reads go through the bucket of the request asking now (a request may wrap
// its bucket, e.g. to count its reads: profile-endpoint.ts).
const readers = new Map<string, { pm: PMTiles; source: R2Source }>();
export function pmtilesFor(r2: R2Bucket, key: string): PMTiles {
  let r = readers.get(key);
  if (!r) {
    const source = new R2Source(r2, key);
    r = { pm: new PMTiles(source, new ResolvedValueCache()), source };
    readers.set(key, r);
  }
  r.source.bucket = r2;
  return r.pm;
}

// Recently read tiles, per isolate: a popular point (a city centre, a ward
// lookup) asks the same ~15 tiles again and again. Keys are versioned R2 keys,
// so a tile never changes under its key. Bounded by bytes, least recently used out.
const TILE_CACHE_BYTES = 16 * 1024 * 1024;
const tiles = new ByteLru<ArrayBuffer | null>(TILE_CACHE_BYTES);

export function clearTileCache(): void {
  tiles.clear();
}

function keepTile(id: string, data: ArrayBuffer | null): void {
  const size = data?.byteLength ?? 0;
  if (size <= TILE_CACHE_BYTES / 4) tiles.set(id, data, size);
}

/** Tile z/x/y of `pm` (cached; `null` for a tile the archive doesn't have). */
export async function tileAt(
  pm: Pick<PMTiles, 'getZxy'>, key: string, z: number, x: number, y: number,
): Promise<ArrayBuffer | null> {
  const id = `${key}/${z}/${x}/${y}`;
  const hit = tiles.get(id);
  if (hit !== undefined) return hit;
  const data = (await pm.getZxy(z, x, y))?.data ?? null;
  keepTile(id, data);
  return data;
}

type Header = Awaited<ReturnType<PMTiles['getHeader']>>;
type Directory = Awaited<ReturnType<PMTiles['cache']['getDirectory']>>;

/** Where tile z/x/y's bytes are in the archive (null: no such tile), walking its directories
 *  (the reader's cache; `dirs` shares a directory being read between the tiles of one call). */
async function tileRange(
  pm: PMTiles, header: Header, dirs: Map<string, Promise<Directory>>, z: number, x: number, y: number,
): Promise<ByteRange | null> {
  if (z < header.minZoom || z > header.maxZoom) return null;
  const tileId = zxyToTileId(z, x, y);
  const directory = (offset: number, length: number) => {
    const k = `${offset}:${length}`;
    if (!dirs.has(k)) dirs.set(k, pm.cache.getDirectory(pm.source, offset, length, header));
    return dirs.get(k)!;
  };
  let offset = header.rootDirectoryOffset, length = header.rootDirectoryLength;
  for (let depth = 0; depth <= 3; depth++) {
    const entry = findTile(await directory(offset, length), tileId);
    if (!entry) return null;
    if (entry.runLength > 0) {
      const start = header.tileDataOffset + entry.offset;
      return { start, end: start + entry.length };
    }
    offset = header.leafDirectoryOffset + entry.offset;
    length = entry.length;
  }
  throw new Error('Maximum directory depth exceeded');
}

/** Tiles at zoom z (as tileAt, cached), the ones not cached read together: the
 *  neighbouring tiles of a clustered archive sit next to each other in the file,
 *  so a block of them is one or a few R2 reads instead of one each. */
export async function tilesAt(pm: PMTiles, key: string, z: number, coords: Array<{ x: number; y: number }>): Promise<Array<ArrayBuffer | null>> {
  const header = await pm.getHeader();
  const ids = coords.map(({ x, y }) => `${key}/${z}/${x}/${y}`);
  const out = ids.map((id) => tiles.get(id));
  const missing = coords.map((c, i) => i).filter((i) => out[i] === undefined);
  if (header.specVersion < 3) {
    await Promise.all(missing.map(async (i) => { out[i] = await tileAt(pm, key, z, coords[i].x, coords[i].y); }));
    return out as Array<ArrayBuffer | null>;
  }
  const dirs = new Map<string, Promise<Directory>>();
  const ranges = await Promise.all(missing.map((i) => tileRange(pm, header, dirs, z, coords[i].x, coords[i].y)));
  const archive: AsyncBuffer = {
    byteLength: Infinity,
    slice: (start, end = Infinity) => pm.source.getBytes(start, end - start, undefined, header.etag).then((b) => b.data),
  };
  const file = coalesced(archive, ranges.filter((r): r is ByteRange => !!r));
  await Promise.all(missing.map(async (i, k) => {
    const r = ranges[k];
    const data = r ? await pm.decompress(await file.slice(r.start, r.end), header.tileCompression) : null;
    keepTile(ids[i], data);
    out[i] = data;
  }));
  return out as Array<ArrayBuffer | null>;
}

/** The layer's polygons at the point: from the merged index when it can answer for the layer,
 *  else (or when reading it fails) from the layer's own tiles. */
async function answerLayer(
  layer: CatalogLayer, zoom: number, lng: number, lat: number, r2: R2Bucket, index: PointIndexManifest, share: IndexShare,
) {
  const entry = indexEntry(index, layer, zoom);
  if (entry) {
    try {
      return await indexHits(index, entry, layer.id, lng, lat, r2,
        (key, z, x, y) => tileAt(pmtilesFor(r2, key), key, z, x, y), share);
    } catch (e) {
      console.error(`locate: ${layer.id} from the point index failed, reading its own tiles:`, (e as Error)?.message ?? e);
    }
  }
  return queryLayer(layer, zoom, lng, lat, r2);
}

async function queryLayer(
  layer: CatalogLayer,
  z: number,
  lng: number, lat: number,
  r2: R2Bucket,
) {
  const r2Key = r2KeyFromUrl(layer.pmtiles!.url);
  if (!r2Key) throw new Error(`${layer.id}: pmtiles url has no R2 key`);
  const pm = pmtilesFor(r2, r2Key);

  // Use the layer's max zoom if lower than requested
  const header = await pm.getHeader();
  const effectiveZ = Math.min(z, header.maxZoom);
  const { x, y } = lngLatToTile(lng, lat, effectiveZ);

  const data = await tileAt(pm, r2Key, effectiveZ, x, y);
  if (!data) return [];
  return findFeaturesAtPoint(data, effectiveZ, x, y, lng, lat);
}
