// The catalog (catalog.json) and the deployment's other static files, read the
// way a Function should: through env.ASSETS, the deployment's own copy. A
// same-origin fetch went out through the zone and back in through the root
// _middleware, and could answer with another deployment's file.
import type { CatalogData } from './catalog-api';
import { sha256Hex } from './crypto';
import { ResolvedCache } from './isolate-cache';

type Assets = { fetch(input: Request | string, init?: RequestInit): Promise<Response> };
/** What a handler has: its request (for the origin) and, on Pages, env.ASSETS. */
export type AssetCtx = { request: Request; env: { ASSETS?: Assets } };

/** A static file of this deployment. Without env.ASSETS (unit tests, a stub
 *  context) it falls back to a same-origin fetch. */
export function fetchAsset(ctx: AssetCtx, path: string): Promise<Response> {
  const url = new URL(path, ctx.request.url).toString();
  return ctx.env.ASSETS ? ctx.env.ASSETS.fetch(url) : fetch(url);
}

/** Pages answers a missing file (and an unmatched path) with the site's
 *  index.html, 200: an HTML answer where a file or JSON was due means "not there". */
export const isSpaFallback = (res: Response): boolean => (res.headers.get('content-type') ?? '').startsWith('text/html');

/** A baked JSON file of this deployment (stats, value index), or null when it is missing or unreadable. */
export async function fetchBakedJson<T>(ctx: AssetCtx, path: string): Promise<T | null> {
  try {
    const r = await fetchAsset(ctx, path);
    return r.ok && !isSpaFallback(r) ? await r.json() as T : null;
  } catch {
    return null;
  }
}

type ParquetRef = { url: string; bytes: number | null };
/** A baked file was made from the parquet the catalog names now (same url and bytes). */
export function bakedFrom(made: ParquetRef | undefined, layer: { parquet?: ParquetRef | null }): boolean {
  return !!layer.parquet?.url && made?.url === layer.parquet.url && made.bytes === (layer.parquet.bytes ?? null);
}

/** `version`: the deploy (build id and catalog), for pages. `dataVersion`: the data only
 *  (catalog and the baked files, data-id.txt), for API answers, which a code-only deploy keeps. */
export type LoadedCatalog = { catalog: CatalogData; version: string; dataVersion: string };

// One load per isolate: catalog.json changes only with a deploy, which starts
// new isolates. Only a loaded catalog is shared across requests (a load in
// flight dies with its request, isolate-cache.ts); a rejected load is dropped.
const loaded = new ResolvedCache<LoadedCatalog>();

async function load(ctx: AssetCtx): Promise<LoadedCatalog> {
  const text = (path: string) => fetchAsset(ctx, path).then((b) => (b.ok && !isSpaFallback(b) ? b.text() : ''), () => '');
  const [r, build, data] = await Promise.all([
    fetchAsset(ctx, '/catalog.json'),
    // Written by every vite build (vite.config.ts): a deploy that changes only
    // code or pages still gets a new version. Absent (tests, dev) → ''.
    text('/build-id.txt'),
    // The baked files' id (scripts/data-id.mjs), for the data version.
    text('/data-id.txt'),
  ]);
  if (!r.ok) throw new Error(`catalog.json fetch failed: ${r.status}`);
  const catalogText = await r.text();
  return {
    catalog: JSON.parse(catalogText) as CatalogData,
    version: await shortHash(`${build.trim()}\n${catalogText}`),
    dataVersion: await shortHash(`data:${data.trim()}\n${catalogText}`),
  };
}

/** The catalog and the deploy version: a short hash of the build id and the
 *  catalog text. Every deploy gets a new one, so cache keys built on it move
 *  on and nothing needs purging. */
export function loadCatalogVersioned(ctx: AssetCtx): Promise<LoadedCatalog> {
  return loaded.get('', () => load(ctx), ctx.request);
}

export async function loadCatalog(ctx: AssetCtx): Promise<CatalogData> {
  return (await loadCatalogVersioned(ctx)).catalog;
}

export function __resetCatalogForTest(): void {
  loaded.clear();
}

/** First 12 hex characters of the SHA-256 of `text`. */
export async function shortHash(text: string): Promise<string> {
  return (await sha256Hex(text)).slice(0, 12);
}
