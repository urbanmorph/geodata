// Shared helpers. escapeHtml (shared/format.mjs, the same one bharatlas.com
// uses): every untrusted string (contributor names, author labels, saved-map
// names) is routed through it before landing in innerHTML. The CSP blocks
// inline script, but escaping also stops markup/phishing-link injection on
// the admin's high-value screen.
export { escapeHtml, plural } from '../../shared/format.mjs';

/** Hand the person a file made in the browser. */
export function downloadText(content: string, filename: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a); // Firefox ignores a click on a detached link
  a.click();
  a.remove();
  // Revoke later: Safari can abort a download whose URL is revoked in the same tick.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
