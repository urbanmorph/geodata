#!/usr/bin/env python3
"""Ingest AMRUT urban land use: one layer per state.

Under AMRUT's sub-scheme for GIS-based master plans, NRSC (ISRO) mapped the
existing land use of each AMRUT city and hosts it on Bhuvan; West Bengal's own
AMRUT portal (Nagar GIS Pariseva) hosts its towns. ramSeraph/indianopenmaps
compiles both into per-state GeoParquet + PMTiles (release `urban-land-use`,
CC0 1.0 from the compiler). Neither publisher states an open licence, so the
layers are republished with credit under policy B (bharatlas.com/about).

Each state is a separate layer (the states together are ~5 GB of parquet, past
the single-file size rule). Columns and geometry are kept as published.

HOLD (17 Nov 2026), not run: the free-text columns (Descr, Name_of_Bu) name some
private people's homes (Chhattisgarh "<name> KA GHAR", Goa "<surname> Residence",
Arunachal "<name> Private Residence") and carry building-level shop and bank
names. Personal data is excluded by policy; whether to skip, or ingest without
those columns (an owner exception, as for Overture's contacts), is the owner's call.

Run:
    python3 scripts/ingest_amrut_landuse.py --no-upload        # build locally only
    python3 scripts/ingest_amrut_landuse.py                    # all states: R2 + manifest + catalog
    python3 scripts/ingest_amrut_landuse.py amrut_landuse_sk   # one state (id substring)

Idempotent through ingest_ramseraph.ingest: downloads are cached under its
WORK dir, uploads skip on a matching md5, catalog and manifest merges are id-keyed.
"""
from __future__ import annotations

import dataclasses
import json
import os
import re
import sys
from pathlib import Path

import duckdb

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from ingest_ramseraph import ROOT, WORK, Dataset, ingest, republished  # noqa: E402
from pipeline import download  # noqa: E402

RELEASE = 'indian_land_features/urban-land-use'
BHUVAN = ('Bhuvan', 'https://bhuvan.nrsc.gov.in/',
          'Bhuvan (NRSC, ISRO), AMRUT GIS-based master plans (MoHUA)')
WB = ('WBAMRUT', 'https://nagargispariseva.wb.gov.in/', 'West Bengal AMRUT (Nagar GIS Pariseva)')

# layer suffix -> (state name, release file stem, publisher)
STATES = {
    'an': ('Andaman and Nicobar Islands', 'AN_AMRUT_ULU', BHUVAN),
    'ar': ('Arunachal Pradesh', 'AR_AMRUT_ULU', BHUVAN),
    'as': ('Assam', 'AS_AMRUT_ULU', BHUVAN),
    'cg': ('Chhattisgarh', 'CG_AMRUT_ULU', BHUVAN),
    'ga': ('Goa', 'GA_AMRUT_ULU', BHUVAN),
    'hp': ('Himachal Pradesh', 'HP_AMRUT_ULU', BHUVAN),
    'jk': ('Jammu and Kashmir', 'JK_AMRUT_ULU', BHUVAN),
    'kl': ('Kerala', 'KR_AMRUT_ULU', BHUVAN),
    'mn': ('Manipur', 'MN_AMRUT_ULU', BHUVAN),
    'mp': ('Madhya Pradesh', 'MP_AMRUT_ULU', BHUVAN),
    'mz': ('Mizoram', 'MZ_AMRUT_ULU', BHUVAN),
    'pb': ('Punjab', 'PB_AMRUT_ULU', BHUVAN),
    'py': ('Puducherry', 'PD_AMRUT_ULU', BHUVAN),
    'sk': ('Sikkim', 'SK_AMRUT_ULU', BHUVAN),
    'tn': ('Tamil Nadu', 'TN_AMRUT_ULU', BHUVAN),
    'ts': ('Telangana', 'TS_AMRUT_ULU', BHUVAN),
    'uk': ('Uttarakhand', 'UK_AMRUT_ULU', BHUVAN),
    'up': ('Uttar Pradesh', 'UP_AMRUT_ULU', BHUVAN),
    'wb': ('West Bengal', 'WB_AMRUT_ULU_polygons', WB),
}

PERSONAL = re.compile(r'owner|mobile|phone|email|e_mail|aadhaar|contact|occupant', re.I)


def personal_columns(cols: list[str]) -> list[str]:
    return [c for c in cols if PERSONAL.search(c)]


def date_only(ts: str) -> str:
    return ts[:10]


def dataset(sid: str) -> Dataset:
    state, stem, (source, url, org) = STATES[sid]
    d = republished(
        f'amrut_landuse_{sid}', f'Urban land use, {state} (AMRUT)', 'agriculture', source, RELEASE, stem,
        f'Existing land use of the AMRUT cities of {state}, mapped for their GIS-based master plans: '
        'one polygon per parcel of land with its land-use class and sub-class (residential, commercial, '
        'industrial, public and semi-public, transport, recreational, water, agriculture and others).',
        'land-use polygons', url, org, 'Sub_Class', f'agriculture/amrut-landuse/{sid}')
    # The cap in ingest_ramseraph decides the whole-layer downloads: a big state's GeoJSON runs to GBs.
    return dataclasses.replace(d, bake_all_formats=False)


DATASETS: list[Dataset] = [dataset(sid) for sid in STATES]


def by_id(layer_id: str) -> Dataset:
    return next(d for d in DATASETS if d.id == layer_id)


def with_cities(d: Dataset, raw: Path) -> Dataset:
    """Name the cities the source covers in the notes; refuse personal columns."""
    con = duckdb.connect()
    cols = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{raw}')").fetchall()]
    if bad := personal_columns(cols):
        raise SystemExit(f'{d.id}: personal fields must never be published: {bad}')
    if 'city' not in cols:
        return d
    cities = [c for (c,) in con.execute(
        f"SELECT DISTINCT city FROM read_parquet('{raw}') WHERE city IS NOT NULL ORDER BY 1").fetchall()]
    return dataclasses.replace(d, notes=f'{d.notes} Cities ({len(cities)}): {", ".join(cities)}.')


def normalise_fetched_at(ids: set[str]) -> None:
    """fetched_at as YYYY-MM-DD on these layers (ingest() writes a timestamp)."""
    f = ROOT / 'catalog.json'
    c = json.loads(f.read_text())
    for layer in c['layers']:
        if layer['id'] in ids and layer.get('fetched_at'):
            layer['fetched_at'] = date_only(layer['fetched_at'])
    f.write_text(json.dumps(c, indent=2) + '\n')


def main(argv: list[str]) -> int:
    upload = '--no-upload' not in argv
    args = [a for a in argv[1:] if a != '--no-upload']
    missing = [k for k in ('CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY') if k not in os.environ]
    if upload and missing:
        sys.exit(f'missing env: {", ".join(missing)} (or pass --no-upload)')
    todo = [d for d in DATASETS if not args or args[0] in d.id]
    for d in todo:
        raw = WORK / f'_raw_{d.id}.parquet'
        download(d.parquet_url, raw)
        ingest(with_cities(d, raw), upload=upload)
    if upload:
        normalise_fetched_at({d.id for d in todo})
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
