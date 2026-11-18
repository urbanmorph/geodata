// Site-wide use, shown on /layers (a small block under the title) and in the
// home line: downloads always; API and MCP queries once they pass
// API_SHOW_MIN. API/MCP counting started on 17 Nov 2026 (#277), so until the
// count means something it stays off the page rather than reading as "unused".
// Read from /api/v1/usage at build time; nothing new is stored.
import { escapeHtml as esc, fmtCount } from '../../shared/format.mjs';

export const API_SHOW_MIN = 1000;
const API_SINCE = '17 Nov 2026';
const ORIGIN = 'https://bharatlas.com';

/** { api, mcp } totals from the live API, or null (offline, error, timeout). */
export async function fetchUsageTotals(fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${ORIGIN}/api/v1/usage`, {
      headers: { 'user-agent': 'bharatlas-build/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const { total } = await res.json();
    return { api: Number(total?.api) || 0, mcp: Number(total?.mcp) || 0 };
  } catch {
    return null;
  }
}

const queries = ({ api, mcp }) => api + mcp;
const showApi = (u) => queries(u) >= API_SHOW_MIN;

/** The /layers usage block, or '' when there is nothing to show. */
export function usageBlockHtml(u) {
  const items = [];
  if (u.downloads > 0) items.push(['downloads', fmtCount(u.downloads), 'downloads']);
  if (showApi(u)) {
    const via = u.mcp ? `, ${fmtCount(u.mcp)} via MCP` : '';
    items.push(['api', fmtCount(queries(u)), `API queries <small>(since ${API_SINCE}${via})</small>`]);
  }
  if (!items.length) return '';
  return `<ul class="usage-block" aria-label="How the layers are used">${items
    .map(([k, n, label]) => `<li class="usage-block__item usage-block__item--${esc(k)}"><strong>${n}</strong> <span>${label}</span></li>`)
    .join('')}</ul>`;
}

/** Appended to the home line after the download total: ' · 1.5k API queries', or ''. */
export function homeUsageSuffix(u) {
  return showApi(u) ? ` · <span class="search-meta__count">${fmtCount(queries(u))}</span> API queries` : '';
}
