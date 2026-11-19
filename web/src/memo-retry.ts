/** A load run once and shared by every caller; a failed one is forgotten, so
 *  the next call tries again (the catalog, the layer index, the map themes). */
export function memoRetry<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () =>
    (pending ??= load().catch((e: unknown) => {
      pending = null;
      throw e;
    }));
}
