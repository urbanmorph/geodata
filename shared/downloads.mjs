// Route an R2 public url through the same-origin /api/dl counter, except
// pmtiles, which the viewer range-reads directly. Every download link on the
// site uses this (the /layers rows, community cards and the map page), so
// every download is counted the same way.
export function dlProxyUrl(r2Url, fmt) {
  if (!r2Url) return r2Url;
  if (fmt === 'pmtiles') return r2Url;
  const m = r2Url.match(/^https?:\/\/[^/]+\/(.+)$/);
  return m ? `/api/dl/${m[1]}` : r2Url;
}
