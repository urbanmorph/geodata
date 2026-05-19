"""
Slice india-geodata parquets into per-state GeoJSON.
Pan-India parquets remain authoritative in sources/india-geodata/.

Edit STATES below to add more states. State codes are the LGD `State_LGD` —
see https://lgdirectory.gov.in/ or sources/india-geodata/LGD_States.parquet.
"""
import os, duckdb

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC  = os.path.join(ROOT, 'sources', 'india-geodata')
OUT  = os.path.join(ROOT, 'data', 'boundaries')

STATES = {'CG': 22, 'JH': 20, 'OD': 21}

# (parquet, state_code_column, out_subdir, out_name)
LAYERS = [
    ('LGD_States.parquet',       'State_LGD',  'states',       'lgd_states'),
    ('LGD_Districts.parquet',    'state_lgd',  'districts',    'lgd_districts'),
    ('LGD_Subdistricts.parquet', 'state_lgd',  'subdistricts', 'lgd_subdistricts'),
    ('LGD_Blocks.parquet',       'state_lgd',  'blocks',       'lgd_blocks'),
    ('LGD_Villages.parquet',     'state_lgd',  'villages',     'lgd_villages'),
]

con = duckdb.connect()
con.execute("INSTALL spatial; LOAD spatial")

for st_abbr, st_lgd in STATES.items():
    for parquet, st_col, sub, name in LAYERS:
        os.makedirs(os.path.join(OUT, sub), exist_ok=True)
        out = os.path.join(OUT, sub, f'{name}_{st_abbr.lower()}.geojson')
        if os.path.exists(out):
            print(f'skip {out}')
            continue
        src = os.path.join(SRC, parquet)
        if not os.path.exists(src):
            print(f'missing source: {src} — run scripts/fetch.sh first')
            continue
        print(f'extract {parquet} state={st_abbr} -> {out}')
        con.execute(f"""
          COPY (
            SELECT * EXCLUDE geometry,
                   ST_AsWKB(geometry) AS wkb_geom,
                   geometry
            FROM '{src}'
            WHERE {st_col} = {st_lgd}
          )
          TO '{out}'
          WITH (FORMAT GDAL, DRIVER 'GeoJSON', LAYER_CREATION_OPTIONS 'RFC7946=YES')
        """)
        sz = os.path.getsize(out)
        print(f'  {sz/1024/1024:.1f} MB')
