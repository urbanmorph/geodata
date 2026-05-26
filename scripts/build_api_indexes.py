"""
Generate pre-computed API indexes from LGD parquets.

Outputs:
  web/public/api-data/counts.json        -- per-layer, per-state feature counts
  web/public/api-data/hierarchy/<SC>.json -- per-state admin hierarchy (LGD chain)

Run after scripts/fetch.sh (needs local parquets in sources/india-geodata/).
Gracefully skips if parquets are absent -- the API endpoints fall back to
catalog.json rows counts and return 404 for hierarchy.

Usage:
    python3 scripts/build_api_indexes.py
"""
from __future__ import annotations
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'sources' / 'india-geodata'
OUT = ROOT / 'web' / 'public' / 'api-data'

# LGD parquet files and the columns we need
LGD_LAYERS = [
    ('lgd_states', 'LGD_States.parquet', 'State_LGD', None),
    ('lgd_districts', 'LGD_Districts.parquet', 'State_LGD', 'Dist_LGD'),
    ('lgd_subdistricts', 'LGD_Subdistricts.parquet', 'State_LGD', 'SubDist_LGD'),
    ('lgd_blocks', 'LGD_Blocks.parquet', 'State_LGD', 'Block_LGD'),
    ('lgd_villages', 'LGD_Villages.parquet', 'State_LGD', 'Vill_LGD'),
]

STATE_COL = 'State_LGD'


def build_counts(con) -> dict:
    """Per-layer, per-state feature counts."""
    counts = {}
    for layer_id, parquet, state_col, _code_col in LGD_LAYERS:
        path = SRC / parquet
        if not path.exists():
            print(f'  counts: skip {layer_id} (no local parquet)')
            continue
        try:
            total = con.execute(f"SELECT COUNT(*) FROM '{path}'").fetchone()[0]
            by_state = {}
            rows = con.execute(
                f"SELECT \"{state_col}\", COUNT(*) as n FROM '{path}' GROUP BY 1"
            ).fetchall()
            for sc, n in rows:
                if sc is not None:
                    by_state[str(int(sc))] = n
            counts[layer_id] = {'_total': total, 'by_state': by_state}
            print(f'  counts: {layer_id} = {total} total, {len(by_state)} states')
        except Exception as e:
            print(f'  counts: {layer_id} failed: {e}')
    return counts


def build_hierarchy(con) -> dict[str, dict]:
    """Per-state hierarchy JSON files. Returns {state_code: hierarchy_dict}."""
    # First, get the state list
    states_pq = SRC / 'LGD_States.parquet'
    if not states_pq.exists():
        print('  hierarchy: skip (no LGD_States.parquet)')
        return {}

    states = {}
    for row in con.execute(f"""
        SELECT State_LGD, STNAME FROM '{states_pq}'
        WHERE State_LGD IS NOT NULL
    """).fetchall():
        sc = str(int(row[0]))
        states[sc] = {'lgd_code': int(row[0]), 'name': row[1]}

    if not states:
        return {}

    print(f'  hierarchy: {len(states)} states')
    hierarchies: dict[str, dict] = {}

    for sc, state_info in states.items():
        h: dict[str, dict] = {'state': state_info}

        # Districts
        dist_pq = SRC / 'LGD_Districts.parquet'
        if dist_pq.exists():
            h['districts'] = {}
            try:
                rows = con.execute(f"""
                    SELECT Dist_LGD, DTNAME FROM '{dist_pq}'
                    WHERE State_LGD = {sc} AND Dist_LGD IS NOT NULL
                """).fetchall()
                for code, name in rows:
                    h['districts'][str(int(code))] = {
                        'lgd_code': int(code), 'name': name, 'state_lgd': int(sc),
                    }
            except Exception as e:
                print(f'    districts for {sc}: {e}')

        # Subdistricts
        subdist_pq = SRC / 'LGD_Subdistricts.parquet'
        if subdist_pq.exists():
            h['subdistricts'] = {}
            try:
                rows = con.execute(f"""
                    SELECT SubDist_LGD, SDTNAME, Dist_LGD FROM '{subdist_pq}'
                    WHERE State_LGD = {sc} AND SubDist_LGD IS NOT NULL
                """).fetchall()
                for code, name, dlgd in rows:
                    h['subdistricts'][str(int(code))] = {
                        'lgd_code': int(code), 'name': name,
                        'district_lgd': int(dlgd) if dlgd else None,
                        'state_lgd': int(sc),
                    }
            except Exception as e:
                print(f'    subdistricts for {sc}: {e}')

        # Blocks
        blocks_pq = SRC / 'LGD_Blocks.parquet'
        if blocks_pq.exists():
            h['blocks'] = {}
            try:
                rows = con.execute(f"""
                    SELECT Block_LGD, BNAME, Dist_LGD FROM '{blocks_pq}'
                    WHERE State_LGD = {sc} AND Block_LGD IS NOT NULL
                """).fetchall()
                for code, name, dlgd in rows:
                    h['blocks'][str(int(code))] = {
                        'lgd_code': int(code), 'name': name,
                        'district_lgd': int(dlgd) if dlgd else None,
                        'state_lgd': int(sc),
                    }
            except Exception as e:
                print(f'    blocks for {sc}: {e}')

        # Villages (can be large)
        villages_pq = SRC / 'LGD_Villages.parquet'
        if villages_pq.exists():
            h['villages'] = {}
            try:
                rows = con.execute(f"""
                    SELECT Vill_LGD, VILNAME, Block_LGD, Dist_LGD FROM '{villages_pq}'
                    WHERE State_LGD = {sc} AND Vill_LGD IS NOT NULL
                """).fetchall()
                for code, name, blgd, dlgd in rows:
                    h['villages'][str(int(code))] = {
                        'lgd_code': int(code), 'name': name,
                        'block_lgd': int(blgd) if blgd else None,
                        'district_lgd': int(dlgd) if dlgd else None,
                        'state_lgd': int(sc),
                    }
            except Exception as e:
                print(f'    villages for {sc}: {e}')

        hierarchies[sc] = h

    return hierarchies


def main():
    try:
        import duckdb
    except ImportError:
        sys.exit('duckdb not installed. pip install duckdb')

    # Check if any parquets exist
    available = [p for _, p, _, _ in LGD_LAYERS if (SRC / p).exists()]
    if not available:
        print('No local LGD parquets found. Skipping API index generation.')
        print(f'Run scripts/fetch.sh to download them to {SRC}/')
        return

    print(f'Found {len(available)}/{len(LGD_LAYERS)} LGD parquets')

    con = duckdb.connect()
    con.install_extension('spatial')
    con.load_extension('spatial')

    # Build counts
    OUT.mkdir(parents=True, exist_ok=True)
    counts = build_counts(con)
    if counts:
        counts_path = OUT / 'counts.json'
        counts_path.write_text(json.dumps(counts, separators=(',', ':')))
        print(f'  wrote {counts_path.relative_to(ROOT)} ({len(counts)} layers)')

    # Build hierarchy
    hierarchies = build_hierarchy(con)
    if hierarchies:
        hier_dir = OUT / 'hierarchy'
        hier_dir.mkdir(parents=True, exist_ok=True)
        for sc, h in hierarchies.items():
            p = hier_dir / f'{sc}.json'
            p.write_text(json.dumps(h, separators=(',', ':')))
        total_size = sum(f.stat().st_size for f in hier_dir.glob('*.json'))
        print(f'  wrote {len(hierarchies)} hierarchy files ({total_size / 1024:.0f} KB total)')

    con.close()


if __name__ == '__main__':
    main()
