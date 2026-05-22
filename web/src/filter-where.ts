// v4.2 commit 2: build SQL WHERE + MapLibre filter expressions from the
// user's active filter state. Pure: no DOM, no DuckDB. The same ActiveFilter
// list drives:
//   - DuckDB-WASM exports + row-count queries (via buildWhereSQL)
//   - in-tile repaint (via buildMaplibreFilter), when the filter column
//     is present as a PMTiles feature property

export type ActiveFilter =
  | { col: string; kind: 'in'; values: Array<string | number> }
  | { col: string; kind: 'range'; min?: number; max?: number }
  | { col: string; kind: 'search'; q: string }
  | { col: string; kind: 'bool'; v: boolean };

function escIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function escString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

// Escape % and _ wildcards (and backslash, the escape char itself) so the
// ILIKE pattern matches literally what the user typed.
function escLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function valueToSql(v: string | number | bigint | boolean): string {
  if (typeof v === 'bigint') return Number(v).toString();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return escString(v);
}

export function buildWhereSQL(filters: ActiveFilter[]): string {
  const parts: string[] = [];
  for (const f of filters) {
    if (f.kind === 'in') {
      if (!f.values.length) continue;
      parts.push(`${escIdent(f.col)} IN (${f.values.map(valueToSql).join(', ')})`);
    } else if (f.kind === 'range') {
      const conds: string[] = [];
      if (f.min != null) conds.push(`${escIdent(f.col)} >= ${f.min}`);
      if (f.max != null) conds.push(`${escIdent(f.col)} <= ${f.max}`);
      if (conds.length) parts.push(conds.join(' AND '));
    } else if (f.kind === 'search') {
      const q = f.q.trim();
      if (!q) continue;
      parts.push(
        `${escIdent(f.col)} ILIKE ${escString('%' + escLike(q) + '%')} ESCAPE '\\'`,
      );
    } else if (f.kind === 'bool') {
      parts.push(`${escIdent(f.col)} = ${f.v ? 'TRUE' : 'FALSE'}`);
    }
  }
  return parts.length ? 'WHERE ' + parts.join(' AND ') : '';
}

export type MaplibreFilter = unknown[] | null;

// MapLibre tile-property filter. Returns null when no filter applies, or
// when the filter kind can't be pushed down (search). Callers can still run
// the SQL path against DuckDB and either route to a pre-baked extract or
// build an ID-list filter (the tier-2 repaint described in the RFC).
export function buildMaplibreFilter(filters: ActiveFilter[]): MaplibreFilter {
  const exprs: unknown[][] = [];
  for (const f of filters) {
    if (f.kind === 'in') {
      if (!f.values.length) continue;
      exprs.push(['in', ['get', f.col], ['literal', f.values]]);
    } else if (f.kind === 'range') {
      const conds: unknown[][] = [];
      if (f.min != null) conds.push(['>=', ['get', f.col], f.min]);
      if (f.max != null) conds.push(['<=', ['get', f.col], f.max]);
      if (conds.length === 1) exprs.push(conds[0]);
      else if (conds.length > 1) exprs.push(['all', ...conds]);
    } else if (f.kind === 'bool') {
      exprs.push(['==', ['get', f.col], f.v]);
    }
    // 'search' (ILIKE) is intentionally skipped — no equivalent in MapLibre
    // tile filters. Caller falls back to the tier-2 ID-list path.
  }
  if (!exprs.length) return null;
  if (exprs.length === 1) return exprs[0];
  return ['all', ...exprs];
}
