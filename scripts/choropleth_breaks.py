#!/usr/bin/env python3
"""Choropleth breaks for value layers, patched into catalog.json in place.

A value layer carries money or a measured quantity per polygon; its map is
coloured by one column (web: shared/choropleth.mjs). This script owns which
column each layer uses and computes the class breaks from the layer's parquet
(equal-count quintiles, rounded to two significant figures), so the browser
never scans data. Writes layer.choropleth = {column, label, unit, breaks}.

Re-run after a layer is rebaked (its register step rewrites the catalog
entry). Idempotent: the same data gives the same breaks and no write. The
column must also be in the layer's PMTiles (tile attributes), or the map shows
every polygon as no data.

Usage: python3 -u scripts/choropleth_breaks.py [layer_id ...]
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pipeline import write_json  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / 'catalog.json'
CLASSES = 5

CHOROPLETH_LAYERS: dict[str, dict[str, str]] = {
    'mgnrega_districts': {
        'column': 'Total_Exp', 'label': 'MGNREGA spending, 2025-26', 'unit': 'Rs lakh'},
    'cityfinance_ulbs': {
        'column': 'total_expenditure', 'label': 'Total expenditure, latest year', 'unit': 'Rs'},
    'state_finance': {
        'column': 'nsdp_per_capita_current_2021_22_rs', 'label': 'Per capita income (NSDP), 2021-22',
        'unit': 'Rs per person'},
    'mi6_wells_districts': {
        'column': 'total', 'label': 'Wells counted, 2017-18', 'unit': 'wells'},
    'corestack_lulc_blocks': {
        'column': 'cropping_intensity_index', 'label': 'Cropping intensity, 2023-24',
        'unit': 'crops a year'},
    'property_tax_chennai_wards': {
        'column': '2017-18 - Property Tax Collection (in crores) - Residential',
        'label': 'Residential property tax collected, 2017-18', 'unit': 'INR crore'},
    'cityfinance_ulb_balance_sheets': {
        'column': 'total_assets', 'label': 'Total assets (latest year)', 'unit': 'INR'},
}


def nice_round(v: float, sig: int = 2) -> float:
    """Round to `sig` significant figures; whole numbers come back as int."""
    if not v:
        return 0
    r = round(v, sig - 1 - math.floor(math.log10(abs(v))))
    return int(r) if r == int(r) else r


def breaks_from(quantiles: list[float], minimum: float) -> list[float]:
    """Rounded quantiles, strictly ascending and above the minimum."""
    out: list[float] = []
    for q in quantiles:
        b = nice_round(q)
        if b > minimum and (not out or b > out[-1]):
            out.append(b)
    return out


def compute_breaks(parquet_url: str, column: str) -> list[float]:
    import duckdb
    con = duckdb.connect()
    con.execute('INSTALL httpfs; LOAD httpfs;')
    probs = [i / CLASSES for i in range(1, CLASSES)]
    lo, qs = con.execute(
        f'SELECT min("{column}"), quantile_cont("{column}", {probs}) FROM read_parquet(?) '
        f'WHERE "{column}" IS NOT NULL AND isfinite("{column}")', [parquet_url]).fetchone()
    return breaks_from(list(qs or []), lo)


def patch_catalog(catalog: dict, breaks_by_id: dict[str, list[float]]) -> list[str]:
    """Set each layer's choropleth block; return the ids that changed."""
    changed = []
    for layer in catalog['layers']:
        lid = layer['id']
        if lid not in breaks_by_id:
            continue
        block = {**CHOROPLETH_LAYERS[lid], 'breaks': breaks_by_id[lid]}
        if layer.get('choropleth') != block:
            layer['choropleth'] = block
            changed.append(lid)
    return changed


def main(ids: list[str]) -> None:
    catalog = json.loads(CATALOG.read_text())
    layers = {l['id']: l for l in catalog['layers']}
    breaks = {}
    for lid in ids or CHOROPLETH_LAYERS:
        cfg = CHOROPLETH_LAYERS[lid]
        url = (layers.get(lid, {}).get('parquet') or {}).get('url')
        if not url:
            print(f'  {lid}: no parquet in catalog, skipped', flush=True)
            continue
        breaks[lid] = compute_breaks(url, cfg['column'])
        print(f'  {lid}.{cfg["column"]}: breaks {breaks[lid]}', flush=True)
    changed = patch_catalog(catalog, breaks)
    if changed:
        write_json(CATALOG, catalog)
    print(f'catalog.json: {"updated " + ", ".join(changed) if changed else "unchanged"}', flush=True)


if __name__ == '__main__':
    main(sys.argv[1:])
