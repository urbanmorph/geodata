// bharatlas catalogue search — a plain fetch, no map/pmtiles deps, so the create
// form (landing entry) stays light and never pulls MapLibre.

const BHARATLAS = 'https://bharatlas.com';

export interface RefLayer { id: string; label: string; category: string; pmtiles_url: string; }

/** Every curated layer that can be shown as an overlay (has pmtiles), sorted by
 *  category then id — the picker filters/browses this in memory. CORS-open. */
export async function listLayers(): Promise<RefLayer[]> {
  const res = await fetch(`${BHARATLAS}/api/v1/layers?limit=1000`);
  if (!res.ok) throw new Error(`catalogue ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id: string; category?: string; downloads?: { pmtiles?: { url?: string } } }> };
  return (body.data || [])
    .filter((l) => l.downloads?.pmtiles?.url)
    .map((l) => ({ id: l.id, label: l.id, category: l.category || 'other', pmtiles_url: l.downloads!.pmtiles!.url! }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
}
