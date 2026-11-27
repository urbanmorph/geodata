"""The Fifth Schedule (PESA) village table, from two official sources:

1. the Presidential orders and the state lists that name their villages, as matched to LGD units by
   match_scheduled_areas.py (data/scheduled_areas/matches.csv): a village is "in the orders" when it is
   named, or lies inside a notified district, subdistrict, block or gram panchayat;
2. MoPR's eGramSwaraj PESA village list (supporting-docs/scheduled-areas/egramswaraj), joined by village code.

Each village gets both flags and a basis: both | order_only | pesa_only. Where the two disagree, the
layer shows it rather than choosing one. Exclusions ("excluding ...") and the Sixth Schedule are
separate steps.

Run: python3 -u scripts/build_scheduled_areas.py   (writes data/scheduled_areas/fifth_schedule_villages.csv)
"""
from __future__ import annotations

import csv
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import match_scheduled_areas as m  # noqa: E402

CONFIDENT = {'code', 'exact', 'override', 'fuzzy'}
# Which village field each area level's LGD id is compared with.
AREA_FIELD = {'lgd_districts': 'dist', 'lgd_subdistricts': 'sub', 'lgd_blocks': 'block', 'lgd_panchayats': 'gp'}
FIFTH = {'Andhra Pradesh', 'Chhattisgarh', 'Gujarat', 'Himachal Pradesh', 'Jharkhand', 'Madhya Pradesh',
         'Maharashtra', 'Odisha', 'Rajasthan', 'Telangana'}
EGS = m.LISTS / 'egramswaraj' / 'egs_pesa_villages.csv'


def _index(villages: list[dict]) -> dict[str, dict[str, list[int]]]:
    by_field = {f: defaultdict(list) for f in AREA_FIELD.values()}
    for v in villages:
        for f in by_field:
            by_field[f][str(v[f])].append(v['id'])
    return by_field


def _expand(layer: str, ids: list[str], by_field: dict) -> list[int]:
    if layer == 'lgd_villages':
        return [int(i) for i in ids]
    idx = by_field[AREA_FIELD[layer]]
    return [vid for i in ids for vid in idx.get(str(i), [])]


def excluded_villages(exclusions: list[dict], villages: list[dict]) -> set[int]:
    """The villages the orders cut out of notified units (matched exclusions only)."""
    by_field = _index(villages)
    return {vid for e in exclusions if e['confidence'] == 'matched' for vid in _expand(e['lgd_layer'], e['ids'], by_field)}


def order_villages(units: list[dict], villages: list[dict], excluded: set[int] = frozenset()) -> dict[int, list[str]]:
    """{village id: [order references]} for every village a confidently matched unit names or contains;
    an excluded village loses coverage that comes from an area unit, not a reference that names it."""
    by_field = _index(villages)
    out: dict[int, list[str]] = defaultdict(list)
    for u in units:
        if u['match'] not in CONFIDENT or not u['lgd_ids']:
            continue
        hits = _expand(u['lgd_layer'], u['lgd_ids'].split(';'), by_field)
        if u['lgd_layer'] != 'lgd_villages':
            hits = [vid for vid in hits if vid not in excluded]
        for vid in hits:
            if u['order_ref'] not in out[vid]:
                out[vid].append(u['order_ref'])
    return {k: sorted(v) for k, v in out.items()}


def pesa_villages(pesa: list[dict], villages: list[dict]) -> tuple[dict[int, dict], list[dict]]:
    """({village id: eGramSwaraj row}, eGramSwaraj PESA rows whose code is in no LGD village)."""
    by_code = {}
    for v in villages:
        by_code.setdefault(str(v['id']), v['id'])
        if v.get('code'):
            by_code.setdefault(str(v['code']), v['id'])
    got, unmatched = {}, []
    for r in pesa:
        if r['is_pesa'] != 'Yes':
            continue
        vid = by_code.get(r['village_code'])
        if vid is None:
            unmatched.append(r)
        else:
            got[vid] = r
    return got, unmatched


def pesa_by_name(rows: list[dict], villages: list[dict]) -> dict[int, dict]:
    """PESA villages whose code is in no LGD village (mostly villages newer than the layer), matched by
    name inside their own gram panchayat, else block, else district; only a single confident match."""
    by_district = defaultdict(list)
    for v in villages:
        by_district[(str(v['state']).upper(), m.name_key(v['district']))].append(v)
    got = {}
    for r in rows:
        pool = by_district.get((r['state'].upper(), m.name_key(r['district'])), [])
        for field, want in (('gp_name', r['gp_name']), ('block_name', r['block'])):
            names = [{'id': n, 'name': n} for n in sorted({str(v[field] or '') for v in pool} - {''})]
            hit = m.match_name(want, names)
            if hit.status in ('exact', 'fuzzy', 'ambiguous'):
                keep = set(hit.ids)
                pool = [v for v in pool if v[field] in keep]
                break
        hit = m.match_name(r['village_name'], [{'id': v['id'], 'name': v['name']} for v in pool])
        if hit.status in ('exact', 'fuzzy'):
            got[hit.ids[0]] = r
    return got


BTR = {'Kokrajhar', 'Chirang', 'Baksa', 'Udalguri', 'Tamulpur'}
KHASI = {'East Khasi Hills', 'West Khasi Hills', 'South West Khasi Hills', 'Eastern West Khasi Hills', 'Ri-Bhoi'}


def council(state: str, district: str, level: str) -> str:
    """The Sixth Schedule council whose area a unit is part of (Paragraph 20 table, BTR accord)."""
    if state == 'Assam':
        if district.replace(' (added villages)', '') in BTR:
            return 'Bodoland Territorial Council'
        return 'Dima Hasao Autonomous Council' if district == 'Dima Hasao' else 'Karbi Anglong Autonomous Council'
    if state == 'Meghalaya':
        if district in KHASI:
            return 'Khasi Hills Autonomous District Council'
        return ('Jaintia Hills Autonomous District Council' if 'Jaintia' in district
                else 'Garo Hills Autonomous District Council')
    if state == 'Tripura':
        return 'Tripura Tribal Areas Autonomous District Council'
    return {'Siaha': 'Mara Autonomous District Council'}.get(
        district, 'Chakma and Lai Autonomous District Councils (split not mapped)')


def basis(in_order: bool, in_pesa: bool) -> str:
    return 'both' if in_order and in_pesa else 'order_only' if in_order else 'pesa_only'


def load_villages() -> list[dict]:
    import duckdb
    cur = duckdb.connect().execute(
        f"SELECT CASE WHEN vil_lgd > 0 THEN vil_lgd ELSE -OBJECTID END AS id, vilcode11 AS code, stname AS state, "
        f"dtname AS district, sdtname AS subdistrict, vilname11 AS name, dist_lgd AS dist, subdt_lgd AS sub, "
        f"block_lgd AS block, gp_code AS gp, block_name, gp_name FROM '{m.CACHE}/lgd_villages.parquet'")
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def main() -> None:
    villages = load_villages()
    with (m.OUT / 'matches.csv').open() as fh:
        units = [u for u in csv.DictReader(fh) if u['state'] in FIFTH]
    with EGS.open() as fh:
        pesa = list(csv.DictReader(fh))
    exclusions = json.loads((HERE / 'scheduled_areas_exclusions.json').read_text())['exclusions']
    excluded = excluded_villages(exclusions, villages)
    orders = order_villages(units, villages, excluded)
    print(f'{len(excluded)} villages cut out of notified units', flush=True)
    pesa_hit, pesa_unmatched = pesa_villages(pesa, villages)
    by_name = {k: v for k, v in pesa_by_name(pesa_unmatched, villages).items() if k not in pesa_hit}
    named = {id(r) for r in by_name.values()}
    pesa_unmatched = [r for r in pesa_unmatched if id(r) not in named]
    join = {**{k: 'code' for k in pesa_hit}, **{k: 'name' for k in by_name}}
    pesa_hit = {**pesa_hit, **by_name}
    by_id = {v['id']: v for v in villages}
    rows, tally = [], Counter()
    for vid in sorted(set(orders) | set(pesa_hit)):
        v, p = by_id[vid], pesa_hit.get(vid)
        b = basis(vid in orders, p is not None)
        tally[(v['state'], b)] += 1
        rows.append({'lgd_village': vid, 'census_2011': v['code'], 'state': v['state'], 'district': v['district'],
                     'subdistrict': v['subdistrict'], 'village': v['name'], 'basis': b,
                     'order_refs': ' | '.join(orders.get(vid, [])), 'pesa_gp': p['gp_name'] if p else '',
                     'pesa_block': p['block'] if p else '', 'pesa_join': join.get(vid, '')})
    out = m.OUT / 'fifth_schedule_villages.csv'
    tmp = out.with_suffix('.tmp')
    with tmp.open('w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    tmp.replace(out)
    with (m.OUT / 'pesa_unmatched.csv').open('w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=list(pesa_unmatched[0]))
        w.writeheader()
        w.writerows(pesa_unmatched)
    write_sixth(villages)
    states = sorted({s for s, _ in tally})
    print('| state | both | order only | PESA only | PESA codes not in LGD |\n|---|---|---|---|---|')
    miss = Counter(r['state'] for r in pesa_unmatched)
    for s in states:
        st = s.title()
        print(f"| {st} | {tally[(s, 'both')]:,} | {tally[(s, 'order_only')]:,} | {tally[(s, 'pesa_only')]:,} | "
              f"{miss.get(st, 0):,} |")


SIXTH = {'Assam', 'Meghalaya', 'Tripura', 'Mizoram'}
# Mizoram's councils have no village polygons in lgd_villages: drawn by district (Paragraph 20 Part III).
MIZORAM_DISTRICTS = {'Lawngtlai': 'Pawi-Lakher Re-organisation Order 1972; CADC/LADC lists',
                     'Saiha': 'MADC village councils 2024 (all 99 in Siaha)'}


def write_sixth(villages: list[dict]) -> None:
    """One row per LGD unit in a Sixth Schedule council area, with the council and the source."""
    import duckdb
    with (m.OUT / 'matches.csv').open() as fh:
        units = [u for u in csv.DictReader(fh) if u['state'] in SIXTH]
    names = {v['id']: v['name'] for v in villages}
    dist_names = dict(duckdb.connect().execute(
        f"SELECT dist_lgd, dtname FROM '{m.CACHE}/lgd_districts.parquet' "
        f"WHERE stname IN ('ASSAM','MEGHALAYA','TRIPURA','MIZORAM')").fetchall())
    rows, seen = [], set()
    for u in units:
        if u['match'] not in CONFIDENT or not u['lgd_ids']:
            continue
        for i in u['lgd_ids'].split(';'):
            key = (u['lgd_layer'], i)
            if key in seen:
                continue
            seen.add(key)
            level = 'district' if u['lgd_layer'] == 'lgd_districts' else 'village'
            rows.append({'state': u['state'], 'council': council(u['state'], u['parent_district'], level),
                         'lgd_layer': u['lgd_layer'], 'lgd_id': i,
                         'name': dist_names.get(int(i), '') if level == 'district' else names.get(int(i), ''),
                         'order_ref': u['order_ref'], 'match': u['match']})
    for name, ref in MIZORAM_DISTRICTS.items():
        did = next(k for k, v in dist_names.items() if v == name)
        rows.append({'state': 'Mizoram', 'council': council('Mizoram', 'Siaha' if name == 'Saiha' else name, 'district'),
                     'lgd_layer': 'lgd_districts', 'lgd_id': str(did), 'name': name, 'order_ref': ref,
                     'match': 'district'})
    with (m.OUT / 'sixth_schedule_units.csv').open('w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    tally = Counter((r['council'], r['lgd_layer']) for r in rows)
    for (c, layer), n in sorted(tally.items()):
        print(f'  {c}: {n} {layer}', flush=True)


if __name__ == '__main__':
    main()
