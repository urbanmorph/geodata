"""
Generate catalog.json from local files. Single source of truth for the viewer.

Run after scripts/fetch.sh + scripts/extract_per_state.py.
"""
import json, os, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'sources' / 'india-geodata'
GB = ROOT / 'sources' / 'geoboundaries'
DATA = ROOT / 'data' / 'boundaries'

# Public base URL of the R2 bucket
R2 = 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev'

# Level metadata
LEVELS = {
    'state':       {'order': 1, 'plural': 'states'},
    'district':    {'order': 2, 'plural': 'districts'},
    'subdistrict': {'order': 3, 'plural': 'subdistricts'},
    'block':       {'order': 4, 'plural': 'blocks'},
    'village':     {'order': 5, 'plural': 'villages'},
}

# Licences per upstream (yashveeeeeeer/india-geodata): states/districts are
# dual-licenced CC0-1.0 / CC-BY-4.0; sub-districts, blocks, villages are CC0-1.0.
# geoBoundaries is CC-BY-4.0.
LIC_STATE_DIST = 'CC0-1.0 / CC-BY-4.0'
LIC_BELOW = 'CC0-1.0'
LIC_GB = 'CC-BY-4.0'

# Per-source primary attribution
ATTR = {
    'LGD':           {'name': 'Local Government Directory',  'url': 'https://lgdirectory.gov.in/'},
    'SOI':           {'name': 'Survey of India',             'url': 'https://surveyofindia.gov.in/'},
    'Bhuvan':        {'name': 'NRSC/ISRO Bhuvan',            'url': 'https://bhuvanpanchayat.nrsc.gov.in/'},
    'PMGSY':         {'name': 'PMGSY (Rural Roads)',         'url': 'https://omms.nic.in/'},
    'geoBoundaries': {'name': 'geoBoundaries',               'url': 'https://www.geoboundaries.org/'},
}
PUBLISHER = {
    'name': 'yashveeeeeeer/india-geodata',
    'url': 'https://github.com/yashveeeeeeer/india-geodata',
}

# (id, level, source, parquet, pmtiles, rows, licence, notes)
LAYERS = [
    ('lgd_states',         'state',       'LGD',    'LGD_States.parquet',         'LGD_States.pmtiles',         36,      LIC_STATE_DIST, 'Authoritative LGD source. Full code chain.'),
    ('soi_states',         'state',       'SOI',    'SOI_States.parquet',         None,                          40,      LIC_STATE_DIST, 'Survey of India derivative.'),
    ('bhuvan_states',      'state',       'Bhuvan', 'bhuvan_states.parquet',      None,                          37,      LIC_STATE_DIST, 'NRSC/ISRO Bhuvan. Own codes, not LGD.'),

    ('lgd_districts',      'district',    'LGD',    'LGD_Districts.parquet',      'LGD_Districts.pmtiles',      785,     LIC_STATE_DIST, 'Authoritative. Joins to states via state_lgd.'),
    ('soi_districts',      'district',    'SOI',    'SOI_Districts.parquet',      None,                          742,     LIC_STATE_DIST, 'SoI derivative. Partial LGD codes.'),
    ('bhuvan_districts',   'district',    'Bhuvan', 'bhuvan_districts.parquet',   None,                          663,     LIC_STATE_DIST, 'Bhuvan. Under-counts vs LGD in some states.'),

    ('lgd_subdistricts',   'subdistrict', 'LGD',    'LGD_Subdistricts.parquet',   'LGD_Subdistricts.pmtiles',   6471,    LIC_BELOW,      'Authoritative.'),
    ('soi_subdistricts',   'subdistrict', 'SOI',    'SOI_Subdistricts.parquet',   None,                          4723,    LIC_BELOW,      'SoI tehsils. Partial codes.'),

    ('lgd_blocks',         'block',       'LGD',    'LGD_Blocks.parquet',         'LGD_Blocks.pmtiles',         7146,    LIC_BELOW,      'Authoritative. Full code chain.'),
    ('bhuvan_blocks',      'block',       'Bhuvan', 'bhuvan_blocks.parquet',      None,                          6393,    LIC_BELOW,      'Bhuvan. Predates recent re-divisions in several states.'),
    ('pmgsy_blocks',       'block',       'PMGSY',  'PMGSY_Blocks.parquet',       None,                          6637,    LIC_BELOW,      'PMGSY rural roads blocks. IDs only — no names.'),

    ('lgd_villages',       'village',     'LGD',    'LGD_Villages.parquet',       'LGD_Villages.pmtiles',       584615,  LIC_BELOW,      'Authoritative. 584k polygons. Use vector tiles to render.'),
    ('soi_village_points', 'village',     'SOI',    'SOI_VILLAGE_POINT.parquet',  None,                          None,    LIC_BELOW,      'SoI village centroids (point geometry).'),
]

# geoBoundaries cross-check layers (geojson only)
GEOBOUNDARIES = [
    ('gb_adm1', 'state',       'IND_ADM1.geojson', 36,   'name-only'),
    ('gb_adm2', 'district',    'IND_ADM2.geojson', 735,  'name-only'),
    ('gb_adm3', 'subdistrict', 'IND_ADM3.geojson', 6824, 'name-only'),
    ('gb_adm4', 'block',       'IND_ADM4.geojson', 7143, 'mislabeled in upstream — block-equivalent, not village'),
]


def size_of(p: Path) -> int | None:
    try:
        return p.stat().st_size
    except FileNotFoundError:
        return None


def build():
    layers = []

    for id_, level, source, parquet, pmtiles, rows, licence, notes in LAYERS:
        parquet_path = SRC / parquet
        pmtiles_path = SRC / pmtiles if pmtiles else None
        layers.append({
            'id': id_,
            'level': level,
            'source': source,
            'rows': rows,
            'parquet': {
                'url': f'{R2}/admin/{LEVELS[level]["plural"]}/{parquet}',
                'bytes': size_of(parquet_path),
            },
            'pmtiles': {
                'url': f'{R2}/admin/{LEVELS[level]["plural"]}/{pmtiles}',
                'bytes': size_of(pmtiles_path),
            } if pmtiles_path else None,
            'licence': licence,
            'attribution': {
                'primary': ATTR[source],
                'publisher': PUBLISHER,
            },
            'notes': notes,
        })

    for id_, level, name, rows, notes in GEOBOUNDARIES:
        path = GB / name
        layers.append({
            'id': id_,
            'level': level,
            'source': 'geoBoundaries',
            'rows': rows,
            'geojson': {
                'url': f'{R2}/geoboundaries/{name}',
                'bytes': size_of(path),
            },
            'parquet': None,
            'pmtiles': None,
            'licence': LIC_GB,
            'attribution': {
                'primary': ATTR['geoBoundaries'],
                'publisher': None,
            },
            'notes': notes,
        })

    # per-state geojson extracts under data/boundaries/<level>/lgd_<level>_<state>.geojson
    state_extracts = []
    for level_dir in sorted(DATA.glob('*')):
        if not level_dir.is_dir():
            continue
        for gj in sorted(level_dir.glob('*.geojson')):
            stem = gj.stem
            parts = stem.split('_')
            state = parts[-1]
            state_extracts.append({
                'state': state,
                'level': level_dir.name.rstrip('s') if level_dir.name != 'subdistricts' else 'subdistrict',
                'url': f'{R2}/boundaries/{level_dir.name}/{gj.name}',
                'bytes': size_of(gj),
            })

    catalog = {
        'version': 1,
        'generated': None,
        'country': 'IN',
        'r2_base': R2,
        'levels': LEVELS,
        'layers': layers,
        'state_extracts': state_extracts,
        'attribution': ATTR | {'_publisher': PUBLISHER},
        'licence_summary': {
            'states_districts': LIC_STATE_DIST,
            'subdistricts_blocks_villages': LIC_BELOW,
            'geoBoundaries': LIC_GB,
            'note': 'Per yashveeeeeeer/india-geodata. CC0-1.0 is public domain; CC-BY-4.0 requires attribution. When in doubt, attribute.',
        },
    }

    from datetime import datetime, timezone
    catalog['generated'] = datetime.now(timezone.utc).isoformat()

    out = ROOT / 'catalog.json'
    out.write_text(json.dumps(catalog, indent=2) + '\n')
    print(f'wrote {out} ({len(layers)} layers, {len(state_extracts)} state extracts)')


if __name__ == '__main__':
    build()
