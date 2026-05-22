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


def normalise_type(t: str) -> str:
    base = t.split('(')[0].strip().upper()
    return DUCKDB_TO_NORM.get(base, 'string')


def stats_for_parquet(path: Path, con: duckdb.DuckDBPyConnection) -> dict | None:
    if not path.exists():
        return None
    src = str(path)
    try:
        desc = con.execute(f"DESCRIBE SELECT * FROM '{src}' LIMIT 0").fetchall()
        row_count = con.execute(f"SELECT COUNT(*) FROM '{src}'").fetchone()[0]
    except duckdb.Error as e:
        print(f'  filter_stats: DESCRIBE failed on {path.name} — {e}')
        return None

    columns: list[dict] = []
    for row in desc:
        col_name, col_type = row[0], row[1]
        norm = normalise_type(col_type)
        if norm in ('geometry', 'blob'):
            columns.append({'name': col_name, 'type': norm, 'distinct': -1, 'null_frac': 0})
            continue

        try:
            agg = con.execute(f"""
                SELECT
                  COUNT(DISTINCT "{col_name}") AS distinct_count,
                  COALESCE(
                    CAST(COUNT(*) FILTER (WHERE "{col_name}" IS NULL) AS DOUBLE)
                      / NULLIF(COUNT(*), 0),
                    0
                  ) AS null_frac,
                  MIN("{col_name}")::VARCHAR AS min_v,
                  MAX("{col_name}")::VARCHAR AS max_v
                FROM '{src}'
            """).fetchone()
        except duckdb.Error as e:
            print(f'  filter_stats: agg failed on {col_name} — {e}')
            continue

        distinct_count, null_frac, min_v, max_v = agg
        entry: dict = {
            'name': col_name,
            'type': norm,
            'distinct': int(distinct_count) if distinct_count is not None else 0,
            'null_frac': round(float(null_frac or 0), 4),
        }
        if min_v is not None:
            entry['min'] = _coerce_minmax(min_v, norm)
        if max_v is not None:
            entry['max'] = _coerce_minmax(max_v, norm)

        if 2 <= entry['distinct'] <= FACET_THRESHOLD:
            try:
                top = con.execute(f"""
                    SELECT "{col_name}"::VARCHAR AS v, COUNT(*) AS n
                    FROM '{src}'
                    WHERE "{col_name}" IS NOT NULL
                    GROUP BY 1
                    ORDER BY n DESC
                    LIMIT {MAX_TOP_VALUES}
                """).fetchall()
                entry['top_values'] = [
                    {'v': _coerce_value(v, norm), 'n': int(n)} for v, n in top
                ]
            except duckdb.Error as e:
                print(f'  filter_stats: top_values failed on {col_name} — {e}')

        columns.append(entry)

    return {'row_count': int(row_count), 'columns': columns}


def _coerce_minmax(v: str, norm: str) -> str | float | int:
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


def _coerce_value(v: str | None, norm: str) -> str | float | int | None:
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

    for i in range(len(candidates)):
        a = candidates[i]
        for j in range(i + 1, len(candidates)):
            b = candidates[j]
            da, db = by_name[a]['distinct'], by_name[b]['distinct']
            # Skip pairs with very different cardinalities — they can't bijective.
            if abs(da - db) > 1:
                continue
            try:
                row = con.execute(f"""
                    SELECT COUNT(DISTINCT ("{a}", "{b}"))
                    FROM '{src}'
                    WHERE "{a}" IS NOT NULL AND "{b}" IS NOT NULL
                """).fetchone()
            except duckdb.Error:
                continue
            ab = int(row[0]) if row and row[0] is not None else 0
            mx = max(da, db)
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
