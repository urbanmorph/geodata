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
