// Shared helpers. escapeHtml mirrors web/src/util — every untrusted string
// (contributor names, author labels, saved-map names) is routed through it
// before landing in innerHTML. The CSP blocks inline script, but escaping also
// stops markup/phishing-link injection on the admin's high-value screen.
export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Hand the person a file made in the browser. */
export function downloadText(content: string, filename: string, mime: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
