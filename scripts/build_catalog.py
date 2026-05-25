"""
Generate catalog.json from local files. Single source of truth for the viewer.

Run after scripts/fetch.sh + scripts/extract_per_state.py.
"""
import json, os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'sources' / 'india-geodata'
GB = ROOT / 'sources' / 'geoboundaries'
DATA = ROOT / 'data' / 'boundaries'
# Whole-layer baked downloads (geojson / kml / shp.zip). Produced by
# scripts/bake_whole_layer.py. URLs are wired into each layer only when
# the corresponding file actually exists on disk — so this script is a
# safe no-op until the bake has run.
BAKED = ROOT / 'data' / 'baked'

# Public base URL of the R2 bucket
R2 = 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev'

# Level metadata. `path` is the R2 key prefix (also the upstream release path).
# `category` is the catalog facet (matches the home-page filter chips).
LEVELS = {
    'state':                  {'order': 1,  'plural': 'states',                                 'path': 'admin/states',          'category': 'administrative'},
    'district':               {'order': 2,  'plural': 'districts',                              'path': 'admin/districts',       'category': 'administrative'},
    'subdistrict':            {'order': 3,  'plural': 'subdistricts',                           'path': 'admin/subdistricts',    'category': 'administrative'},
    'block':                  {'order': 4,  'plural': 'blocks',                                 'path': 'admin/blocks',          'category': 'administrative'},
    'panchayat':              {'order': 5,  'plural': 'panchayats',                             'path': 'admin/panchayats',      'category': 'administrative'},
    'village':                {'order': 6,  'plural': 'villages',                               'path': 'admin/villages',        'category': 'administrative'},

    # Electoral
    'parliament_constituency':{'order': 10, 'plural': 'parliament constituencies',              'path': 'electoral/constituencies', 'category': 'people'},
    'assembly_constituency':  {'order': 11, 'plural': 'assembly constituencies',                'path': 'electoral/constituencies', 'category': 'people'},

    # Postal
    'pincode':                {'order': 20, 'plural': 'pin codes',                              'path': 'postal/boundaries',     'category': 'infrastructure'},

    # Environment
    'wildlife':               {'order': 30, 'plural': 'wildlife sanctuaries + national parks',  'path': 'environment/forests',         'category': 'environment'},
    'eco_zone':               {'order': 31, 'plural': 'eco-sensitive zones',                    'path': 'environment/forests',         'category': 'environment'},
    'forest':                 {'order': 32, 'plural': 'forest boundaries',                      'path': 'environment/forests',         'category': 'environment'},
    'ramsar':                 {'order': 33, 'plural': 'ramsar wetlands',                        'path': 'water/wetlands',              'category': 'environment'},
    'wetland':                {'order': 34, 'plural': 'wetland boundaries',                    'path': 'water/wetlands',              'category': 'environment'},
    'river_basin':            {'order': 35, 'plural': 'river basins',                           'path': 'water/hydro-boundaries',      'category': 'environment'},
    'river_subbasin':         {'order': 36, 'plural': 'river sub-basins',                       'path': 'water/hydro-boundaries',      'category': 'environment'},
    'river':                  {'order': 37, 'plural': 'rivers + streams',                       'path': 'water/rivers',                'category': 'environment'},
    'flood_event':            {'order': 38, 'plural': 'historical flood polygons',              'path': 'environment/flood-inventory', 'category': 'environment'},

    # Reference layers — base assets used across the platform AND useful
    # standalone (national outline, etc.).
    'country':                {'order': 0,  'plural': 'national boundary',                      'path': 'reference',             'category': 'administrative'},
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
    'data.gov.in':   {'name': 'Open Government Data (India)','url': 'https://data.gov.in/'},
    'GatiShakti':    {'name': 'PM GatiShakti',               'url': 'https://gis.pmgatishakti.gov.in/'},
    'Bharatmaps':    {'name': 'Bharatmaps (NIC)',            'url': 'https://bharatmaps.gov.in/'},
    'OpenCity':      {'name': 'OpenCity / Oorvani Foundation', 'url': 'https://data.opencity.in/'},
    'bharatviz':     {'name': 'bharatviz (Saket Choudhary)',  'url': 'https://bharatviz.org/'},
    'osm-in':        {'name': 'osm-in (community)',           'url': 'https://github.com/osm-in/mapbox-gl-styles'},
    'CWC':           {'name': 'Central Water Commission (WRIS)', 'url': 'https://cwc.gov.in/en/water-resources-information-system-wris'},
    'IndiaFloodInventory': {'name': 'India Flood Inventory v3', 'url': 'https://github.com/yashveeeeeeer/india-geodata/releases/tag/environment/flood-inventory'},
}
PUBLISHER = {
    'name': 'yashveeeeeeer/india-geodata',
    'url': 'https://github.com/yashveeeeeeer/india-geodata',
}

# Sources whose files are republished via the yashveeeeeeer/india-geodata
# release archive (so PUBLISHER + UPSTREAM_BASE apply). Other curated sources
# (bharatviz, etc.) are pulled direct from origin — their entries should not
# carry the yashveer attribution or upstream_url.
YASHVEER_HOSTED = {'LGD', 'SOI', 'Bhuvan', 'PMGSY', 'GatiShakti', 'Bharatmaps', 'CWC', 'IndiaFloodInventory', 'data.gov.in'}

# Where to re-fetch each upstream file from. Path under the release base URL.
# Kept here so the source registry travels with the catalog and a single
# `scripts/refresh.sh` can drive re-pulls without grepping shell scripts.
UPSTREAM_BASE = 'https://github.com/yashveeeeeeer/india-geodata/releases/download'
UPSTREAM_GEOBOUNDARIES = 'https://github.com/wmgeolab/geoBoundaries/raw/9469f09'  # pinned commit

# Categories drive the home-page filter chips and the /submit dropdown.
# Order here is the order the chips render in. Keep in sync with
# web/submit.template.html and the /about page copy.
CATEGORIES = {
    'administrative': 'Administrative',
    'people': 'People & places',
    'environment': 'Environment',
    'agriculture': 'Agriculture & land use',
    'transport': 'Transport & mobility',
    'infrastructure': 'Infrastructure & utilities',
    'culture': 'Culture & heritage',
    'health-edu': 'Health & education',
    'other': 'Other',
}

# (id, level, source, parquet, pmtiles, rows, licence, notes)
LAYERS = [
    ('lgd_states',         'state',       'LGD',    'LGD_States.parquet',         'LGD_States.pmtiles',         36,      LIC_STATE_DIST, 'Authoritative state and Union Territory boundaries from India\'s Local Government Directory (LGD). 36 polygons with the full LGD code chain, enabling joins with district, subdistrict, block and village layers.'),
    ('soi_states',         'state',       'SOI',    'SOI_States.parquet',         'SOI_States.pmtiles',          40,      LIC_STATE_DIST, 'Survey of India derivative.'),
    ('bhuvan_states',      'state',       'Bhuvan', 'bhuvan_states.parquet',      'bhuvan_states.pmtiles',       37,      LIC_STATE_DIST, 'NRSC/ISRO Bhuvan. Own codes, not LGD.'),

    ('lgd_districts',      'district',    'LGD',    'LGD_Districts.parquet',      'LGD_Districts.pmtiles',      785,     LIC_STATE_DIST, 'Every district in India from the Local Government Directory (LGD). 785 polygons; joins to state boundaries via the state_lgd code, with the full LGD chain for joining to subdistricts, blocks and villages.'),
    ('soi_districts',      'district',    'SOI',    'SOI_Districts.parquet',      'SOI_Districts.pmtiles',       742,     LIC_STATE_DIST, 'SoI derivative. Partial LGD codes.'),
    ('bhuvan_districts',   'district',    'Bhuvan', 'bhuvan_districts.parquet',   'bhuvan_districts.pmtiles',    663,     LIC_STATE_DIST, 'Bhuvan. Under-counts vs LGD in some states.'),

    ('lgd_subdistricts',   'subdistrict', 'LGD',    'LGD_Subdistricts.parquet',   'LGD_Subdistricts.pmtiles',   6471,    LIC_BELOW,      'All subdistricts (tehsil / taluk / mandal) in India from the Local Government Directory (LGD). 6,471 polygons with the full LGD code chain for joining to districts, states, and finer admin levels (blocks, villages).'),
    ('soi_subdistricts',   'subdistrict', 'SOI',    'SOI_Subdistricts.parquet',   'SOI_Subdistricts.pmtiles',    4723,    LIC_BELOW,      'SoI tehsils. Partial codes.'),

    ('lgd_blocks',         'block',       'LGD',    'LGD_Blocks.parquet',         'LGD_Blocks.pmtiles',         7146,    LIC_BELOW,      'Community-development blocks across India from the Local Government Directory (LGD). 7,146 polygons with the full LGD code chain joining to subdistricts, districts and states.'),
    ('bhuvan_blocks',      'block',       'Bhuvan', 'bhuvan_blocks.parquet',      'bhuvan_blocks.pmtiles',       6393,    LIC_BELOW,      'Bhuvan. Predates recent re-divisions in several states.'),
    ('pmgsy_blocks',       'block',       'PMGSY',  'PMGSY_Blocks.parquet',       'PMGSY_Blocks.pmtiles',        6637,    LIC_BELOW,      'PMGSY rural roads blocks. Block + district + state names joined from PMGSY_Masterdata (99% coverage).'),

    ('lgd_panchayats',     'panchayat',   'LGD',    'LGD_panchayats.parquet',     'LGD_Panchayats.pmtiles',     319287,  LIC_BELOW,      'Authoritative. 319k gram-panchayat polygons. Use vector tiles to render at zoom.'),

    ('lgd_villages',       'village',     'LGD',    'LGD_Villages.parquet',       'LGD_Villages.pmtiles',       584615,  LIC_BELOW,      'Authoritative. 584k polygons. Use vector tiles to render.'),
    ('soi_village_points', 'village',     'SOI',    'SOI_VILLAGE_POINT.parquet',  'SOI_VILLAGE_POINT.pmtiles',   576430,  LIC_BELOW,      'SoI village centroids (point geometry). 5.76 lakh point features. Coverage is dense in southern + western states and sparse in UP, Bihar, Jharkhand and several NE states (SoI source limitation, not a rendering issue).'),

    # Electoral
    ('lgd_parliament',     'parliament_constituency', 'LGD', 'LGD_Parliament_Constituencies.parquet', 'LGD_Parliament_Constituencies.pmtiles', 543,  LIC_BELOW, 'Lok Sabha constituencies — 543 polygons covering the entire country. Latest delimitation.'),
    ('lgd_assembly',       'assembly_constituency',   'LGD', 'LGD_Assembly_Constituencies.parquet',   'LGD_Assembly_Constituencies.pmtiles',   4177, LIC_BELOW, 'State legislative assembly constituencies. Polygons keyed by ST_CODE.'),

    # Postal
    ('bharatviz_pincodes', 'pincode',     'bharatviz', 'bharatviz_pincodes.parquet', 'bharatviz_pincodes.pmtiles',  63864,   'MIT',          'India Post pincode boundary polygons (simplified). 63,864 polygons. © 2025 Saket Choudhary, MIT-licensed via bharatviz.org. Source: bharatviz.org/India_pincodes_simplified.geojson; code repo github.com/saketlab/bharatviz.'),
    ('datagov_pincodes',   'pincode',     'data.gov.in', 'Datagov_Pincode_Boundaries.parquet', 'Datagov_Pincode_Boundaries.pmtiles', 19312, 'GODL-India', "India Post delivery post office pincode boundaries from data.gov.in (May 2025). 19,312 polygons covering delivery PO service areas. Compare with bharatviz's 63,864 finer polygons. Neither is officially surveyed; both are Voronoi approximations from post office point locations."),

    # Environment
    ('gs_wildlife',        'wildlife',    'GatiShakti', 'GatiShakti_Wildlife_Sanctuaries_and_National_Parks.parquet', 'GatiShakti_Wildlife_Sanctuaries_and_National_Parks.pmtiles', 665, LIC_BELOW, 'Wildlife sanctuaries + national parks. Source via PM GatiShakti GIS portal.'),
    ('bm_eco_zones',       'eco_zone',    'Bharatmaps', 'Bharatmaps_Parivesh_Eco_Sensitive_Zones.parquet',           'Bharatmaps_Parivesh_Eco_Sensitive_Zones.pmtiles',           249, LIC_BELOW, 'Eco-sensitive zone boundaries from MoEFCC Parivesh. Sourced via Bharatmaps.'),

    # Environment + water (added 2026-05): Ramsar sites, full wetland inventory,
    # river basins, sub-basins, river network, SOI forests. All yashveer-hosted
    # under CC0; same fetch/upload/bake pipeline as the curated admin layers.
    ('soi_forests',        'forest',         'SOI',        'SOI_Forests.parquet',                                'SOI_Forests.pmtiles',                                57963,  LIC_BELOW, 'Forest boundary polygons from Survey of India topographic maps. Includes reserved + protected + unclassed forests.'),
    ('bp_ramsar',          'ramsar',         'Bharatmaps', 'Bharatmaps_Parivesh_Ramsar_Wetlands.parquet',        'Bharatmaps_Parivesh_Ramsar_Wetlands.pmtiles',        99,     LIC_BELOW, "India's Ramsar Convention wetland sites of international importance, sourced via Bharatmaps Parivesh."),
    ('bp_wetlands',        'wetland',        'Bharatmaps', 'Bharatmaps_Parivesh_Wetland_Boundaries.parquet',     'Bharatmaps_Parivesh_Wetland_Boundaries.pmtiles',     207483, LIC_BELOW, 'All wetland boundary polygons notified under MoEFCC Wetland Rules 2017. Sourced via Bharatmaps Parivesh.'),
    ('wris_basin',         'river_basin',    'CWC',        'WRIS_Basin.parquet',                                 'WRIS_Basin.pmtiles',                                 25,     LIC_BELOW, "India's major river basin polygons from the Central Water Commission Water Resources Information System (WRIS)."),
    ('wris_subbasin',      'river_subbasin', 'CWC',        'WRIS_SubBasin.parquet',                              'WRIS_SubBasin.pmtiles',                              99,     LIC_BELOW, 'River sub-basin polygons (one tier under basins) from CWC WRIS.'),
    ('wris_rivers',        'river',          'CWC',        'WRIS_Rivers.parquet',                                'WRIS_Rivers.pmtiles',                                30546,  LIC_BELOW, "India's river network from CWC WRIS — line geometry for streams and rivers."),
]


# ──────────────────────────────────────────────────────────────────────────
# Externally-ingested layers (scripts/ingest_external.py). Each ingest run
# updates scripts/external-ingested.json; we merge those entries into
# LEVELS + LAYERS + a level-meta dict that prerender.mjs consumes for
# label/unit/description rendering. Future ingestions need zero edits here.
# ──────────────────────────────────────────────────────────────────────────
EXTERNAL_MANIFEST = ROOT / 'scripts' / 'external-ingested.json'
EXTERNAL_LEVEL_META: dict[str, dict] = {}  # level_id -> {label, unit, description, source_url, source_org}
EXTERNAL_BYTES: dict[str, dict[str, int | None]] = {}  # layer_id -> {'parquet': bytes, 'pmtiles': bytes}

if EXTERNAL_MANIFEST.exists():
    _external = json.loads(EXTERNAL_MANIFEST.read_text())
    # Stable order: respect the manifest insertion order; assign numeric
    # `order` from a fixed base so external layers fall after the hardcoded
    # ones in LEVEL_ORDER iteration.
    for idx, x in enumerate(_external, start=100):
        lvl = x['level']
        if lvl in LEVELS:
            # External level id collides with a hardcoded one — keep the
            # hardcoded definition, let LAYERS pick this up as a duplicate
            # source for the same level.
            pass
        else:
            LEVELS[lvl] = {
                'order': idx,
                'plural': x['id'].replace('_', ' '),
                'path': x['r2_prefix'],
                'category': x['category'],
            }
        # Prerender consumes this metadata for the visible card.
        # `name` is the friendly display label from the ingest config;
        # fall back to title-cased id if older manifests lack it.
        EXTERNAL_LEVEL_META[lvl] = {
            'label': x.get('name') or x['id'].replace('_', ' ').title(),
            'unit': x.get('unit') or 'features',
            'description': x['description'],
            'source_url': x['source_url'],
            'source_org': x['source_org'],
            'notes': x.get('notes', ''),
        }
        LAYERS.append((
            x['id'], x['level'], x['source'],
            x['parquet_file'], x['pmtiles_file'],
            x['features'], LIC_BELOW if x['license'] == 'CC0-1.0' else x['license'],
            x['description'],
        ))
        # Local source files live in /tmp/ingest, not SRC, so size_of() can't
        # find them. Cache the manifest-recorded bytes for the build() loop.
        EXTERNAL_BYTES[x['id']] = {
            'parquet': x.get('parquet_bytes'),
            'pmtiles': x.get('pmtiles_bytes'),
        }

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


# Whole-layer baked download formats. Catalog only advertises a format
# when the file actually exists in BAKED — keeps the catalog honest if
# bake_whole_layer.py hasn't run yet or gated a layer above the size cap.
_BAKED_FORMATS = (
    ('geojson',   '.geojson',  'application/geo+json'),
    ('kml',       '.kml',      'application/vnd.google-earth.kml+xml'),
    ('shapefile', '.shp.zip',  'application/zip'),
)


def baked_downloads(r2_prefix: str, basename: str) -> dict:
    """Return {fmt: {url, bytes}} for each baked file that exists. Empty
    dict if none have been baked yet."""
    out = {}
    for fmt, ext, _mime in _BAKED_FORMATS:
        p = BAKED / r2_prefix / f'{basename}{ext}'
        if p.exists() and p.stat().st_size > 0:
            out[fmt] = {
                'url': f'{R2}/{r2_prefix}/{basename}{ext}',
                'bytes': p.stat().st_size,
            }
    return out


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


def fetch_download_counts():
    """Read download_counts from the live D1 via wrangler. Failures (offline,
    unauthenticated build env) silently return an empty list — the home
    page just renders without count badges."""
    import json as _json
    import subprocess
    web_root = ROOT / 'web'
    if not (web_root / 'wrangler.toml').exists():
        return {}
    import shutil
    # Prefer a PATH-resolved wrangler (mise / homebrew) over npx, which
    # has hit a workerd arch mismatch on this machine's npx cache.
    wrangler_bin = shutil.which('wrangler') or 'npx'
    wrangler_cmd = ([wrangler_bin] if wrangler_bin != 'npx'
                    else ['npx', '--yes', 'wrangler@latest'])
    try:
        out = subprocess.run(
            [*wrangler_cmd, 'd1', 'execute',
             'geodata-submissions', '--remote',
             '--command', 'SELECT layer_id, state_code, format, count FROM download_counts',
             '--json'],
            cwd=str(web_root),
            capture_output=True, text=True, timeout=30,
        )
    except Exception as e:
        print(f'  download_counts: skipped — {e}')
        return {}
    if out.returncode != 0:
        # Don't error the build — counts are nice-to-have.
        return {}
    try:
        # wrangler --json wraps the result in [{ results: [...] }, ...]
        parsed = _json.loads(out.stdout)
        rows = parsed[0]['results'] if isinstance(parsed, list) else parsed.get('results', [])
    except Exception:
        return {}
    counts = {}
    for r in rows:
        layer = r.get('layer_id')
        state = r.get('state_code') or ''
        fmt = r.get('format')
        n = int(r.get('count') or 0)
        if not (layer and fmt):
            continue
        counts.setdefault(layer, {}).setdefault(state, {})[fmt] = n
    total = sum(sum(s.values()) for layer in counts.values() for s in layer.values())
    print(f'  download_counts: {len(rows)} rows, {total:,} total')
    return counts


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
        level_meta = LEVELS[level]
        path = level_meta['path']
        baked = baked_downloads(path, parquet_path.stem)
        layers.append({
            'id': id_,
            'level': level,
            'source': source,
            'rows': rows,
            'parquet': {
                'url': f'{R2}/{path}/{parquet}',
                'upstream_url': f'{UPSTREAM_BASE}/{path}/{parquet}',
                'bytes': size_of(parquet_path) or EXTERNAL_BYTES.get(id_, {}).get('parquet'),
            },
            'pmtiles': {
                'url': f'{R2}/{path}/{pmtiles}',
                'upstream_url': f'{UPSTREAM_BASE}/{path}/{pmtiles}',
                'bytes': size_of(pmtiles_path) or EXTERNAL_BYTES.get(id_, {}).get('pmtiles'),
            } if pmtiles_path else None,
            # Whole-layer baked downloads. Each is None when not baked
            # (size-cap gated, or bake hasn't run). Frontend only renders
            # buttons for non-null formats.
            'geojson': baked.get('geojson'),
            'kml': baked.get('kml'),
            'shapefile': baked.get('shapefile'),
            'licence': licence,
            'attribution': {
                'primary': ATTR[source],
                'publisher': PUBLISHER if source in YASHVEER_HOSTED else None,
            },
            'category': level_meta.get('category', 'administrative'),
            'provenance': 'curated',
            'fetched_at': fetched_at,
            'notes': notes,
        })

    # India national boundary (osm-in). The same India-correct line that
    # the Bharatlas Minimal basemap renders, exposed as a downloadable
    # layer so QGIS users get a clean outline.
    ib_path = 'reference'
    ib_basename = 'india_boundary'
    ib_baked = baked_downloads(ib_path, ib_basename)
    if ib_baked.get('geojson'):
        layers.append({
            'id': 'india_boundary',
            'level': 'country',
            'source': 'LGD',
            'rows': 1,
            'parquet': None,
            'pmtiles': None,
            'geojson': ib_baked.get('geojson'),
            'kml': ib_baked.get('kml'),
            'shapefile': ib_baked.get('shapefile'),
            'licence': LIC_STATE_DIST,
            'attribution': {
                'primary': ATTR['LGD'],
                'publisher': None,
            },
            'category': 'administrative',
            'provenance': 'curated',
            'fetched_at': mtime_of(BAKED / ib_path / f'{ib_basename}.geojson'),
            'notes': "India's national boundary as a single MultiPolygon, derived by dissolving the 36 LGD state + UT polygons. India-correct by construction (LGD is India's authoritative admin source — includes Aksai Chin via J&K/Ladakh and the full Arunachal Pradesh claim).",
        })

    # India Flood Inventory v3 — single geojson upstream (CC-BY-4.0). 1,006
    # historical flood event polygons 1960s–2020. No parquet/pmtiles upstream;
    # ships as geojson-only (the in-viewer DuckDB path can still load it).
    flood_name = 'INDIA_FLOOD_INVENTORY_V3.geojson'
    flood_local = SRC / flood_name
    if flood_local.exists():
        layers.append({
            'id': 'india_flood_inventory',
            'level': 'flood_event',
            'source': 'IndiaFloodInventory',
            'rows': 1006,
            'parquet': None,
            'pmtiles': None,
            'geojson': {
                'url': f'{R2}/environment/flood-inventory/{flood_name}',
                'upstream_url': f'{UPSTREAM_BASE}/environment/flood-inventory/{flood_name}',
                'bytes': size_of(flood_local),
            },
            'kml': None,
            'shapefile': None,
            'licence': 'CC-BY-4.0',
            'attribution': {
                'primary': ATTR['IndiaFloodInventory'],
                'publisher': PUBLISHER,
            },
            'category': 'environment',
            'provenance': 'curated',
            'fetched_at': mtime_of(flood_local),
            'notes': '1,006 historical flood event polygons across India, 1960s–2020. Compiled for hydrological modelling research; useful as a climate-adaptation reference layer.',
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

    # v4.2 commit 3: bake per-column filter stats for layers whose parquet
    # lives locally. External (R2-only) layers fall back to the browser's
    # live `describeParquet` probe in commit 4.
    from build_filter_stats import build_all as build_filter_stats_all
    fs_inputs: list[tuple[str, Path]] = []
    for l in layers:
        if l.get('parquet') and l['parquet'].get('url'):
            local = SRC / Path(l['parquet']['url']).name
            if local.exists():
                fs_inputs.append((l['id'], local))
    filter_stats = build_filter_stats_all(fs_inputs) if fs_inputs else {}

    catalog = {
        'version': 1,
        'generated': None,
        'country': 'IN',
        'r2_base': R2,
        'levels': LEVELS,
        'level_meta': EXTERNAL_LEVEL_META,  # prerender.mjs fallback for ingested levels
        'level_order': sorted(LEVELS.keys(), key=lambda k: LEVELS[k]['order']),
        'layers': layers,
        'state_extracts': state_extracts,
        'categories': CATEGORIES,
        'states': build_state_list(),
        'state_counts': build_state_counts(),
        'state_bounds': build_state_bounds(),
        'extracts': build_extracts(),
        'filter_stats': filter_stats,
        'download_counts': fetch_download_counts(),
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
