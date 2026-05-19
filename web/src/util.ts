const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => HTML_ESCAPES[c]);
}
