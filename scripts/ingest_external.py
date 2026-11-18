#!/usr/bin/env python3
"""
Ingest external geo datasets into the bharatlas catalog.

Pipeline per dataset (files land at data/baked/<r2_prefix>/<id>.<ext>):
  1. KML / GeoJSON -> GeoJSON via ogr2ogr (EPSG:4326)
  2. GeoJSON -> Parquet via DuckDB-spatial, then rebake_flatten_bbox: flat
     xmin/ymin/xmax/ymax columns + Hilbert order (/api/v1/nearby needs both)
  3. GeoJSON -> PMTiles via tippecanoe, z0-z12 (locate tests a point at the
     tileset's max zoom; -zg once stopped at z4)
  4. Parquet -> GeoJSON, KML (Placemarks named by kml_name_field) and a
     zipped Shapefile, longitude first
  5. Upload every file to R2 (skips on a matching md5) and merge the layer
     rows into scripts/external-ingested.json by id

Idempotent: a dataset whose outputs are all newer than its source is skipped.

Run:
    pip install boto3 duckdb
    brew install gdal tippecanoe
    python3 scripts/ingest_external.py zones_pune --no-upload   # build locally only
    export R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... CLOUDFLARE_ACCOUNT_ID=...
    python3 scripts/ingest_external.py            # all datasets
    python3 scripts/ingest_external.py chennai    # one by id substring
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import duckdb

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from pipeline import (  # noqa: E402
    bake_whole_layer,
    geojson_to_parquet,
    r2_client,
    r2_upload,
    upsert_by_id,
    write_json,
)
from rebake_locate_tiles import tippecanoe_cmd  # noqa: E402

HOME = Path.home()
ROOT = HERE.parent
OUT = ROOT / 'data' / 'baked'          # same layout as R2: OUT/<r2_prefix>/<id>.<ext>
SRC = ROOT / 'data' / 'external-src'   # fetched by hand (OpenCity sits behind a Cloudflare challenge)
MANIFEST = HERE / 'external-ingested.json'


@dataclass
class Dataset:
    id: str                 # catalog id (snake_case, unique)
    name: str               # display label on the home card
    src: str                # absolute path to the source file (KML or GeoJSON)
    category: str           # one of catalog.categories keys
    level: str              # LEVELS dict id (one per layer for city data)
    description: str        # one-liner for the card + JSON-LD
    source_org: str         # primary attribution org (e.g. "BBMP")
    source_url: str         # canonical link to the upstream dataset
    license: str            # SPDX-style; must be in OPEN_LICENCES
    r2_prefix: str          # R2 key prefix (e.g. "admin/wards-bengaluru-gba")
    unit: str = 'features'  # plural noun shown next to the count ("wards", "corporations")
    features: int | None = None  # feature count; filled in post-conversion if None
    notes: str = ''         # extra note shown on the card
    attr_key: str = 'OpenCity'  # key into build_catalog.py ATTR dict for attribution
    kml_name_field: str = ''    # column that names each KML Placemark (map labels)
    bake_all_formats: bool = False  # read by ingest_ramseraph.bake_whole_layer
    shp_split_by: str = ''          # read by ingest_ramseraph.bake_whole_layer


# All datasets ingested in v4.1 (notf + BDA).
# source_url points at OpenCity (the canonical citation) where applicable;
# notf is just our local working copy.
DATASETS: list[Dataset] = [
    # ──────── Bengaluru ────────
    Dataset(
        id='wards_bengaluru_gba',
        name='Greater Bengaluru Wards (2025)',
        src=str(HOME / 'GitHub/notf/supporting documents/bengaluru/gba-369-wards-december-2025.kml'),
        category='city-wards',
        level='wards_bengaluru_gba',
        description='Greater Bengaluru Authority — 369 final wards across 5 corporations, notified Nov 2025.',
        source_org='Greater Bengaluru Authority',
        source_url='https://data.opencity.in/dataset/gba-wards-delimitation-2025',
        license='CC0-1.0',
        unit='wards',
        r2_prefix='admin/wards-bengaluru-gba',
        features=369,
        notes='Latest GBA delimitation. Pair with the 5-corp polygons for parent grouping.',
    ),
    Dataset(
        id='corporation_bengaluru',
        name='Greater Bengaluru Corporations (2025)',
        src=str(HOME / 'GitHub/notf/supporting documents/bengaluru/gba_corporation.geojson'),
        category='city-wards',
        level='corporation_bengaluru',
        description='Five corporation-level polygons that make up the Greater Bengaluru Authority.',
        source_org='Greater Bengaluru Authority',
        source_url='https://data.opencity.in/dataset/greater-bengaluru-authority-corporations-delimitation-2025',
        license='CC0-1.0',
        unit='corporations',
        r2_prefix='admin/corporation-bengaluru',
        features=5,
        notes='Parent polygons for the 369 GBA wards.',
    ),
    Dataset(
        id='wards_bengaluru_bbmp_2022',
        name='BBMP Wards (2022, historical)',
        src=str(HOME / 'GitHub/BDA/supporting-documents/bbmp-wards-2022.geojson'),
        category='city-wards',
        level='wards_bengaluru_bbmp_2022',
        description='Bruhat Bengaluru Mahanagara Palike — 243 wards from the 2022 draft delimitation. Historical reference; superseded by the 2025 GBA 369-ward scheme. OpenCity states no licence for this dataset, so the layer keeps the ODbL-1.0 label used for OpenCity data and credits both OpenCity and BBMP.',
        source_org='BBMP',
        source_url='https://data.opencity.in/dataset/bbmp-ward-information',
        license='ODbL-1.0',
        unit='wards',
        r2_prefix='admin/wards-bengaluru-bbmp-2022',
        features=243,
        notes='Use the GBA 2025 layer for current ward boundaries.',
    ),
    Dataset(
        id='bda_jurisdiction',
        name='BDA Jurisdiction',
        src=str(HOME / 'GitHub/BDA/public/data/bda_jurisdiction.geojson'),
        category='city-wards',
        level='bda_jurisdiction',
        description='Bengaluru Development Authority planning + acquisition jurisdiction boundary.',
        source_org='Bengaluru Development Authority',
        source_url='https://data.opencity.in/dataset/bda-jurisdiction-and-boundary',
        license='CC0-1.0',
        unit='jurisdiction',
        r2_prefix='admin/bda-jurisdiction',
        notes='Single polygon. Useful as a boundary mask for any BDA-scoped analysis.',
    ),
    Dataset(
        id='bda_layouts',
        name='BDA Approved Layouts',
        src=str(HOME / 'GitHub/BDA/supporting-documents/bda layout boundaries.kml'),
        category='city-wards',
        level='bda_layouts',
        description='BDA-approved residential and commercial layout boundaries within the BDA jurisdiction.',
        source_org='Bengaluru Development Authority',
        source_url='https://data.opencity.in/dataset/bda-layouts',
        license='CC0-1.0',
        unit='layouts',
        r2_prefix='admin/bda-layouts',
        features=149,
    ),

    # ──────── Chennai ────────
    Dataset(
        id='wards_chennai',
        name='Chennai (GCC) Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/chennai/chennai-wards.kml'),
        category='city-wards',
        level='wards_chennai',
        description='Greater Chennai Corporation — 200 ward boundaries across the 15 zones. OpenCity states no licence for this dataset, so the layer keeps the ODbL-1.0 label used for OpenCity data and credits both OpenCity and Greater Chennai Corporation.',
        source_org='Greater Chennai Corporation',
        source_url='https://data.opencity.in/dataset/gcc-ward-information',
        license='ODbL-1.0',
        unit='wards',
        r2_prefix='admin/wards-chennai',
        features=200,
    ),

    # ──────── Hyderabad ────────
    # GHMC's own ward map (OpenCity "Greater Hyderabad Wards Map - 2022", updated
    # Feb 2026). Replaces the earlier 145-ward OpenStreetMap extract, which stays
    # in the catalog as wards_hyderabad_osm on its original R2 keys (immutable).
    Dataset(
        id='wards_hyderabad',
        name='Hyderabad (GHMC) Wards',
        src=str(SRC / 'ghmc_wards_2022.kml'),
        category='city-wards',
        level='wards_hyderabad',
        description=('Greater Hyderabad Municipal Corporation: 150 wards in 30 circles and 6 zones, from '
                     "GHMC's ward map (2022), plus 5 areas inside the outline that are no ward."),
        source_org='Greater Hyderabad Municipal Corporation',
        source_url='https://data.opencity.in/dataset/hyderabad-wards-info',
        license='CC0-1.0',
        unit='wards',
        r2_prefix='admin/wards-hyderabad-ghmc-2022',
        features=155,
        notes=('Each ward carries its number and name (ward, e.g. "127-RANGAREDDY NAGAR"), circle and zone. '
               'Five polygons are not wards and have no zone: Osmania University (OU), the '
               'Cantonment area, Peerzadiguda and Kalvancha gram panchayats, and Bandlaguda. This is the '
               '150-ward map in force before the 2025 merger of 27 towns into GHMC; the new 300-ward '
               'delimitation is not published as a map file yet. The earlier OpenStreetMap-derived '
               '145-ward map stays as Hyderabad Wards (OpenStreetMap, historical).'),
        kml_name_field='ward',
    ),

    # ──────── Mumbai ────────
    Dataset(
        id='wards_mumbai',
        name='Mumbai (BMC) Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/mumbai/mumbai-wards.kml'),
        category='city-wards',
        level='wards_mumbai',
        description='Brihanmumbai Municipal Corporation — 24 administrative wards (A–T plus the city-island spread).',
        source_org='Brihanmumbai Municipal Corporation',
        source_url='https://data.opencity.in/dataset/mumbai-wards-map',
        license='CC0-1.0',
        unit='wards',
        r2_prefix='admin/wards-mumbai',
        features=24,
    ),
    Dataset(
        id='electoral_wards_mumbai_2017',
        name='Mumbai Electoral Wards (2017)',
        src=str(HOME / 'GitHub/notf/supporting documents/mumbai/mumbai-227-electoral-wards-2017.geojson'),
        category='people',  # electoral → people-and-places
        level='electoral_wards_mumbai_2017',
        description='227 electoral ward divisions of Mumbai, 2017 delimitation. Use for election + civic-rep maps.',
        source_org='Mumbai State Election Commission',
        source_url='https://data.opencity.in/dataset/mumbai-wards-map',
        license='CC0-1.0',
        unit='electoral wards',
        r2_prefix='electoral/wards-mumbai-2017',
        features=227,
    ),

    # ──────── Kolkata ────────
    Dataset(
        id='wards_kolkata',
        name='Kolkata (KMC) Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/kolkata/kolkata-wards.kml'),
        category='city-wards',
        level='wards_kolkata',
        description='Kolkata Municipal Corporation — 141 ward boundaries across the 16 boroughs.',
        source_org='Kolkata Municipal Corporation',
        source_url='https://data.opencity.in/dataset/kolkata-wards-information',
        license='CC0-1.0',
        unit='wards',
        r2_prefix='admin/wards-kolkata',
        features=141,
    ),

    # ──────── Pune ────────
    Dataset(
        id='wards_pune',
        name='Pune (PMC) Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/pune/pune-wards.kml'),
        category='city-wards',
        level='wards_pune',
        description='Pune Municipal Corporation — 58 administrative wards.',
        source_org='Pune Municipal Corporation',
        source_url='https://data.opencity.in/dataset/pune-wards-info',
        license='CC0-1.0',
        unit='wards',
        r2_prefix='admin/wards-pune',
        features=58,
    ),

    # ──────── Ahmedabad ────────
    Dataset(
        id='wards_ahmedabad',
        name='Ahmedabad (AMC) Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/ahmedabad/ahmedabad-wards.kml'),
        category='city-wards',
        level='wards_ahmedabad',
        description='Ahmedabad Municipal Corporation — 48 wards across the 7 zones.',
        source_org='Ahmedabad Municipal Corporation',
        source_url='https://data.opencity.in/dataset/amdavad-municipal-corporation-wards-map-2024',
        license='CC0-1.0',
        unit='wards',
        r2_prefix='admin/wards-ahmedabad',
        features=48,
    ),

    # ──────── Jaipur ────────
    Dataset(
        id='wards_jaipur',
        name='Jaipur (JMC) Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/jaipur/jaipur-wards.kml'),
        category='city-wards',
        level='wards_jaipur',
        description='Jaipur Municipal Corporation — 150 ward boundaries.',
        source_org='Jaipur Municipal Corporation',
        source_url='https://data.opencity.in/dataset/jaipur-municipal-corporation-wards-map',
        license='CC0-1.0',
        unit='wards',
        r2_prefix='admin/wards-jaipur',
        features=150,
    ),

    # ──────── Gurugram ────────
    Dataset(
        id='wards_gurugram',
        name='Gurugram (MCG) Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/gurugram/gurugram-wards.kml'),
        category='city-wards',
        level='wards_gurugram',
        description='Municipal Corporation of Gurugram — 35 ward boundaries.',
        source_org='Municipal Corporation of Gurugram',
        source_url='https://data.opencity.in/dataset/gurugram-wards-map',
        license='CC0-1.0',
        unit='wards',
        r2_prefix='admin/wards-gurugram',
        features=35,
    ),

    # ──────── Kochi ────────
    Dataset(
        id='wards_kochi',
        name='Kochi (KMC) Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/kochi/kochi-wards.kml'),
        category='city-wards',
        level='wards_kochi',
        description="Kochi Municipal Corporation ward boundaries — 74 administrative wards covering the city. Sourced from Oorvani Foundation's OpenCity data portal.",
        source_org='Kochi Municipal Corporation',
        source_url='https://data.opencity.in/dataset/kochi-wards-map',
        license='CC0-1.0',
        unit='wards',
        r2_prefix='admin/wards-kochi',
        features=74,
    ),

    # ──────── Bhubaneshwar ────────
    Dataset(
        id='wards_bhubaneshwar',
        name='Bhubaneshwar (BMC) Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/bhubaneshwar/bhubaneshwar-wards.kml'),
        category='city-wards',
        level='wards_bhubaneshwar',
        description="Bhubaneshwar Municipal Corporation ward boundaries — 67 wards covering Odisha's capital city. Sourced from Oorvani Foundation's OpenCity data portal. OpenCity lists it as CC BY-SA without a version; labelled CC-BY-SA-4.0.",
        source_org='Bhubaneshwar Municipal Corporation',
        source_url='https://data.opencity.in/dataset/bhubaneswar-administrative-boundaries',
        license='CC-BY-SA-4.0',
        unit='wards',
        r2_prefix='admin/wards-bhubaneshwar',
        features=67,
    ),

    # ──────── Visakhapatnam ────────
    Dataset(
        id='wards_vizag',
        name='Visakhapatnam (GVMC) Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/vishakapatnam/vizag-wards.kml'),
        category='city-wards',
        level='wards_vizag',
        description='Greater Visakhapatnam Municipal Corporation — 98 wards.',
        source_org='Greater Visakhapatnam Municipal Corporation',
        source_url='https://data.opencity.in/dataset/visakhapatnam-wards-map-2024',
        license='CC0-1.0',
        unit='wards',
        r2_prefix='admin/wards-vizag',
        features=98,
    ),

    # ──────── Thane ────────
    Dataset(
        id='wards_thane',
        name='Thane (TMC) Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/thane/thane-wards.kml'),
        category='city-wards',
        level='wards_thane',
        description='Thane Municipal Corporation — 47 wards across the city.',
        source_org='Thane Municipal Corporation',
        source_url='https://data.opencity.in/dataset/thane-wards-map',
        license='CC0-1.0',
        unit='wards',
        r2_prefix='admin/wards-thane',
        features=47,
    ),

    # ──────── Delhi ────────
    Dataset(
        id='wards_delhi',
        name='Delhi Wards (MCD + NDMC + Cantonment)',
        src=str(HOME / 'GitHub/notf/supporting documents/delhi/delhi-wards.geojson'),
        category='city-wards',
        level='wards_delhi',
        description='Municipal Corporation of Delhi, NDMC, and Delhi Cantonment Board wards. 290 ward boundaries.',
        source_org='DataMeet',
        source_url='https://github.com/datameet/Municipal_Spatial_Data/tree/master/Delhi',
        license='CC-BY-SA-2.5-IN',
        unit='wards',
        r2_prefix='admin/wards-delhi',
        features=290,
        attr_key='DataMeet',
    ),

    # ──────── Indore ────────
    Dataset(
        id='wards_indore',
        name='Indore (IMC) Wards (2024)',
        src=str(HOME / 'GitHub/notf/supporting documents/indore/indore-wards.kml'),
        category='city-wards',
        level='wards_indore',
        description='Indore Municipal Corporation — 85 ward boundaries. 2024 delimitation.',
        source_org='Indore Municipal Corporation',
        source_url='https://data.opencity.in/dataset/indore-wards-map',
        license='CC0-1.0',
        unit='wards',
        r2_prefix='admin/wards-indore',
        features=85,
    ),

    # ──────── Coimbatore ────────
    Dataset(
        id='wards_coimbatore',
        name='Coimbatore (CCMC) Wards (2011)',
        src=str(HOME / 'GitHub/notf/supporting documents/coimbatore/coimbatore-wards.geojson'),
        category='city-wards',
        level='wards_coimbatore',
        description='Coimbatore City Municipal Corporation — 100 ward boundaries. Census 2011 reorganization.',
        source_org='DataMeet',
        source_url='https://github.com/datameet/Municipal_Spatial_Data/tree/master/Coimbatore',
        license='CC-BY-SA-2.5-IN',
        unit='wards',
        r2_prefix='admin/wards-coimbatore',
        features=100,
        attr_key='DataMeet',
    ),

    # ──────── Madurai ────────
    Dataset(
        id='wards_madurai',
        name='Madurai (MCM) Wards (2024)',
        src=str(HOME / 'GitHub/notf/supporting documents/madurai/madurai-wards.kml'),
        category='city-wards',
        level='wards_madurai',
        description='Madurai City Municipal Corporation — 100 ward boundaries. 2024 delimitation.',
        source_org='Madurai City Municipal Corporation',
        source_url='https://data.opencity.in/dataset/madurai-wards-map',
        license='CC0-1.0',
        unit='wards',
        r2_prefix='admin/wards-madurai',
        features=100,
    ),

    # ──────── Navi Mumbai ────────
    Dataset(
        id='wards_navi_mumbai',
        name='Navi Mumbai (NMMC) Wards (2024)',
        src=str(HOME / 'GitHub/notf/supporting documents/navi-mumbai/navi-mumbai-wards.kml'),
        category='city-wards',
        level='wards_navi_mumbai',
        description='Navi Mumbai Municipal Corporation — 111 ward boundaries. 2024 delimitation.',
        source_org='Navi Mumbai Municipal Corporation',
        source_url='https://data.opencity.in/dataset/navi-mumbai-wards-map',
        license='CC0-1.0',
        unit='wards',
        r2_prefix='admin/wards-navi-mumbai',
        features=111,
    ),

    # ──────── Guwahati ────────
    Dataset(
        id='wards_guwahati',
        name='Guwahati (GMC) Wards (2022)',
        src=str(HOME / 'GitHub/notf/supporting documents/guwahati/guwahati-wards.kml'),
        category='city-wards',
        level='wards_guwahati',
        description='Guwahati Municipal Corporation — 60 ward boundaries. 2022 delimitation.',
        source_org='Guwahati Municipal Corporation',
        source_url='https://data.opencity.in/dataset/guwahati-wards-information',
        license='CC0-1.0',
        unit='wards',
        r2_prefix='admin/wards-guwahati',
        features=60,
    ),

    # ──────── Mysuru ────────
    Dataset(
        id='wards_mysuru',
        name='Mysuru (MCC) Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/mysuru/mysuru-wards.kml'),
        category='city-wards',
        level='wards_mysuru',
        description='Mysuru City Corporation — 65 ward boundaries. OpenCity states no licence for this dataset, so the layer keeps the ODbL-1.0 label used for OpenCity data and credits both OpenCity and Mysuru City Corporation.',
        source_org='Mysuru City Corporation',
        source_url='https://data.opencity.in/dataset/mysuru-city-corporation-wards-info',
        license='ODbL-1.0',
        unit='wards',
        r2_prefix='admin/wards-mysuru',
        features=65,
    ),

    # ──────── Bhopal ────────
    Dataset(
        id='wards_bhopal',
        name='Bhopal (BMC) Wards (2024)',
        src=str(HOME / 'GitHub/notf/supporting documents/bhopal/bhopal-wards.geojson'),
        category='city-wards',
        level='wards_bhopal',
        description='Bhopal Municipal Corporation — 86 ward boundaries. 2024 delimitation.',
        source_org='Bhopal Municipal Corporation',
        source_url='https://data.opencity.in/dataset/bhopal-wards-map',
        license='CC0-1.0',
        unit='wards',
        r2_prefix='admin/wards-bhopal',
        features=86,
    ),

    # ──────── Chandigarh ────────
    Dataset(
        id='wards_chandigarh',
        name='Chandigarh (MC) Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/chandigarh/chandigarh-wards.geojson'),
        category='city-wards',
        level='wards_chandigarh',
        description='Municipal Corporation of Chandigarh — 28 ward boundaries.',
        source_org='DataMeet',
        source_url='https://github.com/datameet/Municipal_Spatial_Data/tree/master/Chandigarh',
        license='CC-BY-SA-2.5-IN',
        unit='wards',
        r2_prefix='admin/wards-chandigarh',
        features=28,
        attr_key='DataMeet',
    ),

    # ──────── Lucknow ────────
    Dataset(
        id='wards_lucknow',
        name='Lucknow (LMC) Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/lucknow/lucknow-wards.geojson'),
        category='city-wards',
        level='wards_lucknow',
        description='Lucknow Municipal Corporation — 112 ward boundaries.',
        source_org='DataMeet',
        source_url='https://github.com/datameet/Municipal_Spatial_Data/tree/master/Lucknow',
        license='CC-BY-4.0',
        unit='wards',
        r2_prefix='admin/wards-lucknow',
        features=112,
        attr_key='DataMeet',
    ),

    # ──────── Kanpur ────────
    Dataset(
        id='wards_kanpur',
        name='Kanpur (KMC) Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/kanpur/kanpur-wards.geojson'),
        category='city-wards',
        level='wards_kanpur',
        description='Kanpur Municipal Corporation — 58 ward boundaries.',
        source_org='DataMeet',
        source_url='https://github.com/datameet/Municipal_Spatial_Data/tree/master/Kanpur',
        license='CC-BY-4.0',
        unit='wards',
        r2_prefix='admin/wards-kanpur',
        features=58,
        attr_key='DataMeet',
    ),

    # ──────── Patna ────────
    Dataset(
        id='wards_patna',
        name='Patna (PMC) Wards (~2019)',
        src=str(HOME / 'GitHub/notf/supporting documents/patna/patna-wards-cleaned-keswani-2026-11.kml'),
        category='city-wards',
        level='wards_patna',
        description='Patna Municipal Corporation, 75 wards. Cleaned by Jayesh Keswani (Nov 2026): the upstream file repeats each ward many times (628 polygons, 115 distinct shapes) under two naming schemes; this version keeps one "Ward N" polygon per ward.',
        source_org='Jayesh Keswani (cleaned from datta07/INDIAN-SHAPEFILES)',
        source_url='https://github.com/datta07/INDIAN-SHAPEFILES/tree/master/METROPOLITAN%20CITIES',
        license='MIT',
        unit='wards',
        r2_prefix='admin/wards-patna',
        features=75,
        attr_key='Keswani',
    ),

    # ──────── Surat ────────
    Dataset(
        id='wards_surat',
        name='Surat (SMC) Wards (~2019)',
        src=str(HOME / 'GitHub/notf/supporting documents/surat/surat-wards.geojson'),
        category='city-wards',
        level='wards_surat',
        description='Surat Municipal Corporation — 30 ward boundaries with named wards.',
        source_org='datta07/INDIAN-SHAPEFILES',
        source_url='https://github.com/datta07/INDIAN-SHAPEFILES/tree/master/METROPOLITAN%20CITIES',
        license='MIT',
        unit='wards',
        r2_prefix='admin/wards-surat',
        features=30,
        attr_key='datta07',
    ),

    # ──────── Vadodara ────────
    Dataset(
        id='wards_vadodara',
        name='Vadodara (VMC) Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/vadodara/vadodara-wards.geojson'),
        category='city-wards',
        level='wards_vadodara',
        description='Vadodara Municipal Corporation — 12 administrative ward boundaries.',
        source_org='DataMeet',
        source_url='https://github.com/datameet/Municipal_Spatial_Data/tree/master/Vadodara',
        license='CC-BY-4.0',
        unit='wards',
        r2_prefix='admin/wards-vadodara',
        features=12,
        attr_key='DataMeet',
    ),

    # ──────── Faridabad ────────
    Dataset(
        id='wards_faridabad',
        name='Faridabad (MCF) Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/faridabad/faridabad-wards.geojson'),
        category='city-wards',
        level='wards_faridabad',
        description='Municipal Corporation of Faridabad — 40 ward boundaries.',
        source_org='DataMeet',
        source_url='https://github.com/datameet/Municipal_Spatial_Data/tree/master/Faridabad',
        license='CC-BY-4.0',
        unit='wards',
        r2_prefix='admin/wards-faridabad',
        features=40,
        attr_key='DataMeet',
    ),

    # ──────── Pimpri-Chinchwad ────────
    Dataset(
        id='wards_pcmc',
        name='Pimpri-Chinchwad (PCMC) Electoral Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/pimpri-chinchwad/pcmc-wards.geojson'),
        category='city-wards',
        level='wards_pcmc',
        description='Pimpri-Chinchwad Municipal Corporation — 66 electoral ward boundaries across 6 zones.',
        source_org='DataMeet',
        source_url='https://github.com/datameet/Municipal_Spatial_Data/tree/master/PCMC',
        license='CC-BY-4.0',
        unit='wards',
        r2_prefix='admin/wards-pcmc',
        features=66,
        attr_key='DataMeet',
    ),

    # ──────── Vijayawada ────────
    Dataset(
        id='wards_vijayawada',
        name='Vijayawada (VMC) Wards',
        src=str(HOME / 'GitHub/notf/supporting documents/vijayawada/vijayawada-wards.geojson'),
        category='city-wards',
        level='wards_vijayawada',
        description='Vijayawada Municipal Corporation — 77 ward boundaries.',
        source_org='DataMeet',
        source_url='https://github.com/datameet/Municipal_Spatial_Data/tree/master/Vijayawada',
        license='CC-BY-4.0',
        unit='wards',
        r2_prefix='admin/wards-vijayawada',
        features=77,
        attr_key='DataMeet',
    ),

    # ──────── Ward and zone batch (Nov 2026) ────────
    # Sources in data/external-src/ (gitignored), downloaded 2026-11-15:
    # OpenCity resources through a browser (Cloudflare challenge), DataMeet
    # from GitHub raw. CKAN license_id other-pd maps to CC0-1.0.
    Dataset(
        id='wards_kalyan_dombivli',
        name='Kalyan-Dombivli (KDMC) Wards',
        src=str(SRC / 'kdmc_wards.kml'),
        category='city-wards',
        level='wards_kalyan_dombivli',
        description='Kalyan-Dombivli Municipal Corporation: 123 electoral ward boundaries, with LGD ward codes.',
        source_org='Kalyan-Dombivli Municipal Corporation',
        source_url='https://data.opencity.in/dataset/kalyan-dombivli-wards-map',
        license='CC0-1.0',
        unit='wards',
        r2_prefix='admin/wards-kalyan-dombivli',
        features=123,
        kml_name_field='sourcewardcode',  # ward_lgd_name is empty for one polygon (9001)
    ),
    Dataset(
        id='zones_bengaluru_gba',
        name='Greater Bengaluru Zones (2025)',
        src=str(SRC / 'gba_zones_2025.kml'),
        category='city-wards',
        level='zones_bengaluru_gba',
        description='Greater Bengaluru Authority: 10 zones, two in each of its five corporations (2025).',
        source_org='Greater Bengaluru Authority',
        source_url='https://data.opencity.in/dataset/greater-bengaluru-authority-corporations-delimitation-2025',
        license='CC0-1.0',
        unit='zones',
        r2_prefix='admin/zones-bengaluru-gba',
        features=10,
        notes='Each zone carries its corporation (Corporatio) and zone (Zone).',
        kml_name_field='Zone',
    ),
    Dataset(
        id='wards_pune_2025',
        name='Pune (PMC) Administrative Wards (2025)',
        src=str(SRC / 'pune_admin_wards_2025.geojson'),
        category='city-wards',
        level='wards_pune_2025',
        description='Pune Municipal Corporation: 15 administrative wards (ward offices), 2025.',
        source_org='Pune Municipal Corporation',
        source_url='https://data.opencity.in/dataset/pune-wards-info',
        license='CC0-1.0',
        unit='wards',
        r2_prefix='admin/wards-pune-2025',
        features=15,
        kml_name_field='Field',
    ),
    Dataset(
        id='zones_pune',
        name='Pune (PMC) Zones',
        src=str(SRC / 'pmc_zones.kml'),
        category='city-wards',
        level='zones_pune',
        description='Pune Municipal Corporation: 5 zones (Deputy Municipal Commissioner zones).',
        source_org='Pune Municipal Corporation',
        source_url='https://data.opencity.in/dataset/pune-wards-info',
        license='CC0-1.0',
        unit='zones',
        r2_prefix='admin/zones-pune',
        features=5,
        kml_name_field='Zone_Name',
    ),
    Dataset(
        id='zones_chennai',
        name='Chennai (GCC) Zones',
        src=str(SRC / 'chennai_zones.geojson'),
        category='city-wards',
        level='zones_chennai',
        description='Greater Chennai Corporation: 15 zones, plus St. Thomas Mount as a 16th area, from Transparent Chennai via DataMeet.',
        source_org='DataMeet',
        source_url='https://github.com/datameet/Municipal_Spatial_Data/tree/master/Chennai',
        license='CC-BY-SA-2.5-IN',
        unit='zones',
        r2_prefix='admin/zones-chennai',
        features=16,
        attr_key='DataMeet',
        kml_name_field='Zone Name',
    ),
]


# ───────────────────── pipeline ─────────────────────

FORMATS = {'parquet': 'parquet', 'pmtiles': 'pmtiles', 'geojson': 'geojson', 'kml': 'kml', 'shapefile': 'shp.zip'}


def outputs(ds: Dataset, out_root: Path = OUT) -> dict[str, Path]:
    """Where each of the layer's files is built: its R2 key under out_root."""
    return {fmt: out_root / ds.r2_prefix / f'{ds.id}.{ext}' for fmt, ext in FORMATS.items()}


def tippecanoe_args(gj: Path, out: Path, layer_name: str) -> list[str]:
    """z0-z12 like every locate-able layer (rebake_locate_tiles), tileset named after the layer."""
    return tippecanoe_cmd(gj, out, layer_name)  # tippecanoe_cmd already names the tileset (-n)


def to_geojson(src: Path, out: Path) -> None:
    """KML or GeoJSON -> GeoJSON in EPSG:4326 (GeoJSON is always written lon,lat)."""
    out.unlink(missing_ok=True)
    subprocess.run(
        ['ogr2ogr', '-f', 'GeoJSON', '-t_srs', 'EPSG:4326',
         '-skipfailures', str(out), str(src)],
        check=True, capture_output=True,
    )


def to_parquet(gj: Path, out: Path) -> int:
    """GeoJSON -> Parquet with flat bbox columns in Hilbert order. Returns feature count."""
    return geojson_to_parquet(gj, out)


def to_pmtiles(gj: Path, out: Path, layer_name: str) -> None:
    out.unlink(missing_ok=True)
    subprocess.run(tippecanoe_args(gj, out, layer_name), check=True, capture_output=True)


def up_to_date(src: Path, files: dict[str, Path]) -> bool:
    return all(f.exists() and f.stat().st_mtime >= src.stat().st_mtime for f in files.values())


def build(ds: Dataset, out_root: Path = OUT) -> dict[str, Path]:
    """Build every format for one dataset under out_root; skip when already built from this source."""
    src = Path(ds.src)
    if not src.exists():
        raise FileNotFoundError(src)
    files = outputs(ds, out_root)
    if up_to_date(src, files):
        print(f'    skip  {ds.id}: built and newer than its source', flush=True)
        return files
    folder = files['parquet'].parent
    folder.mkdir(parents=True, exist_ok=True)
    for f in files.values():
        f.unlink(missing_ok=True)

    src_gj = folder / f'{ds.id}.src.geojson'
    to_geojson(src, src_gj)
    n = to_parquet(src_gj, files['parquet'])
    if ds.features and n != ds.features:
        print(f'    !!  feature count drifted: expected {ds.features}, got {n}', flush=True)
    to_pmtiles(src_gj, files['pmtiles'], ds.id)
    src_gj.unlink()

    baked = bake_whole_layer(ds, files['parquet'], bake_dir=folder, basename=ds.id)
    shutil.rmtree(folder / f'{ds.id}_shp', ignore_errors=True)
    missing = sorted(set(FORMATS) - {'parquet', 'pmtiles'} - set(baked))
    if missing:
        raise RuntimeError(f'{ds.id}: failed to bake {missing}')
    for fmt, f in files.items():
        print(f'    built {fmt:<9} {f.relative_to(out_root)}  ({f.stat().st_size:,} bytes)', flush=True)
    return files


def manifest_row(ds: Dataset, files: dict[str, Path]) -> dict:
    (n,) = duckdb.connect().execute(f"SELECT COUNT(*) FROM '{files['parquet']}'").fetchone()
    return {
        'id': ds.id,
        'name': ds.name,                # friendly label shown on the card
        'level': ds.level,
        'category': ds.category,
        'source': ds.attr_key,
        'description': ds.description,
        'unit': ds.unit,                # "wards" / "corporations" / "layouts" etc.
        'features': n,
        'license': ds.license,
        'r2_prefix': ds.r2_prefix,
        'parquet_file': files['parquet'].name,
        'parquet_bytes': files['parquet'].stat().st_size,
        'pmtiles_file': files['pmtiles'].name,
        'pmtiles_bytes': files['pmtiles'].stat().st_size,
        'source_url': ds.source_url,
        'source_org': ds.source_org,
        'notes': ds.notes,
    }


def merge_manifest(old: list[dict], new: list[dict]) -> list[dict]:
    """Replace rows by id where they stand and append new ids; every other row stays."""
    for row in new:
        old = upsert_by_id(old, row)
    return old


def save_manifest(rows: list[dict]) -> None:
    write_json(MANIFEST, merge_manifest(json.loads(MANIFEST.read_text()), rows))


def main(argv: list[str]) -> int:
    upload = '--no-upload' not in argv
    args = [a for a in argv[1:] if a != '--no-upload']
    missing = [k for k in ('CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY') if k not in os.environ]
    if upload and missing:
        sys.exit(f'missing env: {", ".join(missing)} (or pass --no-upload)')

    filt = args[0] if args else None
    todo = [d for d in DATASETS if not filt or filt in d.id]
    if not todo:
        sys.exit(f'no datasets match "{filt}"')

    print(f'ingesting {len(todo)} dataset(s)' + ('' if upload else ' (local build only)'), flush=True)
    s3 = r2_client() if upload else None
    rows = []
    for ds in todo:
        print(f'  {ds.id}  ({ds.src})', flush=True)
        try:
            files = build(ds)
        except Exception as e:
            print(f'    FAIL  {ds.id}: {e}', flush=True)
            continue
        if s3:
            for f in files.values():
                r2_upload(s3, f, f'{ds.r2_prefix}/{f.name}')
        rows.append(manifest_row(ds, files))

    if s3:
        save_manifest(rows)
        print(f'\nmerged {len(rows)}/{len(todo)} row(s) into {MANIFEST.relative_to(ROOT)}', flush=True)
        print('Next: patch catalog.json for these layers (patch in place; do not rebuild).', flush=True)
    else:
        print(f'\nbuilt {len(rows)}/{len(todo)} locally; R2 and {MANIFEST.name} untouched', flush=True)
    return 0 if len(rows) == len(todo) else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
