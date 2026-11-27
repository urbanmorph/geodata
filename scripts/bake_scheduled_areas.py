#!/usr/bin/env python3
"""
Bake the two Scheduled Areas layers from the tables build_scheduled_areas.py writes.

scheduled_areas_fifth: the Fifth Schedule (PESA) areas of 10 states. One feature per LGD village (its
LGD polygon), with whether the Presidential orders / state lists name it (in_orders), whether MoPR's
eGramSwaraj PESA list does (in_pesa_list) and the basis that gives: both | order_only | pesa_only.
Himachal Pradesh, whose villages have no LGD polygons, is drawn by its notified districts and tehsils.
Units a list names but no boundary could be found for are kept as rows without geometry (mapped =
false, why_unmapped says why), so the layer lists everything notified, mapped or not.

scheduled_areas_sixth: the Sixth Schedule council areas (Paragraph 20): one feature per LGD district or
village in a council's area, with the council; listed villages with no polygon kept without geometry.

Usage:
    python3 -u scripts/bake_scheduled_areas.py bake      # local files in data/scheduled_areas/out/
    python3 -u scripts/bake_scheduled_areas.py register  # patch catalog.json + manifest from the summary
"""
from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import build_scheduled_areas as b  # noqa: E402
import match_scheduled_areas as m  # noqa: E402
import pipeline  # noqa: E402

ROOT = HERE.parent
CATALOG = ROOT / 'catalog.json'
GEO = m.CACHE / 'geo'                    # LGD polygons, downloaded once
OUT = m.OUT / 'out'
EXT = {'parquet': 'parquet', 'geojson': 'geojson', 'kml': 'kml', 'shapefile': 'shp.zip', 'pmtiles': 'pmtiles'}
FIFTH_COLS = ['feature', 'state', 'district', 'subdistrict', 'name', 'lgd_layer', 'lgd_code', 'census_2011',
              'in_orders', 'in_pesa_list', 'basis', 'order_refs', 'pesa_gp', 'pesa_block', 'mapped', 'why_unmapped']
SIXTH_COLS = ['feature', 'state', 'council', 'district', 'name', 'lgd_layer', 'lgd_code', 'order_ref', 'mapped',
              'why_unmapped']
TILE_FIELDS = {'scheduled_areas_fifth': ['name', 'district', 'state', 'basis', 'in_orders', 'in_pesa_list'],
               'scheduled_areas_sixth': ['name', 'district', 'state', 'council']}
WHY = {'review': 'name not matched to an LGD village with confidence (candidates need a check)',
       'none': 'name not matched to any LGD unit in its district',
       'ambiguous': 'two or more LGD units share the name; not guessed',
       'needs_list': 'no boundary for this unit in LGD (needs the list of its villages)',
       'unmapped_parent': "the order's district could not be traced to a current district"}
# Superseded as a source of unmapped rows: the 1950 Telangana village list (G.O.Ms.89/2015 is the list drawn).
NOT_UNMAPPED_SOURCES = {'ap_telangana/telangana.csv'}


def why_unmapped(status: str) -> str:
    return WHY.get(status, status)


def _blank(cols: list[str]) -> dict:
    return {c: '' for c in cols}


def village_row(v: dict) -> dict:
    return {**_blank(FIFTH_COLS), 'feature': 'village', 'state': v['state'].title(), 'district': v['district'],
            'subdistrict': v['subdistrict'], 'name': v['village'], 'lgd_layer': 'lgd_villages',
            'lgd_code': v['lgd_village'], 'census_2011': v['census_2011'], 'in_orders': v['basis'] != 'pesa_only',
            'in_pesa_list': v['basis'] != 'order_only', 'basis': v['basis'], 'order_refs': v['order_refs'],
            'pesa_gp': v['pesa_gp'], 'pesa_block': v['pesa_block'], 'mapped': True}


def unmapped_order_row(u: dict) -> dict:
    return {**_blank(FIFTH_COLS), 'feature': u['unit_level'], 'state': u['state'], 'district': u['parent_district'],
            'subdistrict': u['parent_subdistrict_or_block'], 'name': u['unit_name'], 'in_orders': True,
            'in_pesa_list': False, 'basis': 'order_only', 'order_refs': u['order_ref'], 'mapped': False,
            'why_unmapped': why_unmapped(u['match'])}


def unmapped_pesa_row(p: dict) -> dict:
    return {**_blank(FIFTH_COLS), 'feature': 'village', 'state': p['state'], 'district': p['district'],
            'name': p['village_name'], 'lgd_code': p['village_code'], 'in_orders': False, 'in_pesa_list': True,
            'basis': 'pesa_only', 'pesa_gp': p['gp_name'], 'pesa_block': p['block'], 'mapped': False,
            'why_unmapped': 'no LGD polygon for this village code (likely newer than the boundary layer)'}


def area_row(u: dict, lgd_id: str, pesa_districts: set[str]) -> dict:
    """A whole notified district or tehsil drawn by its LGD polygon (Himachal: no village polygons)."""
    in_pesa = u['parent_district'].lower() in pesa_districts or u['unit_name'].lower() in pesa_districts
    return {**_blank(FIFTH_COLS), 'feature': u['unit_level'], 'state': u['state'], 'district': u['parent_district'],
            'name': u['unit_name'], 'lgd_layer': u['lgd_layer'], 'lgd_code': lgd_id, 'in_orders': True,
            'in_pesa_list': in_pesa, 'basis': b.basis(True, in_pesa), 'order_refs': u['order_ref'], 'mapped': True}


def read_csv(path: Path) -> list[dict]:
    with path.open() as fh:
        return list(csv.DictReader(fh))


def fifth_rows() -> list[dict]:
    rows = [village_row(v) for v in read_csv(m.OUT / 'fifth_schedule_villages.csv')]
    units = [u for u in read_csv(m.OUT / 'matches.csv') if u['state'] in b.FIFTH]
    pesa_hp = {r['district'].lower() for r in read_csv(b.EGS) if r['state'] == 'Himachal Pradesh' and r['is_pesa'] == 'Yes'}
    for u in units:
        if u['state'] == 'Himachal Pradesh' and u['match'] in b.CONFIDENT:
            rows += [area_row(u, i, pesa_hp) for i in u['lgd_ids'].split(';')]
        elif u['match'] not in b.CONFIDENT and u['source_file'] not in NOT_UNMAPPED_SOURCES:
            rows.append(unmapped_order_row(u))
    rows += [unmapped_pesa_row(p) for p in read_csv(m.OUT / 'pesa_unmatched.csv')]
    return rows


def sixth_rows() -> list[dict]:
    rows = []
    for r in read_csv(m.OUT / 'sixth_schedule_units.csv'):
        feature = 'district' if r['lgd_layer'] == 'lgd_districts' else 'village'
        rows.append({**_blank(SIXTH_COLS), 'feature': feature, 'state': r['state'], 'council': r['council'],
                     'name': r['name'], 'lgd_layer': r['lgd_layer'], 'lgd_code': r['lgd_id'],
                     'order_ref': r['order_ref'], 'mapped': True})
    for u in read_csv(m.OUT / 'matches.csv'):
        if u['state'] in b.SIXTH and u['unit_level'] == 'village' and u['match'] not in b.CONFIDENT:
            rows.append({**_blank(SIXTH_COLS), 'feature': 'village', 'state': u['state'],
                         'council': b.council(u['state'], u['parent_district'], 'village'),
                         'district': u['parent_district'].replace(' (added villages)', ''), 'name': u['unit_name'],
                         'order_ref': u['order_ref'], 'mapped': False, 'why_unmapped': why_unmapped(u['match'])})
    return rows


def geometry_sources() -> dict[str, Path]:
    GEO.mkdir(parents=True, exist_ok=True)
    import bake_formats
    return {layer: bake_formats.fetch_layer_file(CATALOG, layer, 'parquet', GEO / f'{layer}.parquet')
            for layer in ('lgd_villages', 'lgd_subdistricts', 'lgd_districts')}


def write_layer(con, layer_id: str, rows: list[dict], cols: list[str], geo: dict[str, Path]) -> dict:
    """Join each row to its LGD polygon (none for unmapped rows), then every download format."""
    OUT.mkdir(parents=True, exist_ok=True)
    attrs = OUT / f'{layer_id}.attrs.json'
    attrs.write_text(json.dumps([{c: r[c] for c in cols} for r in rows]))
    sel = ', '.join(f'a."{c}"' for c in cols)
    joined = OUT / f'{layer_id}.joined.parquet'
    con.execute(f"""COPY (
        SELECT {sel}, COALESCE(v.geometry, s.geometry, d.geometry) AS geometry
        FROM read_json_auto('{attrs}', maximum_object_size=1000000000) a
        LEFT JOIN (SELECT CASE WHEN vil_lgd > 0 THEN vil_lgd ELSE -OBJECTID END AS id, geometry
                   FROM read_parquet('{geo['lgd_villages']}')) v
               ON a.lgd_layer = 'lgd_villages' AND CAST(a.lgd_code AS VARCHAR) = CAST(v.id AS VARCHAR)
        LEFT JOIN (SELECT subdt_lgd AS id, geometry FROM read_parquet('{geo['lgd_subdistricts']}') WHERE subdt_lgd > 0) s
               ON a.lgd_layer = 'lgd_subdistricts' AND CAST(a.lgd_code AS VARCHAR) = CAST(s.id AS VARCHAR)
        LEFT JOIN (SELECT dist_lgd AS id, geometry FROM read_parquet('{geo['lgd_districts']}')) d
               ON a.lgd_layer = 'lgd_districts' AND CAST(a.lgd_code AS VARCHAR) = CAST(d.id AS VARCHAR)
        ) TO '{joined}' (FORMAT PARQUET)""")
    n, drawn, flagged = con.execute(f"SELECT count(*), count(geometry), count(*) FILTER (WHERE mapped) "
                                    f"FROM '{joined}'").fetchone()
    if drawn != flagged:
        raise ValueError(f'{layer_id}: {flagged:,} rows marked mapped but {drawn:,} have a polygon')
    path = {fmt: OUT / f'{layer_id}.{ext}' for fmt, ext in EXT.items()}
    _, prop_cols = pipeline.rebake_flatten_bbox(joined, path['parquet'])
    import bake_formats
    files = bake_formats.write_all_formats(con, path, layer_id, prop_cols, TILE_FIELDS[layer_id])
    over = {f: path[f].stat().st_size for f in ('geojson', 'kml') if path[f].exists() and pipeline_over(f, path[f])}
    return {'rows': n, 'mapped': drawn, **files, 'over_limit': over}


def pipeline_over(fmt: str, p: Path) -> bool:
    """The download limits from the formats branch (KML 350 MB, GeoJSON 1 GB), until it is merged."""
    limits = getattr(pipeline, 'FORMAT_MAX_BYTES', {'kml': 350 * 1000**2, 'geojson': 1000**3})
    return p.stat().st_size > limits.get(fmt, float('inf'))


def bake() -> dict:
    geo = geometry_sources()
    con = pipeline.make_con()
    summary = {'scheduled_areas_fifth': write_layer(con, 'scheduled_areas_fifth', fifth_rows(), FIFTH_COLS, geo),
               'scheduled_areas_sixth': write_layer(con, 'scheduled_areas_sixth', sixth_rows(), SIXTH_COLS, geo)}
    (OUT / 'summary.json').write_text(json.dumps(summary, indent=2, default=str))
    pipeline.log(json.dumps(summary, indent=2, default=str))
    return summary


# ── catalog ──────────────────────────────────────────────────────────────────

MANIFEST = HERE / 'external-ingested.json'
R2_PREFIX = 'boundaries/scheduled-areas'
LICENCE = 'CC0-1.0'
SOURCE = 'bharatlas (Presidential orders, state lists, MoPR eGramSwaraj)'
ATTRIBUTION = {'name': 'bharatlas, compiled from the Scheduled Areas notifications', 'url': 'https://bharatlas.com'}
ORDERS = ('C.O.9 and C.O.26 (1950), C.O.30 (1951), C.O.50 (1955), C.O.102 (1975), C.O.109 (1977), C.O.123 (1985), '
          'C.O.192 (2003), C.O.229 (2007) and C.O.270 (2018)')
LABEL = {'scheduled_areas_fifth': 'Scheduled Areas, Fifth Schedule (PESA)',
         'scheduled_areas_sixth': 'Tribal Areas, Sixth Schedule (autonomous councils)'}
TAGS = {'scheduled_areas_fifth': ['Scheduled Areas', 'Fifth Schedule', 'PESA', 'tribal', 'Adivasi', 'gram sabha',
                                  'panchayat', 'village', 'boundaries'],
        'scheduled_areas_sixth': ['Sixth Schedule', 'autonomous district council', 'tribal areas', 'Bodoland',
                                  'TTAADC', 'Khasi Hills', 'Garo Hills', 'Karbi Anglong', 'boundaries']}


def notes(layer_id: str, s: dict) -> str:
    unmapped = s['rows'] - s['mapped']
    if layer_id == 'scheduled_areas_fifth':
        return (
            'Scheduled Areas under the Fifth Schedule of the Constitution, where the Panchayats (Extension to '
            'Scheduled Areas) Act, 1996 (PESA) applies: Andhra Pradesh, Chhattisgarh, Gujarat, Himachal Pradesh, '
            'Jharkhand, Madhya Pradesh, Maharashtra, Odisha, Rajasthan and Telangana. Compiled by bharatlas from '
            f'official sources and released as CC0: the Presidential Scheduled Areas orders in force ({ORDERS}; '
            'Gazette of India, and the Ministry of Tribal Affairs list of 10 March 2026); the state lists that name '
            'their villages (Andhra Pradesh Finance G.O.Ms.6 of 2007, Telangana Finance G.O.Ms.89 of 2015, Odisha '
            "Bhulekh village lists for the 1977 tahsils); and the Ministry of Panchayati Raj's eGramSwaraj PESA "
            'village list (80,428 villages, November 2026). Each feature is an LGD village, or in Himachal Pradesh '
            'a notified district or tehsil. in_orders: named in an order or state list, or inside a notified '
            'district, tehsil, block or panchayat; in_pesa_list: marked PESA on eGramSwaraj; basis: both, '
            'order_only or pesa_only. Where the two disagree the layer shows it rather than choosing one. Places an '
            'order excludes are left out of that order\'s coverage. Orders name units as they stood on the order '
            "date and this layer draws today's LGD villages, so villages now in tehsils created later can show as "
            f'pesa_only. {unmapped:,} listed units with no LGD boundary (newer or forest villages, patwari circles, '
            'names not matched with confidence) are rows without geometry; why_unmapped says why. A compilation '
            'for reference, not a legal record: the notifications prevail.')
    return (
        'Tribal areas under the Sixth Schedule of the Constitution (Paragraph 20), administered by autonomous '
        'councils: Bodoland Territorial Council, Karbi Anglong and Dima Hasao councils (Assam); Khasi Hills, '
        'Jaintia Hills and Garo Hills councils (Meghalaya); Tripura Tribal Areas Autonomous District Council; '
        'Chakma, Lai and Mara councils (Mizoram). Compiled by bharatlas from official sources and released as CC0: '
        'the Constitution (Paragraph 20), the TTAADC Election Rules Appendix-I (Tripura Gazette, 2015), the Assam '
        'Gazette notifications adding 81 villages to Bodoland (2022 to 2024) and the 2025 delimitation order, and '
        'the Mizoram council village lists. Bodoland is drawn as its five districts, which the 2003 accord formed '
        'from its villages, plus the added villages; claims to exclude villages are pending and none is excluded '
        "here. Mizoram's councils are drawn by district: the Chakma and Lai councils share Lawngtlai and are not "
        f'split. {unmapped:,} listed villages with no LGD polygon (mostly forest villages and Mizoram villages) are '
        'rows without geometry. A compilation for reference, not a legal record: the notifications prevail.')


def catalog_entry(layer_id: str, s: dict, fetched_at: str, r2_public: str) -> dict:
    return {'id': layer_id, 'level': layer_id, 'source': SOURCE, 'rows': s['rows'],
            **pipeline.format_blocks(EXT, s['names'], s['sizes'], f'{r2_public}/{R2_PREFIX}'),
            'licence': LICENCE, 'attribution': {'primary': dict(ATTRIBUTION), 'publisher': None},
            'category': 'boundaries', 'provenance': 'curated', 'fetched_at': fetched_at,
            'notes': notes(layer_id, s), 'tags': TAGS[layer_id]}


def register() -> None:
    """Patch catalog.json and the manifest in place from the bake summary (idempotent)."""
    summary = json.loads((OUT / 'summary.json').read_text())
    for layer_id, s in summary.items():
        unit = 'villages and areas' if layer_id.endswith('fifth') else 'council areas'
        meta = {'label': LABEL[layer_id], 'unit': unit, 'description': notes(layer_id, s)[:300]}
        row = {'id': layer_id, 'name': LABEL[layer_id], 'level': layer_id, 'category': 'boundaries',
               'source': SOURCE, 'description': meta['description'], 'unit': unit, 'features': s['rows'],
               'license': LICENCE, 'r2_prefix': R2_PREFIX, **pipeline.manifest_files(s['names'], s['sizes']),
               'source_url': ATTRIBUTION['url'], 'source_org': ATTRIBUTION['name'], 'notes': notes(layer_id, s),
               'tags': TAGS[layer_id]}
        pipeline.register_layer(CATALOG, MANIFEST, catalog_entry(layer_id, s, pipeline.now_iso(), pipeline.R2_PUBLIC),
                                row, meta, attribution=(SOURCE, ATTRIBUTION), category=('boundaries', 'Boundaries'))


if __name__ == '__main__':
    steps = {'bake': bake, 'register': register}
    if len(sys.argv) != 2 or sys.argv[1] not in steps:
        sys.exit(__doc__)
    steps[sys.argv[1]]()
