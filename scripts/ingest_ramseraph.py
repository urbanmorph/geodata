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

Idempotent: skips a layer if its R2 objects already exist at matching sizes
AND it's already present in external-ingested.json.
"""
from __future__ import annotations
import json
import os
import subprocess
import sys
import urllib.request
import zipfile
from dataclasses import dataclass
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
POIS_BASE = 'https://github.com/ramSeraph/indian_facilities/releases/download/pois'

RAMSERAPH_NOTE = 'Pre-baked parquet + pmtiles compiled by ramSeraph/indianopenmaps from {src}.'


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
    # ── Wave 3 — POIs ──────────────────────────────────────────────────
    Dataset(
        id='overture_places_india',
        name='Places — Overture Maps (Dec 2023)',
        level='overture_places_india',
        category='infrastructure',
        source='Overture',
        description='Pan-India points of interest from the Overture Maps Foundation December 2023 release. Names, categories, addresses, websites and confidence scores for restaurants, shops, ATMs, schools, transit, monuments and more.',
        unit='places',
        license='CDLA-Permissive-2.0',
        r2_prefix='pois/overture-places',
        parquet_url=f'{POIS_BASE}/overture_places_india.parquet',
        pmtiles_url=f'{POIS_BASE}/overture_places_india.pmtiles',
        source_url='https://overturemaps.org/overture-december-2023-release-notes/',
        source_org='Overture Maps Foundation',
        notes=RAMSERAPH_NOTE.format(src='Overture Maps Foundation 2023-12-14-alpha.0 release') + " Dec 2023 snapshot — refresh tracks ramSeraph's republish cadence, not Overture's monthly upstream releases.",
    ),

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


def rebake_flatten_bbox(src: Path, dst: Path) -> tuple[int, list[str]]:
    """Re-emit parquet with the bbox STRUCT flattened to top-level xmin/ymin/
    xmax/ymax columns (so parquet-query's centroid logic works unchanged).
    Returns (feature_count, non-geom column names).
    """
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial;')
    # Discover the column structure
    cols = con.execute(f"DESCRIBE SELECT * FROM read_parquet('{src}')").fetchall()
    col_names = [c[0] for c in cols]
    has_bbox = 'bbox' in col_names

    if not has_bbox:
        # Nothing to flatten — copy through with zstd recompression.
        con.execute(
            f"COPY (SELECT * FROM read_parquet('{src}')) TO '{dst}' "
            "(FORMAT PARQUET, COMPRESSION ZSTD)"
        )
    else:
        # Flatten bbox struct. Drop the struct column; add flat fields.
        con.execute(
            f"COPY (SELECT * EXCLUDE (bbox), "
            f"bbox.xmin AS xmin, bbox.ymin AS ymin, "
            f"bbox.xmax AS xmax, bbox.ymax AS ymax "
            f"FROM read_parquet('{src}')) TO '{dst}' "
            "(FORMAT PARQUET, COMPRESSION ZSTD)"
        )

    n = con.execute(f"SELECT COUNT(*) FROM read_parquet('{dst}')").fetchone()[0]
    final_cols = con.execute(f"DESCRIBE SELECT * FROM read_parquet('{dst}')").fetchall()
    non_geom = [c[0] for c in final_cols if 'GEOMETRY' not in c[1] and c[0] not in ('geometry',)]
    return n, non_geom


def bake_whole_layer(d: Dataset, src_parquet: Path) -> dict[str, Path]:
    """Bake geojson + kml + shapefile.zip from the source parquet so the
    catalog card surfaces "Download whole layer" buttons. Skips silently if
    the parquet exceeds WHOLE_LAYER_MAX_MB (default 100). Returns a dict of
    {format: local_path} for successfully baked outputs.

    Honours the always-bake-parquet rule indirectly: parquet is already
    uploaded by the time this runs. These extras are nice-to-haves for QGIS
    / Google Earth / ArcGIS users; failures here don't block the ingest.
    """
    pq_bytes = src_parquet.stat().st_size
    if pq_bytes > WHOLE_LAYER_MAX_MB * 1024 * 1024:
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
            ['ogr2ogr', '-f', 'KML', str(kml_path), str(geojson_path)],
            check=True, capture_output=True, timeout=600,
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
        subprocess.run(
            ['ogr2ogr', '-f', 'ESRI Shapefile', str(shp_dir / f'{basename}.shp'), str(geojson_path)],
            check=True, capture_output=True, timeout=600,
        )
        with zipfile.ZipFile(shp_zip, 'w', zipfile.ZIP_DEFLATED) as zf:
            for f in sorted(shp_dir.iterdir()):
                zf.write(f, f.name)
        outputs['shapefile'] = shp_zip
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
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


def r2_upload(s3, local: Path, key: str) -> None:
    ext = ''.join(local.suffixes[-1:])
    ct = CONTENT_TYPES.get(ext, 'application/octet-stream')
    # Skip if remote already matches in size (idempotent).
    try:
        head = s3.head_object(Bucket=BUCKET, Key=key)
        if head.get('ContentLength') == local.stat().st_size:
            print(f'  R2 skip (size match): s3://{BUCKET}/{key}')
            return
    except s3.exceptions.ClientError:
        pass

    transfer = TransferConfig(multipart_threshold=64 * 1024 * 1024, multipart_chunksize=64 * 1024 * 1024)
    extra = {
        'ContentType': ct,
        # Parquet downloads should trigger save; pmtiles should be inline so the viewer can fetch.
        'ContentDisposition': f'attachment; filename="{local.name}"' if ext == '.parquet' else 'inline',
        'CacheControl': 'public, max-age=604800, immutable',
    }
    print(f'  uploading → s3://{BUCKET}/{key}  ({local.stat().st_size:,} bytes)')
    s3.upload_file(str(local), BUCKET, key, ExtraArgs=extra, Config=transfer)


def patch_catalog(d: Dataset, parquet_bytes: int, pmtiles_bytes: int | None, features: int, bakes: dict[str, Path] | None = None) -> None:
    """Patch catalog.json (root + web/public + web/dist) with the new layer
    so the live site picks it up before the next build_catalog.py run.

    Idempotent on re-ingest: preserves any existing layer fields we don't
    explicitly set here (whole-layer bakes geojson/kml/shapefile from
    bake_whole_layer.py, prior fetched_at, etc.). Only fields directly
    derivable from this ingest get overwritten.
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
    for p in ['catalog.json', 'web/public/catalog.json', 'web/dist/catalog.json']:
        f = ROOT / p
        if not f.exists():
            continue
        c = json.loads(f.read_text())
        c.setdefault('layers', [])
        c.setdefault('level_meta', {})

        # Find existing entry (if any) so we can preserve whole-layer bakes
        # + any other field we're not authoritative over.
        prev = next((l for l in c['layers'] if l.get('id') == d.id), None)
        merged: dict = dict(prev) if prev else {}
        merged.update(ingest_owned)
        # Whole-layer bakes: prefer fresh bakes from this run; otherwise
        # carry forward whatever previous run (or bake_whole_layer.py) wrote.
        bakes_local = bakes or {}
        for fmt in ('geojson', 'kml', 'shapefile'):
            if fmt in bakes_local:
                merged[fmt] = {
                    'url': f'{R2_PUBLIC}/{d.r2_prefix}/{bakes_local[fmt].name}',
                    'bytes': bakes_local[fmt].stat().st_size,
                }
            elif prev and prev.get(fmt) is not None:
                merged[fmt] = prev[fmt]
            else:
                merged.setdefault(fmt, None)
        # fetched_at: leave previous if present, else None for downstream fill.
        if 'fetched_at' not in merged:
            merged['fetched_at'] = None

        c['layers'] = [l for l in c['layers'] if l.get('id') != d.id]
        c['layers'].append(merged)
        c['level_meta'][d.level] = level_meta
        # The home prerender (web/scripts/prerender.mjs:311) iterates
        # catalog.level_order to render external level rows; a missing entry
        # silently hides the layer from the home grid even though catalog.json
        # has the layer + level_meta. Keep this list in sync on every patch.
        order = c.setdefault('level_order', [])
        if d.level not in order:
            order.append(d.level)
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


def ingest(d: Dataset) -> None:
    print(f'\n→ {d.id}')

    raw_parquet = WORK / f'_raw_{d.id}.parquet'
    flat_parquet = WORK / f'{d.id}.parquet'

    http_download(d.parquet_url, raw_parquet)

    features, cols = rebake_flatten_bbox(raw_parquet, flat_parquet)
    print(f'  features: {features:,}; columns post-flatten: {cols}')

    pq_bytes = flat_parquet.stat().st_size

    s3 = r2_client()
    r2_upload(s3, flat_parquet, f'{d.r2_prefix}/{Path(d.parquet_url).name}')

    pm_bytes: int | None = None
    if d.pmtiles_url:
        raw_pmtiles = WORK / f'{d.id}.pmtiles'
        http_download(d.pmtiles_url, raw_pmtiles)
        pm_bytes = raw_pmtiles.stat().st_size
        r2_upload(s3, raw_pmtiles, f'{d.r2_prefix}/{Path(d.pmtiles_url).name}')
    else:
        print('  pmtiles skipped (opted out for this layer)')

    # Whole-layer geojson/kml/shapefile bakes for ≤100 MB layers. Bake from
    # the flat parquet (geometry survives the bbox-flatten copy). Each baked
    # output is uploaded under the same r2_prefix as parquet + pmtiles.
    bakes = bake_whole_layer(d, flat_parquet)
    for fmt, path in bakes.items():
        r2_upload(s3, path, f'{d.r2_prefix}/{path.name}')

    append_manifest(d, pq_bytes, pm_bytes, features)
    patch_catalog(d, pq_bytes, pm_bytes, features, bakes)
    print(f'  ✓ {d.id}: catalog + manifest patched ({len(bakes)} extra bakes)')


def main(argv: list[str]) -> int:
    for key in ('CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'):
        if key not in os.environ:
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
        ingest(d)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
