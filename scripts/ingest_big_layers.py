#!/usr/bin/env python3
"""
Ingest the large forest / rural / cadastral layers (Nov 2026 batch) from
ramSeraph GitHub releases, through the shared ingest_ramseraph pipeline
(flat bbox + Hilbert parquet, geojson/kml/shapefile bakes, md5-checked R2
upload, manifest + in-place catalog patch).

What this script adds on top:
  - prefetch(): the release assets run to hundreds of MB, so they come down
    through pipeline.download (a `.part` file that a killed run resumes,
    renamed only once its size and checksum are right).
  - assert_no_personal_data(): a layer whose columns name people (owners,
    occupants, phone numbers) is refused before anything is baked. Columns
    are never dropped (bake rule), so such a source is skipped outright.

Run:
    set -a; source web/.dev.vars; set +a          # CLOUDFLARE_ACCOUNT_ID + R2 keys
    python3 scripts/ingest_big_layers.py cadastrals_puducherry --no-upload
    python3 scripts/ingest_big_layers.py cadastrals_puducherry
    python3 scripts/ingest_big_layers.py --max-minutes 120   # stop cleanly between layers (default 300)

Idempotent: finished downloads are kept, R2 uploads skip on md5 match and the
manifest + catalog merges are id-keyed.
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

import duckdb
import ingest_ramseraph as ir
from bake_formats import write_pmtiles
from ingest_ramseraph import Dataset, republished
from pipeline import Deadline, OutOfTime, atomic_output, download, make_con, take_max_minutes

# Column names that hold people's details. Matched case-insensitively
# against whole name parts, so record numbers (khatian, khasra) and place
# or forest names (name_of_rf, ownership) pass.
PERSONAL_COLUMN = re.compile(
    r'owner|occupant|father|husband|mobile|phone|e_?mail|aadha|beneficiar|applicant|pattadar',
    re.IGNORECASE)


def personal_data_columns(columns: list[str]) -> list[str]:
    return [c for c in columns if PERSONAL_COLUMN.search(c) and c.lower() != 'ownership']


def parquet_columns(path: Path) -> list[str]:
    return [r[0] for r in duckdb.sql(f"DESCRIBE SELECT * FROM read_parquet('{path}')").fetchall()]


def assert_no_personal_data(layer_id: str, parquet: Path) -> None:
    found = personal_data_columns(parquet_columns(parquet))
    if found:
        sys.exit(f'{layer_id}: refused, personal data columns {found}; skip this source')


def bake_popup_pmtiles(src: Path, out: Path, layer: str, fields: list[str]) -> None:
    """PMTiles carrying only the popup `fields` (the upstream tiles carry every
    column, which makes tippecanoe drop parcels at mid zooms). Skips an
    existing file; a killed bake leaves only `.part` files behind."""
    if out.exists():
        print(f'  have {out.name}', flush=True)
        return
    cols = ', '.join(f'"{f}"' for f in fields)
    seq = out.with_suffix('.geojsonl')
    print(f'  baking {out.name} with popup fields {fields}', flush=True)
    with atomic_output(seq) as part:
        con = make_con()
        con.execute(f"COPY (SELECT {cols}, geometry FROM read_parquet('{src}')) "
                    f"TO '{part}' WITH (FORMAT GDAL, DRIVER 'GeoJSONSeq')")
    with atomic_output(out) as part:
        write_pmtiles(seq, part, layer, fields, parallel=True)
    seq.unlink()


def prefetch(d: Dataset) -> None:
    """Put the source parquet and our popup-field PMTiles where ir.ingest()
    looks, so its downloader skips both."""
    raw = ir.WORK / f'_raw_{d.id}.parquet'
    download(d.parquet_url, raw)
    bake_popup_pmtiles(raw, ir.WORK / f'{d.id}.pmtiles', d.id, TILE_FIELDS[d.id])


CADASTRAL_NOTE = (' Parcel boundaries only: the source carries no owner names, and bharatlas does not'
                  ' publish any. Not a legal record; the state land records are authoritative.')


def cadastral(id: str, name: str, source: str, file: str, release: str, description: str,
              source_url: str, source_org: str, kml_name_field: str) -> Dataset:
    d = republished(id, name, 'boundaries', source, f'indian_cadastrals/{release}', file,
                    description, 'land parcels', source_url, source_org, kml_name_field,
                    f'boundaries/{id.replace("_", "-")}')
    d.notes += CADASTRAL_NOTE
    return d


DATASETS: list[Dataset] = [
    cadastral(
        'cadastrals_puducherry_coastal', 'Coastal land parcels, Puducherry (NCSCM)', 'NCSCM',
        'NCSCM_PC_Cadastrals', 'puducherry',
        'Survey-number land parcels in 39 coastal villages of Puducherry, Karaikal and Yanam from the'
        ' coastal zone management plan maps, with the area of each parcel (square metres) inside each'
        ' coastal regulation zone: CRZ-IA, IB, II, IVB, no-development zone, 200 to 500 m from the high'
        ' tide line, hazard line and mangrove buffer. Coastal villages only; Mahe is not covered.',
        'https://czmp.ncscm.res.in/',
        'National Centre for Sustainable Coastal Management (MoEFCC)', 'Survey_No'),
    cadastral(
        'cadastrals_andaman_coastal', 'Coastal land parcels, Andaman and Nicobar (NCSCM)', 'NCSCM',
        'NCSCM_AN_Cadastrals', 'andaman-and-nicobar',
        'Survey-number land parcels in the coastal villages of the Andaman and Nicobar Islands from'
        ' the coastal zone management plan maps, with plot or survey number, village and island.'
        ' Coastal villages only; column names vary between islands in the source.',
        'https://czmp.ncscm.res.in/',
        'National Centre for Sustainable Coastal Management (MoEFCC)', 'SY_NO'),
    cadastral(
        'cadastrals_goa', 'Land parcels, Goa (NBSS)', 'NBSS', 'NBSS_Goa_Cadastrals', 'goa',
        'Survey-number land parcels across Goa from Goa Bhoomi (ICAR-NBSS&LUP), with district,'
        ' taluka and panchayat.',
        'http://14.139.123.73:9090/WEB/goabhoomi.php',
        'Goa Bhoomi, ICAR National Bureau of Soil Survey and Land Use Planning', 'Survey_No'),
    cadastral(
        'cadastrals_delhi', 'Land parcels (khasras), Delhi (GSDL)', 'GSDL', 'GSDL_Cadastrals', 'delhi',
        'Khasra (survey-number) parcels in the revenue villages of Delhi from Geospatial Delhi'
        ' Limited, with district, sub-division, village (and Census codes), khasra number, land use'
        ' type (agriculture, abadi, forest, water bodies, transport, public) and patwari status.'
        ' Digitised 2012 to 2013; built-up urban Delhi has few khasras.',
        'https://gsdl.org.in/', 'Geospatial Delhi Limited (GSDL)', 'M_KHASRA_N'),
    # ── Recorded Forest Area ───────────────────────────────────────────
    # Same FSI geodatabase as fsi_beats (63% of polygons byte-identical) but a
    # different vintage that covers Rajasthan, Assam, Himachal, UP, Arunachal,
    # Tripura, Mizoram, Sikkim, Goa, Ladakh and Meghalaya, which the beats
    # layer barely has (~590,000 vs ~500,000 km² summed).
    republished(
        'fsi_recorded_forest_area', 'Recorded forest area (FSI)', 'environment', 'FSI',
        'indian_admin_boundaries/forests', 'Bharatmaps_RFA',
        'Recorded forest area: land recorded as forest in government records (reserved, protected'
        ' and unclassed forests), as digitised by the Forest Survey of India, with reserved forest'
        ' name, compartment, beat, range, division, circle, district and LGD codes. Covers more'
        ' states than the forest beats layer (Rajasthan, Assam, Himachal Pradesh, Uttar Pradesh and'
        ' the North East); Gujarat and Madhya Pradesh are less complete here. Legal status, not tree'
        ' cover. Many name fields are blank in the source.',
        'forest polygons', 'https://fsi.nic.in/', 'Forest Survey of India (MoEFCC), via Bharatmaps',
        'name_of_rf', 'environment/fsi-recorded-forest-area'),
]
for _d in DATASETS:
    _d.notes += (' Map tiles rebaked by bharatlas with the popup fields only; every column is in the'
                 ' parquet and the downloads.')


# Tile attributes = the click-popup fields; the full table is in the parquet.
TILE_FIELDS: dict[str, list[str]] = {
    'cadastrals_puducherry_coastal': ['Survey_No', 'Village_Name', 'District', 'CRZ_IA', 'CRZ_IB',
                                      'CRZ_II', 'CRZ_IVB', 'NDZ'],
    'cadastrals_andaman_coastal': ['SY_NO', 'Sy_No_1', 'Plot_No', 'Name', 'Village_Na', 'island',
                                   'Area_Sq_m'],
    'cadastrals_goa': ['Survey_No', 'Panchayath', 'Taluka', 'District'],
    'cadastrals_delhi': ['M_KHASRA_N', 'VILL_NM', 'SUBDIV_NM', 'DIST_NM', 'TYPE', 'SUB_TYPE'],
    'fsi_recorded_forest_area': ['name_of_rf', 'name', 'beat_name', 'range', 'division', 'st_name',
                                 'dt_name'],
}


def main(argv: list[str]) -> int:
    upload = '--no-upload' not in argv
    args, minutes = take_max_minutes([a for a in argv[1:] if a != '--no-upload'], 300)
    deadline = Deadline(minutes)
    targets = [d for d in DATASETS if not args or args[0] in d.id]
    if not targets:
        print(f'No dataset matched {args[0]!r}. Available: {[d.id for d in DATASETS]}')
        return 2
    try:
        for d in targets:
            deadline.check(f'fetching {d.id}')
            print(f'\n== {d.id}', flush=True)
            prefetch(d)
            assert_no_personal_data(d.id, ir.WORK / f'_raw_{d.id}.parquet')
    except OutOfTime as e:
        print(f'STOPPED: {e}; finished downloads are kept, re-run to continue', flush=True)
        return 3
    if upload:
        missing = [k for k in ('CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY')
                   if k not in os.environ]
        if missing:
            print(f'ERROR: {missing} not set in env')
            return 2
    for d in targets:
        try:
            deadline.check(f'ingesting {d.id}')
        except OutOfTime as e:
            print(f'STOPPED: {e}; finished layers are done, re-run to continue', flush=True)
            return 3
        ir.ingest(d, upload=upload)
    return 0


if __name__ == '__main__':
    sys.stdout.reconfigure(line_buffering=True)
    sys.exit(main(sys.argv))
