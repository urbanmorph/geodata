export function embedIframeHtml(layerId: string, origin: string): string {
  const src = `${origin}/embed/${encodeURIComponent(layerId)}`;
  return `<iframe src="${src}" width="100%" height="520" loading="lazy" frameborder="0" style="border:1px solid #e5e5e5;border-radius:8px;" allowfullscreen></iframe>`;
}

export function isEmbedPath(pathname: string): { embed: true; layerId: string } | { embed: false } {
  const m = pathname.match(/^\/embed\/([^/?#]+)\/?$/);
  if (!m) return { embed: false };
  return { embed: true, layerId: decodeURIComponent(m[1]) };
}
