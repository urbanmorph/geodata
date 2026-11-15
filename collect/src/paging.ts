/** Every item from a paged endpoint: fetch `pageSize` at a time until a short page. */
export async function fetchAllPages<T>(
  fetchPage: (limit: number, offset: number) => Promise<T[]>,
  pageSize: number,
): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await fetchPage(pageSize, offset);
    out.push(...page);
    if (page.length < pageSize) return out;
  }
}
