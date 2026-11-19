export { escapeHtml } from '../../shared/format.mjs';

/** Start a browser download of `href` (a URL or object URL) as `filename`. */
export function downloadHref(href: string, filename: string, doc: Document = document): void {
  const a = doc.createElement('a');
  a.href = href;
  a.download = filename;
  a.rel = 'noopener';
  doc.body.appendChild(a);
  a.click();
  a.remove();
}

/** Download a Blob as `filename`. The object URL is revoked later so Safari
 *  has time to start the download. */
export function triggerDownload(blob: Blob, filename: string, doc: Document = document): void {
  const url = URL.createObjectURL(blob);
  downloadHref(url, filename, doc);
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
