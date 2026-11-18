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
import sys
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


def stats_for_parquet(path: Path, con: duckdb.DuckDBPyConnection) -> dict | None:
    """Per-column stats in two scans of the parquet: every aggregate at once,
    then the top values of every faceted column at once."""
    if not path.exists():
        return None
    src = str(path)
    try:
        desc = con.execute(f"DESCRIBE SELECT * FROM '{src}' LIMIT 0").fetchall()
        types = {row[0]: normalise_type(row[1]) for row in desc}
        flat = [c for c, norm in types.items() if norm not in ('geometry', 'blob')]
        row_count, aggs = column_aggregates(con, src, flat)
    except duckdb.Error as e:
        print(f'  filter_stats: DESCRIBE failed on {path.name} — {e}')
        return None

    columns: list[dict] = []
    for col_name, norm in types.items():
        if norm in ('geometry', 'blob'):
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


def build_all(layers: list[tuple[str, Path]]) -> dict:
    """layers: [(layer_id, local_parquet_path), …]"""
    con = duckdb.connect()
    try:
        con.execute('INSTALL spatial; LOAD spatial')
    except duckdb.Error:
        pass
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
