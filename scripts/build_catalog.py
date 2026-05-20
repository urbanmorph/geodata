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

# Where to re-fetch each upstream file from. Path under the release base URL.
# Kept here so the source registry travels with the catalog and a single
# `scripts/refresh.sh` can drive re-pulls without grepping shell scripts.
UPSTREAM_BASE = 'https://github.com/yashveeeeeeer/india-geodata/releases/download'
UPSTREAM_GEOBOUNDARIES = 'https://github.com/wmgeolab/geoBoundaries/raw/9469f09'  # pinned commit

# yashveeeeeeer's 15 categories grouped to 6 for the home-page filter chips.
CATEGORIES = {
    'administrative': 'Administrative',
    'people': 'People & places',
    'environment': 'Environment',
    'infrastructure': 'Infrastructure',
    'health-edu': 'Health & education',
    'other': 'Other',
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


def mtime_of(p: Path) -> str | None:
    """ISO-8601 timestamp of when our local copy was last fetched/written.
    Approximates upstream freshness — good enough until we wire in
    upstream release-date metadata."""
    try:
        from datetime import datetime, timezone
        return datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc).isoformat()
    except FileNotFoundError:
        return None


def build_state_list():
    """Pre-extract the 36 states from LGD_States.parquet so the viewer's filter
    dropdown can populate instantly (no DuckDB init needed just for the list)."""
    import duckdb
    src = SRC / 'LGD_States.parquet'
    if not src.exists():
        return []
    con = duckdb.connect()
    rows = con.execute(
        f"SELECT CAST(State_LGD AS INTEGER) AS code, STNAME AS name "
        f"FROM '{src}' WHERE State_LGD IS NOT NULL AND STNAME IS NOT NULL "
        f"ORDER BY STNAME"
    ).fetchall()
    return [{'code': c, 'name': n} for c, n in rows]


def build_state_bounds():
    """Pre-compute per-state bounding box [minLon, minLat, maxLon, maxLat] so the
    viewer can fitBounds() on the map when a user picks a state, without
    loading any spatial library at runtime."""
    import duckdb
    src = SRC / 'LGD_States.parquet'
    if not src.exists():
        return {}
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial")
    try:
        rows = con.execute(
            f"SELECT CAST(State_LGD AS INTEGER) AS code, "
            f"MIN(ST_XMin(geometry)) AS minx, "
            f"MIN(ST_YMin(geometry)) AS miny, "
            f"MAX(ST_XMax(geometry)) AS maxx, "
            f"MAX(ST_YMax(geometry)) AS maxy "
            f"FROM '{src}' WHERE State_LGD IS NOT NULL "
            f"GROUP BY State_LGD"
        ).fetchall()
        out = {int(code): [round(minx, 4), round(miny, 4), round(maxx, 4), round(maxy, 4)]
               for code, minx, miny, maxx, maxy in rows}
        print(f'  state_bounds: {len(out)} states')
        return out
    except Exception as e:
        print(f'  state_bounds: failed — {e}')
        return {}


def build_extracts():
    """Scan data/extracts/ and produce a manifest keyed by singular level name
    so the viewer can look up URLs by (layer.level, state_code, format) and
    skip DuckDB entirely when a pre-baked file exists."""
    EXT = ROOT / 'data' / 'extracts'
    if not EXT.exists():
        return {}
    # Reverse map: directory uses plural ("districts"), catalog uses singular ("district").
    plural_to_singular = {v['plural']: k for k, v in LEVELS.items()}
    out: dict = {}
    for level_dir in sorted(EXT.iterdir()):
        if not level_dir.is_dir():
            continue
        plural = level_dir.name
        singular = plural_to_singular.get(plural, plural)
        out[singular] = {}
        for state_dir in sorted(level_dir.iterdir()):
            if not state_dir.is_dir():
                continue
            try:
                code = int(state_dir.name)
            except ValueError:
                continue
            files = {}
            for f in sorted(state_dir.iterdir()):
                if not f.is_file():
                    continue
                fmt = f.suffix.lstrip('.').lower()
                if fmt not in ('parquet', 'geojson', 'kml'):
                    continue
                files[fmt] = {
                    'url': f'{R2}/extracts/{plural}/{state_dir.name}/{f.name}',
                    'bytes': f.stat().st_size,
                }
            if files:
                out[singular][code] = files
        if not out[singular]:
            del out[singular]
    total = sum(len(s) * 3 for s in out.values())
    print(f'  extracts: {sum(len(s) for s in out.values())} states across {len(out)} levels ({total} files indexed)')
    return out


def build_state_counts():
    """Pre-compute (layer_id, state_code) -> row_count for every LGD parquet that
    carries a state code. Avoids a slow COUNT(*) over HTTP in the browser — the
    villages parquet alone is 452 MB and would require a full scan otherwise."""
    import duckdb
    layer_files = {
        'lgd_states':       (SRC / 'LGD_States.parquet',       'State_LGD'),
        'lgd_districts':    (SRC / 'LGD_Districts.parquet',    'state_lgd'),
        'lgd_subdistricts': (SRC / 'LGD_Subdistricts.parquet', 'state_lgd'),
        'lgd_blocks':       (SRC / 'LGD_Blocks.parquet',       'state_lgd'),
        'lgd_villages':     (SRC / 'LGD_Villages.parquet',     'state_lgd'),
    }
    con = duckdb.connect()
    out = {}
    for layer_id, (src, col) in layer_files.items():
        if not src.exists():
            continue
        try:
            rows = con.execute(
                f"SELECT CAST({col} AS INTEGER) AS code, COUNT(*) AS n "
                f"FROM '{src}' WHERE {col} IS NOT NULL GROUP BY 1"
            ).fetchall()
            out[layer_id] = {int(code): int(n) for code, n in rows}
            print(f'  state_counts[{layer_id}]: {len(out[layer_id])} states, {sum(out[layer_id].values()):,} total rows')
        except Exception as e:
            print(f'  state_counts[{layer_id}]: failed — {e}')
    return out


def build():
    layers = []

    for id_, level, source, parquet, pmtiles, rows, licence, notes in LAYERS:
        parquet_path = SRC / parquet
        pmtiles_path = SRC / pmtiles if pmtiles else None
        # Approximation: file mtime of our local copy. Reflects when we last
        # ran scripts/fetch.sh against upstream — not the upstream publish date.
        fetched_at = mtime_of(parquet_path) or (mtime_of(pmtiles_path) if pmtiles_path else None)
        plural = LEVELS[level]['plural']
        layers.append({
            'id': id_,
            'level': level,
            'source': source,
            'rows': rows,
            'parquet': {
                'url': f'{R2}/admin/{plural}/{parquet}',
                'upstream_url': f'{UPSTREAM_BASE}/admin/{plural}/{parquet}',
                'bytes': size_of(parquet_path),
            },
            'pmtiles': {
                'url': f'{R2}/admin/{plural}/{pmtiles}',
                'upstream_url': f'{UPSTREAM_BASE}/admin/{plural}/{pmtiles}',
                'bytes': size_of(pmtiles_path),
            } if pmtiles_path else None,
            'licence': licence,
            'attribution': {
                'primary': ATTR[source],
                'publisher': PUBLISHER,
            },
            'category': 'administrative',
            'provenance': 'curated',
            'fetched_at': fetched_at,
            'notes': notes,
        })

    for id_, level, name, rows, notes in GEOBOUNDARIES:
        path = GB / name
        # geoBoundaries upstream uses ADM<N> level names: IND_ADM1.geojson etc.
        adm = name.replace('IND_', '').replace('.geojson', '').lower()
        layers.append({
            'id': id_,
            'level': level,
            'source': 'geoBoundaries',
            'rows': rows,
            'geojson': {
                'url': f'{R2}/geoboundaries/{name}',
                'upstream_url': f'{UPSTREAM_GEOBOUNDARIES}/releaseData/gbOpen/IND/{adm.upper()}/geoBoundaries-IND-{adm.upper()}.geojson',
                'bytes': size_of(path),
            },
            'parquet': None,
            'pmtiles': None,
            'licence': LIC_GB,
            'attribution': {
                'primary': ATTR['geoBoundaries'],
                'publisher': None,
            },
            'category': 'administrative',
            'provenance': 'curated',
            'fetched_at': mtime_of(path),
            'notes': notes,
        })

    # per-state geojson extracts under data/boundaries/<level>/lgd_<level>_<state>.geojson
    state_extracts = []
    for level_dir in sorted(DATA.glob('*')):
        if not level_dir.is_dir():
            continue
        plural_to_singular = {v['plural']: k for k, v in LEVELS.items()}
        for gj in sorted(level_dir.glob('*.geojson')):
            stem = gj.stem
            parts = stem.split('_')
            state = parts[-1]
            state_extracts.append({
                'state': state,
                'level': plural_to_singular.get(level_dir.name, level_dir.name),
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
        'categories': CATEGORIES,
        'states': build_state_list(),
        'state_counts': build_state_counts(),
        'state_bounds': build_state_bounds(),
        'extracts': build_extracts(),
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
