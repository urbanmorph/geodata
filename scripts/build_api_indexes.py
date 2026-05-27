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
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'sources' / 'india-geodata'
OUT = ROOT / 'web' / 'public' / 'api-data' / 'layers'

MAX_DISTINCT_FOR_GROUPING = 200
MAX_VALUES_PER_COLUMN = 500


def find_parquet(layer: dict) -> Path | None:
    """Locate the parquet file for a catalog layer on disk."""
    pq = layer.get('parquet')
    if not pq or not pq.get('url'):
        return None
    url: str = pq['url']
    # Try the sources/india-geodata/ directory (fetch.sh + ingest_external.py output)
    filename = url.rsplit('/', 1)[-1]
    candidate = SRC / filename
    if candidate.exists():
        return candidate
    # Try data/baked path
    r2_base = 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev/'
    if url.startswith(r2_base):
        rel = url[len(r2_base):]
        baked = ROOT / 'data' / 'baked' / rel
        if baked.exists():
            return baked
    return None


def compute_layer_stats(con, parquet_path: Path, layer_id: str) -> dict | None:
    """Compute generic column stats for a single parquet file."""
    try:
        row_count = con.execute(f"SELECT COUNT(*) FROM '{parquet_path}'").fetchone()[0]
    except Exception as e:
        print(f'  {layer_id}: failed to read — {e}')
        return None

    if row_count == 0:
        return {'row_count': 0, 'columns': {}}

    # Get column names and types
    schema = con.execute(f"DESCRIBE SELECT * FROM '{parquet_path}'").fetchall()

    columns: dict[str, dict] = {}
    for col_name, col_type, *_ in schema:
        if col_name.lower().startswith('geom') or col_name.lower() == 'wkb_geometry':
            continue

        try:
            distinct = con.execute(
                f'SELECT COUNT(DISTINCT "{col_name}") FROM \'{parquet_path}\''
            ).fetchone()[0]
        except Exception:
            continue

        col_info: dict = {
            'type': simplify_type(col_type),
            'distinct': distinct,
            'row_count': row_count,
        }

        # Only pre-compute value→count for groupable columns
        if 0 < distinct <= MAX_DISTINCT_FOR_GROUPING:
            try:
                rows = con.execute(f"""
                    SELECT "{col_name}"::VARCHAR AS val, COUNT(*) AS n
                    FROM '{parquet_path}'
                    WHERE "{col_name}" IS NOT NULL
                    GROUP BY 1 ORDER BY n DESC
                    LIMIT {MAX_VALUES_PER_COLUMN}
                """).fetchall()
                col_info['values'] = {str(v): n for v, n in rows}
            except Exception:
                pass

        columns[col_name] = col_info

    return {'row_count': row_count, 'columns': columns}


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
