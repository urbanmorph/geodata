// bharatlas catalogue search — a plain fetch, no map/pmtiles deps, so the create
// form (landing entry) stays light and never pulls MapLibre.

const BHARATLAS = 'https://bharatlas.com';

export interface RefLayer { id: string; label: string; category: string; pmtiles_url: string; }

/** Search the bharatlas catalogue (CORS-open) for layers that have pmtiles. */
export async function searchLayers(q: string): Promise<RefLayer[]> {
  const url = `${BHARATLAS}/api/v1/layers?limit=40${q ? `&q=${encodeURIComponent(q)}` : ''}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`catalogue ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id: string; category?: string; downloads?: { pmtiles?: { url?: string } } }> };
  return (body.data || [])
    .filter((l) => l.downloads?.pmtiles?.url)
    .map((l) => ({ id: l.id, label: l.id, category: l.category || '', pmtiles_url: l.downloads!.pmtiles!.url! }));
}
