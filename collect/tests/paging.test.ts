// Every record, page by page: the admin review and the capture map used to
// fetch one page (2000 / the server's default 500) and silently drop the rest.
import { describe, it, expect, vi } from 'vitest';
import { fetchAllPages } from '../src/paging';

describe('fetchAllPages', () => {
  it('keeps fetching until a short page and returns every item in order', async () => {
    const data = Array.from({ length: 5 }, (_, i) => i);
    const fetchPage = vi.fn(async (limit: number, offset: number) => data.slice(offset, offset + limit));
    expect(await fetchAllPages(fetchPage, 2)).toEqual([0, 1, 2, 3, 4]);
    expect(fetchPage.mock.calls).toEqual([[2, 0], [2, 2], [2, 4]]);
  });

  it('stops after one call when the first page is short', async () => {
    const fetchPage = vi.fn(async () => [1]);
    expect(await fetchAllPages(fetchPage, 2000)).toEqual([1]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('passes a failure through', async () => {
    await expect(fetchAllPages(async () => { throw new Error('offline'); }, 10)).rejects.toThrow('offline');
  });
});
