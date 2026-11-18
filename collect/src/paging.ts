/** One page from a paged endpoint, and the cursor for the page after it (null = last). */
export interface Page<T> { items: T[]; next: string | null }

/** Every item from a paged endpoint: follows the server's cursor (`next` → `after`)
 *  until there's no next page. Each id is kept once, whatever a page repeats. */
export async function fetchAllPages<T>(
  fetchPage: (limit: number, after: string | null) => Promise<Page<T>>,
  pageSize: number,
): Promise<T[]> {
  const out: T[] = [];
  const seen = new Set<unknown>();
  for (let after: string | null = null; ;) {
    const page: Page<T> = await fetchPage(pageSize, after);
    for (const item of page.items) {
      const id = (item as { id?: unknown }).id;
      if (id !== undefined && seen.has(id)) continue;
      seen.add(id);
      out.push(item);
    }
    if (!page.next || page.next === after) return out;
    after = page.next;
  }
}
