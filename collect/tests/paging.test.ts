// Every record, page by page: the admin review and the capture map used to
// fetch one page (2000 / the server's default 500) and silently drop the rest.
// Pages follow the server's cursor (next → after), so a point that arrives
// between pages neither repeats nor pushes another off the end.
import { describe, it, expect, vi } from 'vitest';
import { fetchAllPages } from '../src/paging';

type Item = { id: string };
const items = (n: number): Item[] => Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));

/** A server over `data` (newest first) with keyset cursors. */
function server(data: Item[]) {
  return vi.fn(async (limit: number, after: string | null) => {
    const start = after === null ? 0 : data.findIndex((d) => d.id === after) + 1;
    const page = data.slice(start, start + limit);
    return { items: page, next: page.length === limit ? page[page.length - 1].id : null };
  });
}

describe('fetchAllPages', () => {
  it('follows the cursor until there is no next page, returning every item in order', async () => {
    const fetchPage = server(items(5));
    expect((await fetchAllPages(fetchPage, 2)).map((d) => d.id)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
    expect(fetchPage.mock.calls).toEqual([[2, null], [2, 'r1'], [2, 'r3']]);
  });

  it('stops after one call when the first page has no next', async () => {
    const fetchPage = vi.fn(async () => ({ items: [{ id: 'a' }], next: null }));
    expect(await fetchAllPages(fetchPage, 2000)).toEqual([{ id: 'a' }]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('keeps each item once even if a page repeats one', async () => {
    const pages = [{ items: [{ id: 'a' }, { id: 'b' }], next: 'b' }, { items: [{ id: 'b' }, { id: 'c' }], next: null }];
    expect(await fetchAllPages(async () => pages.shift()!, 2)).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  });

  it('never loops on a cursor that does not move', async () => {
    const fetchPage = vi.fn(async () => ({ items: [{ id: 'a' }], next: 'same' }));
    await fetchAllPages(fetchPage, 1);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('passes a failure through', async () => {
    await expect(fetchAllPages(async () => { throw new Error('offline'); }, 10)).rejects.toThrow('offline');
  });
});
