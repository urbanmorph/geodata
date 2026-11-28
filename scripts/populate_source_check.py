#!/usr/bin/env python3
"""
Give every catalog layer a `source_check`: how scripts/check_updates.py asks its upstream whether the data has
changed since bharatlas ingested it. Metadata only; nothing here touches the network.

    source_check = {method, url, fingerprint, checked_at, changed_at}   (+ reason when method is manual)

Methods, inferred from what the catalog and scripts/external-ingested.json already record:
  github_release  a GitHub release asset (india-geodata, ramSeraph): the asset's updated_at and size;
                  a repository URL: its latest release tag
  github_commit   a folder in a GitHub repository (DataMeet, datta07): the latest commit touching it
  http            a file or metadata URL: its ETag / Last-Modified / Content-Length
  ckan            a CKAN package_show URL, or data.gov.in's keyless resource listing: when it was last modified
  gtfs            a GTFS feed's feed_info.feed_version (not built yet)
  manual          no machine check; `reason` says why and `url` is the page to look at by hand

Idempotent: a layer whose method and URL are unchanged keeps its recorded fingerprint and dates; a second run
writes nothing. The fingerprint is recorded by check_updates.py --accept, never here.

Usage:
    python3 scripts/populate_source_check.py            # patch catalog.json in place, print the counts
    python3 scripts/populate_source_check.py --dry-run  # print the counts only
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path
from urllib.parse import urlencode

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from build_catalog import YASHVEER_HOSTED  # noqa: E402
from catalog_record import github_asset, upstream_url  # noqa: E402
from check_updates import GH_FOLDER  # noqa: E402
from pipeline import log, write_json  # noqa: E402

CATALOG = HERE.parent / 'catalog.json'
MANIFEST = HERE / 'external-ingested.json'
YASHVEER_REPO = 'yashveeeeeeer/india-geodata'
OVERTURE_STAC = 'https://stac.overturemaps.org/catalog.json'
GEOBOUNDARIES_API = 'https://www.geoboundaries.org/api/current/gbOpen/IND/{adm}/'
DATAGOV_LISTING = 'https://www.data.gov.in/backend/dmspublic/v1/resources'
GEOFABRIK_INDIA = 'https://download.geofabrik.de/asia/india-latest.osm.pbf'

_GB_ADM = re.compile(r'/gbOpen/IND/(ADM\d)/')


def datagov(**filters: str) -> str:
    """data.gov.in's resource listing, which needs no API key (unlike api.data.gov.in)."""
    q = {'format': 'json', 'limit': '200', **{f'filters[{k}]': v for k, v in filters.items()}}
    return f'{DATAGOV_LISTING}?{urlencode(q)}'


def manual(reason: str, url: str | None = None) -> dict:
    return {'method': 'manual', 'url': url, 'reason': reason}


DERIVED_FROM_LGD = 'derived by bharatlas from lgd_states; refresh it when lgd_states changes'

# Layers whose upstream the generic rules below would get wrong. Kept short and reviewable.
CORE_MWS = ('CoRE Stack serves these per tehsil from its GeoServer (about 600 files each, named by its tehsil-wise '
            'STAC files); the set is pinned by sha256 (scripts/bake_core_mws.py) and no check method reads '
            'per-tehsil files yet')
CORE_MWS_STAC = ('https://spatio-temporal-asset-catalog.s3.ap-south-1.amazonaws.com/'
                 'CorestackCatalogs_merged_collection/tehsil_wise/catalog.json')

OVERRIDES: dict[str, dict] = {
    # data.gov.in resources the bake scripts pull through the keyed API; the listing is keyless
    'mgnrega_districts': {'method': 'ckan', 'url': datagov(uuid='ee03643a-ee4c-48c2-ac30-9f2ff26ab722')},
    'wbc1_water_bodies': {'method': 'ckan', 'url': datagov(catalog_uuid='32f2ec95-ddca-4254-86c6-449d4471efe1')},
    'state_finance': manual('eight data.gov.in tables of Rajya Sabha answers; an answered question does not change',
                            'https://www.data.gov.in/'),
    'india_boundary': manual(DERIVED_FROM_LGD, 'https://lgdirectory.gov.in/'),
    'high_courts': manual(DERIVED_FROM_LGD, 'https://lgdirectory.gov.in/'),
    'ngt_zones': manual(DERIVED_FROM_LGD, 'https://lgdirectory.gov.in/'),
    'nclt_benches': manual(DERIVED_FROM_LGD, 'https://lgdirectory.gov.in/'),
    'ir_stations': manual('merged by bharatlas (scripts/bake_ir_stations_merged.py) from two copies of the CRIS '
                          'station layer (IR GIS portal, PM GatiShakti) and Wikidata; re-run that bake to refresh',
                          'https://irgeoportal.gov.in/'),
    'bharatviz_pincodes': manual('bharatviz.org/India_pincodes_simplified.geojson now answers with a web page, '
                                 'not the file', 'https://bharatviz.org/'),
    'wards_patna': manual('a cleaned copy made by hand (Jayesh Keswani, Nov 2026) of the datta07 file',
                          'https://github.com/datta07/INDIAN-SHAPEFILES'),
    'mi6_wells_districts': manual('summed by hand from the 6th Minor Irrigation Census files (a one-off census)',
                                  'https://mowr.nic.in/irrigationcensus/'),
    # the catalog's templated parquet link names a file the release never held; it holds the GeoJSON
    'nic_health': {'method': 'github_release',
                   'url': 'https://github.com/yashveeeeeeer/india-geodata/releases/download/healthcare/facilities/'
                          'INDIA_HEALTH_FACILITIES_NIC.geojson'},
    'seismic_zones': manual('the recorded india-geodata release (environment/seismic) does not exist',
                            'https://data.gov.in/'),
    # scripts/bake_transit.py: OSM's dated India extract (a HEAD follows india-latest to today's file); bus stops
    # come from five GTFS feeds and OSM, checked on the largest feed (the fast class rebuilds monthly anyway)
    'urban_rail_stations': {'method': 'http', 'url': GEOFABRIK_INDIA},
    'urban_rail_lines': {'method': 'http', 'url': GEOFABRIK_INDIA},
    'bus_stops': {'method': 'github_commit', 'url': 'https://github.com/Vonter/bmtc-gtfs/tree/main/gtfs'},
    # stops, ferry stops and bus stands: the extract again (their many feeds rebuild with it monthly)
    'transit_stops': {'method': 'http', 'url': GEOFABRIK_INDIA},
    'ferry_stops': {'method': 'http', 'url': GEOFABRIK_INDIA},
    'intercity_bus_stands': {'method': 'http', 'url': GEOFABRIK_INDIA},
    # scripts/bake_osm_underground.py: the same dated OSM extract
    'osm_tunnels': {'method': 'http', 'url': GEOFABRIK_INDIA},
    'osm_underground_utilities': {'method': 'http', 'url': GEOFABRIK_INDIA},
    'osm_mines_caves': {'method': 'http', 'url': GEOFABRIK_INDIA},
    'subsidence_megacities': manual('a paper\'s published data on figshare, pinned at version 3 '
                                    '(scripts/bake_subsidence_megacities.py); figshare refuses HEAD requests and no '
                                    'check method reads its API yet', 'https://doi.org/10.7294/25856260.v3'),
    'atal_bhujal_wells': manual('data.gov.in serves the file only after a login; the layer is CoRE Stack\'s copy, '
                                'pinned by sha256 (scripts/bake_atal_bhujal_wells.py), and the 2015-2022 series is '
                                'complete', 'https://www.data.gov.in/catalog/ground-water-level-data-under-atal-bhujal-yojana'),
    # scripts/bake_gem_active_faults.py pins the newest commit of the file; a new commit is a new version
    'gem_active_faults': {'method': 'github_commit',
                          'url': 'https://github.com/GEMScienceTools/gem-global-active-faults/tree/master/'
                                 'geojson/gem_active_faults.geojson'},
    'glhymps_permeability': manual('a paper\'s published data on Borealis, pinned at version 1.0 by md5 and sha256 '
                                   '(scripts/bake_glhymps_permeability.py); no check method reads the Dataverse '
                                   'API yet', 'https://doi.org/10.5683/SP2/TTJNIU'),
    'core_mws_water_balance': manual(CORE_MWS, CORE_MWS_STAC),
    'core_mws_drought': manual(CORE_MWS, CORE_MWS_STAC),
    'wris_groundwater_levels': manual('a live API with no version, change date or row count; the readings are '
                                      'pulled per district and year by scripts/bake_wris_groundwater.py',
                                      'https://indiawris.gov.in/v3/api-docs'),
    'property_tax_chennai_wards': manual('the Smart Cities portal puts each download behind a captcha',
                                         'https://smartcities.data.gov.in/catalog/property-tax-chennai'),
}


def override(layer_id: str) -> dict:
    """A copy of the layer's recorded check, for a bake to build its source_check on."""
    return dict(OVERRIDES[layer_id])


def _source_url(layer: dict, ext: dict | None) -> str | None:
    return (ext or {}).get('source_url') or ((layer.get('attribution') or {}).get('primary') or {}).get('url')


def infer(layer: dict, ext: dict | None) -> dict:
    """{method, url} (plus reason for manual) for one layer. `ext` is its external-ingested.json row, if any."""
    lid = layer['id']
    if lid in OVERRIDES:
        return override(lid)
    src = _source_url(layer, ext)
    if layer.get('provenance') == 'community':
        return manual('a community submission: the contributor sends a new version through /submit', src)

    # a recorded GeoJSON upstream is the file bharatlas converted; parquet/pmtiles links were often templated
    up = (layer.get('geojson') or {}).get('upstream_url') or upstream_url(layer) or ''
    gh = github_asset(up)
    # build_catalog templated india-geodata links for some city layers that its releases never held
    if gh and (gh[0] != YASHVEER_REPO or layer.get('source') in YASHVEER_HOSTED):
        return {'method': 'github_release', 'url': up}
    if 'overturemaps' in up:
        return {'method': 'http', 'url': OVERTURE_STAC}
    if 'drive.google.com' in up:
        return manual('a Google Drive file: Drive gives no metadata without an API key', up)
    m = _GB_ADM.search(up)
    if m and 'geoBoundaries' in up:
        return {'method': 'http', 'url': GEOBOUNDARIES_API.format(adm=m.group(1))}

    if not src:
        return manual('no upstream link is recorded')
    if GH_FOLDER.match(src):
        return {'method': 'github_commit', 'url': src}
    if 'data.opencity.in' in src:
        return manual('data.opencity.in answers scripts with a Cloudflare challenge', src)
    return manual('the source link is a portal page, not a file, release or dataset API', src)


def merge(old: dict | None, inferred: dict) -> dict:
    """The layer's new source_check: the recorded fingerprint and dates survive while method and URL do. A machine
    check a bake script recorded (bake_airports.py's github_commit) is kept when nothing better can be inferred."""
    if inferred['method'] == 'manual' and old and old.get('method') not in (None, 'manual'):
        return old
    keep = old and old.get('method') == inferred['method'] and old.get('url') == inferred.get('url')
    out = {'method': inferred['method'], 'url': inferred.get('url')}
    if 'reason' in inferred:
        out['reason'] = inferred['reason']
    for k in ('fingerprint', 'checked_at', 'changed_at'):
        out[k] = old.get(k) if keep else None
    return out


def populate(catalog: dict, manifest: list[dict]) -> dict:
    ext = {row['id']: row for row in manifest}
    for layer in catalog['layers']:
        old = layer.pop('source_check', None)    # re-added last, so the key sits at the end of every layer
        layer['source_check'] = merge(old, infer(layer, ext.get(layer['id'])))
        if 'refresh' in layer:                   # but before populate_refresh.py's block, which it keeps last
            layer['refresh'] = layer.pop('refresh')
    return catalog


def counts(catalog: dict) -> tuple[dict[str, int], dict[str, list[str]]]:
    """(layers per method, {manual reason: [layer ids]})."""
    methods: Counter = Counter()
    reasons: dict[str, list[str]] = {}
    for layer in catalog['layers']:
        sc = layer.get('source_check') or {}
        methods[sc.get('method')] += 1
        if sc.get('method') == 'manual':
            reasons.setdefault(sc.get('reason'), []).append(layer['id'])
    return dict(methods), reasons


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--catalog', default=str(CATALOG))
    ap.add_argument('--dry-run', action='store_true', help='print the counts, write nothing')
    args = ap.parse_args(argv)

    path = Path(args.catalog)
    text = path.read_text()
    catalog = populate(json.loads(text), json.loads(MANIFEST.read_text()))
    methods, reasons = counts(catalog)
    log('methods: ' + ', '.join(f'{m} {n}' for m, n in sorted(methods.items(), key=lambda kv: -kv[1])))
    for reason, ids in sorted(reasons.items(), key=lambda kv: -len(kv[1])):
        log(f'  manual ({len(ids)}): {reason}: {", ".join(ids)}')
    if args.dry_run:
        return 0
    if json.dumps(catalog, indent=2) + '\n' == text:
        log('catalog.json unchanged')
        return 0
    write_json(path, catalog)
    log(f'wrote {path}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
