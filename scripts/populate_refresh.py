#!/usr/bin/env python3
"""
Give every catalog layer a `refresh` block: how it is kept up to date (spec-data-lifecycle sections 4 and 5).
Internal, like `source_check`: web/scripts/public-catalog.mjs strips it from the served catalog.

    refresh = {class, check, rebuild, release, audit, audited_at, next_due}   (+ tolerance, tolerance_reason,
                                                                            audit_result)

Classes (the owner's decisions of 18 Nov 2026):
  frozen   a one-off or historical publication that will not change: never checked, never rebuilt, released once
  slow     official boundaries and registers revised a few times a year or less: checked weekly, rebuilt when the
           check says changed, released on each rebuild; row count within 2% of the previous version
  regular  data revised several times a year: checked weekly, rebuilt monthly if changed; within 10%
  fast     infrastructure and points of interest that change month to month: checked weekly, rebuilt and released
           monthly whatever the check says; within 25%

The class is inferred from the layer's category and level by RULES (each with its reason); OVERRIDES sets it, or a
per-layer row-count tolerance with its reason, where the rules are wrong. Both are short, for the owner to review.

`next_due` is a month after the last build (fetched_at, or the layer's newest release if later) for monthly
rebuilds, and null otherwise. check_updates.py recomputes it for the "Due or overdue" table in the Source updates
issue from the last refresh (last_refresh): the last build, or a later weekly check that found the source identical,
when that check is strong (weak_check says which are not). The catalog's next_due stays build-only, because the
check results live in data/update-status.json, not the catalog. `audited_at` is kept from the catalog: it is recorded
when a build's audit is done, never here.

Idempotent: the block depends only on the catalog and the release index, never on the day it runs; a second run
writes nothing.

Usage:
    python3 scripts/populate_refresh.py            # patch catalog.json in place, print the counts and reasons
    python3 scripts/populate_refresh.py --dry-run  # print them only
"""
from __future__ import annotations

import argparse
import calendar
import json
import re
import sys
from collections import Counter
from datetime import date
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from pipeline import log, write_json  # noqa: E402

ROOT = HERE.parent
CATALOG = ROOT / 'catalog.json'
RELEASES = ROOT / 'web' / 'public' / 'releases' / 'index.json'

CLASSES: dict[str, dict[str, str]] = {
    'frozen': {'check': 'never', 'rebuild': 'never', 'release': 'once'},
    'slow': {'check': 'weekly', 'rebuild': 'on_change', 'release': 'on_rebuild'},
    'regular': {'check': 'weekly', 'rebuild': 'monthly_if_changed', 'release': 'on_rebuild'},
    'fast': {'check': 'weekly', 'rebuild': 'monthly', 'release': 'monthly'},
}
TOLERANCE = {'slow': 0.02, 'regular': 0.10, 'fast': 0.25}     # row count against the previous version
MONTHLY = ('monthly', 'monthly_if_changed')

# Ordered: the first rule that matches a layer sets its class. (test, class, reason)
RULES = [
    (lambda lyr: lyr.get('provenance') == 'community', 'frozen',
     'a community submission: it changes only when its contributor sends a new version through /submit'),
    (lambda lyr: lyr.get('level') == 'pincode', 'regular',
     'pincode boundaries are revised several times a year'),
    (lambda lyr: lyr.get('category') == 'city-wards', 'regular',
     'city wards and zones are redrawn and renumbered between elections'),
    (lambda lyr: 'police_stations' in lyr['id'], 'regular',
     'state police portals rarely change; rebuild when the source does (owner, 2026-11-18)'),
    (lambda lyr: lyr.get('category') == 'transport', 'fast',
     'transport networks and stations are built and changed month to month'),
    (lambda lyr: lyr.get('category') == 'health-edu', 'fast',
     'health facilities and schools open, close and move month to month'),
    (lambda lyr: lyr.get('category') == 'infrastructure', 'fast',
     'infrastructure and points of interest (places, utilities, power) are built and changed month to month'),
    (lambda lyr: lyr.get('category') == 'economy', 'regular',
     'financial figures are revised as each year\'s statements and returns are filed'),
    (lambda lyr: True, 'slow',
     'official boundaries, zones and registers, revised a few times a year or less'),
]

HISTORICAL = 'a historical vintage, kept as published; a newer one is a separate layer'
ONE_OFF_CENSUS = 'a one-off census: its tables are final once published'
OSM_AUDIT = ('rows per tag set (tunnel, buried pipeline or cable, mine or cave) against the previous build; '
             'every row in the tiles at the top zoom; no mapper data (user, uid, changeset) in the columns')
JUDICIARY = 'a bharatlas-derived judiciary map, dissolved from LGD states by a gazette notification'

# Layers the rules get wrong, or whose class audit needs naming.
# {id: {class?, reason?, tolerance?, tolerance_reason?, audit?}}; a tolerance needs its reason.
OVERRIDES: dict[str, dict] = {
    'state_finance': {'class': 'frozen', 'reason': 'one-off snapshots of Rajya Sabha answers; an answered '
                                                   'question does not change'},
    'mi6_wells_districts': {'class': 'frozen', 'reason': ONE_OFF_CENSUS + ' (6th Minor Irrigation Census, 2017-18)'},
    'wbc1_water_bodies': {'class': 'frozen', 'reason': ONE_OFF_CENSUS + ' (1st Census of Water Bodies, 2017-18)'},
    'property_tax_chennai_wards': {'class': 'frozen',
                                   'reason': 'a closed 2013-2018 table from the Smart Cities portal'},
    'wards_bengaluru_bbmp_2022': {'class': 'frozen',
                                  'reason': HISTORICAL + ' (BBMP 2022 draft wards, superseded by the 2025 GBA wards)'},
    'wards_hyderabad_osm': {'class': 'frozen',
                            'reason': HISTORICAL + ' (the 2017-18 OpenStreetMap ward map, replaced by GHMC\'s)'},
    'electoral_wards_mumbai_2017': {'class': 'frozen', 'reason': HISTORICAL + ' (the 2017 delimitation)'},
    'vedas_solar_panels_ai_2023': {'class': 'frozen', 'reason': HISTORICAL + ' (a 2023 detection run)'},
    'ndem_floods_1998_2022': {'class': 'frozen', 'reason': HISTORICAL + ' (flood extents for 1998-2022)'},
    'subsidence_megacities': {'class': 'frozen', 'reason': 'a paper\'s published data (Ohenhen et al. 2025), '
                                                           'pinned at its figshare version'},
    'atal_bhujal_wells': {'class': 'frozen', 'reason': HISTORICAL + ' (well levels for 2015-2022)'},
    'glhymps_permeability': {'class': 'frozen', 'reason': 'a paper\'s published data (GLHYMPS 2.0, Huscroft et al. '
                                                          '2018), pinned at its Borealis version'},
    'high_courts': {'class': 'frozen', 'reason': JUDICIARY},
    'ngt_zones': {'class': 'frozen', 'reason': JUDICIARY},
    'nclt_benches': {'class': 'frozen', 'reason': JUDICIARY},
    'amrit_sarovar_ponds': {'class': 'fast', 'reason': 'Mission Amrit Sarovar ponds are being built and added'},
    'cgwb_gw_extraction': {'class': 'regular', 'reason': 'groundwater is reassessed every year or two'},
    'gw_quality_premonsoon': {'class': 'regular', 'reason': 'groundwater quality is sampled every season'},
    'gw_quality_postmonsoon': {'class': 'regular', 'reason': 'groundwater quality is sampled every season'},
    # scripts/bake_transit.py writes audited_at and audit_result (the numbers) on each build
    'urban_rail_stations': {'audit': 'stations per system within 2 of Wikipedia\'s operational count (Urban rail '
                                     'transit in India) and against OSM\'s tagged count; no under-construction '
                                     'stations; operational lines and stations reviewed for Mumbai and Chennai; '
                                     'Delhi Metro from station tags; the Mumbai Monorail out while suspended'},
    'urban_rail_lines': {'audit': 'lines per system against Wikipedia\'s operational lines; operational sections '
                                  'only (Mumbai 2B and 9, Chennai Yellow)'},
    # scripts/bake_osm_underground.py: OSM changes month to month like the transit layers (owner, 2026-11-21)
    'osm_tunnels': {'audit': OSM_AUDIT},
    'osm_underground_utilities': {'audit': OSM_AUDIT},
    'osm_mines_caves': {'class': 'fast', 'reason': 'mapped in OpenStreetMap, which changes month to month',
                        'audit': OSM_AUDIT},
    'bus_stops': {'audit': 'stops per city against each GTFS feed\'s stops.txt and the OSM count in the city; '
                           'every row names its source and licence'},
}


def _pct(x: float) -> str:
    return f'{x * 100:g}%'


def audit_text(klass: str, tolerance: float | None, class_audit: str | None = None) -> str:
    """What each build is checked against; `class_audit` names what a fast layer's own audit compares."""
    if klass == 'frozen':
        return 'none while frozen: re-check by hand if the source publishes a correction'
    out = (f'row count within {_pct(tolerance)} of the previous version; schema diff (removed or renamed columns '
           'noted in CHANGES.md); licence and source unchanged; flat bbox and Hilbert sort; tiles decode')
    if class_audit:
        return f'{out}; the class audit: {class_audit}'
    return out + ('; the class audit (counts against the reference)' if klass == 'fast' else '')


def infer(layer: dict) -> tuple[dict, str]:
    """(the refresh block without audited_at and next_due, the reason for its class)."""
    over = OVERRIDES.get(layer['id'], {})
    if 'tolerance' in over and not over.get('tolerance_reason'):
        raise ValueError(f'{layer["id"]}: a tolerance override needs a tolerance_reason')
    klass, reason = next((k, r) for test, k, r in RULES if test(layer))
    klass, reason = over.get('class', klass), over.get('reason', reason)
    block = {'class': klass, **CLASSES[klass]}
    tolerance = over.get('tolerance', TOLERANCE.get(klass))
    block['audit'] = audit_text(klass, tolerance, over.get('audit'))
    if 'tolerance' in over:
        block['tolerance'] = over['tolerance']
        block['tolerance_reason'] = over['tolerance_reason']
    return block, reason


# ── dates ───────────────────────────────────────────────────────────────────

def _add_month(d: date) -> date:
    y, m = (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
    return d.replace(year=y, month=m, day=min(d.day, calendar.monthrange(y, m)[1]))


def next_due(rebuild: str, last: str | None) -> str | None:
    """The date the next rebuild is due: a month after the last build for monthly rebuilds, else None."""
    if rebuild not in MONTHLY or not last:
        return None
    return _add_month(date.fromisoformat(last[:10])).isoformat()


def last_build(layer: dict, releases: dict | None) -> str | None:
    """YYYY-MM-DD of the layer's last build: its fetched_at, or its newest release if that is later."""
    dates = [r['released'] for r in (releases or {}).get('releases', []) if r.get('dataset') == layer['id']]
    if layer.get('fetched_at'):
        dates.append(layer['fetched_at'][:10])
    return max(dates) if dates else None


# ── how much a source check proves ──────────────────────────────────────────
#
# The owner's decision of 19 Nov 2026: a weekly check that finds a layer's source identical counts as the layer's
# refresh, but only when the check is STRONG, an exact fingerprint of the published data:
#   github_release  a release asset's updated_at and size, or a repository's latest release tag
#   github_commit   the sha of the latest commit touching the source folder
#   ckan            the dataset record: data.gov.in's per-resource `changed`, or CKAN's metadata_modified
#   http            the ETag / Last-Modified / length of a data file (a path ending in a data extension, such as
#                   Overture's STAC catalog.json) or of a dataset's API record (a path under /api/, geoBoundaries)
# A WEAK check says nothing reliable about the data, so the layer keeps its build-date schedule:
#   http on a page  a landing page's headers change with the page, not with the data behind it
#   OpenStreetMap   an extract (Geofabrik's .pbf) changes daily whatever happens to the features a layer keeps
#   GTFS            a feed (method gtfs, or a feed's repository folder) is rebuilt and re-dated without the stops
#                   changing, and bharatlas's transit layers also draw on OpenStreetMap
#   manual or none  no machine check at all
#   data.gov.in     a resource marked frequency Daily: its `changed` moves every day whether or not the data did
#                   (mgnrega_districts). Read from the answer, so check_updates.answer_weakness decides it, not this
# WEAK_CHECKS names layers whose check looks strong but is not, with the reason.

WEAK_CHECKS: dict[str, str] = {
    'airports': 'OurAirports re-commits its data every night for the whole world, whatever happens to India\'s rows',
}
DATA_FILE = re.compile(r'\.(parquet|geojson|json|zip|gpkg|shp|kml|kmz|csv|pmtiles|tiff?|gz|xlsx?)$', re.I)
OSM_HOSTS = ('geofabrik.de', 'openstreetmap.org', 'openstreetmap.fr', 'overpass-api.de')
STRONG_METHODS = ('github_release', 'github_commit', 'ckan')


def weak_check(layer: dict) -> str | None:
    """Why the layer's source check cannot confirm its data unchanged, or None when it can (a strong check)."""
    if layer['id'] in WEAK_CHECKS:
        return WEAK_CHECKS[layer['id']]
    check = layer.get('source_check') or {}
    method, url = check.get('method'), check.get('url') or ''
    u = urlparse(url)
    if method in (None, 'manual'):
        return 'no machine check, checked by hand'
    if method == 'gtfs' or 'gtfs' in url.lower():
        return 'a GTFS feed is re-dated without its stops changing'
    if u.netloc.endswith(OSM_HOSTS):
        return 'an OpenStreetMap extract changes daily whatever happens to this layer\'s features'
    if method in STRONG_METHODS:
        return None
    if method == 'http' and (DATA_FILE.search(u.path) or '/api/' in u.path):
        return None
    if method == 'http':
        return 'the check reads a page, not the data file'
    return f'unknown check method {method!r}'


def last_refresh(layer: dict, releases: dict | None, identical_on: str | None) -> str | None:
    """YYYY-MM-DD of the layer's last refresh: its last build, or `identical_on` (the day a check confirmed its
    source identical to what bharatlas holds) if that is later and the check is strong."""
    dates = [d for d in (last_build(layer, releases), None if weak_check(layer) else identical_on) if d]
    return max(d[:10] for d in dates) if dates else None


# ── the catalog ─────────────────────────────────────────────────────────────

def populate(catalog: dict, releases: dict | None) -> dict:
    for layer in catalog['layers']:
        old = layer.pop('refresh', None) or {}     # re-added last, so the key sits at the end of every layer
        block, _ = infer(layer)
        tolerance = {k: block.pop(k) for k in ('tolerance', 'tolerance_reason') if k in block}
        # audit_result (the numbers of the last build's class audit) is written by the layer's bake, kept here
        result = {'audit_result': old['audit_result']} if 'audit_result' in old else {}
        layer['refresh'] = {**block, 'audited_at': old.get('audited_at'),
                            'next_due': next_due(block['rebuild'], last_build(layer, releases)), **tolerance, **result}
    return catalog


def counts(catalog: dict) -> tuple[dict[str, int], dict[tuple[str, str], list[str]]]:
    """(layers per class, {(class, reason): [layer ids]})."""
    classes: Counter = Counter()
    reasons: dict[tuple[str, str], list[str]] = {}
    for layer in catalog['layers']:
        block, reason = infer(layer)
        classes[block['class']] += 1
        reasons.setdefault((block['class'], reason), []).append(layer['id'])
    return dict(classes), reasons


def load_releases(path: Path) -> dict | None:
    return json.loads(path.read_text()) if path.exists() else None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--catalog', default=str(CATALOG))
    ap.add_argument('--releases', default=str(RELEASES), help='the release index (web/public/releases/index.json)')
    ap.add_argument('--dry-run', action='store_true', help='print the counts, write nothing')
    args = ap.parse_args(argv)

    path = Path(args.catalog)
    text = path.read_text()
    catalog = populate(json.loads(text), load_releases(Path(args.releases)))
    classes, reasons = counts(catalog)
    log('classes: ' + ', '.join(f'{k} {classes.get(k, 0)}' for k in CLASSES))
    for (klass, reason), ids in sorted(reasons.items(), key=lambda kv: (list(CLASSES).index(kv[0][0]), -len(kv[1]))):
        log(f'  {klass} ({len(ids)}): {reason}: {", ".join(ids)}')
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
