// The catalog (catalog.json) and the deployment's other static files, read the
// way a Function should: through env.ASSETS, the deployment's own copy. A
// same-origin fetch went out through the zone and back in through the root
// _middleware, and could answer with another deployment's file.
import type { CatalogData } from './catalog-api';
import { sha256Hex } from './crypto';

type Assets = { fetch(input: Request | string, init?: RequestInit): Promise<Response> };
/** What a handler has: its request (for the origin) and, on Pages, env.ASSETS. */
export type AssetCtx = { request: Request; env: { ASSETS?: Assets } };

/** A static file of this deployment. Without env.ASSETS (unit tests, a stub
 *  context) it falls back to a same-origin fetch. */
export function fetchAsset(ctx: AssetCtx, path: string): Promise<Response> {
  const url = new URL(path, ctx.request.url).toString();
  return ctx.env.ASSETS ? ctx.env.ASSETS.fetch(url) : fetch(url);
}

export type LoadedCatalog = { catalog: CatalogData; version: string };

// One load per isolate: catalog.json changes only with a deploy, which starts
// new isolates. A rejected load is dropped, so the next request tries again.
let pending: Promise<LoadedCatalog> | null = null;

async function load(ctx: AssetCtx): Promise<LoadedCatalog> {
  const [r, build] = await Promise.all([
    fetchAsset(ctx, '/catalog.json'),
    // Written by every vite build (vite.config.ts): a deploy that changes only
    // code or pages still gets a new version. Absent (tests, dev) → ''.
    fetchAsset(ctx, '/build-id.txt').then((b) => (b.ok ? b.text() : ''), () => ''),
  ]);
  if (!r.ok) throw new Error(`catalog.json fetch failed: ${r.status}`);
  const text = await r.text();
  return { catalog: JSON.parse(text) as CatalogData, version: await shortHash(`${build.trim()}\n${text}`) };
}

/** The catalog and the deploy version: a short hash of the build id and the
 *  catalog text. Every deploy gets a new one, so cache keys built on it move
 *  on and nothing needs purging. */
export function loadCatalogVersioned(ctx: AssetCtx): Promise<LoadedCatalog> {
  if (!pending) {
    pending = load(ctx);
    pending.catch(() => { pending = null; });
  }
  return pending;
}

export async function loadCatalog(ctx: AssetCtx): Promise<CatalogData> {
  return (await loadCatalogVersioned(ctx)).catalog;
}

export function __resetCatalogForTest(): void {
  pending = null;
}

/** First 12 hex characters of the SHA-256 of `text`. */
export async function shortHash(text: string): Promise<string> {
  return (await sha256Hex(text)).slice(0, 12);
}
