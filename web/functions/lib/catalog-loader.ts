import type { CatalogData } from './catalog-api';

let cached: CatalogData | null = null;

export async function loadCatalog(origin: string): Promise<CatalogData> {
  if (cached) return cached;
  const r = await fetch(`${origin}/catalog.json`);
  if (!r.ok) throw new Error(`catalog.json fetch failed: ${r.status}`);
  cached = await r.json() as CatalogData;
  return cached;
}
