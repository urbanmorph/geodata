type Catalog = {
  layers?: Array<unknown>;
  states?: Array<{ code: number; name: string }>;
  state_counts?: Record<string, Record<string, number>>;
} & Record<string, unknown>;

let cache: Promise<Catalog> | null = null;

export function getCatalog(): Promise<Catalog> {
  if (cache) return cache;
  // Prefer the inline JSON injected by prerender — zero network for state list / counts.
  const inline = document.getElementById('catalog-data');
  if (inline?.textContent) {
    try {
      cache = Promise.resolve(JSON.parse(inline.textContent) as Catalog);
      return cache;
    } catch {
      /* fall through to fetch */
    }
  }
  cache = fetch('/catalog.json').then((r) => r.json() as Promise<Catalog>);
  return cache;
}
