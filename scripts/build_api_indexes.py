"""
Generate pre-computed API stats for all layers with local parquets.

For each layer: scans every column, detects groupable ones (distinct <= 200),
pre-computes value→count mappings. No hardcoded layer or column names.

Outputs:
  web/public/api-data/layers/{layer_id}.json  -- per-layer stats

Run after baking parquets (scripts/ingest_external.py or scripts/fetch.sh).
Gracefully skips layers whose parquets are absent.

Usage:
    python3 scripts/build_api_indexes.py
    python3 scripts/build_api_indexes.py lgd_states    # single layer
"""
from __future__ import annotations
import contextlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'sources' / 'india-geodata'
sys.path.insert(0, str(Path(__file__).resolve().parent))
import pipeline  # noqa: E402
from build_filter_stats import value_counts  # noqa: E402
OUT = ROOT / 'web' / 'public' / 'api-data' / 'layers'

MAX_DISTINCT_FOR_GROUPING = 200
MAX_VALUES_PER_COLUMN = 500


find_parquet = pipeline.find_parquet  # tests patch this module attribute


def compute_layer_stats(con, parquet_path: Path, layer_id: str) -> dict | None:
    """Generic column stats for one parquet file, in two scans: the row count
    and every distinct count at once, then every groupable column's
    value→count at once."""
    src = str(parquet_path)
    try:
        schema = con.execute(f"DESCRIBE SELECT * FROM '{src}'").fetchall()
        types = {name: col_type for name, col_type, *_ in schema
                 if not (name.lower().startswith('geom') or name.lower() == 'wkb_geometry')}
        row_count, distinct = distinct_counts(con, src, list(types))
    except Exception as e:
        print(f'  {layer_id}: failed to read — {e}')
        return None

    if row_count == 0:
        return {'row_count': 0, 'columns': {}}

    columns: dict[str, dict] = {
        c: {'type': simplify_type(types[c]), 'distinct': distinct[c], 'row_count': row_count}
        for c in types if c in distinct}
    # value→count for the groupable columns only, all in one scan
    groupable = [c for c, info in columns.items() if 0 < info['distinct'] <= MAX_DISTINCT_FOR_GROUPING]
    try:
        counts = value_counts(con, src, groupable, MAX_VALUES_PER_COLUMN)
    except Exception:  # one column breaks the merged scan: take them one at a time
        counts = {}
        for c in groupable:
            with contextlib.suppress(Exception):
                counts.update(value_counts(con, src, [c], MAX_VALUES_PER_COLUMN))
    for c, rows in counts.items():
        columns[c]['values'] = {str(v): n for v, n in rows}

    return {'row_count': row_count, 'columns': columns}


def distinct_counts(con, src: str, cols: list[str]) -> tuple[int, dict[str, int]]:
    """(row count, {column: distinct values}) in one scan; per column
    (leaving out a column that fails) when the merged query fails."""
    exprs = ''.join(', COUNT(DISTINCT "%s")' % c for c in cols)
    try:
        row = con.execute(f"SELECT COUNT(*){exprs} FROM '{src}'").fetchone()
        return row[0], dict(zip(cols, row[1:]))
    except Exception:
        if not cols:
            raise
    out = {}
    for c in cols:
        with contextlib.suppress(Exception):
            out[c] = con.execute(f'SELECT COUNT(DISTINCT "{c}") FROM \'{src}\'').fetchone()[0]
    return con.execute(f"SELECT COUNT(*) FROM '{src}'").fetchone()[0], out


def simplify_type(duckdb_type: str) -> str:
    t = duckdb_type.upper()
    if 'INT' in t or 'FLOAT' in t or 'DOUBLE' in t or 'DECIMAL' in t or 'NUMERIC' in t:
        return 'number'
    if 'VARCHAR' in t or 'TEXT' in t or 'CHAR' in t:
        return 'string'
    if 'BOOL' in t:
        return 'boolean'
    return 'other'


def main():
    try:
        import duckdb
    except ImportError:
        sys.exit('duckdb not installed. pip install duckdb')

    catalog_path = ROOT / 'catalog.json'
    if not catalog_path.exists():
        sys.exit('catalog.json not found')

    catalog = json.loads(catalog_path.read_text())
    layers = catalog.get('layers', [])

    filt = sys.argv[1] if len(sys.argv) > 1 else None
    if filt:
        layers = [l for l in layers if filt in l['id']]

    con = duckdb.connect()
    try:
        con.install_extension('spatial')
        con.load_extension('spatial')
    except Exception:
        pass

    OUT.mkdir(parents=True, exist_ok=True)
    built = 0
    skipped = 0

    for layer in layers:
        lid = layer['id']
        pq = find_parquet(layer)
        if not pq:
            skipped += 1
            continue

        stats = compute_layer_stats(con, pq, lid)
        if not stats:
            skipped += 1
            continue

        groupable = [c for c, info in stats['columns'].items() if 'values' in info]
        out_path = OUT / f'{lid}.json'
        out_path.write_text(json.dumps(stats, separators=(',', ':')))
        built += 1
        print(f'  {lid}: {stats["row_count"]} rows, {len(stats["columns"])} cols, {len(groupable)} groupable')

    con.close()
    print(f'\nbuilt {built} layer stats, skipped {skipped} (no local parquet)')


if __name__ == '__main__':
    main()
