"""Bake ir_stations_merged: one point per Indian Railways station, merged from
two government copies of CRIS's station layer and Wikidata's station codes.

Sources (all openly downloadable; none ODbL):
  * PM GatiShakti railway stations (BISAG-N), from CRIS's IR station layer,
    compiled by ramSeraph/indianopenmaps (CC0, policy B).      -> primary
  * Indian Railways GIS portal stations (irgeoportal, CRIS), same compiler
    (the existing ir_stations layer).                           -> codes GatiShakti lacks
  * Wikidata items with an Indian Railways station code (P5696), CC0.
                                                                -> codes for uncoded CRIS points,
                                                                   an independent position check
OpenStreetMap was compared but is not merged: ODbL share-alike would bind the
result. Wikidata positions (mostly copied from datameet/railways, a 2016 scrape)
are never published, only used to check and to place codes on CRIS points.

Merge (pure, in `merge`):
  1. CRIS points with a station code are grouped by code (GatiShakti first,
     IRGIS for codes GatiShakti lacks). The group's medoid is the station; a
     group scattered over more than 2 km follows the point nearest Wikidata's,
     and its points over 2 km away rejoin the uncoded pool (another station).
  2. Uncoded CRIS points within 1 km of a coded station are its platform /
     start / end points and fold into it. The rest are clustered (1 km).
  3. A Wikidata code missing from CRIS goes to the nearest CRIS station within
     1.5 km whose name agrees (or whose text holds the code): an uncoded
     cluster, or a coded station Wikidata has no match for (CRIS's older
     codes: CSTM is CSMT). An uncoded cluster within 500 m also takes it on
     distance alone. Nearest pairs first, one to one.
  4. Every row keeps its source's columns as published (except CRIS editor
     usernames, personal data) and gains new columns: stn_code, source,
     sources, code_source, match_method, match_confidence, wd_distance_m,
     source_points, source_spread_m, plus Wikidata's item, code, coord and
     label where matched.

Usage:
    python3 scripts/bake_ir_stations_merged.py pull        # cached; a second run fetches nothing
    python3 scripts/bake_ir_stations_merged.py bake [--out DIR]
    python3 scripts/bake_ir_stations_merged.py upload [--out DIR]
    python3 scripts/bake_ir_stations_merged.py register   # patch catalog + manifest in place
"""
from __future__ import annotations

import argparse
import csv
import difflib
import hashlib
import json
import math
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from pipeline import log  # noqa: E402
import pipeline  # noqa: E402
import bake_formats  # noqa: E402
from build_catalog import ATTR  # noqa: E402

CATALOG = ROOT / 'catalog.json'
MANIFEST = ROOT / 'scripts' / 'external-ingested.json'
# Build artefacts keep the merged name; the published layer id is ir_stations:
# the merged set replaced the IRGIS-only layer (owner, 2026-11-18), under the
# same id so API/MCP clients and links keep working. ir_stations_merged (live
# 17-18 Nov 2026) is retired; web/public/_redirects sends its /view page here.
ARTEFACT = 'ir_stations_merged'
RAW = ROOT / 'data' / 'raw' / ARTEFACT

LAYER_ID = 'ir_stations'
RETIRED_IDS = ('ir_stations_merged',)
BASENAME = 'IR_Stations_Merged'
# Versioned: R2 objects are cached as immutable, so a re-bake gets a new
# revision folder instead of overwriting (bump BAKE_REVISION).
BAKE_REVISION = 'r2'
R2_PREFIX = f'transport/ir-stations-merged/{BAKE_REVISION}'
EXT = {'parquet': 'parquet', 'pmtiles': 'pmtiles', 'geojson': 'geojson', 'kml': 'kml', 'shapefile': 'shp.zip'}
SUMMARY = ROOT / 'data' / f'{ARTEFACT}.summary.json'
UNPLACED = ROOT / 'data' / f'{ARTEFACT}.wikidata_unplaced.csv'

GS, IRGIS, WIKIDATA = 'GatiShakti', 'IRGIS', 'Wikidata'
RELEASE = 'https://github.com/ramSeraph/indian_transport/releases/download/railways'
SOURCES = {
    GS: (f'{RELEASE}/GatiShakti_Railway_stations.parquet', 'GatiShakti_Railway_stations.parquet'),
    IRGIS: (f'{RELEASE}/IR_Stations.parquet', 'IR_Stations.parquet'),
}
SPARQL = 'https://query.wikidata.org/sparql'
WD_FILE = 'wikidata_p5696.csv'
WD_QUERY = """SELECT ?item ?code ?coord ?label WHERE {
  ?item wdt:P5696 ?code .
  OPTIONAL { ?item wdt:P625 ?coord . }
  OPTIONAL { ?item rdfs:label ?label . FILTER(LANG(?label) = "en") }
}"""
WD_COLS = ['item', 'code', 'coord', 'label']
USER_AGENT = 'bharatlas-ingest/1.0 (open data atlas; https://bharatlas.com)'

SPREAD_MAX_M = 2000   # a code's points further apart than this are scattered
FOLD_M = 1000         # uncoded point this close to a coded station is part of it
CLUSTER_M = 1000      # uncoded points this close are one station
MATCH_M = 1500        # furthest a Wikidata code may land on an uncoded cluster
NEAR_M = 500          # ... without the names agreeing
DUP_M = 50            # IRGIS uncoded point this close to a GatiShakti point is the same record
AGREE_M = 1000        # CRIS and Wikidata within this: high confidence
DISAGREE_M = 2000     # further than this: low confidence

TILE_FIELDS = ('stn_code', 'sttnname', 'label', 'sttntype', 'railway', 'division', 'state',
               'source', 'match_confidence')
TILE_MAXZOOM = 12  # -zg guessed z4 (600 m steps); z12 is ~2 m
PERSONAL = re.compile(r'mobile|phone|email|e_mail|aadhaar|contact', re.I)


# ── pure helpers ─────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Pt:
    src: str
    row: int
    code: str | None
    x: float
    y: float
    name: str | None = None
    detail: str | None = None


@dataclass(frozen=True)
class WD:
    row: int
    code: str
    x: float | None
    y: float | None
    label: str | None
    item: str


def norm_code(s) -> str | None:
    s = (s or '').strip().upper()
    return s or None


def haversine_m(x1: float, y1: float, x2: float, y2: float) -> float:
    p1, p2 = math.radians(y1), math.radians(y2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(x2 - x1) / 2) ** 2
    return 2 * 6_371_008.8 * math.asin(math.sqrt(a))


def _d(a, b) -> float:
    return haversine_m(a.x, a.y, b.x, b.y)


def representative(pts: list[Pt], anchor: tuple[float, float] | None = None,
                   spread_max: float = SPREAD_MAX_M) -> tuple[Pt, float]:
    """The medoid of a station's points, and the furthest point's distance
    from it. A scattered group (one code at two places) follows `anchor`."""
    rep = min(pts, key=lambda p: (sum(_d(p, q) for q in pts), p.src, p.row))
    spread = max(_d(rep, q) for q in pts)
    if spread > spread_max and anchor is not None:
        rep = min(pts, key=lambda p: (haversine_m(p.x, p.y, *anchor), p.src, p.row))
        spread = max(_d(rep, q) for q in pts)
    return rep, spread


LABEL_NOISE = re.compile(r'\b(RAILWAY STATION|STATION|JUNCTION|JN|HALT|TERMINUS)\b')


def name_corroborates(code: str, label: str | None, texts: list[str | None]) -> bool:
    """True when CRIS's name / description text names the Wikidata station:
    the code as a word, or Wikidata's name (without 'railway station')."""
    texts = [t.upper() for t in texts if t]
    if any(re.search(rf'(?<![A-Z0-9]){re.escape(code)}(?![A-Z0-9])', t) for t in texts):
        return True
    core = re.sub(r'[^A-Z]', '', LABEL_NOISE.sub(' ', (label or '').upper()))
    if len(core) < 4:
        return False
    for t in texts:
        letters = re.sub(r'[^A-Z]', '', LABEL_NOISE.sub(' ', t))
        if core in letters or difflib.SequenceMatcher(None, core, letters).ratio() >= 0.8:
            return True
    return False


class Grid:
    """Points bucketed by ~0.02 degree cells for radius queries."""
    CELL = 0.02

    def __init__(self, items):
        self.cells = defaultdict(list)
        for it in items:
            self.cells[self._key(it.x, it.y)].append(it)

    def _key(self, x, y):
        return int(math.floor(x / self.CELL)), int(math.floor(y / self.CELL))

    def near(self, x, y, radius_m):
        """Items within radius_m of (x, y), nearest first, as (distance, item)."""
        cx, cy = self._key(x, y)
        ry = math.ceil(radius_m / 111_000 / self.CELL)
        rx = math.ceil(radius_m / (111_000 * max(math.cos(math.radians(y)), 0.1)) / self.CELL)
        out = []
        for i in range(cx - rx, cx + rx + 1):
            for j in range(cy - ry, cy + ry + 1):
                for it in self.cells.get((i, j), ()):
                    d = haversine_m(x, y, it.x, it.y)
                    if d <= radius_m:
                        out.append((d, it))
        out.sort(key=lambda t: (t[0], t[1].src, t[1].row))
        return out


def _clusters(pts: list[Pt], radius_m: float) -> list[list[Pt]]:
    """Single-linkage clusters of points within radius_m of each other."""
    parent = list(range(len(pts)))
    index = {p: i for i, p in enumerate(pts)}

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    grid = Grid(pts)
    for i, p in enumerate(pts):
        for _, q in grid.near(p.x, p.y, radius_m):
            a, b = find(i), find(index[q])
            if a != b:
                parent[max(a, b)] = min(a, b)
    groups = defaultdict(list)
    for i, p in enumerate(pts):
        groups[find(i)].append(p)
    return [groups[k] for k in sorted(groups)]


def _confidence(method: str, wd_dist: float | None) -> str:
    if method == 'none':
        return 'low'
    if method != 'code':
        return 'medium' if method == 'name+distance' else 'low'
    if wd_dist is not None and wd_dist > DISAGREE_M:
        return 'low'
    if wd_dist is not None and wd_dist <= AGREE_M:
        return 'high'
    return 'medium'


def merge(cris: list[Pt], wd: list[WD]) -> tuple[list[dict], dict]:
    """One record per station (see module docstring). Returns (stations, stats)."""
    cris = sorted(cris, key=lambda p: (p.src != GS, p.src, p.row))
    gs_codes = {p.code for p in cris if p.src == GS and p.code}
    ir_codes = {p.code for p in cris if p.src == IRGIS and p.code}

    wd_by_code: dict[str, WD] = {}
    for w in sorted(wd, key=lambda w: (int(re.sub(r'\D', '', w.item) or 0), w.row)):
        wd_by_code.setdefault(w.code, w)

    groups: dict[str, list[Pt]] = defaultdict(list)
    for p in cris:
        if p.code and (p.src == GS or p.code not in gs_codes):
            groups[p.code].append(p)

    gs_grid = Grid([p for p in cris if p.src == GS])
    uncoded, ir_dups = [], 0
    for p in cris:
        if p.code:
            continue
        if p.src == IRGIS and gs_grid.near(p.x, p.y, DUP_M):
            ir_dups += 1
            continue
        uncoded.append(p)

    stations: dict[str, dict] = {}
    split = 0
    for code in sorted(groups):
        w = wd_by_code.get(code)
        anchor = (w.x, w.y) if w and w.x is not None else None
        rep, spread = representative(groups[code], anchor)
        pts = groups[code]
        if spread > SPREAD_MAX_M:
            # One code at two places: the far points are another station
            # (CRIS codes a Kalyan platform THK); they rejoin as uncoded points.
            far = [q for q in pts if _d(rep, q) > SPREAD_MAX_M]
            pts = [q for q in pts if q not in far]
            uncoded += far
            split += len(far)
        stations[code] = {'code': code, 'rep': rep, 'pts': list(pts), 'code_source': rep.src,
                          'method': 'code', 'wd': w}

    rep_grid = Grid([s['rep'] for s in stations.values()])
    by_rep = {s['rep']: s for s in stations.values()}
    loose, folded = [], 0
    for p in uncoded:
        hit = rep_grid.near(p.x, p.y, FOLD_M)
        if hit:
            by_rep[hit[0][1]]['pts'].append(p)
            folded += 1
        else:
            loose.append(p)

    clusters = []
    for pts in _clusters(loose, CLUSTER_M):
        rep, _ = representative(pts)
        clusters.append({'code': None, 'rep': rep, 'pts': pts, 'code_source': None, 'method': 'none', 'wd': None})

    # Wikidata codes CRIS lacks: onto an uncoded cluster (names agree, or
    # within NEAR_M), or onto a coded station Wikidata has no match for when
    # the names agree (CRIS's CSTM is Wikidata's CSMT). Nearest pairs first.
    open_ = [s for s in stations.values() if s['wd'] is None] + clusters
    by_open = {s['rep']: s for s in open_}
    grid = Grid(list(by_open))
    pairs, unplaced = [], []
    for code in sorted(set(wd_by_code) - set(stations)):
        w = wd_by_code[code]
        if w.x is None:
            unplaced.append({'code': code, 'label': w.label, 'item': w.item, 'reason': 'no_coordinates'})
            continue
        near = grid.near(w.x, w.y, MATCH_M)
        ok = []
        for d, rep in near:
            t = by_open[rep]
            named = name_corroborates(code, w.label, [x for q in t['pts'] for x in (q.name, q.detail)])
            if named or (t['code'] is None and d <= NEAR_M):
                ok.append((d, code, rep.src, rep.row, 'name+distance' if named else 'distance'))
        pairs += ok
        if not ok:
            reason = 'nearest_unconfirmed' if near else 'no_cris_point_within_1500m'
            unplaced.append({'code': code, 'label': w.label, 'item': w.item, 'reason': reason})
    taken_codes, taken, on_coded = set(), set(), 0
    rep_of = {(s['rep'].src, s['rep'].row): s for s in open_}
    for d, code, src, row, method in sorted(pairs):
        if code in taken_codes or (src, row) in taken:
            continue
        taken_codes.add(code)
        taken.add((src, row))
        t = rep_of[(src, row)]
        if t['code'] is None:
            t.update(code=code, code_source=WIKIDATA)
        else:
            on_coded += 1
        t.update(method=method, wd=wd_by_code[code])
    lost = sorted({code for _, code, *_ in pairs} - taken_codes)
    unplaced += [{'code': c, 'label': wd_by_code[c].label, 'item': wd_by_code[c].item,
                  'reason': 'cris_point_taken_by_nearer_code'} for c in lost]

    out = []
    for s in list(stations.values()) + clusters:
        code, rep, w = s['code'], s['rep'], s['wd']
        spread = max(_d(rep, q) for q in s['pts'])
        wd_dist = haversine_m(rep.x, rep.y, w.x, w.y) if w and w.x is not None else None
        srcs = {q.src for q in s['pts']}
        if code in gs_codes:
            srcs.add(GS)
        if code in ir_codes:
            srcs.add(IRGIS)
        if w:
            srcs.add(WIKIDATA)
        out.append({
            'src': rep.src, 'row': rep.row, 'stn_code': code,
            'code_source': s['code_source'],
            'sources': ';'.join(x for x in (GS, IRGIS, WIKIDATA) if x in srcs),
            'match_method': s['method'],
            'match_confidence': _confidence(s['method'], wd_dist),
            'wd_row': w.row if w else None,
            'wd_distance_m': round(wd_dist, 1) if wd_dist is not None else None,
            'source_points': len(s['pts']),
            'source_spread_m': round(spread, 1),
        })
    out.sort(key=lambda r: (r['src'], r['row']))
    stats = {
        'cris_points': len(cris),
        'codes_gatishakti': len(gs_codes), 'codes_irgis_only': len(ir_codes - gs_codes),
        'irgis_uncoded_duplicates': ir_dups, 'uncoded_points_folded': folded,
        'uncoded_clusters': len(clusters),
        'wikidata_codes': len(wd_by_code),
        'wikidata_codes_matched_to_cris_code': sum(1 for c in stations if c in wd_by_code),
        'scattered_points_split': split,
        'wikidata_codes_placed_on_uncoded': len(taken_codes) - on_coded,
        'wikidata_codes_placed_on_other_cris_code': on_coded,
        'wikidata_unplaced': unplaced,
    }
    return out, stats


# ── pull ─────────────────────────────────────────────────────────────────

def _curl(args: list[str], dest: Path) -> None:
    with pipeline.atomic_output(dest) as part:
        subprocess.run(['curl', '-sSfL', '--retry', '3', '--retry-delay', '5', '-m', '600',  # 3 tries x 600 s
                        '-A', USER_AGENT, '-o', str(part), *args], check=True, timeout=2400)
        if dest.suffix == '.parquet' and pipeline.read_head(part, 4) != b'PAR1':
            raise ValueError(f'{dest.name}: not a parquet file')
        if dest.suffix == '.csv' and not part.read_text().startswith(','.join(WD_COLS)):
            raise ValueError(f'{dest.name}: not the Wikidata CSV answer')


def pull(raw: Path = RAW) -> dict:
    """Fetch each source once, saved atomically as it arrives; a cached file
    is never fetched again (delete it to refresh). Records md5 + fetch time."""
    raw.mkdir(parents=True, exist_ok=True)
    meta_path = raw / 'sources.json'
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    jobs = [(name, fname, [url]) for name, (url, fname) in SOURCES.items()]
    jobs.append((WIKIDATA, WD_FILE, ['-H', 'Accept: text/csv', '--data-urlencode', f'query={WD_QUERY}', SPARQL]))
    for name, fname, args in jobs:
        dest = raw / fname
        if dest.exists() and name in meta:
            log(f'cached {fname}')
            continue
        log(f'fetching {name} -> {fname}')
        _curl(args, dest)
        meta[name] = {'file': fname, 'url': args[-1], 'md5': pipeline.file_md5(dest),
                      'fetched_at': datetime.now(timezone.utc).date().isoformat()}
        meta_path.write_text(json.dumps(meta, indent=2) + '\n')  # saved after every file
    return meta


# ── bake ─────────────────────────────────────────────────────────────────

POINT = re.compile(r'Point\(([-\d.eE]+) ([-\d.eE]+)\)')


def read_wikidata(path: Path) -> list[WD]:
    out = []
    with path.open(newline='') as fh:
        for i, r in enumerate(csv.DictReader(fh)):
            code = norm_code(r['code'])
            m = POINT.fullmatch(r['coord'] or '')
            if code:
                out.append(WD(i, code, float(m[1]) if m else None, float(m[2]) if m else None,
                              r['label'] or None, r['item']))
    return out


# GatiShakti's copy carries the CRIS GIS accounts that created and last edited
# each point; some are individuals' usernames (personal data), so they are left
# out. The edit dates (created_da, last_edi_1) stay.
EDITOR_COLS = ('created_us', 'last_edite')


def excluded_cols(con, src: str) -> str:
    """EXCLUDE list: the compilers' bbox helper columns (re-made by
    rebake_flatten_bbox) and the editor usernames."""
    cols = {c[0] for c in con.execute(f'DESCRIBE SELECT * FROM {src}').fetchall()}
    return ', '.join(c for c in ('bbox', 'xmin', 'ymin', 'xmax', 'ymax', *EDITOR_COLS) if c in cols)


def write_merged_parquet(con, raw: Path, out: Path) -> dict:
    srcs = {name: f"read_parquet('{raw / fname}', file_row_number = true)" for name, (_, fname) in SOURCES.items()}
    cris = []
    for name, src in srcs.items():
        for row, code, x, y, nm, det in con.execute(
                f'SELECT file_row_number, sttncode, ST_X(geometry), ST_Y(geometry), sttnname, fdetail FROM {src} '
                'WHERE geometry IS NOT NULL').fetchall():
            cris.append(Pt(name, row, norm_code(code), x, y, nm, det))
    wd = read_wikidata(raw / WD_FILE)
    stations, stats = merge(cris, wd)

    con.execute('CREATE OR REPLACE TABLE m (src VARCHAR, "row" BIGINT, stn_code VARCHAR, code_source VARCHAR, '
                'sources VARCHAR, match_method VARCHAR, match_confidence VARCHAR, wd_row BIGINT, '
                'wd_distance_m DOUBLE, source_points INTEGER, source_spread_m DOUBLE)')
    keys = ['src', 'row', 'stn_code', 'code_source', 'sources', 'match_method', 'match_confidence',
            'wd_row', 'wd_distance_m', 'source_points', 'source_spread_m']
    con.executemany(f"INSERT INTO m VALUES ({', '.join('?' * len(keys))})", [[s[k] for k in keys] for s in stations])
    con.execute('CREATE OR REPLACE TABLE wd (wd_row BIGINT, item VARCHAR, code VARCHAR, coord VARCHAR, label VARCHAR)')
    with (raw / WD_FILE).open(newline='') as fh:
        con.executemany('INSERT INTO wd VALUES (?, ?, ?, ?, ?)',
                        [[i, *(r[c] or None for c in WD_COLS)] for i, r in enumerate(csv.DictReader(fh))])

    union = ' UNION ALL BY NAME '.join(
        f"SELECT '{name}' AS _src, * EXCLUDE ({excluded_cols(con, src)}) FROM {src}" for name, src in srcs.items())
    con.execute(f"""COPY (
        WITH cris AS ({union})
        SELECT m.stn_code, c.* EXCLUDE (_src, file_row_number, geometry),
               w.item, w.code, w.coord, w.label,
               m.src AS source, m.sources, m.code_source, m.match_method, m.match_confidence,
               m.wd_distance_m, m.source_points, m.source_spread_m, c.geometry
        FROM m JOIN cris c ON c._src = m.src AND c.file_row_number = m."row"
        LEFT JOIN wd w USING (wd_row)
        ORDER BY m.src, m."row"
    ) TO '{out}' (FORMAT PARQUET, COMPRESSION ZSTD)""")
    cols = [c[0] for c in con.execute(f"DESCRIBE SELECT * FROM '{out}'").fetchall()]
    bad = [c for c in cols if PERSONAL.search(c) or c in EDITOR_COLS]
    if bad:
        raise ValueError(f'personal fields must never be published: {bad}')

    unplaced = stats.pop('wikidata_unplaced')
    with UNPLACED.open('w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=['code', 'label', 'item', 'reason'])
        w.writeheader()
        w.writerows(sorted(unplaced, key=lambda u: (u['reason'], u['code'])))
    stats['wikidata_unplaced'] = dict(Counter(u['reason'] for u in unplaced))
    stats['stations'] = len(stations)
    stats['stations_with_code'] = sum(1 for s in stations if s['stn_code'])
    stats['by_confidence'] = dict(Counter(s['match_confidence'] for s in stations))
    stats['by_method'] = dict(Counter(s['match_method'] for s in stations))
    return stats


def up_to_date(summary_path: Path, inputs: str, outputs: list[Path]) -> bool:
    """True when the last bake used the same inputs and every output exists."""
    if not summary_path.exists() or not all(p.exists() for p in outputs):
        return False
    return json.loads(summary_path.read_text()).get('inputs') == inputs


def bake(out_dir: Path, raw: Path = RAW) -> dict:
    """Bake every format. A second run with the same sources and this same
    script does nothing (tippecanoe and zip output differ byte-for-byte run to
    run, so re-baking would re-upload unchanged layers)."""
    import tempfile
    from bake_extracts import make_con, write_kml_from_geojson
    from bake_whole_layer import write_geojson_whole
    from pipeline import rebake_flatten_bbox

    path = {fmt: out_dir / f'{BASENAME}.{ext}' for fmt, ext in EXT.items()}
    inputs = hashlib.md5((raw / 'sources.json').read_bytes() + Path(__file__).read_bytes()).hexdigest()
    if up_to_date(SUMMARY, inputs, list(path.values())):
        log('up to date: same sources and script as the last bake')
        return json.loads(SUMMARY.read_text())
    out_dir.mkdir(parents=True, exist_ok=True)
    con = make_con()
    # Build every format under its real name in a staging folder (the
    # shapefile's inner names come from the zip's name), then move each in.
    with tempfile.TemporaryDirectory(prefix='ir_stations_', dir=out_dir) as tmp:
        stage = {fmt: Path(tmp) / p.name for fmt, p in path.items()}
        merged = Path(tmp) / 'merged.parquet'
        stats = write_merged_parquet(con, raw, merged)
        rows, prop_cols = rebake_flatten_bbox(merged, stage['parquet'], con)
        write_geojson_whole(con, stage['parquet'], stage['geojson'])
        write_kml_from_geojson(stage['geojson'], LAYER_ID, stage['kml'])
        bake_formats.shapefile_zip_from_geojson(stage['geojson'], stage['shapefile'],
                                                bake_formats.short_field_names(prop_cols))
        bake_formats.write_pmtiles(stage['geojson'], stage['pmtiles'], LAYER_ID, TILE_FIELDS, max_zoom=TILE_MAXZOOM)
        for fmt, p in stage.items():
            os.replace(p, path[fmt])

    summary = {'rows': rows, 'inputs': inputs, **stats, 'sources': json.loads((raw / 'sources.json').read_text()),
               **pipeline.sizes_and_names(path)}
    SUMMARY.write_text(json.dumps(summary, indent=2) + '\n')
    return summary


# ── catalog ──────────────────────────────────────────────────────────────

SOURCE = 'bharatlas (CRIS, PM GatiShakti, Wikidata)'
ATTRIBUTION = ATTR[SOURCE]
PUBLISHER = {'name': 'bharatlas', 'url': 'https://bharatlas.com'}
TAGS = ['railway stations', 'Indian Railways', 'station code', 'halt', 'railway zone', 'railway division',
        'CRIS', 'PM GatiShakti', 'Wikidata', 'transport']


def description() -> str:
    return ('One point per Indian Railways station or halt, with its station code, merged by bharatlas from '
            'two government copies of the CRIS station layer (PM GatiShakti and the IR GIS portal) and '
            'Wikidata station codes, with a source and match-confidence column on every row.')


def notes() -> str:
    return (
        'Merged by bharatlas and published under CC BY 4.0 (credit: bharatlas, Indian Railways / CRIS, '
        'PM GatiShakti, Wikidata). Sources: (1) PM GatiShakti railway stations (BISAG-N), drawn from CRIS\'s '
        'Indian Railways station layer; (2) the Indian Railways GIS portal stations (irgeoportal.gov.in, CRIS), '
        'the ir_stations layer; both compiled by ramSeraph/indianopenmaps (DataMeet community, CC0 1.0) and '
        'republished with credit under bharatlas.com/about#sources-and-licensing; (3) Wikidata items with an '
        'Indian Railways station code (P5696), CC0 1.0. Every location comes from CRIS. CRIS records most '
        'stations as several points (start, centre, end, platforms); points sharing a station code become one '
        'row at their medoid, and uncoded points within 1 km fold into it (source_points counts them, '
        'source_spread_m is how far they spread). Points of one code more than 2 km apart are treated as '
        'different stations. GatiShakti is used first; the IR portal adds the 52 codes GatiShakti lacks. '
        'A Wikidata code missing from CRIS is placed on the nearest CRIS station within 1.5 km whose name or '
        'description agrees (match_method name+distance; this also links CRIS\'s older codes to the current '
        'ones, e.g. CSTM/CSMT, BCT/MMCT, HNZM/NZM, KEU/KIUL: stn_code keeps CRIS\'s code, code holds '
        'Wikidata\'s), or on an uncoded CRIS point within 500 m on distance alone (distance). '
        'match_confidence: high = CRIS code and Wikidata agree within 1 km; medium = CRIS code not in Wikidata '
        'or 1 to 2 km away, or a name-confirmed match; low = Wikidata more than 2 km away, a distance-only '
        'match, or an uncoded CRIS point (stn_code empty). Checked against OpenStreetMap: high rows sit a '
        'median 26 m from OSM\'s station with the same code (98% within 500 m), medium 90%, low 87%. '
        'OpenStreetMap is used only for that check and is not merged, because its ODbL licence would require '
        'the whole layer to stay under ODbL. Every source column is kept as published (sttncode, sttnname, '
        'fdetail ... from CRIS; item, code, coord, label from Wikidata; coord is Wikidata\'s point, kept for '
        'reference, never the location), except the CRIS GIS accounts that created and last edited each '
        'point (created_us, last_edite), left out because some are individuals\' usernames. '
        'Known gaps: about 800 Wikidata codes have no CRIS point to sit on and '
        'are left out (e.g. Kalyan KYN, whose only CRIS point is coded THK, and Lokmanya Tilak Terminus LTT); '
        'Wikidata positions are mostly copied from the 2016 datameet/railways compilation and sit a median '
        '~90 m and a 90th percentile ~1.2 km from CRIS, so they are not used as locations. About 300 rows are '
        'uncoded, unnamed CRIS points. CRIS state names are as published (mixed case, some blank).')


def level_meta() -> dict:
    return {'label': 'Railway stations', 'unit': 'stations', 'description': description()}


def catalog_entry(rows: int, sizes: dict[str, int], fetched_at: str, r2_public: str,
                  names: dict[str, str] | None = None) -> dict:
    names = names or pipeline.plain_names(BASENAME, EXT)
    entry = {'id': LAYER_ID, 'level': LAYER_ID, 'source': SOURCE, 'rows': rows,
             **pipeline.format_blocks(EXT, names, sizes, f'{r2_public}/{R2_PREFIX}')}
    entry.update({
        'licence': 'CC-BY-4.0',
        'attribution': {'primary': dict(ATTRIBUTION), 'publisher': dict(PUBLISHER)},
        'category': 'transport',
        'provenance': 'curated',
        'fetched_at': fetched_at,
        'notes': notes(),
        'tags': TAGS,
    })
    return entry


def manifest_entry(rows: int, sizes: dict[str, int], names: dict[str, str] | None = None) -> dict:
    names = names or pipeline.plain_names(BASENAME, EXT)
    return {
        'id': LAYER_ID, 'name': level_meta()['label'], 'level': LAYER_ID, 'category': 'transport',
        'source': SOURCE, 'description': description(), 'unit': 'stations', 'features': rows,
        'license': 'CC-BY-4.0', 'r2_prefix': R2_PREFIX,
        **pipeline.manifest_files(names, sizes),
        'source_url': ATTRIBUTION['url'], 'source_org': ATTRIBUTION['name'],
        'notes': notes(), 'tags': TAGS,
    }


def upload(out_dir: Path) -> dict[str, str]:
    """Upload every format to its content-versioned key (<BASENAME>.<md5[:8]>.<ext>):
    changed bytes get a new key, unchanged files keep theirs (md5-skipped)."""
    return pipeline.upload_layer(out_dir, BASENAME, EXT, R2_PREFIX)


def register(catalog_path: Path = CATALOG, manifest_path: Path = MANIFEST, summary_path: Path = SUMMARY,
             r2_public: str | None = None, fetched_at: str | None = None) -> None:
    """Patch catalog.json + external-ingested.json in place (never rebuild the
    catalog). Idempotent: the layer keeps its place and any rebaked tiles
    (pipeline.register_layer); the retired ids are dropped. fetched_at is the
    sources' fetch date (the data's vintage), set on every run."""
    summary = json.loads(summary_path.read_text())
    if fetched_at is None:
        fetched_at = min(s['fetched_at'] for s in summary['sources'].values())
    names = pipeline.summary_names(summary)
    entry = catalog_entry(summary['rows'], summary['sizes'], fetched_at, r2_public or pipeline.R2_PUBLIC, names=names)
    catalog = json.loads(catalog_path.read_text())
    catalog['layers'] = [e for e in catalog['layers'] if e.get('id') not in RETIRED_IDS]
    for rid in RETIRED_IDS:
        catalog['level_meta'].pop(rid, None)
    catalog['level_order'] = [lvl for lvl in catalog['level_order'] if lvl not in RETIRED_IDS]
    pipeline.upsert_layer(catalog, entry, level_meta(), attribution=(SOURCE, ATTRIBUTION))
    next(e for e in catalog['layers'] if e['id'] == LAYER_ID)['fetched_at'] = fetched_at
    pipeline.write_json(catalog_path, catalog)
    manifest = [e for e in json.loads(manifest_path.read_text()) if e.get('id') not in RETIRED_IDS]
    row = manifest_entry(summary['rows'], summary['sizes'], names=names)
    pipeline.write_json(manifest_path, pipeline.upsert_by_id(manifest, row))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('step', choices=['pull', 'bake', 'upload', 'register'])
    ap.add_argument('--out', type=Path, default=ROOT / 'data' / 'baked' / R2_PREFIX)
    a = ap.parse_args()
    if a.step == 'pull':
        log(json.dumps(pull(), indent=2))
    elif a.step == 'bake':
        log(json.dumps(bake(a.out), indent=2))
    elif a.step == 'upload':
        upload(a.out)
    else:
        register()


if __name__ == '__main__':
    main()
