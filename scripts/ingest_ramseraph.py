#!/usr/bin/env python3
"""
Ingest pre-baked layers from ramSeraph GitHub releases into the bharatlas
catalog.

Unlike scripts/ingest_external.py (which re-bakes parquet+pmtiles from KML
or GeoJSON sources via tippecanoe + duckdb-spatial), ramSeraph publishes
ready-to-use parquet and pmtiles in GitHub release assets. This script:

  1. Downloads the parquet + pmtiles from the release URL
  2. Re-bakes the parquet to flatten ramSeraph's `bbox` STRUCT column into
     flat top-level xmin/ymin/xmax/ymax columns so the catalog's bbox-based
     centroid logic (web/functions/lib/parquet-query.ts FIX #3) works
     unchanged for these layers
  3. Counts features for the catalog card
  4. Uploads both files to R2 (geodata-data bucket) under r2_prefix/
  5. Appends to scripts/external-ingested.json (for future build_catalog.py runs)
  6. Patches catalog.json in place (so the layer is live without a rebuild
     — per the patch-catalog-not-rebuild rule)

Run:
    pip install boto3 duckdb requests
    set -a; source web/.dev.vars; set +a   # CLOUDFLARE_ACCOUNT_ID + R2 keys
    python3 scripts/ingest_ramseraph.py vedas_power_plants  # one layer
    python3 scripts/ingest_ramseraph.py vedas               # category prefix
    python3 scripts/ingest_ramseraph.py                     # all layers
    python3 scripts/ingest_ramseraph.py sbm --no-upload     # build locally, touch nothing live

Idempotent: skips each R2 upload whose stored md5 matches the local file
(sizes alone miss a lat,lon swap); manifest and catalog merges are id-keyed.
"""
from __future__ import annotations
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.request
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import boto3
import duckdb
from botocore.config import Config
from boto3.s3.transfer import TransferConfig

ROOT = Path(__file__).resolve().parent.parent
WORK = Path('/tmp/ramseraph')
WORK.mkdir(exist_ok=True)

BUCKET = 'geodata-data'
R2_PUBLIC = 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev'

CONTENT_TYPES = {
    '.parquet': 'application/vnd.apache.parquet',
    '.pmtiles': 'application/vnd.pmtiles',
    '.geojson': 'application/geo+json',
    '.kml':     'application/vnd.google-earth.kml+xml',
    '.zip':     'application/zip',  # for *.shp.zip
}

# Size policy lifted from scripts/bake_whole_layer.py: whole-layer
# geojson/kml/shapefile bakes only run when the source parquet is small
# enough that the GeoJSON expansion (typically 3-5x parquet) is still
# tractable as a single download. Anything larger is gated to per-state
# slices in the viewer.
WHOLE_LAYER_MAX_MB = int(os.environ.get('WHOLE_LAYER_MAX_MB', '100'))


@dataclass
class Dataset:
    id: str                 # catalog id (snake_case, unique)
    name: str               # display label on the home card
    level: str              # one per layer
    category: str           # boundaries|environment|agriculture|transport|infrastructure|...
    source: str             # primary source key in build_catalog.py ATTR
    description: str        # one-liner for the card
    unit: str               # 'power plants', 'lakes', 'roads', etc.
    license: str            # SPDX-like; must be in OPEN_LICENCES
    r2_prefix: str          # path under R2 bucket
    parquet_url: str        # ramSeraph release asset URL
    pmtiles_url: str        # ramSeraph release asset URL
    source_url: str         # canonical upstream link
    source_org: str         # primary attribution org (e.g. 'ISRO VEDAS Energymap')
    notes: str              # mentions ramSeraph as compiler
    bake_all_formats: bool = False  # bake geojson/kml/shapefile even above WHOLE_LAYER_MAX_MB
    kml_name_field: str = ''        # column that names each KML Placemark (map labels)
    shp_split_by: str = ''          # one shapefile per value of this column (keeps each .dbf < 2 GB)


# ─────────────────────────────────────────────────────────────────────
# v2 ingest plan (project_candidate_layers_ingest memory):
#   PMGSY (1) → WRIS (2) → SLUSI (3) → VEDAS power (4)
# Starting with VEDAS power plants as the smallest proof point (~30 KB).
# ─────────────────────────────────────────────────────────────────────

POWER_BASE = 'https://github.com/ramSeraph/indian_power_infra/releases/download/power-sources'
POWER_LINES_BASE = 'https://github.com/ramSeraph/indian_power_infra/releases/download/power-lines'
WATER_WB_BASE = 'https://github.com/ramSeraph/indian_water_features/releases/download/waterbodies'
WATER_RIVERS_BASE = 'https://github.com/ramSeraph/indian_water_features/releases/download/rivers'
WATER_HYDRO_BASE = 'https://github.com/ramSeraph/indian_water_features/releases/download/hydro-boundaries'
LAND_SOIL_BASE = 'https://github.com/ramSeraph/indian_land_features/releases/download/soil-health'
PMGSY_ROADS_BASE = 'https://github.com/ramSeraph/indian_transport/releases/download/pmgsy-roads'
PMGSY_HAB_BASE = 'https://github.com/ramSeraph/indian_admin_boundaries/releases/download/habitations'
ND_FLOODS_BASE = 'https://github.com/ramSeraph/india_natural_disasters/releases/download/floods'
ND_LANDSLIDES_BASE = 'https://github.com/ramSeraph/india_natural_disasters/releases/download/landslides'
ND_EARTHQUAKES_BASE = 'https://github.com/ramSeraph/india_natural_disasters/releases/download/earthquakes'
ND_CYCLONES_BASE = 'https://github.com/ramSeraph/india_natural_disasters/releases/download/cyclones'

RAMSERAPH_NOTE = (
    'Pre-baked parquet + pmtiles compiled by ramSeraph/indianopenmaps '
    '(DataMeet community) from {src}.'
)


SBM_URBAN_BASE = 'https://github.com/ramSeraph/indian_admin_boundaries/releases/download/urban'
SBM_NOTE = RAMSERAPH_NOTE.format(src='Swachh Bharat Mission (Urban) GIS') + (
    ' Licence: CC0 1.0 from the compiler (the government source states none);'
    ' credit DataMeet and Swachh Bharat Mission (Urban). Records span Oct 2021 to Jan 2025.'
)

FAC_HEALTH_BASE = 'https://github.com/ramSeraph/indian_facilities/releases/download/health'
FAC_EDU_BASE = 'https://github.com/ramSeraph/indian_facilities/releases/download/education'

RS = 'https://github.com/ramSeraph'


def republished(id: str, name: str, category: str, source: str, release: str, file: str,
                description: str, unit: str, source_url: str, source_org: str,
                kml_name_field: str, r2_prefix: str, **kw) -> Dataset:
    """A government layer republished under bharatlas's sources policy (B):
    the publisher states no open licence, so the compiler's CC0 applies and
    the publisher is credited. `release` is '<repo>/<tag>' under ramSeraph."""
    base = f'{RS}/{release.split("/")[0]}/releases/download/{release.split("/")[1]}/{file}'
    return Dataset(
        id=id, name=name, level=id, category=category, source=source, description=description,
        unit=unit, license='CC0-1.0', r2_prefix=r2_prefix,
        parquet_url=f'{base}.parquet', pmtiles_url=f'{base}.pmtiles',
        source_url=source_url, source_org=source_org,
        notes=RAMSERAPH_NOTE.format(src=source_org) + (
            ' The publisher states no open licence; republished with credit under'
            ' bharatlas.com/about#sources-and-licensing (CC0 1.0 from the compiler).'),
        bake_all_formats=True, kml_name_field=kml_name_field, **kw)


DATASETS: list[Dataset] = [
    # ── 1. PMGSY (transport / settlements) ─────────────────────────────
    Dataset(
        id='pmgsy_roads',
        name='Rural roads (PMGSY 2024)',
        level='pmgsy_roads',
        category='transport',
        source='PMGSY',
        description='Pan-India rural road network built or in progress under PMGSY-I/II/III. Complements national highways.',
        unit='road segments',
        license='GODL-India',
        r2_prefix='transport/pmgsy-roads',
        parquet_url=f'{PMGSY_ROADS_BASE}/pmgsy_roads.parquet',
        pmtiles_url=f'{PMGSY_ROADS_BASE}/pmgsy_roads.pmtiles',
        source_url='https://omms.nic.in/',
        source_org='PMGSY GeoSadak (Ministry of Rural Development)',
        notes=RAMSERAPH_NOTE.format(src='PMGSY GeoSadak / OMMS'),
    ),
    Dataset(
        id='pmgsy_habitations',
        name='Rural habitations (PMGSY 2024)',
        level='pmgsy_habitations',
        category='boundaries',
        source='PMGSY',
        description='Point locations of rural habitations registered under PMGSY. Finer than village polygons; finer than the LGD village hierarchy.',
        unit='habitations',
        license='GODL-India',
        r2_prefix='boundaries/pmgsy-habitations',
        parquet_url=f'{PMGSY_HAB_BASE}/PMGSY_Habitations.parquet',
        pmtiles_url=f'{PMGSY_HAB_BASE}/PMGSY_Habitations.pmtiles',
        source_url='https://omms.nic.in/',
        source_org='PMGSY GeoSadak (Ministry of Rural Development)',
        notes=RAMSERAPH_NOTE.format(src='PMGSY GeoSadak / OMMS') + ' Updated 20 Oct 2024.',
    ),

    # ── 2. WRIS water family (environment) ─────────────────────────────
    Dataset(
        id='wris_lakes',
        name='Lakes (WRIS 2024)',
        level='wris_lakes',
        category='environment',
        source='CWC',
        description='Lake polygons across India from the Central Water Commission Water Resources Information System.',
        unit='lakes',
        license='CC0-1.0',
        r2_prefix='environment/wris-lakes',
        parquet_url=f'{WATER_WB_BASE}/WRIS_Lakes.parquet',
        pmtiles_url=f'{WATER_WB_BASE}/WRIS_Lakes.pmtiles',
        source_url='https://indiawris.gov.in/',
        source_org='Central Water Commission (WRIS)',
        notes=RAMSERAPH_NOTE.format(src='CWC WRIS lakes layer'),
    ),
    Dataset(
        id='wris_waterbodies',
        name='Waterbodies (WRIS 2024)',
        level='wris_waterbodies',
        category='environment',
        source='CWC',
        description='Surface waterbody polygons from CWC WRIS — covers ponds, tanks, reservoirs and natural waterbodies beyond named lakes.',
        unit='waterbodies',
        license='CC0-1.0',
        r2_prefix='environment/wris-waterbodies',
        parquet_url=f'{WATER_WB_BASE}/WRIS_Waterbodies.parquet',
        pmtiles_url=f'{WATER_WB_BASE}/WRIS_Waterbodies.pmtiles',
        source_url='https://indiawris.gov.in/',
        source_org='Central Water Commission (WRIS)',
        notes=RAMSERAPH_NOTE.format(src='CWC WRIS waterbodies layer'),
    ),
    Dataset(
        id='wris_river_polygons',
        name='River polygons (WRIS 2024)',
        level='wris_river_polygons',
        category='environment',
        source='CWC',
        description='Rivers as polygon geometry from CWC WRIS — complements the existing line-geometry river network for area-based queries.',
        unit='river polygons',
        license='CC0-1.0',
        r2_prefix='environment/wris-river-polygons',
        parquet_url=f'{WATER_RIVERS_BASE}/WRIS_River_Polygons.parquet',
        pmtiles_url=f'{WATER_RIVERS_BASE}/WRIS_River_Polygons.pmtiles',
        source_url='https://indiawris.gov.in/',
        source_org='Central Water Commission (WRIS)',
        notes=RAMSERAPH_NOTE.format(src='CWC WRIS river polygons layer'),
    ),
    Dataset(
        id='wris_watersheds',
        name='Watersheds (WRIS 2024)',
        level='wris_watersheds',
        category='environment',
        source='CWC',
        description='Watershed boundary polygons from CWC WRIS — the tier below sub-basin in the hydrology hierarchy.',
        unit='watersheds',
        license='CC0-1.0',
        r2_prefix='environment/wris-watersheds',
        parquet_url=f'{WATER_HYDRO_BASE}/WRIS_Watershed.parquet',
        pmtiles_url=f'{WATER_HYDRO_BASE}/WRIS_Watershed.pmtiles',
        source_url='https://indiawris.gov.in/',
        source_org='Central Water Commission (WRIS)',
        notes=RAMSERAPH_NOTE.format(src='CWC WRIS watersheds layer'),
    ),

    # ── 3. SLUSI (environment / agriculture) ───────────────────────────
    Dataset(
        id='slusi_micro_watersheds',
        name='Micro-watersheds (SLUSI)',
        level='slusi_micro_watersheds',
        category='environment',
        source='SLUSI',
        description='Micro-watershed boundary polygons across India from the Soil and Land Use Survey of India — the finest watershed delineation in the hydrology hierarchy.',
        unit='micro-watersheds',
        license='CC0-1.0',
        r2_prefix='environment/slusi-micro-watersheds',
        parquet_url=f'{WATER_HYDRO_BASE}/SLUSI_MicroWatersheds.parquet',
        pmtiles_url=f'{WATER_HYDRO_BASE}/SLUSI_MicroWatersheds.pmtiles',
        source_url='https://slusi.dacnet.nic.in/',
        source_org='SLUSI (Soil & Land Use Survey of India)',
        notes=RAMSERAPH_NOTE.format(src='SLUSI hydro boundaries'),
    ),
    Dataset(
        id='slusi_soil_health',
        name='Soil health (SLUSI 2020-23 snapshot)',
        level='slusi_soil_health',
        category='agriculture',
        source='SLUSI',
        description='Soil health cards / soil-suitability polygons across India from SLUSI. Vintage snapshot; the upstream refresh cadence is multi-year.',
        unit='soil polygons',
        license='CC0-1.0',
        r2_prefix='agriculture/slusi-soil-health',
        parquet_url=f'{LAND_SOIL_BASE}/SLUSI_SHC.parquet',
        # SLUSI soil pmtiles is 1.77 GB — defer to a follow-up; ship parquet
        # only first so the layer's filter + download surface is live without
        # bloating the home map. Set pmtiles_url='' to opt out.
        pmtiles_url='',
        source_url='https://slusi.dacnet.nic.in/',
        source_org='SLUSI (Soil & Land Use Survey of India)',
        notes=RAMSERAPH_NOTE.format(src='SLUSI Soil Health Card layer') + ' Parquet-only; pmtiles deferred (1.77 GB; oversized for the viewer).',
    ),

    # ── 4. VEDAS power family (infrastructure) ─────────────────────────
    Dataset(
        id='vedas_power_plants',
        name='Power plants (VEDAS 2023)',
        level='vedas_power_plants',
        category='infrastructure',
        source='VEDAS',
        description='Thermal, hydro, nuclear and renewable power plant points across India, including installed capacity.',
        unit='power plants',
        license='CC0-1.0',
        r2_prefix='infra/vedas-power-plants',
        parquet_url=f'{POWER_BASE}/Vedas_Power_Plants.parquet',
        pmtiles_url=f'{POWER_BASE}/Vedas_Power_Plants.pmtiles',
        source_url='https://vedas.sac.gov.in/energymap/',
        source_org='ISRO VEDAS Energymap',
        notes=RAMSERAPH_NOTE.format(src='ISRO VEDAS energymap'),
    ),
    Dataset(
        id='vedas_transmission_lines',
        name='Power transmission lines (VEDAS)',
        level='vedas_transmission_lines',
        category='infrastructure',
        source='VEDAS',
        # VEDAS transmission lines specifically carry ODbL not CC0 per the
        # release body — likely OSM-derived. Surface that distinction.
        description='High-voltage transmission line geometry across India. Licence differs from the rest of the VEDAS family — ODbL because the source is OSM-derived.',
        unit='transmission line segments',
        license='ODbL-1.0',
        r2_prefix='infra/vedas-transmission-lines',
        parquet_url=f'{POWER_LINES_BASE}/Vedas_Power_Transmission_Lines.parquet',
        pmtiles_url=f'{POWER_LINES_BASE}/Vedas_Power_Transmission_Lines.pmtiles',
        source_url='https://vedas.sac.gov.in/energymap/',
        source_org='ISRO VEDAS Energymap (OSM-derived)',
        notes=RAMSERAPH_NOTE.format(src='ISRO VEDAS energymap (transmission lines)') + ' OSM-derived per release body — ODbL applies.',
    ),
    Dataset(
        id='vedas_oil_refineries',
        name='Oil refineries (VEDAS)',
        level='vedas_oil_refineries',
        category='infrastructure',
        source='VEDAS',
        description='Oil refinery point locations across India.',
        unit='refineries',
        license='CC0-1.0',
        r2_prefix='infra/vedas-oil-refineries',
        parquet_url=f'{POWER_BASE}/Vedas_Oil_Refineries.parquet',
        pmtiles_url=f'{POWER_BASE}/Vedas_Oil_Refineries.pmtiles',
        source_url='https://vedas.sac.gov.in/energymap/',
        source_org='ISRO VEDAS Energymap',
        notes=RAMSERAPH_NOTE.format(src='ISRO VEDAS energymap'),
    ),
    Dataset(
        id='vedas_oil_wells',
        name='Oil wells (VEDAS)',
        level='vedas_oil_wells',
        category='infrastructure',
        source='VEDAS',
        description='Oil well point locations across India.',
        unit='oil wells',
        license='CC0-1.0',
        r2_prefix='infra/vedas-oil-wells',
        parquet_url=f'{POWER_BASE}/Vedas_Oil_Wells.parquet',
        pmtiles_url=f'{POWER_BASE}/Vedas_Oil_Wells.pmtiles',
        source_url='https://vedas.sac.gov.in/energymap/',
        source_org='ISRO VEDAS Energymap',
        notes=RAMSERAPH_NOTE.format(src='ISRO VEDAS energymap'),
    ),
    Dataset(
        id='vedas_wind_farms',
        name='Wind farms (VEDAS)',
        level='vedas_wind_farms',
        category='infrastructure',
        source='VEDAS',
        description='Wind farm point locations across India.',
        unit='wind farms',
        license='CC0-1.0',
        r2_prefix='infra/vedas-wind-farms',
        parquet_url=f'{POWER_BASE}/Vedas_Wind_Farms.parquet',
        pmtiles_url=f'{POWER_BASE}/Vedas_Wind_Farms.pmtiles',
        source_url='https://vedas.sac.gov.in/energymap/',
        source_org='ISRO VEDAS Energymap',
        notes=RAMSERAPH_NOTE.format(src='ISRO VEDAS energymap'),
    ),
    Dataset(
        id='vedas_ethanol_plants',
        name='Ethanol plants (VEDAS)',
        level='vedas_ethanol_plants',
        category='infrastructure',
        source='VEDAS',
        description='Ethanol production plant locations across India.',
        unit='ethanol plants',
        license='CC0-1.0',
        r2_prefix='infra/vedas-ethanol-plants',
        parquet_url=f'{POWER_BASE}/Vedas_Ethanol_Plants.parquet',
        pmtiles_url=f'{POWER_BASE}/Vedas_Ethanol_Plants.pmtiles',
        source_url='https://vedas.sac.gov.in/energymap/',
        source_org='ISRO VEDAS Energymap',
        notes=RAMSERAPH_NOTE.format(src='ISRO VEDAS energymap'),
    ),
    Dataset(
        id='vedas_solar_plants',
        name='Solar power plants (VEDAS)',
        level='vedas_solar_plants',
        category='infrastructure',
        source='VEDAS',
        description='Solar power plant point locations across India.',
        unit='solar plants',
        license='CC0-1.0',
        r2_prefix='infra/vedas-solar-plants',
        parquet_url=f'{POWER_BASE}/Vedas_Solar_Power_Plants.parquet',
        pmtiles_url=f'{POWER_BASE}/Vedas_Solar_Power_Plants.pmtiles',
        source_url='https://vedas.sac.gov.in/energymap/',
        source_org='ISRO VEDAS Energymap',
        notes=RAMSERAPH_NOTE.format(src='ISRO VEDAS energymap'),
    ),
    Dataset(
        id='vedas_solar_panel_areas',
        name='Solar panel areas (VEDAS)',
        level='vedas_solar_panel_areas',
        category='infrastructure',
        source='VEDAS',
        description='Solar panel array polygon boundaries across India.',
        unit='solar panel areas',
        license='CC0-1.0',
        r2_prefix='infra/vedas-solar-panel-areas',
        parquet_url=f'{POWER_BASE}/Vedas_Solar_Panel_Areas.parquet',
        pmtiles_url=f'{POWER_BASE}/Vedas_Solar_Panel_Areas.pmtiles',
        source_url='https://vedas.sac.gov.in/energymap/',
        source_org='ISRO VEDAS Energymap',
        notes=RAMSERAPH_NOTE.format(src='ISRO VEDAS energymap'),
    ),
    # ── Wave 2 — natural disasters (environment category) ──────────────
    Dataset(
        id='ndem_floods_1998_2022',
        name='Flood inundation 1998-2022 (NDEM)',
        level='ndem_floods_1998_2022',
        category='environment',
        source='NDEM',
        description='Pan-India satellite-derived flood inundation polygons from 1998 to 2022, compiled by NDEM (NRSC/ISRO). Complements the older India Flood Inventory v3 event catalogue.',
        unit='flood inundation polygons',
        license='CC0-1.0',
        r2_prefix='environment/ndem-floods-1998-2022',
        parquet_url=f'{ND_FLOODS_BASE}/NDEM_All_India_Flood_Innundation_1998_to_2022.parquet',
        pmtiles_url=f'{ND_FLOODS_BASE}/NDEM_All_India_Flood_Innundation_1998_to_2022.pmtiles',
        source_url='https://ndem.nrsc.gov.in/',
        source_org='NDEM (NRSC / ISRO)',
        notes=RAMSERAPH_NOTE.format(src='NDEM all-India flood inundation 1998-2022'),
    ),
    Dataset(
        id='gsi_landslide_inventory',
        name='Landslide inventory (GSI)',
        level='gsi_landslide_inventory',
        category='environment',
        source='GSI',
        description='Geological Survey of India landslide inventory — pan-India catalogue of historical landslide occurrences with metadata.',
        unit='landslides',
        license='CC0-1.0',
        r2_prefix='environment/gsi-landslide-inventory',
        parquet_url=f'{ND_LANDSLIDES_BASE}/GSI_Landslide_Inventory.parquet',
        pmtiles_url=f'{ND_LANDSLIDES_BASE}/GSI_Landslide_Inventory.pmtiles',
        source_url='https://gsi.gov.in/',
        source_org='Geological Survey of India',
        notes=RAMSERAPH_NOTE.format(src='GSI landslide inventory'),
    ),
    Dataset(
        id='ndem_landslide_hazard',
        name='Landslide hazard zones (NDEM)',
        level='ndem_landslide_hazard',
        category='environment',
        source='NDEM',
        description='Landslide hazard zonation polygons across India from NDEM, classifying terrain by landslide susceptibility.',
        unit='hazard zones',
        license='CC0-1.0',
        r2_prefix='environment/ndem-landslide-hazard',
        parquet_url=f'{ND_LANDSLIDES_BASE}/NDEM_Landslide_Hazard.parquet',
        pmtiles_url=f'{ND_LANDSLIDES_BASE}/NDEM_Landslide_Hazard.pmtiles',
        source_url='https://ndem.nrsc.gov.in/',
        source_org='NDEM (NRSC / ISRO)',
        notes=RAMSERAPH_NOTE.format(src='NDEM landslide hazard zonation'),
    ),
    Dataset(
        id='ngdr_earthquakes',
        name='Earthquake epicentres (NGDR)',
        level='ngdr_earthquakes',
        category='environment',
        source='NGDR',
        description='Historical earthquake epicentre points across India from the National Geoscience Data Repository (GSI Bhukosh). Complements the BIS IS 1893:2016 seismic hazard zones we already host.',
        unit='earthquake events',
        license='CC0-1.0',
        r2_prefix='environment/ngdr-earthquakes',
        parquet_url=f'{ND_EARTHQUAKES_BASE}/NGDR_Earthquakes.parquet',
        pmtiles_url=f'{ND_EARTHQUAKES_BASE}/NGDR_Earthquakes.pmtiles',
        source_url='https://bhukosh.gsi.gov.in/',
        source_org='NGDR / GSI Bhukosh',
        notes=RAMSERAPH_NOTE.format(src='NGDR earthquake epicentres'),
    ),
    # Overture places moved to scripts/bake_overture_places.py (baked straight
    # from Overture's releases; this mirror stopped at the Dec 2023 alpha).

    Dataset(
        id='ndem_cyclone_tracks',
        name='Cyclone tracks (NDEM)',
        level='ndem_cyclone_tracks',
        category='environment',
        source='NDEM',
        description='Historical cyclone track line geometries across the Indian Ocean basins, compiled by NDEM.',
        unit='cyclone tracks',
        license='CC0-1.0',
        r2_prefix='environment/ndem-cyclone-tracks',
        parquet_url=f'{ND_CYCLONES_BASE}/NDEM_Cyclones_ctl.parquet',
        pmtiles_url=f'{ND_CYCLONES_BASE}/NDEM_Cyclones_ctl.pmtiles',
        source_url='https://ndem.nrsc.gov.in/',
        source_org='NDEM (NRSC / ISRO)',
        notes=RAMSERAPH_NOTE.format(src='NDEM cyclone track lines') + ' Line geometry — see ndem_cyclones_ctp for the time-step point positions when needed.',
    ),

    Dataset(
        id='vedas_solar_panels_ai_2023',
        name='Solar panels — AI-detected (VEDAS 2023)',
        level='vedas_solar_panels_ai_2023',
        category='infrastructure',
        source='VEDAS',
        description='AI-derived solar panel footprints across India from VEDAS, 2023 snapshot. Complements the manually curated solar plants layer.',
        unit='solar panels',
        license='CC0-1.0',
        r2_prefix='infra/vedas-solar-panels-ai-2023',
        parquet_url=f'{POWER_BASE}/Vedas_Solar_Panels_AI_2023.parquet',
        pmtiles_url=f'{POWER_BASE}/Vedas_Solar_Panels_AI_2023.pmtiles',
        source_url='https://vedas.sac.gov.in/energymap/',
        source_org='ISRO VEDAS Energymap',
        notes=RAMSERAPH_NOTE.format(src='ISRO VEDAS energymap (AI-derived)'),
    ),
    # ── SBM urban local bodies + wards (Nov 2026) ──────────────────────
    # National coverage (3,300 ULBs, 70k wards). Published as the source has
    # it; city ward layers stay the better answer where bharatlas has them.
    Dataset(
        id='sbm_wards',
        name='Urban wards, all India (SBM)',
        level='sbm_wards',
        category='city-wards',
        source='SBM',
        description=('Ward boundaries for about 3,300 towns and cities from Swachh Bharat Mission (Urban). '
                     'Quality varies by town: some repeat wards or use an older delimitation, so where '
                     'bharatlas has a city ward map, prefer it. No data for West Bengal, Tripura, Mizoram or Manipur.'),
        unit='wards',
        license='CC0-1.0',
        r2_prefix='boundaries/sbm-wards',
        parquet_url=f'{SBM_URBAN_BASE}/SBM_Wards.parquet',
        pmtiles_url=f'{SBM_URBAN_BASE}/SBM_Wards.pmtiles',
        source_url='https://sbmurban.org/',
        source_org='Swachh Bharat Mission (Urban), MoHUA',
        notes=SBM_NOTE,
        bake_all_formats=True,
        kml_name_field='wardname',
    ),
    Dataset(
        id='sbm_ulbs',
        name='Towns and cities, all India (SBM)',
        level='sbm_ulbs',
        category='boundaries',
        source='SBM',
        description=('Boundaries of about 3,370 urban local bodies (municipal corporations, councils and '
                     'nagar panchayats) from Swachh Bharat Mission (Urban). No data for Tripura, Mizoram or Manipur.'),
        unit='towns and cities',
        license='CC0-1.0',
        r2_prefix='boundaries/sbm-ulbs',
        parquet_url=f'{SBM_URBAN_BASE}/SBM_ULBs.parquet',
        pmtiles_url=f'{SBM_URBAN_BASE}/SBM_ULBs.pmtiles',
        source_url='https://sbmurban.org/',
        source_org='Swachh Bharat Mission (Urban), MoHUA',
        notes=SBM_NOTE,
        bake_all_formats=True,
        kml_name_field='ulbnm',
    ),
    # ── Facilities batch (Nov 2026) ────────────────────────────────────
    # Licences traced to the original: hospitals = data.gov.in (GODL);
    # schools = NCOG states no terms, so the compiler's CC0 applies. Held
    # (original requires permission): RBI branches, PostalGIS. IR stations/tracks
    # came in later under policy B (see below).
    Dataset(
        id='nhp_hospitals',
        name='Hospitals directory (NHP 2025)',
        level='nhp_hospitals',
        category='health-edu',
        source='NHP',
        description=('Hospitals listed in the National Health Portal directory, with category, care type, '
                     'system of medicine, address and phone numbers. About 170 entries have coordinates '
                     'outside India in the source.'),
        unit='hospitals',
        license='GODL-India',
        r2_prefix='healthcare/nhp-hospitals',
        parquet_url=f'{FAC_HEALTH_BASE}/NHP_Hospital_Directory_2025.parquet',
        pmtiles_url=f'{FAC_HEALTH_BASE}/NHP_Hospital_Directory_2025.pmtiles',
        source_url='https://www.data.gov.in/',
        source_org='National Health Portal (MoHFW), via data.gov.in',
        notes=RAMSERAPH_NOTE.format(src='the data.gov.in NHP hospital directory') + ' Licence: GODL-India.',
        bake_all_formats=True,
        kml_name_field='Hospital_Name',
    ),
    Dataset(
        id='nin_health_facilities',
        name='Health facilities (NIN 2025)',
        level='nin_health_facilities',
        category='health-edu',
        source='NHP',
        description=('Public health facilities registered with a National Identification Number (NIN): '
                     'sub-centres, primary and community health centres and hospitals, with address and type.'),
        unit='health facilities',
        license='GODL-India',
        r2_prefix='healthcare/nin-health-facilities',
        parquet_url=f'{FAC_HEALTH_BASE}/Datagov_NIN_Health_Facilties_2025.parquet',
        pmtiles_url=f'{FAC_HEALTH_BASE}/Datagov_NIN_Health_Facilties_2025.pmtiles',
        source_url='https://www.data.gov.in/',
        source_org='National Health Portal (MoHFW), via data.gov.in',
        notes=RAMSERAPH_NOTE.format(src='the data.gov.in NIN health facilities list') + ' Licence: GODL-India.',
        bake_all_formats=True,
        kml_name_field='health_facility_name',
    ),
    Dataset(
        id='udise_schools',
        name='Schools (UDISE)',
        level='udise_schools',
        category='health-edu',
        source='UDISE',
        description=('About 2.9 million schools from UDISE (Ministry of Education) as mapped by NCOG: '
                     'UDISE code, management, category, year established, enrolment, teachers, '
                     'electricity and drinking water, with LGD state and district codes. About 920,000 '
                     'schools have no state or district in the source; the shapefile has one file per state.'),
        unit='schools',
        license='CC0-1.0',
        r2_prefix='education/udise-schools',
        parquet_url=f'{FAC_EDU_BASE}/NCOG_UDISE_Schools.parquet',
        pmtiles_url=f'{FAC_EDU_BASE}/NCOG_UDISE_Schools.pmtiles',
        source_url='https://ncog.gov.in/',
        source_org='UDISE+ (Ministry of Education), mapped by NCOG (BISAG-N)',
        notes=RAMSERAPH_NOTE.format(src='NCOG UDISE schools') + (
            ' Licence: CC0 1.0 from the compiler (the source states no terms);'
            ' credit DataMeet, UDISE+ and NCOG.'),
        bake_all_formats=True,
        kml_name_field='school_nam',
        shp_split_by='state_name',  # one India-wide .dbf is 5.8 GB
    ),
    # ── Significant batch, policy B (Nov 2026) ─────────────────────────
    # Left out: mining leases (lessee names, phones, emails) and Rajasthan
    # police (editor name + mobile on every row): personal data.
    republished('fsi_circles', 'Forest circles (FSI)', 'environment', 'FSI', 'indian_admin_boundaries/forests', 'FSI_Circles', 'Forest administrative circles from the Forest Survey of India, the level above divisions.', 'circle polygons', 'https://fsi.nic.in/', 'Forest Survey of India (MoEFCC)', 'Circle_Nam', 'environment/fsi-circles'),
    republished('fsi_divisions', 'Forest divisions (FSI)', 'environment', 'FSI', 'indian_admin_boundaries/forests', 'FSI_Divisions', 'Forest divisions from the Forest Survey of India, with circle and state.', 'division polygons', 'https://fsi.nic.in/', 'Forest Survey of India (MoEFCC)', 'Division', 'environment/fsi-divisions'),
    republished('fsi_ranges', 'Forest ranges (FSI)', 'environment', 'FSI', 'indian_admin_boundaries/forests', 'FSI_Ranges', 'Forest ranges from the Forest Survey of India, with division, circle, district and LGD codes.', 'range polygons', 'https://fsi.nic.in/', 'Forest Survey of India (MoEFCC)', 'Range', 'environment/fsi-ranges'),
    republished('fsi_beats', 'Forest beats (FSI)', 'environment', 'FSI', 'indian_admin_boundaries/forests', 'FSI_Beats', 'Forest beats, the smallest unit of forest administration, from the Forest Survey of India, with reserved forest, compartment, range, division and LGD codes. Many name fields are blank in the source.', 'beat polygons', 'https://fsi.nic.in/', 'Forest Survey of India (MoEFCC)', 'Beat_Name', 'environment/fsi-beats'),
    republished('wildlife_corridors', 'Wildlife reserves and corridors (PARIVESH)', 'environment', 'Parivesh', 'indian_admin_boundaries/forests', 'Bharatmaps_Parivesh_Wildlife_Reserves_and_Corridors', 'Tiger reserves, wildlife corridors and other reserves from PARIVESH, the environment ministry clearance portal.', 'reserves and corridors', 'https://parivesh.nic.in/', 'PARIVESH (MoEFCC), via Bharatmaps', 'name', 'environment/wildlife-corridors'),
    republished('crz2019_zones', 'Coastal Regulation Zones 2019 (PARIVESH)', 'environment', 'Parivesh', 'indian_admin_boundaries/coastal', 'Bharatmaps_Parivesh_CRZ2019_Regulatory_Zones', 'Coastal Regulation Zone areas (CRZ-I to CRZ-IV) under the CRZ Notification 2019, from approved Coastal Zone Management Plans. For reference; the approved state CZMP maps are the legal record. The source covers Maharashtra, Karnataka and Odisha only.', 'zone polygons', 'https://parivesh.nic.in/', 'PARIVESH (MoEFCC), via Bharatmaps', 'category', 'environment/crz2019-zones'),
    republished('crz2019_lines', 'Coastal regulation lines 2019 (PARIVESH)', 'environment', 'Parivesh', 'indian_admin_boundaries/coastal', 'Bharatmaps_Parivesh_CRZ2019_Regulatory_Lines', 'High tide, low tide, hazard and no-development lines under the CRZ Notification 2019. For reference; the approved state CZMP maps are the legal record. The source covers Maharashtra, Karnataka and Odisha only.', 'lines', 'https://parivesh.nic.in/', 'PARIVESH (MoEFCC), via Bharatmaps', 'category', 'environment/crz2019-lines'),
    republished('gw_quality_premonsoon', 'Groundwater quality, pre-monsoon (Bhuvan)', 'water', 'Bhuvan', 'indian_land_features/groundwater-prospects', 'Bhuvan_Groundwater_Quality_Premonsoon', 'Pre-monsoon groundwater quality samples (pH, TDS, hardness, fluoride, nitrate, iron, arsenic and more, with a potability class) from Bhuvan. Columns vary by state and year in the source.', 'samples', 'https://bhuvan.nrsc.gov.in/', 'Bhuvan (NRSC, ISRO)', 'GWQ', 'water/gw-quality-premonsoon'),
    republished('gw_quality_postmonsoon', 'Groundwater quality, post-monsoon (Bhuvan)', 'water', 'Bhuvan', 'indian_land_features/groundwater-prospects', 'Bhuvan_Groundwater_Quality_Postmonsoon', 'Post-monsoon groundwater quality samples (pH, TDS, hardness, fluoride, nitrate, iron, arsenic and more, with a potability class) from Bhuvan. Columns vary by state and year in the source.', 'samples', 'https://bhuvan.nrsc.gov.in/', 'Bhuvan (NRSC, ISRO)', 'GWQ', 'water/gw-quality-postmonsoon'),
    republished('gsi_geology_2m', 'Geology 1:2M (GSI)', 'environment', 'NGDR', 'indian_land_features/geology', 'NGDR_Geology_2M', 'Geological map of India at 1:2 million: rock units with age, supergroup, group and stratigraphy, from the Geological Survey of India.', 'rock units', 'https://bhukosh.gsi.gov.in/', 'Geological Survey of India (NGDR / Bhukosh)', 'index_', 'environment/gsi-geology-2m'),
    republished('gsi_coal_blocks', 'Coal blocks (GSI)', 'environment', 'NGDR', 'indian_land_features/mining', 'NGDR_Coal_Blocks', 'Coal blocks with coalfield, exploration status, resources and allotted company, from the Geological Survey of India.', 'coal blocks', 'https://bhukosh.gsi.gov.in/', 'Geological Survey of India (NGDR / Bhukosh)', 'block_name', 'environment/gsi-coal-blocks'),
    republished('gsi_critical_minerals', 'Critical mineral occurrences (GSI)', 'environment', 'NGDR', 'indian_land_features/mining', 'NGDR_Critical_Minerals', 'Critical mineral localities (copper, rare earths, lithium and others) with commodity, resource, grade, host rock and age, from the Geological Survey of India.', 'localities', 'https://bhukosh.gsi.gov.in/', 'Geological Survey of India (NGDR / Bhukosh)', 'locality', 'environment/gsi-critical-minerals'),
    republished('gsi_lineaments_250k', 'Lineaments 1:250k (GSI)', 'environment', 'NGDR', 'indian_land_features/geomorphology', 'NGDR_Lineament_250k', 'Structural and geomorphic lineaments (faults, fractures, joints) mapped at 1:250,000 by the Geological Survey of India.', 'lineaments', 'https://bhukosh.gsi.gov.in/', 'Geological Survey of India (NGDR / Bhukosh)', 'l2descript', 'environment/gsi-lineaments-250k'),
    republished('police_stations_ap', 'Police station areas, Andhra Pradesh (APSAC)', 'people', 'APSAC', 'indian_admin_boundaries/police', 'APSAC_Police_station_boundaries', 'Police station jurisdictions in Andhra Pradesh with circle, sub-division, division, district and station phone number.', 'police stations', 'https://apsac.ap.gov.in/', 'Andhra Pradesh Space Applications Centre (APSAC)', 'police_station_name', 'people/police-stations-ap'),
    republished('police_stations_bihar', 'Police station areas, Bihar (i-Bhugoal)', 'people', 'Bhugoal', 'indian_admin_boundaries/police', 'Bhugoal_BH_Police_Thana_Boundaries', 'Police thana jurisdictions in Bihar with district and thana code.', 'thanas', 'https://gis.bih.nic.in/', 'i-Bhugoal (Government of Bihar)', 'PS_NAME', 'people/police-stations-bihar'),
    republished('police_stations_delhi', 'Police station areas, Delhi (GSDL)', 'people', 'GSDL', 'indian_admin_boundaries/police', 'GSDL_DL_Police_Station_Boundaries', 'Police station jurisdictions in Delhi with district, sub-division and range.', 'police stations', 'https://gsdl.org.in/', 'Geospatial Delhi Limited (GSDL)', 'POL_STN_NM', 'people/police-stations-delhi'),
    republished('police_stations_tn', 'Police station areas, Tamil Nadu (TNGIS)', 'people', 'TNGIS', 'indian_admin_boundaries/police', 'TNGIS_TN_Police_Station_Boundaries', 'Law-and-order police station jurisdictions in Tamil Nadu with district and taluk.', 'police stations', 'https://tngis.tn.gov.in/', 'TNGIS (Government of Tamil Nadu)', 'police_station_name', 'people/police-stations-tn'),
    republished('traffic_police_stations_tn', 'Traffic police station areas, Tamil Nadu (TNGIS)', 'people', 'TNGIS', 'indian_admin_boundaries/police', 'TNGIS_TN_Traffic_Police_Station_Boundaries', 'Traffic police station jurisdictions in Tamil Nadu with district and taluk.', 'police stations', 'https://tngis.tn.gov.in/', 'TNGIS (Government of Tamil Nadu)', 'police_station', 'people/traffic-police-stations-tn'),
    republished('police_stations_telangana', 'Police station areas, Telangana (TGRAC)', 'people', 'TGRAC', 'indian_admin_boundaries/police', 'TRACGIS_TG_Police_Station_Boundaries', 'Police station jurisdictions in Telangana with mandal, district, circle and sub-division.', 'police stations', 'https://tgrac.telangana.gov.in/', 'Telangana Remote Sensing Applications Centre (TGRAC)', 'PS_Name', 'people/police-stations-telangana'),
    republished('marine_police_stations', 'Marine police station areas (NCOG)', 'people', 'NCOG', 'indian_admin_boundaries/police', 'NCOG_Marine_Police_Boundaries', 'Coastal villages grouped by marine police station, with LGD state, district and sub-district codes.', 'areas', 'https://ncog.gov.in/', 'National Centre of Geo-informatics (BISAG-N)', 'vname', 'people/marine-police-stations'),
    republished('amrit_sarovar_ponds', 'Amrit Sarovar ponds', 'water', 'AmritSarovar', 'indian_water_features/waterbodies', 'Amrit_Sarovar_Water_Observatory_Ponds', 'Ponds built or rejuvenated under Mission Amrit Sarovar (mostly via MGNREGA), with status, scheme, village, block and district.', 'ponds', 'https://amritsarovar.gov.in/', 'Mission Amrit Sarovar (Ministry of Rural Development), via the Water Observatory', 'Name_of_Sarovar', 'water/amrit-sarovar-ponds'),
    republished('jjm_facilities', 'Jal Jeevan Mission facilities', 'infrastructure', 'JJM', 'indian_facilities/jjm-facilities', 'JJM_facilities', 'Schools, anganwadis and other public institutions in rural habitations recorded by the Jal Jeevan Mission, with category, class and LGD village code.', 'facilities', 'https://jaljeevanmission.gov.in/', 'Jal Jeevan Mission (Ministry of Jal Shakti)', 'fac_name', 'infrastructure/jjm-facilities'),
    # ── West Bengal wards + Indian Railways (Nov 2026, policy B) ────────
    # SBM wards have no West Bengal; WB AMRUT covers 52 towns (not Kolkata,
    # which has wards_kolkata). Railways were held until policy B.
    republished('wb_amrut_wards', 'Urban wards, West Bengal (AMRUT)', 'city-wards', 'WBAMRUT', 'indian_admin_boundaries/urban', 'WB_AMRUT_Wards', 'Ward boundaries for 52 West Bengal towns and cities from the state AMRUT GIS, with ward number, town and district codes. Fills the West Bengal gap in the national SBM wards; Kolkata has its own ward map.', 'wards', 'https://nagargispariseva.wb.gov.in/', 'West Bengal AMRUT (Nagar GIS Pariseva)', 'Ward_No', 'boundaries/wb-amrut-wards'),
    republished('wb_amrut_ulbs', 'Towns and cities, West Bengal (AMRUT)', 'boundaries', 'WBAMRUT', 'indian_admin_boundaries/urban', 'WB_AMRUT_ULBs', 'Boundaries of 57 West Bengal urban local bodies (municipal corporations, municipalities and development authorities) from the state AMRUT GIS. Kolkata is not included.', 'towns and cities', 'https://nagargispariseva.wb.gov.in/', 'West Bengal AMRUT (Nagar GIS Pariseva)', 'Name', 'boundaries/wb-amrut-ulbs'),
    republished('ir_stations', 'Railway stations (Indian Railways GIS)', 'transport', 'IRGIS', 'indian_transport/railways', 'IR_Stations', 'Railway stations and halts from the Indian Railways GIS portal, with station code, category, zone, division, section and state. About a third have no station name in the source.', 'stations', 'https://irgeoportal.gov.in/', 'Indian Railways GIS portal (CRIS)', 'sttnname', 'transport/ir-stations'),
    republished('ir_tracks', 'Railway tracks (Indian Railways GIS)', 'transport', 'IRGIS', 'indian_transport/railways', 'IR_Tracks', 'Railway track segments from the Indian Railways GIS portal, with section, zone, division, chainage and state.', 'track segments', 'https://irgeoportal.gov.in/', 'Indian Railways GIS portal (CRIS)', 'tmssection', 'transport/ir-tracks'),
]


def http_download(url: str, dest: Path) -> int:
    """Stream a URL to disk. Returns bytes written."""
    if dest.exists() and dest.stat().st_size > 0:
        return dest.stat().st_size
    print(f'  fetching {url}')
    with urllib.request.urlopen(url) as r, dest.open('wb') as f:
        n = 0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            n += len(chunk)
    return n


def row_group_size_for(feature_count: int) -> int | None:
    """Tighter row groups → tighter per-group bbox stats → more effective
    /api/v1/nearby pruning. Default (122880) wastes pruning on dense layers
    because a single group still covers a meaningful chunk of India even
    after Hilbert sort. Bucket by feature count so each layer ends up with
    enough groups that even Hilbert curve discontinuities (zigzag points
    that span large bboxes) only pull in ~120k rows post-prune.

    Returns None for tiny layers where a single group is fine.

    Cap at 20k: a 50k tier was tried for >1M-row layers and left Mumbai
    and Delhi Overture queries 503-ing because 5-6 row groups matched
    their bbox including a Hilbert outlier spanning half of west India.
    """
    if feature_count < 10_000:    return None
    if feature_count < 100_000:   return 5_000
    return 20_000


def rebake_flatten_bbox(src: Path, dst: Path, con=None) -> tuple[int, list[str]]:
    """Re-emit parquet so /api/v1/nearby can prune efficiently:
      1. Top-level flat xmin/ymin/xmax/ymax columns — either flattened from
         an existing `bbox` STRUCT (ramSeraph shape) or synthesised from the
         geometry's extent when neither is present (own-bake LGD shape).
      2. Rows ordered along a Hilbert curve over India's bbox so row-group
         bbox stats are tight enough for hyparquet to skip entire groups.

    Without (1) /nearby falls through to a full WKB scan that's capped at
    200 MB; without (2) the row-group bbox stats span all of India and no
    pruning happens regardless of how good the filter is.

    Pass `con` to run on a caller's connection (big bakes set temp_directory
    and preserve_insertion_order there so the Hilbert sort can spill).

    Returns (feature_count, non-geom column names).
    """
    if con is None:
        con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial;')
    cols = con.execute(f"DESCRIBE SELECT * FROM read_parquet('{src}')").fetchall()
    col_names = [c[0] for c in cols]
    has_bbox_struct = 'bbox' in col_names
    has_flat_bbox = all(c in col_names for c in ('xmin', 'ymin', 'xmax', 'ymax'))
    # ramSeraph parquet stores `geometry` already typed as GEOMETRY; a few
    # older / simpler files store it as raw BLOB (WKB) or name the column
    # `geom` / `wkb_geometry` (e.g. own-bake point layers like nic_health).
    # Detect the column name + its type rather than assuming `geometry`.
    geom_col = next((c[0] for c in cols if c[0] in ('geometry', 'wkb_geometry', 'geom')), 'geometry')
    geom_type = next((c[1] for c in cols if c[0] == geom_col), 'BLOB')
    geom_expr = geom_col if 'GEOMETRY' in geom_type else f'ST_GeomFromWKB({geom_col})'
    # India bbox; ST_Hilbert uses this as the curve's domain so the 32-bit
    # index has max resolution over the country instead of the whole world.
    india_bbox = "ST_Extent(ST_MakeEnvelope(68, 6, 98, 38))"

    if has_bbox_struct:
        # Flatten the struct into top-level cols, drop the struct itself.
        bbox_clause = (
            "SELECT * EXCLUDE (bbox), "
            "bbox.xmin AS xmin, bbox.ymin AS ymin, "
            "bbox.xmax AS xmax, bbox.ymax AS ymax"
        )
    elif has_flat_bbox:
        bbox_clause = "SELECT *"
    else:
        # No bbox in source; compute from the geometry's extent per row.
        bbox_clause = (
            f"SELECT *, "
            f"ST_XMin({geom_expr}) AS xmin, ST_YMin({geom_expr}) AS ymin, "
            f"ST_XMax({geom_expr}) AS xmax, ST_YMax({geom_expr}) AS ymax"
        )

    row_count = con.execute(f"SELECT COUNT(*) FROM read_parquet('{src}')").fetchone()[0]
    rgs = row_group_size_for(row_count)
    rgs_clause = f", ROW_GROUP_SIZE {rgs}" if rgs is not None else ""
    # Ties on the Hilbert key (many features at one point) break on the source
    # row number: a parallel sort otherwise orders them differently each run,
    # changing the bytes (and the md5) of an unchanged layer.
    con.execute(
        f"COPY (SELECT * EXCLUDE (file_row_number) FROM ("
        f"{bbox_clause} FROM read_parquet('{src}', file_row_number = true)) "
        f"ORDER BY ST_Hilbert({geom_expr}, {india_bbox}), file_row_number) TO '{dst}' "
        f"(FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL 9{rgs_clause})"
    )

    n = con.execute(f"SELECT COUNT(*) FROM read_parquet('{dst}')").fetchone()[0]
    final_cols = con.execute(f"DESCRIBE SELECT * FROM read_parquet('{dst}')").fetchall()
    non_geom = [c[0] for c in final_cols if 'GEOMETRY' not in c[1] and c[0] not in ('geometry',)]
    return n, non_geom


# Lift GDAL's 200 MB per-feature GeoJSON read limit: one CRZ 2019 line alone
# is larger, and ogr2ogr then fails the KML and shapefile conversions.
OGR_ENV = {**os.environ, 'OGR_GEOJSON_MAX_OBJ_SIZE': '0'}

DBF_MAX_BYTES = 2 * 1024**3  # most GIS tools refuse a .dbf of 2 GB or more


def slug(value: str) -> str:
    return re.sub(r'[^a-z0-9]+', '_', str(value).lower()).strip('_') or 'unknown'


def write_split_shapefiles(src_parquet: Path, out_dir: Path, basename: str, column: str) -> None:
    """One shapefile per distinct `column` value (e.g. state), so each .dbf
    stays under 2 GB. Read from the parquet, not the GeoJSON: one scan per
    value of a multi-GB GeoJSON would be slow. Same columns as the GeoJSON."""
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial;')
    con.execute('SET geometry_always_xy = true')  # else EPSG:4326 writes lat,lon
    src = f"read_parquet('{src_parquet}')"
    for (value,) in con.execute(f'SELECT DISTINCT "{column}" FROM {src} ORDER BY 1').fetchall():
        cond = f'"{column}" IS NULL' if value is None else f'"{column}" = ?'
        con.execute(
            f"COPY (SELECT * FROM {src} WHERE {cond}) TO '{out_dir / f'{basename}_{slug(value)}.shp'}' "
            "WITH (FORMAT GDAL, DRIVER 'ESRI Shapefile', LAYER_CREATION_OPTIONS ('ENCODING=UTF-8', 'RESIZE=YES'))",
            [] if value is None else [value])


def bake_whole_layer(d: Dataset, src_parquet: Path) -> dict[str, Path]:
    """Bake geojson + kml + shapefile.zip from the source parquet so the
    catalog card surfaces "Download whole layer" buttons. Skips silently if
    the parquet exceeds WHOLE_LAYER_MAX_MB (default 100), unless the layer sets
    bake_all_formats. Returns a dict of {format: local_path} for successfully
    baked outputs.

    The parquet (always baked) drives the viewer, query and filter; these
    extras serve QGIS / Google Earth / ArcGIS users. A failure here doesn't
    block the ingest.
    """
    pq_bytes = src_parquet.stat().st_size
    if not d.bake_all_formats and pq_bytes > WHOLE_LAYER_MAX_MB * 1024 * 1024:
        print(f'  whole-layer bake skipped (parquet {pq_bytes / 1024 / 1024:.0f} MB > {WHOLE_LAYER_MAX_MB} MB cap)')
        return {}

    bake_dir = WORK / f'bake_{d.id}'
    bake_dir.mkdir(exist_ok=True)
    basename = Path(d.parquet_url).stem

    outputs: dict[str, Path] = {}

    geojson_path = bake_dir / f'{basename}.geojson'
    try:
        con = duckdb.connect()
        con.execute('INSTALL spatial; LOAD spatial;')
        con.execute('SET geometry_always_xy = true')  # else EPSG:4326 writes lat,lon
        con.execute(
            f"COPY (SELECT * FROM read_parquet('{src_parquet}')) "
            f"TO '{geojson_path}' WITH (FORMAT GDAL, DRIVER 'GeoJSON')"
        )
        outputs['geojson'] = geojson_path
    except Exception as e:
        print(f'  geojson bake failed: {e}')
        return {}  # without geojson we can't bake kml or shapefile downstream

    kml_path = bake_dir / f'{basename}.kml'
    try:
        subprocess.run(
            ['ogr2ogr', '-f', 'KML',
             *(['-dsco', f'NameField={d.kml_name_field}'] if d.kml_name_field else []),
             str(kml_path), str(geojson_path)],
            check=True, capture_output=True, timeout=600, env=OGR_ENV,
        )
        outputs['kml'] = kml_path
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
        print(f'  kml bake skipped: {e}')

    shp_dir = bake_dir / f'{basename}_shp'
    shp_zip = bake_dir / f'{basename}.shp.zip'
    try:
        shp_dir.mkdir(exist_ok=True)
        # Clear any prior shapefile pieces (idempotent re-run)
        for f in shp_dir.iterdir():
            f.unlink()
        if d.shp_split_by:
            write_split_shapefiles(src_parquet, shp_dir, basename, d.shp_split_by)
        else:
            subprocess.run(
                ['ogr2ogr', '-f', 'ESRI Shapefile', '-lco', 'ENCODING=UTF-8', '-lco', 'RESIZE=YES',
                 str(shp_dir / f'{basename}.shp'), str(geojson_path)],
                check=True, capture_output=True, timeout=600, env=OGR_ENV,
            )
        too_big = [f.name for f in shp_dir.glob('*.dbf') if f.stat().st_size >= DBF_MAX_BYTES]
        if too_big:
            # Most GIS tools refuse a .dbf of 2 GB or more: ship no shapefile rather than a broken one.
            print(f'  shapefile skipped: .dbf over {DBF_MAX_BYTES:,} bytes ({", ".join(too_big)}); set shp_split_by')
        else:
            with zipfile.ZipFile(shp_zip, 'w', zipfile.ZIP_DEFLATED) as zf:
                for f in sorted(shp_dir.iterdir()):
                    # Fixed timestamp: same input, same bytes, same md5 (no re-upload).
                    info = zipfile.ZipInfo(f.name, date_time=(1980, 1, 1, 0, 0, 0))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    zf.writestr(info, f.read_bytes())
            outputs['shapefile'] = shp_zip
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, duckdb.Error) as e:
        print(f'  shapefile bake skipped: {e}')

    return outputs


def r2_client():
    return boto3.client(
        's3',
        endpoint_url=f'https://{os.environ["CLOUDFLARE_ACCOUNT_ID"]}.r2.cloudflarestorage.com',
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],
        aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
        config=Config(signature_version='s3v4'),
    )


def file_md5(path: Path) -> str:
    h = hashlib.md5()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def r2_upload(s3, local: Path, key: str) -> None:
    ext = ''.join(local.suffixes[-1:])
    ct = CONTENT_TYPES.get(ext, 'application/octet-stream')
    # Skip only when the remote holds the same bytes. Sizes can't tell (a
    # lat,lon swap keeps the byte count) and a multipart ETag isn't an MD5,
    # so each upload stores its MD5 in metadata and that is compared.
    md5 = file_md5(local)
    try:
        head = s3.head_object(Bucket=BUCKET, Key=key)
        if head.get('Metadata', {}).get('md5') == md5:
            print(f'  R2 skip (md5 match): s3://{BUCKET}/{key}')
            return
    except s3.exceptions.ClientError:
        pass

    transfer = TransferConfig(multipart_threshold=64 * 1024 * 1024, multipart_chunksize=64 * 1024 * 1024)
    extra = {
        'ContentType': ct,
        # Parquet downloads should trigger save; pmtiles should be inline so the viewer can fetch.
        'ContentDisposition': f'attachment; filename="{local.name}"' if ext == '.parquet' else 'inline',
        'CacheControl': 'public, max-age=604800, immutable',
        'Metadata': {'md5': md5},
    }
    print(f'  uploading → s3://{BUCKET}/{key}  ({local.stat().st_size:,} bytes)')
    s3.upload_file(str(local), BUCKET, key, ExtraArgs=extra, Config=transfer)


def merge_layer_into_catalog(
    catalog: dict,
    d: Dataset,
    parquet_bytes: int,
    pmtiles_bytes: int | None,
    features: int,
    bakes_info: dict[str, dict] | None = None,
) -> dict:
    """Merge a Dataset ingest result into a catalog dict in place. Returns
    the same dict (mutated) so callers can chain or test.

    Pure function — no file I/O, no Path stat calls. patch_catalog() wraps
    this with the read-modify-write loop across the three on-disk catalogs.
    The pure split exists so the round-trip stability of the merge can be
    asserted in test_catalog_idempotent.py.

    `bakes_info` shape: {fmt: {'name': str, 'bytes': int}} for any
    whole-layer formats (geojson/kml/shapefile) freshly baked in this run.
    When absent, prev catalog's bake blocks are carried over.
    """
    parquet_block: dict = {
        'url': f'{R2_PUBLIC}/{d.r2_prefix}/{Path(d.parquet_url).name}',
        'upstream_url': d.parquet_url,
        'bytes': parquet_bytes,
    }
    pmtiles_block: dict | None = (
        {
            'url': f'{R2_PUBLIC}/{d.r2_prefix}/{Path(d.pmtiles_url).name}',
            'upstream_url': d.pmtiles_url,
            'bytes': pmtiles_bytes,
        }
        if d.pmtiles_url
        else None
    )
    # Fields owned by THIS ingest (will overwrite existing values).
    ingest_owned = {
        'id': d.id,
        'level': d.level,
        'source': d.source,
        'rows': features,
        'parquet': parquet_block,
        'pmtiles': pmtiles_block,
        'licence': d.license,
        'attribution': {
            'primary': {'name': d.source_org, 'url': d.source_url},
            'publisher': None,
        },
        'category': d.category,
        'provenance': 'curated',
        'notes': d.notes,
    }
    level_meta = {
        'label': d.name,
        'unit': d.unit,
        'description': d.description,
    }

    catalog.setdefault('layers', [])
    catalog.setdefault('level_meta', {})

    # Find existing entry (if any) so we can preserve whole-layer bakes
    # + any other field we're not authoritative over.
    prev = next((l for l in catalog['layers'] if l.get('id') == d.id), None)
    merged: dict = dict(prev) if prev else {}
    merged.update(ingest_owned)
    # Whole-layer bakes: prefer fresh bakes from this run; otherwise
    # carry forward whatever previous run (or bake_whole_layer.py) wrote.
    bakes_local = bakes_info or {}
    for fmt in ('geojson', 'kml', 'shapefile'):
        if fmt in bakes_local:
            merged[fmt] = {
                'url': f'{R2_PUBLIC}/{d.r2_prefix}/{bakes_local[fmt]["name"]}',
                'bytes': bakes_local[fmt]['bytes'],
            }
        elif prev and prev.get(fmt) is not None:
            merged[fmt] = prev[fmt]
        else:
            merged.setdefault(fmt, None)
    # fetched_at drives the card's "Updated" line: set it on first ingest,
    # keep it on re-runs (the merge must stay a no-op the second time).
    if not merged.get('fetched_at'):
        merged['fetched_at'] = datetime.now(timezone.utc).replace(microsecond=0).isoformat()

    catalog['layers'] = [l for l in catalog['layers'] if l.get('id') != d.id]
    catalog['layers'].append(merged)
    catalog['level_meta'][d.level] = level_meta
    # The home prerender (web/scripts/prerender.mjs:311) iterates
    # catalog.level_order to render external level rows; a missing entry
    # silently hides the layer from the home grid even though catalog.json
    # has the layer + level_meta. Keep this list in sync on every patch.
    order = catalog.setdefault('level_order', [])
    if d.level not in order:
        order.append(d.level)
    return catalog


def patch_catalog(d: Dataset, parquet_bytes: int, pmtiles_bytes: int | None, features: int, bakes: dict[str, Path] | None = None) -> None:
    """Patch catalog.json (root + web/public + web/dist) with the new layer
    so the live site picks it up before the next build_catalog.py run.

    Idempotent on re-ingest: preserves any existing layer fields we don't
    explicitly set here (whole-layer bakes geojson/kml/shapefile from
    bake_whole_layer.py, prior fetched_at, etc.). Only fields directly
    derivable from this ingest get overwritten.
    """
    # Resolve Path → {name, bytes} so the merge can stay pure / testable.
    bakes_info: dict[str, dict] = {
        fmt: {'name': p.name, 'bytes': p.stat().st_size}
        for fmt, p in (bakes or {}).items()
    }
    for p in ['catalog.json', 'web/public/catalog.json', 'web/dist/catalog.json']:
        f = ROOT / p
        if not f.exists():
            continue
        c = json.loads(f.read_text())
        merge_layer_into_catalog(c, d, parquet_bytes, pmtiles_bytes, features, bakes_info)
        f.write_text(json.dumps(c, indent=2) + '\n')


def append_manifest(d: Dataset, parquet_bytes: int, pmtiles_bytes: int | None, features: int) -> None:
    """Append (or replace) an entry in scripts/external-ingested.json so
    future build_catalog.py runs pick it up without manual editing."""
    f = ROOT / 'scripts' / 'external-ingested.json'
    items = json.loads(f.read_text())
    items = [it for it in items if it.get('id') != d.id]
    items.append({
        'id': d.id,
        'name': d.name,
        'level': d.level,
        'category': d.category,
        'source': d.source,
        'description': d.description,
        'unit': d.unit,
        'features': features,
        'license': d.license,
        'r2_prefix': d.r2_prefix,
        'parquet_file': Path(d.parquet_url).name,
        'parquet_bytes': parquet_bytes,
        'pmtiles_file': Path(d.pmtiles_url).name if d.pmtiles_url else None,
        'pmtiles_bytes': pmtiles_bytes,
        'source_url': d.source_url,
        'source_org': d.source_org,
        'notes': d.notes,
    })
    f.write_text(json.dumps(items, indent=2) + '\n')


def ingest(d: Dataset, upload: bool = True) -> None:
    """Download, flatten, bake every format, then (upload=True) put the files
    on R2 and record the layer in the manifest + catalog. upload=False builds
    the same local files under WORK for checking, and records nothing: the
    catalog must never point at files that are not on R2."""
    print(f'\n→ {d.id}' + ('' if upload else '  (no upload: local build only)'))

    raw_parquet = WORK / f'_raw_{d.id}.parquet'
    flat_parquet = WORK / f'{d.id}.parquet'

    http_download(d.parquet_url, raw_parquet)

    features, cols = rebake_flatten_bbox(raw_parquet, flat_parquet)
    print(f'  features: {features:,}; columns post-flatten: {cols}')

    pq_bytes = flat_parquet.stat().st_size
    files = {flat_parquet: Path(d.parquet_url).name}

    pm_bytes: int | None = None
    if d.pmtiles_url:
        raw_pmtiles = WORK / f'{d.id}.pmtiles'
        http_download(d.pmtiles_url, raw_pmtiles)
        pm_bytes = raw_pmtiles.stat().st_size
        files[raw_pmtiles] = Path(d.pmtiles_url).name
    else:
        print('  pmtiles skipped (opted out for this layer)')

    # Whole-layer geojson/kml/shapefile bakes (≤ WHOLE_LAYER_MAX_MB unless the
    # layer sets bake_all_formats), from the flat parquet.
    bakes = bake_whole_layer(d, flat_parquet)
    files.update({path: path.name for path in bakes.values()})

    if not upload:
        for local in files:
            print(f'  built {local}  ({local.stat().st_size:,} bytes)')
        print(f'  ✓ {d.id}: {len(files)} files built locally; R2, manifest and catalog untouched')
        return

    s3 = r2_client()
    for local, name in files.items():
        r2_upload(s3, local, f'{d.r2_prefix}/{name}')

    append_manifest(d, pq_bytes, pm_bytes, features)
    patch_catalog(d, pq_bytes, pm_bytes, features, bakes)
    print(f'  ✓ {d.id}: catalog + manifest patched ({len(bakes)} extra bakes)')


def main(argv: list[str]) -> int:
    upload = '--no-upload' not in argv
    argv = [a for a in argv if a != '--no-upload']
    for key in ('CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'):
        if upload and key not in os.environ:
            print(f'ERROR: {key} not set in env')
            return 2

    targets = DATASETS
    if len(argv) > 1:
        needle = argv[1]
        targets = [d for d in DATASETS if needle in d.id]
        if not targets:
            print(f'No dataset matched "{needle}". Available: {[d.id for d in DATASETS]}')
            return 2

    for d in targets:
        ingest(d, upload=upload)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
