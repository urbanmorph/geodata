"""
Bake judiciary jurisdiction layers by dissolving LGD state polygons.

Produces three GeoJSON FeatureCollections (+ KML + Shapefile):
  - high_courts.geojson    (25 features — one per High Court)
  - ngt_zones.geojson      (5 features — NGT zonal benches)
  - nclt_benches.geojson   (15 features — NCLT benches)

Each feature carries rich properties for the viewer's filter panel:
name, short_name, seat, bench_type, states_covered, state_count,
established (HC only), website (HC only).

Source: LGD_States.parquet (India's authoritative admin boundaries).
Jurisdiction mappings from Wikipedia, eCourts, greentribunal.gov.in,
nclt.gov.in — verified May 2026.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import duckdb

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SRC = ROOT / "sources" / "india-geodata" / "LGD_States.parquet"
OUT = ROOT / "data" / "baked" / "judiciary"

sys.path.insert(0, str(HERE))
from bake_extracts import write_kml_from_geojson  # noqa: E402
from bake_whole_layer import write_shapefile_zip, have_ogr2ogr  # noqa: E402


# ── 25 High Courts ──────────────────────────────────────────────────────

HIGH_COURTS = {
    'allahabad': {'name': 'Allahabad High Court', 'short': 'Allahabad HC', 'seat': 'Prayagraj', 'est': 1866, 'web': 'allahabadhighcourt.in', 'states': ['UTTAR PRADESH']},
    'andhra_pradesh': {'name': 'Andhra Pradesh High Court', 'short': 'AP HC', 'seat': 'Amaravati', 'est': 2019, 'web': 'aphc.gov.in', 'states': ['ANDHRA PRADESH']},
    'bombay': {'name': 'Bombay High Court', 'short': 'Bombay HC', 'seat': 'Mumbai', 'est': 1862, 'web': 'bombayhighcourt.nic.in', 'states': ['MAHARASHTRA', 'GOA', 'DADRA,NAGAR HAVELI,DAMAN & DIU']},
    'calcutta': {'name': 'Calcutta High Court', 'short': 'Calcutta HC', 'seat': 'Kolkata', 'est': 1862, 'web': 'calcuttahighcourt.gov.in', 'states': ['WEST BENGAL', 'ANDAMAN & NICOBAR']},
    'chhattisgarh': {'name': 'Chhattisgarh High Court', 'short': 'CG HC', 'seat': 'Bilaspur', 'est': 2000, 'web': 'highcourt.cg.gov.in', 'states': ['CHHATTISGARH']},
    'delhi': {'name': 'Delhi High Court', 'short': 'Delhi HC', 'seat': 'New Delhi', 'est': 1966, 'web': 'delhihighcourt.nic.in', 'states': ['DELHI']},
    'gauhati': {'name': 'Gauhati High Court', 'short': 'Gauhati HC', 'seat': 'Guwahati', 'est': 1948, 'web': 'ghconline.gov.in', 'states': ['ASSAM', 'ARUNACHAL PRADESH', 'MIZORAM', 'NAGALAND']},
    'gujarat': {'name': 'Gujarat High Court', 'short': 'Gujarat HC', 'seat': 'Ahmedabad', 'est': 1960, 'web': 'gujarathighcourt.nic.in', 'states': ['GUJARAT']},
    'himachal_pradesh': {'name': 'Himachal Pradesh High Court', 'short': 'HP HC', 'seat': 'Shimla', 'est': 1971, 'web': 'hphighcourt.nic.in', 'states': ['HIMACHAL PRADESH']},
    'jammu_kashmir_ladakh': {'name': 'High Court of Jammu & Kashmir and Ladakh', 'short': 'J&K HC', 'seat': 'Srinagar', 'est': 1928, 'web': 'jkhighcourt.nic.in', 'states': ['JAMMU & KASHMIR', 'LADAKH']},
    'jharkhand': {'name': 'Jharkhand High Court', 'short': 'Jharkhand HC', 'seat': 'Ranchi', 'est': 2000, 'web': 'jharkhandhighcourt.nic.in', 'states': ['JHARKHAND']},
    'karnataka': {'name': 'Karnataka High Court', 'short': 'Karnataka HC', 'seat': 'Bengaluru', 'est': 1884, 'web': 'karnatakajudiciary.kar.nic.in', 'states': ['KARNATAKA']},
    'kerala': {'name': 'Kerala High Court', 'short': 'Kerala HC', 'seat': 'Kochi', 'est': 1956, 'web': 'highcourtofkerala.nic.in', 'states': ['KERALA', 'LAKSHADWEEP']},
    'madhya_pradesh': {'name': 'Madhya Pradesh High Court', 'short': 'MP HC', 'seat': 'Jabalpur', 'est': 1956, 'web': 'mphc.gov.in', 'states': ['MADHYA PRADESH']},
    'madras': {'name': 'Madras High Court', 'short': 'Madras HC', 'seat': 'Chennai', 'est': 1862, 'web': 'mhc.tn.gov.in', 'states': ['TAMIL NADU', 'PUDUCHERRY']},
    'manipur': {'name': 'Manipur High Court', 'short': 'Manipur HC', 'seat': 'Imphal', 'est': 2013, 'web': 'hcmimphal.nic.in', 'states': ['MANIPUR']},
    'meghalaya': {'name': 'Meghalaya High Court', 'short': 'Meghalaya HC', 'seat': 'Shillong', 'est': 2013, 'web': 'meghighcourt.nic.in', 'states': ['MEGHALAYA']},
    'orissa': {'name': 'Orissa High Court', 'short': 'Orissa HC', 'seat': 'Cuttack', 'est': 1948, 'web': 'orissahighcourt.nic.in', 'states': ['ODISHA']},
    'patna': {'name': 'Patna High Court', 'short': 'Patna HC', 'seat': 'Patna', 'est': 1916, 'web': 'patnahighcourt.gov.in', 'states': ['BIHAR']},
    'punjab_haryana': {'name': 'Punjab and Haryana High Court', 'short': 'P&H HC', 'seat': 'Chandigarh', 'est': 1947, 'web': 'highcourtchd.gov.in', 'states': ['PUNJAB', 'HARYANA', 'CHANDIGARH']},
    'rajasthan': {'name': 'Rajasthan High Court', 'short': 'Rajasthan HC', 'seat': 'Jodhpur', 'est': 1949, 'web': 'hcraj.nic.in', 'states': ['RAJASTHAN']},
    'sikkim': {'name': 'Sikkim High Court', 'short': 'Sikkim HC', 'seat': 'Gangtok', 'est': 1975, 'web': 'highcourtofsikkim.nic.in', 'states': ['SIKKIM']},
    'telangana': {'name': 'Telangana High Court', 'short': 'Telangana HC', 'seat': 'Hyderabad', 'est': 2019, 'web': 'tshc.gov.in', 'states': ['TELANGANA']},
    'tripura': {'name': 'Tripura High Court', 'short': 'Tripura HC', 'seat': 'Agartala', 'est': 2013, 'web': 'thc.nic.in', 'states': ['TRIPURA']},
    'uttarakhand': {'name': 'Uttarakhand High Court', 'short': 'Uttarakhand HC', 'seat': 'Nainital', 'est': 2000, 'web': 'highcourtofuttarakhand.gov.in', 'states': ['UTTARAKHAND']},
}

# ── 5 NGT Zonal Benches ────────────────────────────────────────────────

NGT_ZONES = {
    'principal': {'name': 'NGT Principal Bench', 'short': 'NGT Delhi', 'seat': 'New Delhi',
        'states': ['UTTAR PRADESH', 'UTTARAKHAND', 'PUNJAB', 'HARYANA', 'HIMACHAL PRADESH', 'JAMMU & KASHMIR', 'LADAKH', 'DELHI', 'CHANDIGARH']},
    'central': {'name': 'NGT Central Zone Bench', 'short': 'NGT Bhopal', 'seat': 'Bhopal',
        'states': ['MADHYA PRADESH', 'RAJASTHAN', 'CHHATTISGARH']},
    'eastern': {'name': 'NGT Eastern Zone Bench', 'short': 'NGT Kolkata', 'seat': 'Kolkata',
        'states': ['WEST BENGAL', 'ODISHA', 'BIHAR', 'JHARKHAND', 'SIKKIM', 'ASSAM', 'ARUNACHAL PRADESH', 'NAGALAND', 'MANIPUR', 'MEGHALAYA', 'MIZORAM', 'TRIPURA', 'ANDAMAN & NICOBAR']},
    'southern': {'name': 'NGT Southern Zone Bench', 'short': 'NGT Chennai', 'seat': 'Chennai',
        'states': ['TAMIL NADU', 'KERALA', 'KARNATAKA', 'ANDHRA PRADESH', 'TELANGANA', 'PUDUCHERRY', 'LAKSHADWEEP']},
    'western': {'name': 'NGT Western Zone Bench', 'short': 'NGT Pune', 'seat': 'Pune',
        'states': ['MAHARASHTRA', 'GUJARAT', 'GOA', 'DADRA,NAGAR HAVELI,DAMAN & DIU']},
}

# ── 15 NCLT Benches ─────────────────────────────────────────────────────

NCLT_BENCHES = {
    'new_delhi': {'name': 'NCLT Principal Bench', 'short': 'NCLT Delhi', 'seat': 'New Delhi', 'states': ['DELHI']},
    'ahmedabad': {'name': 'NCLT Ahmedabad Bench', 'short': 'NCLT Ahmedabad', 'seat': 'Ahmedabad', 'states': ['GUJARAT', 'DADRA,NAGAR HAVELI,DAMAN & DIU']},
    'allahabad': {'name': 'NCLT Allahabad Bench', 'short': 'NCLT Prayagraj', 'seat': 'Prayagraj', 'states': ['UTTAR PRADESH', 'UTTARAKHAND']},
    'amaravati': {'name': 'NCLT Amaravati Bench', 'short': 'NCLT Amaravati', 'seat': 'Hyderabad', 'states': ['ANDHRA PRADESH']},
    'bengaluru': {'name': 'NCLT Bengaluru Bench', 'short': 'NCLT Bengaluru', 'seat': 'Bengaluru', 'states': ['KARNATAKA']},
    'chandigarh': {'name': 'NCLT Chandigarh Bench', 'short': 'NCLT Chandigarh', 'seat': 'Chandigarh', 'states': ['PUNJAB', 'HARYANA', 'HIMACHAL PRADESH', 'JAMMU & KASHMIR', 'LADAKH', 'CHANDIGARH']},
    'chennai': {'name': 'NCLT Chennai Bench', 'short': 'NCLT Chennai', 'seat': 'Chennai', 'states': ['TAMIL NADU', 'PUDUCHERRY']},
    'cuttack': {'name': 'NCLT Cuttack Bench', 'short': 'NCLT Cuttack', 'seat': 'Cuttack', 'states': ['ODISHA', 'CHHATTISGARH']},
    'guwahati': {'name': 'NCLT Guwahati Bench', 'short': 'NCLT Guwahati', 'seat': 'Guwahati', 'states': ['ASSAM', 'ARUNACHAL PRADESH', 'MANIPUR', 'MIZORAM', 'MEGHALAYA', 'NAGALAND', 'SIKKIM', 'TRIPURA']},
    'hyderabad': {'name': 'NCLT Hyderabad Bench', 'short': 'NCLT Hyderabad', 'seat': 'Hyderabad', 'states': ['TELANGANA']},
    'indore': {'name': 'NCLT Indore Bench', 'short': 'NCLT Indore', 'seat': 'Indore', 'states': ['MADHYA PRADESH']},
    'jaipur': {'name': 'NCLT Jaipur Bench', 'short': 'NCLT Jaipur', 'seat': 'Jaipur', 'states': ['RAJASTHAN']},
    'kochi': {'name': 'NCLT Kochi Bench', 'short': 'NCLT Kochi', 'seat': 'Kochi', 'states': ['KERALA', 'LAKSHADWEEP']},
    'kolkata': {'name': 'NCLT Kolkata Bench', 'short': 'NCLT Kolkata', 'seat': 'Kolkata', 'states': ['WEST BENGAL', 'BIHAR', 'JHARKHAND', 'ANDAMAN & NICOBAR']},
    'mumbai': {'name': 'NCLT Mumbai Bench', 'short': 'NCLT Mumbai', 'seat': 'Mumbai', 'states': ['MAHARASHTRA', 'GOA']},
}


def dissolve_layer(
    con: duckdb.DuckDBPyConnection,
    parquet: Path,
    jurisdictions: dict,
    layer_type: str,
    out_geojson: Path,
) -> None:
    """Dissolve LGD states into jurisdiction polygons."""
    out_geojson.parent.mkdir(parents=True, exist_ok=True)
    features = []
    for key, info in jurisdictions.items():
        state_names = info['states']
        placeholders = ', '.join(f"'{s}'" for s in state_names)
        row = con.execute(
            f"SELECT ST_AsGeoJSON(ST_Union_Agg(geometry)) AS gj "
            f"FROM '{parquet.as_posix()}' "
            f"WHERE STNAME IN ({placeholders})"
        ).fetchone()
        if not row or not row[0]:
            print(f"  WARN: no geometry for {key} ({state_names})")
            continue
        props = {
            'name': info['name'],
            'short_name': info['short'],
            'seat': info['seat'],
            'court_type': layer_type,
            'states_covered': ', '.join(info['states']),
            'state_count': len(info['states']),
        }
        if 'est' in info:
            props['established'] = info['est']
        if 'web' in info:
            props['website'] = info['web']
        features.append({
            'type': 'Feature',
            'properties': props,
            'geometry': json.loads(row[0]),
        })
    fc = {'type': 'FeatureCollection', 'features': features}
    with out_geojson.open('w', encoding='utf-8') as f:
        json.dump(fc, f, ensure_ascii=False, separators=(',', ':'))
    print(f"  wrote {out_geojson.name}: {len(features)} features, {out_geojson.stat().st_size:,} bytes")


def geojson_to_parquet(con: duckdb.DuckDBPyConnection, gj: Path, out: Path) -> None:
    """Convert a GeoJSON FeatureCollection to spatial Parquet via DuckDB."""
    out.parent.mkdir(parents=True, exist_ok=True)
    con.execute(
        f"COPY (SELECT * FROM ST_Read('{gj.as_posix()}')) "
        f"TO '{out.as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD)"
    )


def geojson_to_pmtiles(gj: Path, out: Path) -> None:
    """Convert GeoJSON to PMTiles via tippecanoe (if available)."""
    import subprocess
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([
        'tippecanoe',
        '-o', str(out),
        '-zg',             # auto max zoom
        '--drop-densest-as-needed',
        '--extend-zooms-if-still-dropping',
        '-l', gj.stem,    # layer name = filename stem
        '--force',         # overwrite
        str(gj),
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def main() -> int:
    if not SRC.exists():
        print(f"ERROR: {SRC} not found — download via scripts/fetch.sh")
        return 1

    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial")
    ogr2ogr_ok = have_ogr2ogr()
    import shutil
    tippecanoe_ok = shutil.which('tippecanoe') is not None
    OUT.mkdir(parents=True, exist_ok=True)

    layers = [
        ('high_courts', HIGH_COURTS, 'High Court'),
        ('ngt_zones', NGT_ZONES, 'NGT'),
        ('nclt_benches', NCLT_BENCHES, 'NCLT'),
    ]

    for basename, lookup, court_type in layers:
        gj = OUT / f'{basename}.geojson'
        print(f"\n=== {basename} ({len(lookup)} jurisdictions) ===")
        dissolve_layer(con, SRC, lookup, court_type, gj)

        pq = OUT / f'{basename}.parquet'
        try:
            geojson_to_parquet(con, gj, pq)
            print(f"  wrote {pq.name}: {pq.stat().st_size:,} bytes")
        except Exception as e:
            print(f"  FAIL parquet: {e}")

        pmt = OUT / f'{basename}.pmtiles'
        if tippecanoe_ok:
            try:
                geojson_to_pmtiles(gj, pmt)
                print(f"  wrote {pmt.name}: {pmt.stat().st_size:,} bytes")
            except Exception as e:
                print(f"  FAIL pmtiles: {e}")

        kml = OUT / f'{basename}.kml'
        try:
            write_kml_from_geojson(gj, basename, kml)
            print(f"  wrote {kml.name}: {kml.stat().st_size:,} bytes")
        except Exception as e:
            print(f"  FAIL kml: {e}")

        shp = OUT / f'{basename}.shp.zip'
        if ogr2ogr_ok:
            try:
                write_shapefile_zip(gj, basename, shp)
                print(f"  wrote {shp.name}: {shp.stat().st_size:,} bytes")
            except Exception as e:
                print(f"  FAIL shp: {e}")

    return 0


if __name__ == '__main__':
    sys.exit(main())
