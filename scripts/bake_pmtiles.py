#!/usr/bin/env python3
"""
Bake PMTiles for the 8 curated layers that currently only have parquet
downloads (SOI / Bhuvan / PMGSY). Cross-source viewing on the home page
("Per LGD · also: SOI, Bhuvan") only surfaces map-renderable sources;
without pmtiles these alts stay hidden behind the <details> "compare
sources" block. Baking them unblocks the inline alt links.

Pipeline per layer:
  1. parquet → GeoJSON via DuckDB-spatial (COPY ... FORMAT GDAL)
  2. GeoJSON → PMTiles via tippecanoe (auto zoom)
  3. Write output to sources/india-geodata/<NAME>.pmtiles
  4. Print actual row count + output size for catalog update

After running, update scripts/build_catalog.py LAYERS to fill in the
5th tuple slot (pmtiles filename) for each baked layer, then run
build_catalog.py and upload_r2.sh to publish.

Run:
    python3 scripts/bake_pmtiles.py            # all 8 layers
    python3 scripts/bake_pmtiles.py bhuvan     # filter by substring
"""
from __future__ import annotations
import os, subprocess, sys, time
from pathlib import Path
import duckdb

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'sources' / 'india-geodata'
WORK = Path('/tmp/bake')
WORK.mkdir(exist_ok=True)

# (parquet_filename, layer_name_for_tippecanoe, pmtiles_filename)
# layer_name matches the catalog id so map.ts can find vector_layers[0].
LAYERS = [
    ('SOI_States.parquet',         'soi_states',          'SOI_States.pmtiles'),
    ('SOI_Districts.parquet',      'soi_districts',       'SOI_Districts.pmtiles'),
    ('SOI_Subdistricts.parquet',   'soi_subdistricts',    'SOI_Subdistricts.pmtiles'),
    ('SOI_VILLAGE_POINT.parquet',  'soi_village_points',  'SOI_VILLAGE_POINT.pmtiles'),
    ('bhuvan_states.parquet',      'bhuvan_states',       'bhuvan_states.pmtiles'),
    ('bhuvan_districts.parquet',   'bhuvan_districts',    'bhuvan_districts.pmtiles'),
    ('bhuvan_blocks.parquet',      'bhuvan_blocks',       'bhuvan_blocks.pmtiles'),
    ('PMGSY_Blocks.parquet',       'pmgsy_blocks',        'PMGSY_Blocks.pmtiles'),
]


def bake(parquet_name: str, layer: str, pmtiles_name: str, con: duckdb.DuckDBPyConnection):
    src = SRC / parquet_name
    if not src.exists():
        print(f'  !! SKIP — source missing: {src}')
        return None

    gj = WORK / f'{layer}.geojson'
    pmt_out = SRC / pmtiles_name

    if gj.exists(): gj.unlink()
    t0 = time.time()
    con.execute(f"""
        COPY (SELECT * FROM '{src}')
        TO '{gj}'
        WITH (FORMAT GDAL, DRIVER 'GeoJSON', LAYER_CREATION_OPTIONS ('WRITE_BBOX=YES'))
    """)
    (rows,) = con.execute(f"SELECT COUNT(*) FROM '{src}'").fetchone()
    gj_mb = gj.stat().st_size / 1024 / 1024
    print(f'    geojson: {gj_mb:.1f} MB, {rows:,} rows  ({time.time()-t0:.1f}s)')

    if pmt_out.exists(): pmt_out.unlink()
    t0 = time.time()
    subprocess.run(
        ['tippecanoe',
         '-o', str(pmt_out), '-l', layer,
         '-zg',
         '--drop-densest-as-needed',
         '--extend-zooms-if-still-dropping',
         '--force',
         '--no-progress-indicator',
         str(gj)],
        check=True, capture_output=True,
    )
    pmt_mb = pmt_out.stat().st_size / 1024 / 1024
    print(f'    pmtiles: {pmt_mb:.1f} MB  ({time.time()-t0:.1f}s)')

    gj.unlink()  # don't keep huge intermediate geojson around
    return {'rows': rows, 'pmtiles_bytes': pmt_out.stat().st_size, 'pmtiles_name': pmtiles_name}


def main():
    filt = sys.argv[1].lower() if len(sys.argv) > 1 else None
    con = duckdb.connect()
    con.install_extension('spatial')
    con.load_extension('spatial')

    targets = [t for t in LAYERS if not filt or filt in t[0].lower() or filt in t[1]]
    print(f'Baking {len(targets)} layer(s)...\n')
    results = {}
    for parquet, layer, pmt in targets:
        print(f'• {layer}')
        r = bake(parquet, layer, pmt, con)
        if r:
            results[layer] = r
        print()

    print('=== summary (paste into build_catalog.py LAYERS rows) ===')
    for layer, r in results.items():
        print(f"  {layer}: rows={r['rows']:,}  pmtiles='{r['pmtiles_name']}'  ({r['pmtiles_bytes']/1024/1024:.1f} MB)")


if __name__ == '__main__':
    main()
