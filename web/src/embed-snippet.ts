export function embedIframeHtml(layerId: string, origin: string): string {
  const src = `${origin}/embed/${encodeURIComponent(layerId)}`;
  return `<iframe src="${src}" width="100%" height="520" loading="lazy" frameborder="0" style="border:1px solid #e5e5e5;border-radius:8px;" allowfullscreen></iframe>`;
}

export function isEmbedPath(pathname: string): { embed: true; layerId: string } | { embed: false } {
  const m = pathname.match(/^\/embed\/([^/?#]+)\/?$/);
  if (!m) return { embed: false };
  return { embed: true, layerId: decodeURIComponent(m[1]) };
}

export function isViewPath(pathname: string): { view: true; layerId: string } | { view: false } {
  const m = pathname.match(/^\/view\/([^/?#]+)\/?$/);
  if (!m) return { view: false };
  return { view: true, layerId: decodeURIComponent(m[1]) };
}

// What the URL should become after the user closes the map overlay. Three
// call-sites (close button, Escape key, hash-clear) all funnel through here
// so the URL bar always matches what the user is looking at (the catalog).
// Without this, /view/<id> stays in the URL after close even though the
// page visually returns to the catalog list.
export function urlAfterCloseMap(pathname: string, hash: string, search: string): string {
  if (hash.startsWith('#view/')) {
    // Hash-based: the user was on / (or another page) and the map opened
    // via the hash. Drop the hash; keep the original pathname + query.
    return pathname + search;
  }
  if (isViewPath(pathname).view) {
    // Path-based: the user landed at /view/<id> via shared link or anchor
    // navigation from the catalog. Closing the map should return them to
    // the catalog home; preserve any query string.
    return '/' + search;
  }
  // Defensive no-op for non-view URLs (shouldn't happen, but safe).
  return pathname + hash + search;
}
