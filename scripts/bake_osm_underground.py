#!/usr/bin/env python3
"""
Below ground, from OpenStreetMap: three layers from a dated Geofabrik India
extract (ODbL 1.0, © OpenStreetMap contributors).

  osm_tunnels                ways tagged tunnel=yes or tunnel=flooded (roads,
                             railways and metro, canals and streams); culverts,
                             building passages and covered drains are left out
  osm_underground_utilities  pipelines mapped location=underground or
                             underwater, power cables (power=cable, a buried or
                             submarine cable, unless mapped above ground) and
                             power lines mapped location=underground
  osm_mines_caves            mine shafts and adits (man_made=mineshaft, adit),
                             old mines (historic=mine, mine_shaft, mine_adit),
                             cave entrances and sinkholes; one point each, a
                             feature drawn as an area at its centre

Every OSM tag of a feature is kept as published: a key carried by at least
MIN_SHARE of a layer's rows is its own column (most used first), every other
tag goes into other_tags (a JSON object). The extract carries no mapper data
(user names, uids, changesets, versions), so none reaches the layers.

Surveyed and left out (extract of 2026-11-19): water wells (man_made=water_well,
about 166,000, nearly all open wells traced from imagery in Maharashtra with no
other tag: one mapping effort, not a picture of India's wells), and culverts
(about 49,000 tunnel=culvert drains under roads).

Steps (each cached under WORK and written atomically, so a killed run redoes
only the step it was in; a second run with the same inputs does nothing):
  pull      the extract india-latest points at, md5-checked (once; --refresh
            fetches the current one)
  extract   the candidate features and the nodes of their ways, two passes
            (cache/, backed up on R2 every 10 minutes and on exit)
  bake      each layer's parquet (flat bbox, Hilbert order), GeoJSON, KML,
            Shapefile and map tiles (popup fields only)
  upload    to content-versioned keys, skipping files R2 already holds (md5)
  register  patch catalog.json and scripts/external-ingested.json in place

Run (R2 credentials in the env for the cache backup and the upload):
    python3 -u scripts/bake_osm_underground.py all --minutes 60   # pull, extract, bake
    python3 -u scripts/bake_osm_underground.py upload
    python3 -u scripts/bake_osm_underground.py register
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from collections.abc import Callable
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import pipeline  # noqa: E402
from bake_transit import WAY_GEOM_SQL, dated_extract_url, get_text, head_location, osm_date  # noqa: E402
from pipeline import OutOfTime, cached, log, work_dir  # noqa: E402
from populate_source_check import GEOFABRIK_INDIA  # noqa: E402

ROOT = HERE.parent
CATALOG = ROOT / 'catalog.json'
MANIFEST = HERE / 'external-ingested.json'
WORK = work_dir('osm_underground', 'OSM_UNDERGROUND_WORK')
CACHE_PREFIX = 'bake_osm_underground'
R2_PREFIX = 'below-ground/osm'
EXT = {'parquet': 'parquet', 'pmtiles': 'pmtiles', 'geojson': 'geojson', 'kml': 'kml', 'shapefile': 'shp.zip'}
MIN_SHARE = 0.01            # a tag key on at least 1% of a layer's rows is its own column
OSM_LICENCE = 'ODbL-1.0'
OSM_ATTRIBUTION = {'name': '© OpenStreetMap contributors', 'url': 'https://www.openstreetmap.org/copyright'}
PUBLISHER = {'name': 'bharatlas', 'url': 'https://bharatlas.com'}
RESERVED = ('osm_type', 'osm_id', 'other_tags', 'as_of', 'geometry', 'xmin', 'ymin', 'xmax', 'ymax')

# ── which features ──────────────────────────────────────────────────────────

TUNNELS = ('yes', 'flooded')
BURIED = ('underground', 'underwater', 'partially_underground')
ABOVE = ('overground', 'overhead', 'surface', 'outdoor', 'bridge', 'indoor')
MINES_CAVES = {'man_made': ('mineshaft', 'adit'), 'historic': ('mine', 'mine_shaft', 'mine_adit'),
               'natural': ('cave_entrance', 'sinkhole')}


def layer_of(kind: str, tags: dict) -> str | None:
    """The layer a feature belongs to (at most one: a tunnel first), or None."""
    if kind == 'way' and tags.get('tunnel') in TUNNELS:
        return 'osm_tunnels'
    if kind == 'way':
        loc = tags.get('location')
        if tags.get('man_made') == 'pipeline' and loc in BURIED:
            return 'osm_underground_utilities'
        if tags.get('power') == 'cable' and loc not in ABOVE:
            return 'osm_underground_utilities'
        if tags.get('power') in ('line', 'minor_line') and loc in BURIED:
            return 'osm_underground_utilities'
    if any(tags.get(k) in v for k, v in MINES_CAVES.items()):
        return 'osm_mines_caves'
    return None


def _in(key: str, values) -> str:
    return f"tags['{key}'] IN ({', '.join(repr(v) for v in values)})"


# A superset of layer_of, so the extract keeps only what a layer can use.
FEATURE_SQL = ' OR '.join([_in('tunnel', TUNNELS), "tags['man_made'] = 'pipeline'",
                           _in('power', ('cable', 'line', 'minor_line')) + " AND tags['location'] IS NOT NULL",
                           "tags['power'] = 'cable'", *(_in(k, v) for k, v in MINES_CAVES.items())])


# ── tags ────────────────────────────────────────────────────────────────────

def tag_columns(all_tags: list[dict], min_share: float = MIN_SHARE) -> list[str]:
    """Keys carried by at least `min_share` of the rows, most used first (then
    by name). A key named like one of the layer's own columns, or differing
    from a chosen key only in case, stays in other_tags."""
    counts = Counter(k for tags in all_tags for k in tags)
    need = min_share * len(all_tags)
    out, seen = [], {c.lower() for c in RESERVED}
    for key, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])):
        if n >= need and key.lower() not in seen:
            out.append(key)
            seen.add(key.lower())
    return out


def row_of(feature: dict, columns: list[str]) -> dict:
    """osm_type, osm_id, the tag columns (null when absent) and other_tags:
    every other tag as a JSON object, or null when there is none."""
    tags = feature['tags']
    rest = {k: v for k, v in tags.items() if k not in columns}
    return {'osm_type': feature['type'], 'osm_id': feature['id'], **{c: tags.get(c) for c in columns},
            'other_tags': json.dumps(rest, ensure_ascii=False, sort_keys=True) if rest else None}


# ── pull ────────────────────────────────────────────────────────────────────

def sources_path(work: Path) -> Path:
    return work / 'cache' / 'sources.json'


def pull(work: Path, extract_url: Callable[[], str], download: Callable[[str, Path], None],
         md5_text: Callable[[str], str], now: str | None = None, refresh: bool = False) -> dict:
    """The dated extract, downloaded once to raw/ (re-downloadable by its name,
    so not backed up) and checked against Geofabrik's md5. The record in
    cache/sources.json stands until --refresh."""
    path = sources_path(work)
    if path.exists() and not refresh:
        return json.loads(path.read_text())
    url = extract_url()
    name = url.rsplit('/', 1)[1]
    dest = work / 'raw' / name
    download(url, dest)
    want, got = md5_text(url + '.md5').split()[0], pipeline.file_md5(dest)
    if got != want:
        dest.unlink()
        raise RuntimeError(f'{name}: md5 {got} is not the published {want}; deleted, re-run to fetch again')
    record = {'url': url, 'file': str(dest), 'md5': got, 'bytes': dest.stat().st_size, 'as_of': osm_date(name),
              'fetched_at': now or pipeline.now_iso()}
    path.parent.mkdir(parents=True, exist_ok=True)
    pipeline.write_json(path, record)
    return record


# ── extract ─────────────────────────────────────────────────────────────────

def osm_dir(work: Path, sources: dict) -> Path:
    return work / 'cache' / 'osm' / sources['as_of']


def extract(work: Path, sources: dict, deadline: pipeline.Deadline) -> Path:
    """Two cached passes over the extract: the nodes and ways FEATURE_SQL
    keeps, then the nodes those ways use."""
    out, con = osm_dir(work, sources), pipeline.make_con()
    con.execute(f"SET temp_directory = '{work / 'duckdb_tmp'}'")
    read = f"ST_ReadOSM('{sources['file']}')"

    def features(part: Path) -> None:
        con.execute(f"""COPY (SELECT kind::VARCHAR AS kind, id, tags, refs, lat, lon FROM {read}
                              WHERE kind IN ('node', 'way') AND ({FEATURE_SQL}))
                        TO '{part}' (FORMAT PARQUET)""")

    def way_nodes(part: Path) -> None:
        con.execute(f"""COPY (SELECT n.id, n.lon, n.lat FROM {read} n
                              WHERE n.kind = 'node' AND n.id IN (
                                  SELECT UNNEST(refs) FROM read_parquet('{out / 'features.parquet'}')
                                  WHERE kind = 'way'))
                        TO '{part}' (FORMAT PARQUET)""")

    for name, build in (('features', features), ('way_nodes', way_nodes)):
        deadline.check(f'extract {name}')
        if not (out / f'{name}.parquet').exists():
            t0 = time.monotonic()
            cached(out / f'{name}.parquet', build)
            log(f'  {name}: {pipeline.parquet_rows(out / f"{name}.parquet"):,} rows in {time.monotonic() - t0:,.0f} s')
    return out


# ── bake ────────────────────────────────────────────────────────────────────

LAYERS = {
    'osm_tunnels': {
        'basename': 'OSM_Tunnels', 'category': 'transport', 'unit': 'tunnels', 'geometry': 'line',
        'label': 'Tunnels (OpenStreetMap)',
        'description': ('Road, rail, metro and canal tunnels mapped in OpenStreetMap, one line per mapped '
                        'stretch, with every tag OpenStreetMap gives them.'),
        'tiles': ('name', 'highway', 'railway', 'waterway', 'tunnel', 'ref', 'layer', 'osm_id'),
        'keep_all': False, 'max_zoom': 14,   # short tunnels and underpasses vanish below z14
        'tags': ['tunnels', 'underground', 'below ground', 'road tunnels', 'rail tunnels', 'metro', 'canal tunnels',
                 'OpenStreetMap', 'transport'],
        'notes': ('A tunnel is a way tagged tunnel=yes, or tunnel=flooded (a canal or stream tunnel full of '
                  'water). Culverts (tunnel=culvert, small drains under a road), passages through buildings and '
                  'covered drains are left out. Many short road tunnels are underpasses beneath a railway or a '
                  'road. A tunnel mapped as two ways (one per direction or per bore) is two rows. Features still '
                  'tagged as under construction or disused keep those tags.'),
    },
    'osm_underground_utilities': {
        'basename': 'OSM_Underground_Utilities', 'category': 'infrastructure', 'unit': 'lines',
        'geometry': 'line', 'label': 'Underground pipelines and cables (OpenStreetMap)',
        'description': ('Pipelines and power cables mapped below ground or under water in OpenStreetMap, with '
                        'what they carry where mapped and every tag OpenStreetMap gives them.'),
        'tiles': ('name', 'man_made', 'power', 'substance', 'location', 'voltage', 'operator', 'osm_id'),
        'keep_all': True, 'max_zoom': 14,
        'tags': ['pipelines', 'power cables', 'underground', 'below ground', 'utilities', 'water pipelines',
                 'gas pipelines', 'OpenStreetMap', 'infrastructure'],
        'notes': ('Pipelines (man_made=pipeline) mapped location=underground or underwater, power cables '
                  '(power=cable, which OpenStreetMap uses for buried and submarine cables) unless mapped above '
                  'ground, and power lines mapped location=underground. About as many pipelines again are mapped '
                  'with no location, and are left out because it is not known where they run.'),
    },
    'osm_mines_caves': {
        'basename': 'OSM_Mines_Caves', 'category': 'environment', 'unit': 'places', 'geometry': 'point',
        'label': 'Mine shafts and caves (OpenStreetMap)',
        'description': ('Mine shafts, adits, old mines, cave entrances and sinkholes mapped in OpenStreetMap, '
                        'one point each, with every tag OpenStreetMap gives them.'),
        'tiles': ('name', 'man_made', 'natural', 'historic', 'resource', 'tourism', 'osm_id'),
        'keep_all': True, 'max_zoom': None,
        'tags': ['mines', 'mine shafts', 'coal mines', 'caves', 'sinkholes', 'underground', 'below ground',
                 'OpenStreetMap', 'environment'],
        'notes': ('Mine shafts and adits (man_made=mineshaft, adit), old mines (historic=mine, mine_shaft, '
                  'mine_adit), cave entrances (natural=cave_entrance) and sinkholes (natural=sinkhole). A '
                  'feature drawn as an area is one point at its centre (osm_type says way). Most mine shafts '
                  'mapped so far are small coal pits in Meghalaya, tagged resource=coal.'),
    },
}
ODBL_NOTE = ('Published under the Open Database License (ODbL 1.0): you may copy, change and share it if you credit '
             '© OpenStreetMap contributors and share changed versions of the data under ODbL. ')
TAGS_NOTE = ('Every OpenStreetMap tag is kept as mapped: a tag used on at least 1% of the rows is its own column, '
             'every other tag is in other_tags (a JSON object). osm_type and osm_id link each row to '
             'openstreetmap.org/<osm_type>/<osm_id>; as_of is the extract date. ')
COVERAGE_NOTE = ('OpenStreetMap is mapped by volunteers, so coverage is incomplete and uneven: a place with no '
                 'feature here may simply not be mapped yet.')


def notes(lid: str) -> str:
    return (ODBL_NOTE + 'From a dated Geofabrik extract of OpenStreetMap. ' + LAYERS[lid]['notes'] + ' '
            + TAGS_NOTE + COVERAGE_NOTE)


def build_table(con, osm: Path, lid: str, as_of: str, out: Path, min_share: float = MIN_SHARE) -> int:
    """One layer's rows (by layer_of) with its tag columns and geometry: a
    node's point; a way's line, or for a point layer the centre of the area
    (or line) it draws. Rows in (osm_type, osm_id) order. Returns the count."""
    con.execute('INSTALL spatial; LOAD spatial;')
    feats = [{'type': kind, 'id': oid, 'tags': dict(zip(keys, values))}
             for kind, oid, keys, values in con.execute(f"""
                 SELECT kind, id, map_keys(tags), map_values(tags) FROM read_parquet('{osm / 'features.parquet'}')
                 ORDER BY kind, id""").fetchall()]
    feats = [f for f in feats if layer_of(f['type'], f['tags']) == lid]
    columns = tag_columns([f['tags'] for f in feats], min_share)
    ndjson = out.with_suffix('.ndjson')
    with ndjson.open('w') as fh:
        for f in feats:
            fh.write(json.dumps(row_of(f, columns), ensure_ascii=False) + '\n')
    con.execute(WAY_GEOM_SQL.format(ways=osm / 'features.parquet', nodes=osm / 'way_nodes.parquet'))
    way = ('g.geom' if LAYERS[lid]['geometry'] == 'line' else
           'ST_Centroid(CASE WHEN ST_IsClosed(g.geom) AND ST_NPoints(g.geom) >= 4 '
           'THEN ST_MakePolygon(g.geom) ELSE g.geom END)')
    spec = ', '.join(f"'{c}': '{'BIGINT' if c == 'osm_id' else 'VARCHAR'}'"
                     for c in ['osm_type', 'osm_id', *columns, 'other_tags'])
    select = ', '.join(f'r."{c}"' for c in ['osm_type', 'osm_id', *columns, 'other_tags'])
    con.execute(f"""COPY (
        SELECT {select}, '{as_of}' AS as_of,
               CASE WHEN r.osm_type = 'node' THEN ST_Point(f.lon, f.lat) ELSE {way} END AS geometry
        FROM read_json('{ndjson}', format = 'newline_delimited', columns = {{{spec}}}) r
        LEFT JOIN read_parquet('{osm / 'features.parquet'}') f ON f.kind = r.osm_type AND f.id = r.osm_id
        LEFT JOIN way_geom g ON r.osm_type = 'way' AND g.id = r.osm_id
        ORDER BY r.osm_type, r.osm_id) TO '{out}' (FORMAT PARQUET)""")
    ndjson.unlink()
    return con.execute(f"SELECT count(*) FROM '{out}'").fetchone()[0]


def out_dir(work: Path) -> Path:
    return work / 'out'


def layer_paths(work: Path, lid: str) -> dict[str, Path]:
    """{format: the local file the bake writes} for one layer."""
    return {fmt: out_dir(work) / name for fmt, name in pipeline.plain_names(LAYERS[lid]['basename'], EXT).items()}


def tile_fields(lid: str, columns: list[str]) -> list[str]:
    return [c for c in LAYERS[lid]['tiles'] if c in columns]


def bake(work: Path, sources: dict, deadline: pipeline.Deadline) -> dict:
    """Every layer's files into out/ and out/summary.json. Nothing happens
    when the last bake used the same extract and every file is still there."""
    import bake_formats
    from bake_extracts import gdal_geojson_available, write_kml_from_geojson
    from bake_whole_layer import write_geojson_whole

    out, summary_path = out_dir(work), out_dir(work) / 'summary.json'
    code = {p.name: pipeline.file_md5(p) for p in (Path(__file__), HERE / 'pipeline.py', HERE / 'bake_formats.py')}
    if summary_path.exists():
        prev = json.loads(summary_path.read_text())
        if prev.get('sources') == sources and prev.get('code') == code and all(
                all(p.exists() for p in layer_paths(work, lid).values())
                and pipeline.versioned_names(layer_paths(work, lid)) == lyr['names']
                for lid, lyr in prev['layers'].items()):
            log('  up to date: same extract and code as the last bake')
            return prev
    out.mkdir(parents=True, exist_ok=True)
    con = pipeline.make_con()
    con.execute(f"SET temp_directory = '{work / 'duckdb_tmp'}'")
    osm = osm_dir(work, sources)
    summary = {'sources': sources, 'code': code, 'layers': {}}
    for lid, meta in LAYERS.items():
        deadline.check(f'bake {lid}')
        path = layer_paths(work, lid)
        raw = out / f'{lid}.raw.parquet'
        build_table(con, osm, lid, sources['as_of'], raw)
        rows, props = pipeline.rebake_flatten_bbox(raw, path['parquet'], con)
        raw.unlink()
        nulls = con.execute(f"SELECT count(*) FROM '{path['parquet']}' WHERE geometry IS NULL").fetchone()[0]
        path['geojson'].unlink(missing_ok=True)
        write_geojson_whole(con, path['parquet'], path['geojson'], gdal_geojson_available(con))
        write_kml_from_geojson(path['geojson'], lid, path['kml'])
        bake_formats.shapefile_zip_from_geojson(path['geojson'], path['shapefile'],
                                                bake_formats.short_field_names(props))
        bake_formats.write_pmtiles(path['geojson'], path['pmtiles'], lid, tile_fields(lid, props),
                                   keep_all=meta['keep_all'], max_zoom=meta['max_zoom'])
        summary['layers'][lid] = {'rows': rows, 'no_geometry': nulls, 'columns': props,
                                  'sizes': {fmt: p.stat().st_size for fmt, p in path.items()},
                                  'names': pipeline.versioned_names(path)}
        log(f'  {lid}: {rows:,} rows ({nulls} without geometry), {len(props)} columns')
    pipeline.write_json(summary_path, summary)
    return summary


def upload(work: Path) -> dict:
    """Each file to its content-versioned key; one R2 already holds (md5) is skipped."""
    summary = json.loads((out_dir(work) / 'summary.json').read_text())
    s3 = pipeline.r2_client()
    done = {}
    with pipeline.upload_lock(owner='bake_osm_underground (feat/osm-underground)'):
        for lid in LAYERS:
            names = pipeline.upload_versioned(s3, layer_paths(work, lid), R2_PREFIX)
            if names != summary['layers'][lid]['names']:
                raise RuntimeError(f'{lid}: the files changed since the bake; re-run the bake')
            done[lid] = names
            log(f'  {lid}: {names}')
    return done


# ── register ────────────────────────────────────────────────────────────────

def catalog_entry(lid: str, summ: dict, prev: dict, r2_public: str) -> dict:
    from populate_refresh import infer, next_due
    from populate_source_check import OVERRIDES, merge
    meta, built, src = LAYERS[lid], summ['layers'][lid], summ['sources']
    entry = {'id': lid, 'level': lid, 'source': 'OpenStreetMap', 'rows': built['rows'],
             **pipeline.format_blocks(EXT, built['names'], built['sizes'], f'{r2_public}/{R2_PREFIX}')}
    entry.update({'licence': OSM_LICENCE,
                  'attribution': {'primary': dict(OSM_ATTRIBUTION), 'publisher': dict(PUBLISHER)},
                  'category': meta['category'], 'provenance': 'curated', 'fetched_at': src['as_of'],
                  'notes': notes(lid), 'tags': list(meta['tags']),
                  'source_check': merge(prev.get('source_check'), OVERRIDES[lid])})
    block, _ = infer(entry)
    entry['refresh'] = {**block, 'audited_at': (prev.get('refresh') or {}).get('audited_at'),
                        'next_due': next_due(block['rebuild'], src['as_of'])}
    return entry


def manifest_entry(lid: str, summ: dict) -> dict:
    meta, built = LAYERS[lid], summ['layers'][lid]
    return {'id': lid, 'name': meta['label'], 'level': lid, 'category': meta['category'], 'source': 'OpenStreetMap',
            'description': meta['description'], 'unit': meta['unit'], 'features': built['rows'],
            'license': OSM_LICENCE, 'r2_prefix': R2_PREFIX,
            **pipeline.manifest_files(built['names'], built['sizes']),
            'source_url': OSM_ATTRIBUTION['url'], 'source_org': OSM_ATTRIBUTION['name'],
            'source_version': f'Geofabrik India extract of {summ["sources"]["as_of"]}',
            'notes': notes(lid), 'tags': list(meta['tags'])}


def register(catalog_path: Path = CATALOG, manifest_path: Path = MANIFEST, summary_path: Path | None = None,
             r2_public: str | None = None) -> None:
    """Patch catalog.json and the manifest in place (never rebuild). Idempotent."""
    summ = json.loads((summary_path or out_dir(WORK) / 'summary.json').read_text())
    catalog = json.loads(catalog_path.read_text())
    manifest = json.loads(manifest_path.read_text())
    for lid, meta in LAYERS.items():
        entry = catalog_entry(lid, summ, pipeline.prev_layer(catalog, lid), r2_public or pipeline.R2_PUBLIC)
        level_meta = {'label': meta['label'], 'unit': meta['unit'], 'description': meta['description']}
        pipeline.upsert_as_built(catalog, entry, level_meta, attribution=('OpenStreetMap', OSM_ATTRIBUTION))
        manifest = pipeline.upsert_by_id(manifest, manifest_entry(lid, summ))
    pipeline.write_json(catalog_path, catalog)
    pipeline.write_json(manifest_path, manifest)


# ── CLI ─────────────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('step', choices=['all', 'pull', 'extract', 'bake', 'upload', 'register'])
    ap.add_argument('--minutes', type=float, default=90, help='stop cleanly between steps after this long')
    ap.add_argument('--refresh', action='store_true', help='pull: fetch the current extract')
    a = ap.parse_args(argv)
    deadline = pipeline.Deadline(a.minutes)
    try:
        if a.step in ('all', 'pull', 'extract', 'bake'):
            with pipeline.cache_backup(WORK / 'cache', CACHE_PREFIX):
                if a.step in ('all', 'pull') or not sources_path(WORK).exists():
                    deadline.check('pull')
                    sources = pull(WORK, lambda: dated_extract_url(GEOFABRIK_INDIA, head_location),
                                   lambda url, dest: pipeline.download(url, dest, timeout=600), get_text,
                                   refresh=a.refresh)
                    log(f'  extract {sources["url"]} ({sources["bytes"]:,} bytes, as of {sources["as_of"]})')
                sources = json.loads(sources_path(WORK).read_text())
                if a.step in ('all', 'extract', 'bake'):
                    extract(WORK, sources, deadline)
                if a.step in ('all', 'bake'):
                    summary = bake(WORK, sources, deadline)
                    log(json.dumps({lid: lyr['rows'] for lid, lyr in summary['layers'].items()}))
        elif a.step == 'upload':
            upload(WORK)
        else:
            register()
    except OutOfTime as e:
        log(f'STOPPED: {e}; finished steps are kept, re-run to continue')
        return 3
    return 0


if __name__ == '__main__':
    sys.exit(main())
