#!/usr/bin/env python3
"""
v4.2 commit 3 — Bake per-column filter stats from local Parquet files.

For each layer with a local parquet, DuckDB computes:
  - distinct count, null_frac, min, max
  - top_values list (up to MAX_TOP_VALUES) when distinct ≤ FACET_THRESHOLD

Output keyed by layer id; consumed by web/src/filter-schema.ts (the
affordance picker) and rendered by the generic FilterPanel.

Only LOCAL parquet files are baked here. Layers whose parquet only
lives on R2 (e.g. external opencity ingests) fall back to the browser's
live `describeParquet` path (commit 4).

Called from scripts/build_catalog.py; can be run standalone:
    python3 scripts/build_filter_stats.py
"""
from __future__ import annotations
import json
import re
from collections.abc import Callable
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'sources' / 'india-geodata'

# A column is faceted if distinct ≤ this; top_values are baked too.
FACET_THRESHOLD = 50
# Hard cap on top_values per column — keeps catalog.json size bounded.
MAX_TOP_VALUES = 50

DUCKDB_TO_NORM = {
    'BOOLEAN': 'bool',
    'TINYINT': 'int', 'SMALLINT': 'int', 'INTEGER': 'int', 'BIGINT': 'int',
    'UTINYINT': 'int', 'USMALLINT': 'int', 'UINTEGER': 'int', 'UBIGINT': 'int',
    'HUGEINT': 'int',
    'FLOAT': 'float', 'DOUBLE': 'float', 'DECIMAL': 'float', 'REAL': 'float',
    'VARCHAR': 'string', 'TEXT': 'string', 'CHAR': 'string',
    'DATE': 'date', 'TIMESTAMP': 'date', 'TIME': 'date',
    'TIMESTAMP_NS': 'date', 'TIMESTAMP_MS': 'date', 'TIMESTAMP_S': 'date',
    'GEOMETRY': 'geometry',
    'BLOB': 'blob', 'BIT': 'blob',
}


# STRUCT / MAP / UNION / LIST (`T[]`): not filterable (mirrors web/src/filter-probe.ts).
NESTED_RX = re.compile(r'^(STRUCT|MAP|UNION)\s*\(|\[\d*\]\s*$', re.I)


def normalise_type(t: str) -> str:
    if NESTED_RX.search(t.strip()):
        return 'blob'
    base = t.split('(')[0].strip().upper()
    return DUCKDB_TO_NORM.get(base, 'string')


# ── the Filter panel's column pick (mirrors web/src/filter-schema.ts) ───────
# The map tiles carry these columns, so the map can draw every filter the panel
# offers. web/tests/fixtures/filter-columns.json holds cases both sides check.

DISPLAY_CAP = 6
ALL_UNIQUE_MIN_ROWS = 50
GEOM_NAME_RX = re.compile(r'^(geom|geometry|shape|wkb|wkt)$', re.I)
BBOX_NAME_RX = re.compile(r'^[xy](min|max)$')
ID_NAME_RX = re.compile(r'^(id|fid|objectid|gid|uuid|hash|geohash)$|_id$|^ogc_fid$|^orig_fid$|^InPoly_FID$', re.I)
NUMERIC_RX = re.compile(r'^-?\d+(\.\d+)?$')
BOOL_VALUE_SETS = [{'0', '1'}, {'true', 'false'}, {'yes', 'no'}, {'y', 'n'}]
KIND_PRIORITY = {'facet': 5, 'boolean': 4, 'range': 3, 'searchable': 2, 'search': 1}


def is_unoffered_name(name: str) -> bool:
    """Columns the panel never offers by name (isUnofferedName)."""
    return bool(GEOM_NAME_RX.search(name) or BBOX_NAME_RX.search(name) or ID_NAME_RX.search(name)
                or name.startswith('_'))


def _js_str(v) -> str:
    """String(v) as JavaScript writes it: 1.0 is '1', True is 'true'."""
    if isinstance(v, bool):
        return str(v).lower()
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _is_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def affordance(col: dict, row_count: int) -> str:
    """The kind of control the panel renders for a column (pickAffordance), or 'drop'."""
    name, kind, distinct = col['name'], col['type'], col['distinct']
    null = col.get('null_frac', 0)
    top = col.get('top_values') or []
    if kind in ('geometry', 'blob') or GEOM_NAME_RX.search(name) or BBOX_NAME_RX.search(name):
        return 'drop'
    if distinct <= 1 or null > 0.95 or ID_NAME_RX.search(name) or name.startswith('_'):
        return 'drop'
    if kind == 'bool':
        return 'boolean'
    if distinct == 2 and len(top) == 2 and {_js_str(t['v']).strip().lower() for t in top} in BOOL_VALUE_SETS:
        return 'boolean'
    if distinct <= 3 and top and all(NUMERIC_RX.match(_js_str(t['v']).strip()) for t in top):
        return 'drop'  # near-constant technical metadata (tessellate=-1)
    non_null = row_count * (1 - null)
    if kind == 'float' and row_count >= 10 and non_null > 0 and distinct / non_null > 0.9:
        return 'drop'  # a per-row computed stat (area, length)
    if (kind == 'int' and row_count >= ALL_UNIQUE_MIN_ROWS and distinct > 50
            and non_null > 0 and distinct / non_null > 0.97):
        return 'drop'  # a row key
    if kind in ('int', 'float', 'date'):
        if distinct <= 20:
            return 'facet'
        if _is_number(col.get('min')) and _is_number(col.get('max')):
            return 'range'
    if distinct <= FACET_THRESHOLD:
        return 'facet'
    return 'searchable' if distinct <= 2000 else 'search'


def rank_columns(cols: list[dict], row_count: int) -> list[dict]:
    """The columns the panel shows, best first, at most DISPLAY_CAP (rankColumns)."""
    scored = [(KIND_PRIORITY[k] * 10 + (1 - c.get('null_frac', 0)), c)
              for c in cols if (k := affordance(c, row_count)) != 'drop']
    return [c for _, c in sorted(scored, key=lambda s: -s[0])][:DISPLAY_CAP]


PANEL_STATS_DIR = ROOT / 'web' / 'public' / 'api-data' / 'filter-stats'


def panel_stats(layer: dict, catalog: dict, probe: Callable[[], dict | None],
                stats_dir: Path = PANEL_STATS_DIR, threshold: int | None = None) -> dict | None:
    """The column stats the viewer's Filter panel ranks for `layer`, from
    where it reads them (web/src/filter-stats.ts, filter-schema.ts
    columnStatsSource): the catalog's filter_stats, else the layer's
    filter-stats file; else, for a parquet at or under LARGE_FILTER_BYTES,
    what the browser's probe finds (`probe()`). None when there is no panel:
    no parquet, or a large layer without a stats file."""
    pq = layer.get('parquet') or {}
    if not pq.get('url'):
        return None
    inline = (catalog.get('filter_stats') or {}).get(layer['id'])
    if inline:
        return inline
    filed = stats_dir / f"{layer['id']}.json"
    if filed.exists():
        return json.loads(filed.read_text())
    if threshold is None:
        from bake_large_filter_stats import large_filter_bytes  # it imports this module
        threshold = large_filter_bytes()
    if isinstance(pq.get('bytes'), int) and pq['bytes'] > threshold:
        return None
    return probe()


def tile_filter_columns(stats: dict) -> list[str]:
    """The columns the map tiles need so the map can draw the panel's filters:
    the panel's columns (equivalent columns folded into their canonical one, as
    the viewer does) with at most FACET_THRESHOLD distinct values. Higher
    cardinality columns would bloat the tiles; the count and export still
    filter on them."""
    folded = {m for g in stats.get('column_groups') or [] for m in g['members'] if m != g['canonical']}
    cols = [c for c in stats['columns'] if c['name'] not in folded]
    return [c['name'] for c in rank_columns(cols, stats['row_count']) if c['distinct'] <= FACET_THRESHOLD]


def _column_aggs(col: str) -> list[str]:
    """distinct, non-null count, min, max of one column, as SELECT expressions.
    Plain aggregates: a FILTER clause or a cast inside them makes DuckDB's
    merged scan several times slower; min and max are cast on the one result row."""
    q = f'"{col}"'
    return [f'COUNT(DISTINCT {q})', f'COUNT({q})', f'MIN({q})', f'MAX({q})']


def _aggregate_query(src: str, cols: list[str]) -> str:
    inner = ', '.join(f'{e} AS a{i}_{k}' for i, c in enumerate(cols) for k, e in enumerate(_column_aggs(c)))
    outer = ', '.join(f'a{i}_0, n - a{i}_1, a{i}_2::VARCHAR, a{i}_3::VARCHAR' for i in range(len(cols)))
    return f"SELECT n{', ' if cols else ''}{outer} FROM (SELECT COUNT(*) AS n, {inner or '1'} FROM '{src}')"


def column_aggregates(con, src: str, cols: list[str]) -> tuple[int, dict[str, tuple]]:
    """(row count, {column: (distinct, nulls, min, max)}) in one scan. A column
    the merged query can't aggregate fails it; then each column runs alone
    and one that still fails is left out (logged)."""
    try:
        row = con.execute(_aggregate_query(src, cols)).fetchone()
        return row[0], {c: tuple(row[1 + 4 * i:5 + 4 * i]) for i, c in enumerate(cols)}
    except duckdb.Error:
        if not cols:
            raise
    out = {}
    for c in cols:
        try:
            out[c] = con.execute(_aggregate_query(src, [c])).fetchone()[1:]
        except duckdb.Error as e:
            print(f'  filter_stats: agg failed on {c} — {e}')
    return con.execute(f"SELECT COUNT(*) FROM '{src}'").fetchone()[0], out


def value_counts(con, src: str, cols: list[str], limit: int) -> dict[str, list[tuple[str, int]]]:
    """{column: [(value as text, rows)]}, most rows first (ties by value), up to
    `limit` per column, NULLs left out: every column in one scan (UNPIVOT
    drops NULLs, as the per-column WHERE did)."""
    if not cols:
        return {}
    alias = {f'c{i}': c for i, c in enumerate(cols)}
    casts = ', '.join(f'"{c}"::VARCHAR AS {a}' for a, c in alias.items())
    rows = con.execute(f"""
        WITH t AS (SELECT {casts} FROM '{src}')
        SELECT col, v, COUNT(*) AS n FROM (UNPIVOT t ON {', '.join(alias)} INTO NAME col VALUE v)
        GROUP BY col, v
        QUALIFY row_number() OVER (PARTITION BY col ORDER BY n DESC, v) <= {limit}
        ORDER BY col, n DESC, v""").fetchall()
    out: dict[str, list[tuple[str, int]]] = {c: [] for c in cols}
    for a, v, n in rows:
        out[alias[a]].append((v, int(n)))
    return out


def is_url(path: Path | str) -> bool:
    return str(path).startswith(('http://', 'https://'))


def stats_for_parquet(path: Path | str, con: duckdb.DuckDBPyConnection, probe: bool = False) -> dict | None:
    """Per-column stats in two scans of the parquet: every aggregate at once,
    then the top values of every faceted column at once. `path` is a local
    file or an http(s) URL (read with range requests, nothing kept on disk).
    `probe` matches the viewer's live probe (web/src/filter-probe.ts): columns
    the panel never offers by name are not aggregated (distinct -1)."""
    if not is_url(path) and not Path(path).exists():
        return None
    src = str(path)
    try:
        desc = con.execute(f"DESCRIBE SELECT * FROM '{src}' LIMIT 0").fetchall()
        types = {row[0]: normalise_type(row[1]) for row in desc}
        skipped = {c for c, norm in types.items()
                   if norm in ('geometry', 'blob') or (probe and is_unoffered_name(c))}
        row_count, aggs = column_aggregates(con, src, [c for c in types if c not in skipped])
    except duckdb.Error as e:
        print(f'  filter_stats: DESCRIBE failed on {Path(src).name} — {e}')
        return None

    columns: list[dict] = []
    for col_name, norm in types.items():
        if col_name in skipped:
            columns.append({'name': col_name, 'type': norm, 'distinct': -1, 'null_frac': 0})
            continue
        if col_name not in aggs:
            continue
        distinct_count, nulls, min_v, max_v = aggs[col_name]
        entry: dict = {
            'name': col_name,
            'type': norm,
            'distinct': int(distinct_count) if distinct_count is not None else 0,
            'null_frac': round(nulls / row_count, 4) if row_count else 0.0,
        }
        if min_v is not None:
            entry['min'] = _coerce(min_v, norm)
        if max_v is not None:
            entry['max'] = _coerce(max_v, norm)
        columns.append(entry)

    faceted = [c for c in columns if 2 <= c['distinct'] <= FACET_THRESHOLD]
    try:
        top = value_counts(con, src, [c['name'] for c in faceted], MAX_TOP_VALUES)
    except duckdb.Error:  # one column breaks the merged scan: take them one at a time
        top = {}
        for c in faceted:
            try:
                top.update(value_counts(con, src, [c['name']], MAX_TOP_VALUES))
            except duckdb.Error as e:
                print(f'  filter_stats: top_values failed on {c["name"]} — {e}')
    for c in faceted:
        if c['name'] in top:
            c['top_values'] = [{'v': _coerce(v, c['type']), 'n': n} for v, n in top[c['name']]]

    return {'row_count': int(row_count), 'columns': columns}


def _coerce(v, norm: str):
    if v is None:
        return None
    if norm == 'int':
        try:
            return int(v)
        except (ValueError, TypeError):
            return v
    if norm == 'float':
        try:
            return float(v)
        except (ValueError, TypeError):
            return v
    return v


def detect_equivalences(
    src: str,
    columns: list[dict],
    row_count: int,
    con: duckdb.DuckDBPyConnection,
) -> list[list[str]]:
    """Find groups of columns whose value sets are bijective (modulo a single
    null discrepancy). For each pair (a, b) of low-cardinality columns, we
    compute COUNT(DISTINCT a), COUNT(DISTINCT b), COUNT(DISTINCT (a, b)) — if
    the joint distinct count matches the larger single, they encode the same
    information. Generalises the regex hack we previously used to hide
    state_lgd / stcode11 next to STNAME.

    Row-unique columns (distinct ≈ rowCount) are excluded — in a 36-row
    LGD_States table, every column has 36 distinct values and any pair is
    trivially "bijective", but the columns are row keys, not facets."""
    row_unique_threshold = max(2, int(row_count * 0.95))
    candidates = [
        c['name'] for c in columns
        if c['type'] not in ('geometry', 'blob')
        and 2 <= c.get('distinct', 0) <= 50
        and c.get('distinct', 0) < row_unique_threshold
        and c.get('null_frac', 0) < 0.5
    ]
    by_name = {c['name']: c for c in columns}

    # Union-find for transitive equivalence grouping.
    parent = {n: n for n in candidates}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    # Skip pairs with very different cardinalities — they can't be bijective.
    pairs = [(a, b) for i, a in enumerate(candidates) for b in candidates[i + 1:]
             if abs(by_name[a]['distinct'] - by_name[b]['distinct']) <= 1]

    def joint(a: str, b: str) -> str:
        # CASE, not FILTER: COUNT(DISTINCT) skips the NULL, and a FILTER clause
        # makes the merged scan several times slower.
        return f'COUNT(DISTINCT CASE WHEN "{a}" IS NOT NULL AND "{b}" IS NOT NULL THEN ("{a}", "{b}") END)'

    joint_counts: dict[tuple[str, str], int | None] = {}
    if pairs:
        try:  # every pair in one scan
            row = con.execute(f"SELECT {', '.join(joint(a, b) for a, b in pairs)} FROM '{src}'").fetchone()
            joint_counts = dict(zip(pairs, row))
        except duckdb.Error:  # a pair breaks the merged scan: take them one at a time, skipping failures
            for a, b in pairs:
                try:
                    joint_counts[(a, b)] = con.execute(f"SELECT {joint(a, b)} FROM '{src}'").fetchone()[0]
                except duckdb.Error:
                    continue
    for (a, b), n in joint_counts.items():
        ab = int(n) if n is not None else 0
        mx = max(by_name[a]['distinct'], by_name[b]['distinct'])
        # Allow up to 1 row of slack: a NULL-encoded "Other" state can
        # make stcode11 (28) differ from state_lgd (27) — still equivalent.
        if mx - 1 <= ab <= mx + 1:
            union(a, b)

    groups_by_root: dict[str, list[str]] = {}
    for n in candidates:
        groups_by_root.setdefault(find(n), []).append(n)
    return [sorted(g) for g in groups_by_root.values() if len(g) > 1]


_CODE_NAME_RX = re.compile(r'(code|_lgd|_id|^id$)', re.IGNORECASE)


def pick_canonical(group: list[str], columns: list[dict]) -> str:
    """Choose the most human-readable representative of an equivalence group:
    prefer strings over ints; prefer names that don't look like codes; fall
    back to alphabetic order for stability."""
    by_name = {c['name']: c for c in columns}

    def score(name: str) -> tuple[int, int, int, str]:
        c = by_name.get(name, {'type': 'string'})
        is_string = 1 if c['type'] == 'string' else 0
        not_code = 0 if _CODE_NAME_RX.search(name) else 1
        # Prefer shorter names within the same other-axis tie.
        return (not_code, is_string, -len(name), name)

    return sorted(group, key=score, reverse=True)[0]


def build_all(layers: list[tuple[str, Path | str]]) -> dict:
    """layers: [(layer_id, local parquet path or http(s) URL), …]"""
    con = duckdb.connect()
    try:
        con.execute('INSTALL spatial; LOAD spatial')
    except duckdb.Error:
        pass
    if any(is_url(p) for _, p in layers):
        con.execute('INSTALL httpfs; LOAD httpfs')
    out: dict = {}
    for layer_id, path in layers:
        s = stats_for_parquet(path, con)
        if s is None:
            continue
        groups = detect_equivalences(str(path), s['columns'], s['row_count'], con)
        if groups:
            s['column_groups'] = [
                {'canonical': pick_canonical(g, s['columns']), 'members': g}
                for g in groups
            ]
        out[layer_id] = s
        cols = len(s['columns'])
        nb_groups = len(s.get('column_groups', []))
        msg = f'  filter_stats[{layer_id}]: {s["row_count"]:,} rows, {cols} cols'
        if nb_groups:
            msg += f', {nb_groups} equivalence group(s)'
        print(msg)
    return out


if __name__ == '__main__':
    # Standalone smoke run — picks up every parquet under sources/india-geodata.
    layers = [(p.stem, p) for p in sorted(SRC.glob('*.parquet'))]
    print(f'Probing {len(layers)} local parquets…')
    out = build_all(layers)
    target = ROOT / 'scripts' / 'filter-stats.local.json'
    target.write_text(json.dumps(out, indent=2, default=str))
    print(f'wrote {target} ({len(out)} layers)')
