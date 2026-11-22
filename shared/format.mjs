// Escaping and number/date formatting, in one place for every surface: the
// prerender (node), the Pages Functions, the web app and collect. Plain ESM so
// all of them can import it (types in format.d.mts).

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape text for HTML content or a quoted attribute. null/undefined -> ''. */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

const LD_ESCAPES = { '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' };

/** A JSON-LD <script> tag for `obj`. < > & become \u escapes, so no string in
 *  the data can close the tag or open a comment; JSON.parse reads it back unchanged. */
export function ldJsonScript(obj) {
  return `<script type="application/ld+json">${JSON.stringify(obj).replace(/[<>&]/g, (c) => LD_ESCAPES[c])}</script>`;
}

/** "512 B", "221 KB", "5.0 MB", "3.00 GB"; "n/a" when unknown. */
export function fmtBytes(n) {
  if (n == null) return 'n/a';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/** A whole number in Indian grouping (29,40,912); "n/a" when unknown, like fmtBytes. */
export const fmtInt = (n) => (n == null ? 'n/a' : n.toLocaleString('en-IN'));

/** Compact count: one decimal while it reads (9.3k, 22.1k), whole units after (250k), then M. */
export function fmtCount(n) {
  const compact = (v, suffix) => (v < 100 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v))) + suffix;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return compact(n / 1000, 'k');
  return compact(n / 1_000_000, 'M');
}

/** "1 point", "3 points": a count and its noun, plural unless the count is one. */
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "26 May 2026" from an ISO date or timestamp (the date part, in UTC). */
export function fmtDate(iso) {
  return new Date(String(iso).slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}
