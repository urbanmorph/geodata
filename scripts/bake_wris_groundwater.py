#!/usr/bin/env python3
"""
Bake wris_groundwater_levels: every India-WRIS groundwater-level station as a
point, with summaries of its manual readings (metres below ground level).

Sources (India-WRIS, Ministry of Jal Shakti; no open licence stated, so
republished with credit under bharatlas's Policy B):
  stations  ArcGIS layer NWIC/GroundwaterLevel_Stations/MapServer/0 on
            arc.indiawris.gov.in: every station, every published field.
  readings  the India-WRIS Dataset API (OpenAPI at indiawris.gov.in/v3/api-docs):
            POST /Dataset/Ground Water Level?stateName&districtName&agencyName
            &startdate&enddate&page&size. No auth, no total count (page until a
            short page), "no data" is HTTP 200 with statusCode 500, names must
            match exactly (taken from the station layer).

Telemetry: the API cannot filter by acquisition mode, data type or station
(probed 2026-11-21) and telemetric stations report every 1-6 hours (tens of
millions of rows), so they are bounded, not mirrored. And the API pages a large
answer unreliably (pages overlap, rows go missing), so every window is read
only when its first page holds all of it:
  1. each (state, district, agency) is read in windows: 1900-2018, then one per
     year to MANUAL_END_YEAR (manual readings end in 2024). A window whose first
     page is full is split in two by date, and so on, unless telemetry fills it
     over a year or less: that window is "heavy";
  2. a heavy window is read only on the days manual readings were taken that
     year by the same agency in the same State (else any agency in the State),
     learned from the other windows; at most MAX_DAYS days, the busiest. A day
     that still fills a page is paged as best the API allows;
  3. telemetric readings are kept for one recent week only (TELEMETRY_WINDOW,
     the telemetry feed's last week), for each station's last telemetric value.
Each station records whether its manual series was read without either
compromise (series_complete).

Cache: every answer is stored as it arrives under data/work/wris_groundwater_levels/
(readings/<state>/<district>/<agency>/<start>_<end>/page_00000.json.gz, then
window.json once the window is done, naming its halves when it split), backed up to R2 cache/wris_groundwater_levels/
every 10 minutes and on exit. A rerun asks nothing it has; a stopped run
continues; --max-minutes gives the run its own time limit.

TLS: the WRIS servers send incomplete certificate chains. The trust roots stay
certifi's (or the system's); the missing intermediates are fetched from the
leaf certificate's AIA "CA Issuers" URL and cached under the work folder.
WRIS_CA_BUNDLE=<pem> adds a bundle of your own instead. Verification is never
turned off.

Usage:
    python3 -u scripts/bake_wris_groundwater.py pull [--max-minutes 300]
    python3 -u scripts/bake_wris_groundwater.py bake
    python3 -u scripts/bake_wris_groundwater.py upload      # md5-skip uploads to R2
    python3 -u scripts/bake_wris_groundwater.py register    # patch catalog + manifest
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import ssl
import sys
import threading
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import pipeline  # noqa: E402
from pipeline import atomic_output, log, make_con  # noqa: E402

LAYER_ID = 'wris_groundwater_levels'
LEVEL = LAYER_ID
CATEGORY = 'water'
BASENAME = 'WRIS_Groundwater_Levels'
READINGS_BASENAME = 'WRIS_Groundwater_Manual_Readings'
R2_PREFIX = 'water/wris-groundwater-levels'
RAW = pipeline.work_dir(LAYER_ID, 'WRIS_GW_WORK')
CATALOG = ROOT / 'catalog.json'
MANIFEST = ROOT / 'scripts' / 'external-ingested.json'
OUT_DIR = ROOT / 'data' / 'baked' / R2_PREFIX
SUMMARY = ROOT / 'data' / f'{LAYER_ID}.summary.json'
EXT = {'parquet': 'parquet', 'pmtiles': 'pmtiles', 'geojson': 'geojson', 'kml': 'kml', 'shapefile': 'shp.zip'}

STATIONS_URL = ('https://arc.indiawris.gov.in/server/rest/services/NWIC/GroundwaterLevel_Stations/MapServer/0')
API_URL = 'https://indiawris.gov.in/Dataset/Ground%20Water%20Level'
API_DOCS = 'https://indiawris.gov.in/v3/api-docs'
PORTAL = 'https://indiawris.gov.in/wris/'
HOSTS = ('arc.indiawris.gov.in', 'indiawris.gov.in')

PAGE = 1000                          # the API's largest page
STATION_PAGE = 20000
HEAVY_SPAN_DAYS = 366                # telemetry filling a page over this span or less: read on manual days
WINDOW_VERSION = 2                   # window records of the one-page design (older ones are asked again)
MAX_DAYS = 40                        # manual days read in one heavy window
WORKERS = 4                          # polite: at most four requests in flight
MANUAL_SPLIT_YEAR = 2019             # before it, one window; telemetry starts about here
MANUAL_END_YEAR = 2024               # the manual series ends in 2024 (probed 2026-11-21)
TELEMETRY_WINDOW = ('2026-05-29', '2026-06-04')   # the telemetry feed's last week (it stops 2026-06-04)
TREND_YEARS = (2015, 2024)           # the last ten years of the manual series
MIN_TREND_YEARS = 5
PRE_MONTHS, POST_MONTHS = (3, 4, 5), (10, 11)
BELOW_GROUND = 'HGZ'                 # "MANUAL-Water Level": metres below ground level
TELEMETRY_LEVEL = 'GGZ'              # "GPRS-Water Level"

SOURCE = 'India-WRIS'
LICENCE = 'India-WRIS terms'
ATTRIBUTION = {'name': 'India-WRIS / CGWB and state ground water departments', 'url': PORTAL}
TAGS = ['groundwater', 'groundwater level', 'water table', 'depth to water', 'wells', 'piezometers',
        'observation wells', 'DWLR', 'telemetry', 'India-WRIS', 'CGWB', 'monsoon']
TILE_FIELDS = ('station_code', 'station_name', 'agency_name', 'district_name', 'last_reading', 'last_depth_m',
               'premonsoon_depth_m', 'premonsoon_year', 'premonsoon_trend_m_per_yr')
SUMMARY_COLUMNS = ('first_reading', 'last_reading', 'n_readings', 'years_of_record', 'last_depth_m',
                   'premonsoon_depth_m', 'premonsoon_year', 'postmonsoon_depth_m', 'postmonsoon_year',
                   'premonsoon_trend_m_per_yr', 'trend_n_years')

Fetch = Callable[[dict], dict]


# ── TLS: certifi's roots plus the intermediates the servers leave out ────────

def _ca_dir() -> Path:
    return RAW / 'ca'


def _aia_issuer_url(cert) -> str | None:
    from cryptography.x509 import AuthorityInformationAccess, ExtensionNotFound
    from cryptography.x509.oid import AuthorityInformationAccessOID
    try:
        aia = cert.extensions.get_extension_for_class(AuthorityInformationAccess).value
    except ExtensionNotFound:
        return None
    return next((d.access_location.value for d in aia if d.access_method == AuthorityInformationAccessOID.CA_ISSUERS),
                None)


def _load_certs(body: bytes) -> list:
    """A CA Issuers answer: one DER or PEM certificate, or a PKCS#7 bundle (.p7c)."""
    from cryptography import x509
    from cryptography.hazmat.primitives.serialization import pkcs7
    for load in (lambda b: [x509.load_der_x509_certificate(b)], lambda b: [x509.load_pem_x509_certificate(b)],
                 pkcs7.load_der_pkcs7_certificates, pkcs7.load_pem_pkcs7_certificates):
        try:
            return load(body)
        except ValueError:
            continue
    raise ValueError('the CA Issuers answer is not a certificate')


def fetch_intermediates(host: str, hops: int = 3) -> Path:
    """Follow the AIA CA Issuers links from `host`'s leaf certificate and save the
    issuers as PEM. They only help build a chain: trust still ends at a root in
    the default store, so fetching them over plain HTTP is safe."""
    from cryptography import x509
    from cryptography.hazmat.primitives.serialization import Encoding
    cert = x509.load_pem_x509_certificate(ssl.get_server_certificate((host, 443)).encode())
    found = []
    for _ in range(hops):
        url = _aia_issuer_url(cert)
        if not url or cert.issuer == cert.subject:
            break
        req = urllib.request.Request(url, headers={'User-Agent': pipeline.USER_AGENT})
        certs = _load_certs(pipeline.with_retries(lambda: urllib.request.urlopen(req, timeout=60).read()))
        found += certs
        cert = certs[0]
    out = _ca_dir() / f'{host}.pem'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(b''.join(c.public_bytes(Encoding.PEM) for c in found))
    return out


def ssl_context() -> ssl.SSLContext:
    try:
        import certifi
        ctx = ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        ctx = ssl.create_default_context()
    extra = [Path(os.environ['WRIS_CA_BUNDLE'])] if os.environ.get('WRIS_CA_BUNDLE') else \
        sorted(_ca_dir().glob('*.pem'))
    for pem in extra:
        if pem.stat().st_size:
            ctx.load_verify_locations(str(pem))
    return ctx


def verified_context(hosts: Iterable[str] = HOSTS) -> ssl.SSLContext:
    """A context that verifies every host, completing a host's chain once if it does not."""
    import socket
    for host in hosts:
        try:
            with socket.create_connection((host, 443), timeout=60) as s, \
                    ssl_context().wrap_socket(s, server_hostname=host):
                continue
        except ssl.SSLCertVerificationError:
            if os.environ.get('WRIS_CA_BUNDLE'):
                raise
            log(f'  {host}: incomplete certificate chain, fetching its intermediates')
            fetch_intermediates(host)
    return ssl_context()


# ── answers ──────────────────────────────────────────────────────────────────

def rows_of(answer: dict) -> list[dict]:
    """The rows of one API answer. "No data" comes back as statusCode 500."""
    code = answer.get('statusCode')
    if code == 200:
        return answer.get('data') or []
    if code == 500 and not answer.get('data'):
        return []
    raise ValueError(f'unexpected answer: statusCode {code}: {answer.get("message")}')


def api_fetch(ctx: ssl.SSLContext) -> Fetch:
    def fetch(params: dict) -> dict:
        url = f'{API_URL}?{urllib.parse.urlencode(params)}'
        req = urllib.request.Request(url, data=b'', method='POST',
                                     headers={'User-Agent': pipeline.USER_AGENT, 'Accept': 'application/json'})
        return pipeline.with_retries(lambda: json.loads(urllib.request.urlopen(req, timeout=300, context=ctx).read()),
                                     give_up=pipeline.is_client_error)
    return fetch


def _read_gz(path: Path):
    return json.loads(gzip.decompress(path.read_bytes()))


def _write_gz(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with atomic_output(path) as part:
        part.write_bytes(gzip.compress(json.dumps(data).encode(), mtime=0))


# ── stations ─────────────────────────────────────────────────────────────────

def pull_stations(raw: Path, get_json: Callable[[str], dict]) -> list[dict]:
    """Every station (ArcGIS features, lon/lat), one cached page per offset."""
    feats, offset = [], 0
    while True:
        page = raw / 'stations' / f'offset_{offset:07d}.json.gz'
        if not page.exists():
            q = {'where': '1=1', 'outFields': '*', 'outSR': 4326, 'f': 'json', 'orderByFields': 'objectid',
                 'resultOffset': offset, 'resultRecordCount': STATION_PAGE}
            got = get_json(f'{STATIONS_URL}/query?{urllib.parse.urlencode(q)}')
            if 'error' in got:
                raise ValueError(f'station layer: {got["error"]}')
            _write_gz(page, got['features'])
            log(f'  stations: {offset + len(got["features"]):,}')
        got = _read_gz(page)
        feats += got
        if len(got) < STATION_PAGE:
            return feats
        offset += STATION_PAGE


def group_key(state: str, district: str, agency: str) -> tuple[str, str, str]:
    """The API matches names case-insensitively (ANANTAPUR and Anantapur answer the
    same rows), so groups, and their cache folders, are keyed by slug."""
    return pipeline.slug(state), pipeline.slug(district), pipeline.slug(agency)


def combos(stations: list[dict]) -> dict[tuple[str, str, str], bool]:
    """{(state, district, agency): has a telemetric station}, from the station
    layer's names: per group_key, the spelling most of its stations use (a
    stray variant such as "Tarn Taran " with a trailing space answers nothing)."""
    spellings: dict[tuple, Counter] = defaultdict(Counter)
    telemetric: dict[tuple, bool] = defaultdict(bool)
    for f in stations:
        a = f['attributes']
        names = (a['state_name'], a['district_name'], a['agency_name'])
        if all(names):
            spellings[group_key(*names)][names] += 1
            telemetric[group_key(*names)] |= a.get('telemetry') == 1
    return dict(sorted((min(c, key=lambda n: (-c[n], n)), telemetric[k]) for k, c in spellings.items()))


# ── readings: one window, answered in one page ───────────────────────────────
# The API pages a large answer unreliably: pages overlap, so rows go missing
# (probed 2026-11-21: three of four multi-page answers held duplicates). A
# window is therefore read only when its first page holds all of it; a fuller
# one is split in two by date, and so on. Telemetry filling a span of a year or
# less makes that window "heavy": it is read later on the manual days only. A
# single day that still fills a page is paged as best the API allows ("paged").

def manual_windows(split_year: int = MANUAL_SPLIT_YEAR, end_year: int = MANUAL_END_YEAR) -> list[tuple[str, str]]:
    return [('1900-01-01', f'{split_year - 1}-12-31')] + \
        [(f'{y}-01-01', f'{y}-12-31') for y in range(split_year, end_year + 1)]


def window_dir(raw: Path, combo: tuple[str, str, str], start: str, end: str) -> Path:
    return raw.joinpath('readings', *group_key(*combo), f'{start}_{end}')


def span_days(start: str, end: str) -> int:
    return (date.fromisoformat(end) - date.fromisoformat(start)).days + 1


def halves(start: str, end: str) -> list[list[str]]:
    a, b = date.fromisoformat(start), date.fromisoformat(end)
    mid = a + timedelta(days=(b - a).days // 2)
    return [[start, mid.isoformat()], [(mid + timedelta(days=1)).isoformat(), end]]


def _marker(wdir: Path) -> dict | None:
    """A finished window's record, or None (none yet, or one from the paging design)."""
    path = wdir / 'window.json'
    done = json.loads(path.read_text()) if path.exists() else None
    return done if done and done.get('v') == WINDOW_VERSION else None


def pull_window(fetch: Fetch, raw: Path, combo: tuple[str, str, str], start: str, end: str,
                heavy_ok: bool = True, deadline: pipeline.Deadline | None = None) -> dict:
    """Read one window (and, when it splits, its halves), caching each answer as
    it arrives; returns its record {v, status: full | split | heavy | paged, ...}.
    A finished window is never asked again; a heavy one is, when `heavy_ok` is off."""
    wdir = window_dir(raw, combo, start, end)
    done = _marker(wdir)
    if done and not (done['status'] == 'heavy' and not heavy_ok):
        if done['status'] == 'split':
            for s, e in done['children']:
                pull_window(fetch, raw, combo, s, e, heavy_ok, deadline)
        return done
    params = {'stateName': combo[0], 'districtName': combo[1], 'agencyName': combo[2],
              'startdate': start, 'enddate': end}

    def page(n: int) -> list[dict]:
        path = wdir / f'page_{n:05d}.json.gz'
        if not path.exists():
            if deadline:
                deadline.check(f'{wdir.name} page {n}')
            answer = fetch({**params, 'page': n, 'size': PAGE})
            rows_of(answer)
            _write_gz(path, answer)
        return rows_of(_read_gz(path))

    first = page(0)
    if len(first) < PAGE:
        result = {'status': 'full', 'pages': 1}
    elif start == end:
        n, got = 0, len(first)
        while got == PAGE:
            n += 1
            got = len(page(n))
        result = {'status': 'paged', 'pages': n + 1}
    elif heavy_ok and span_days(start, end) <= HEAVY_SPAN_DAYS and not all(is_manual(r) for r in first):
        result = {'status': 'heavy'}
    else:
        result = {'status': 'split', 'children': halves(start, end)}
        for s, e in result['children']:
            pull_window(fetch, raw, combo, s, e, heavy_ok, deadline)
    result = {'v': WINDOW_VERSION, **result}
    pipeline.write_json(wdir / 'window.json', result)
    return result


def leaves(raw: Path, combo: tuple[str, str, str], start: str, end: str):
    """(start, end, status, folder) of each finished window under a split tree."""
    wdir = window_dir(raw, combo, start, end)
    done = _marker(wdir)
    if done is None:
        return
    if done['status'] == 'split':
        for s, e in done['children']:
            yield from leaves(raw, combo, s, e)
    else:
        yield start, end, done['status'], wdir


def window_rows(wdir: Path) -> list[dict]:
    """The rows of a finished full or paged window, in page order."""
    out = []
    for n in range(json.loads((wdir / 'window.json').read_text())['pages']):
        out += rows_of(_read_gz(wdir / f'page_{n:05d}.json.gz'))
    return out


# ── heavy windows: the days manual readings were taken ───────────────────────

def is_manual(row: dict) -> bool:
    return str(row.get('description') or '').lower().startswith('manual')


def manual_days(rows: Iterable[dict]) -> dict[tuple[str, str], Counter]:
    """{(state, agency): Counter(day: manual readings)}."""
    out: dict[tuple, Counter] = defaultdict(Counter)
    for r in rows:
        if is_manual(r) and r.get('dataTime'):
            out[(r['state'], r['agencyName'])][r['dataTime'][:10]] += 1
    return out


def days_for(days: dict[tuple[str, str], Counter], state: str, agency: str, start: str, end: str) -> list[str]:
    """The days to read a heavy window on: the agency's manual days in that State
    within the window, else every agency's in that State; the MAX_DAYS busiest."""
    def within(c: Counter) -> Counter:
        return Counter({d: n for d, n in c.items() if start <= d <= end})
    mine = within(days.get((state, agency), Counter()))
    if not mine:
        mine = sum((within(c) for (st, _), c in days.items() if st == state), Counter())
    return sorted(d for d, _ in sorted(mine.items(), key=lambda t: (-t[1], t[0]))[:MAX_DAYS])


# ── the run ──────────────────────────────────────────────────────────────────

def _run(jobs: list[tuple], fetch: Fetch, heavy_ok: bool, deadline: pipeline.Deadline | None, what: str) -> None:
    """Pull every (combo, start, end) window, WORKERS at a time."""
    todo = [j for j in jobs if not _settled(j, heavy_ok)]
    log(f'{what}: {len(jobs):,} windows, {len(todo):,} to ask')
    lock, t0, done = threading.Lock(), time.monotonic(), [0]

    def one(job):
        pull_window(fetch, RAW, *job, heavy_ok=heavy_ok, deadline=deadline)
        with lock:
            done[0] += 1
            if done[0] % 200 == 0 or done[0] == len(todo):
                rate = done[0] / max(time.monotonic() - t0, 1e-9)
                log(f'  {what}: {done[0]:,}/{len(todo):,} windows, {rate * 60:.0f}/min, '
                    f'~{(len(todo) - done[0]) / max(rate, 1e-9) / 60:.0f} min left')

    with ThreadPoolExecutor(WORKERS) as pool:
        futures = [pool.submit(one, j) for j in todo]
        try:
            for f in as_completed(futures):
                f.result()
        except BaseException:
            for f in futures:
                f.cancel()
            raise


def _settled(job: tuple, heavy_ok: bool) -> bool:
    """Every window of the job's tree is finished (a heavy one counts only when heavy_ok)."""
    marker = _marker(window_dir(RAW, *job))
    if marker is None:
        return False
    found = list(leaves(RAW, *job))
    return bool(found) and all(st != 'heavy' or heavy_ok for *_, st, _ in found) and \
        sum(span_days(s, e) for s, e, *_ in found) == span_days(*job[1:])


def pull(fetch: Fetch | None = None, deadline: pipeline.Deadline | None = None, now: str | None = None) -> dict:
    ctx = verified_context() if fetch is None else None
    fetch = fetch or api_fetch(ctx)

    def get_json(url: str) -> dict:
        req = urllib.request.Request(url, headers={'User-Agent': pipeline.USER_AGENT})
        return pipeline.with_retries(lambda: json.loads(urllib.request.urlopen(req, timeout=300, context=ctx).read()))

    stations = pull_stations(RAW, get_json)
    groups = combos(stations)
    log(f'{len(stations):,} stations in {len(groups):,} (state, district, agency) groups, '
        f'{sum(groups.values()):,} with telemetry')
    jobs = [(c, s, e) for c in groups for s, e in manual_windows()]
    _run(jobs, fetch, True, deadline, 'manual windows')
    found = [(c, s, e, st, wdir) for c, s0, e0 in jobs for s, e, st, wdir in leaves(RAW, c, s0, e0)]
    heavy = [(c, s, e) for c, s, e, st, _ in found if st == 'heavy']
    days = manual_days(r for *_, st, wdir in found if st == 'full' for r in window_rows(wdir))
    day_jobs = sorted({(c, d, d) for c, s, e in heavy for d in days_for(days, c[0], c[2], s, e)})
    log(f'{len(heavy):,} heavy windows, read on {len(day_jobs):,} manual days')
    _run(day_jobs, fetch, False, deadline, 'manual days')
    tele = [(c, *TELEMETRY_WINDOW) for c, t in groups.items() if t]
    _run(tele, fetch, False, deadline, 'telemetry week')
    statuses = Counter(st for c, s0, e0 in [*jobs, *day_jobs, *tele] for *_, st, _ in leaves(RAW, c, s0, e0))
    record = RAW / 'pull.json'
    prev = json.loads(record.read_text()) if record.exists() else {}
    got = {'stations': len(stations), 'groups': len(groups), 'windows': dict(sorted(statuses.items())),
           'heavy_windows': len(heavy), 'heavy_groups': len({c for c, _, _ in heavy}), 'day_windows': len(day_jobs),
           'telemetry_windows': len(tele)}
    if {k: v for k, v in prev.items() if k != 'pulled_at'} == got:
        return prev
    got['pulled_at'] = now or pipeline.now_iso()
    pipeline.write_json(record, got)
    return got


# ── summaries ────────────────────────────────────────────────────────────────

def _slope(points: list[tuple[int, float]]) -> float:
    n = len(points)
    mx, my = sum(x for x, _ in points) / n, sum(y for _, y in points) / n
    return sum((x - mx) * (y - my) for x, y in points) / sum((x - mx) ** 2 for x, _ in points)


def _latest_in(readings: list[tuple[str, float]], months: tuple[int, ...]) -> dict[int, float]:
    """{year: the year's last reading in `months`} (readings sorted by time)."""
    out = {}
    for t, v in readings:
        if int(t[5:7]) in months:
            out[int(t[:4])] = v
    return out


def summarise(rows: list[dict], trend_years: tuple[int, int] = TREND_YEARS,
              min_trend_years: int = MIN_TREND_YEARS) -> dict:
    """One station's summary of its manual below-ground readings (HGZ, with a value)."""
    readings = sorted((r['dataTime'], float(r['dataValue'])) for r in rows
                      if r.get('datatypeCode') == BELOW_GROUND and r.get('dataValue') is not None and r.get('dataTime'))
    out = dict.fromkeys(SUMMARY_COLUMNS)
    out['n_readings'], out['trend_n_years'] = len(readings), 0
    if not readings:
        return out
    pre, post = _latest_in(readings, PRE_MONTHS), _latest_in(readings, POST_MONTHS)
    trend = sorted((y, v) for y, v in pre.items() if trend_years[0] <= y <= trend_years[1])
    out.update(first_reading=readings[0][0][:10], last_reading=readings[-1][0][:10],
               years_of_record=len({t[:4] for t, _ in readings}), last_depth_m=readings[-1][1],
               trend_n_years=len(trend))
    if pre:
        y = max(pre)
        out.update(premonsoon_depth_m=pre[y], premonsoon_year=y)
    if post:
        y = max(post)
        out.update(postmonsoon_depth_m=post[y], postmonsoon_year=y)
    if len(trend) >= min_trend_years:
        out['premonsoon_trend_m_per_yr'] = round(_slope(trend), 3)
    return out


def last_telemetry(rows: Iterable[dict]) -> dict[str, tuple[float, str]]:
    """{station: (value, time)} of its latest telemetric GPRS-Water Level reading, as published."""
    out: dict[str, tuple[float, str]] = {}
    for r in rows:
        if r.get('datatypeCode') == TELEMETRY_LEVEL and r.get('dataValue') is not None:
            code, t = r['stationCode'], r['dataTime']
            if code not in out or t > out[code][1]:
                out[code] = (r['dataValue'], t)
    return out


# ── bake ─────────────────────────────────────────────────────────────────────

READING_FIELDS = ('stationCode', 'stationName', 'stationType', 'latitude', 'longitude', 'agencyName', 'state',
                  'district', 'majorBasin', 'tributary', 'dataAcquisitionMode', 'stationStatus', 'tehsil',
                  'datatypeCode', 'description', 'dataValue', 'dataTime', 'unit', 'block', 'village', 'wellType',
                  'wellDepth', 'wellAquiferType')
READING_TYPES = {'latitude': 'DOUBLE', 'longitude': 'DOUBLE', 'dataValue': 'DOUBLE', 'wellDepth': 'DOUBLE',
                 'dataTime': 'TIMESTAMP'}
# Dates as ISO text: GDAL's GeoJSON writer fails on a DATE before 1970 (the readings start in 1931).
SUMMARY_TYPES = {'first_reading': 'VARCHAR', 'last_reading': 'VARCHAR', 'n_readings': 'INTEGER',
                 'years_of_record': 'INTEGER', 'last_depth_m': 'DOUBLE', 'premonsoon_depth_m': 'DOUBLE',
                 'premonsoon_year': 'INTEGER', 'postmonsoon_depth_m': 'DOUBLE', 'postmonsoon_year': 'INTEGER',
                 'premonsoon_trend_m_per_yr': 'DOUBLE', 'trend_n_years': 'INTEGER',
                 'telemetry_last_value': 'DOUBLE', 'telemetry_last_at': 'TIMESTAMP', 'series_complete': 'BOOLEAN'}
TIME_FORMAT = '%Y-%m-%dT%H:%M:%S'


def _json_columns(types: dict[str, str]) -> str:
    return '{' + ', '.join(f"'{c}': '{t}'" for c, t in types.items()) + '}'


def gather(raw: Path, groups: Iterable[tuple[str, str, str]], manual_out, telemetry_rows: list) -> set:
    """Write every manual reading of the finished one-page (or paged) windows to
    `manual_out` (NDJSON), add the telemetry week's rows to `telemetry_rows`, and
    return the group_keys whose manual series may miss readings (a heavy window,
    read on manual days only, or a paged day)."""
    incomplete = set()
    for combo in groups:
        key = group_key(*combo)
        for marker in sorted(raw.joinpath('readings', *key).glob('*/window.json')):
            done = _marker(marker.parent)
            if done is None or done['status'] == 'split':
                continue
            telemetry = marker.parent.name.split('_')[0] >= TELEMETRY_WINDOW[0]
            if done['status'] == 'heavy' or (done['status'] == 'paged' and not telemetry):
                incomplete.add(key)
            if done['status'] == 'heavy':
                continue
            rows = window_rows(marker.parent)
            if telemetry:
                telemetry_rows += [r for r in rows if r.get('datatypeCode') == TELEMETRY_LEVEL]
                continue
            for r in rows:
                if is_manual(r):
                    manual_out.write(json.dumps({k: r.get(k) for k in READING_FIELDS}) + '\n')
    return incomplete


def build_readings(con, ndjson: Path, out: Path) -> int:
    """The manual readings, every published field, one row per distinct reading,
    by station and time. Returns the row count."""
    cols = _json_columns({c: READING_TYPES.get(c, 'VARCHAR') for c in READING_FIELDS})
    sel = ', '.join(f'"{c}"' for c in READING_FIELDS)
    con.execute(f"""COPY (SELECT DISTINCT {sel}
                          FROM read_json('{ndjson}', format = 'newline_delimited', columns = {cols},
                                         timestampformat = '{TIME_FORMAT}')
                          ORDER BY stationCode, dataTime, datatypeCode, dataValue)
                    TO '{out}' (FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL 9, ROW_GROUP_SIZE 100000)""")
    return con.execute(f"SELECT count(*) FROM '{out}'").fetchone()[0]


def station_summaries(con, readings: Path) -> dict[str, dict]:
    """{stationCode: summarise(its readings)}, streamed one station at a time."""
    from itertools import groupby
    cur = con.execute(f"""SELECT stationCode, strftime(dataTime, '{TIME_FORMAT}') AS dataTime, dataValue,
                                 datatypeCode
                          FROM '{readings}' WHERE datatypeCode = '{BELOW_GROUND}' ORDER BY stationCode, dataTime""")
    names = [d[0] for d in cur.description]

    def rows():
        while chunk := cur.fetchmany(100_000):
            yield from chunk
    return {code: summarise([dict(zip(names, t)) for t in group])
            for code, group in groupby(rows(), key=lambda t: t[0])}


def _published_types(stations: list[dict], fields: list[str]) -> dict[str, str]:
    """A published field whose every value is a number is a number (integers stay integers); the rest is text."""
    out = {}
    for c in fields:
        vals = [f['attributes'][c] for f in stations if f['attributes'].get(c) is not None]
        nums = vals and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in vals)
        out[c] = ('BIGINT' if all(isinstance(v, int) for v in vals) else 'DOUBLE') if nums else 'VARCHAR'
    return out


def build_station_table(con, stations: list[dict], summaries: dict[str, dict],
                        telemetry: dict[str, tuple[float, str]], incomplete: set, out: Path) -> int:
    """Every station with every published field in the layer's order, then the
    summaries, its last telemetric reading, series_complete and a point from
    the published long/lat. Returns the row count."""
    fields = list(dict.fromkeys(k for f in stations for k in f['attributes']))
    types = {**_published_types(stations, fields), **SUMMARY_TYPES}
    empty = summarise([])
    tmp = out.with_suffix('.ndjson')
    with tmp.open('w') as f:
        for feat in stations:
            a = feat['attributes']
            value, at = telemetry.get(a.get('station_code'), (None, None))
            combo = group_key(a.get('state_name'), a.get('district_name'), a.get('agency_name'))
            f.write(json.dumps({**{k: a.get(k) for k in fields}, **summaries.get(a.get('station_code'), empty),
                                'telemetry_last_value': value, 'telemetry_last_at': at,
                                'series_complete': combo not in incomplete}) + '\n')
    sel = ', '.join(f'"{c}"' for c in types)
    con.execute('INSTALL spatial; LOAD spatial;')
    con.execute(f"""COPY (SELECT {sel}, CASE WHEN "long" IS NULL OR "lat" IS NULL THEN NULL
                                             ELSE ST_Point("long", "lat") END AS geometry
                          FROM read_json('{tmp}', format = 'newline_delimited', columns = {_json_columns(types)},
                                         timestampformat = '{TIME_FORMAT}'))
                    TO '{out}' (FORMAT PARQUET)""")
    tmp.unlink()
    return con.execute(f"SELECT count(*) FROM '{out}'").fetchone()[0]


def load_stations(raw: Path = RAW) -> list[dict]:
    return [f for p in sorted((raw / 'stations').glob('offset_*.json.gz')) for f in _read_gz(p)]


def bake(out_dir: Path = OUT_DIR, raw: Path = RAW) -> dict:
    import tempfile

    import bake_formats
    from bake_extracts import gdal_geojson_available, write_kml_from_geojson
    from bake_whole_layer import write_geojson_whole

    got = json.loads((raw / 'pull.json').read_text())
    stations = load_stations(raw)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = {fmt: out_dir / f'{BASENAME}.{ext}' for fmt, ext in EXT.items()}
    path['readings'] = out_dir / f'{READINGS_BASENAME}.parquet'
    con = make_con()
    with tempfile.TemporaryDirectory(prefix='wris_gw_') as tmp:
        ndjson, telemetry_rows = Path(tmp) / 'manual.ndjson', []
        log('gathering the cached readings')
        with ndjson.open('w') as f:
            incomplete = gather(raw, combos(stations), f, telemetry_rows)
        n_readings = build_readings(con, ndjson, path['readings'])
        log(f'{n_readings:,} manual readings')
        summaries = station_summaries(con, path['readings'])
        table = Path(tmp) / 'stations.parquet'
        build_station_table(con, stations, summaries, last_telemetry(telemetry_rows), incomplete, table)
        rows, prop_cols = pipeline.rebake_flatten_bbox(table, path['parquet'])
    p, r = path['parquet'], path['readings']
    counts = dict(zip(('stations', 'with_readings', 'with_trend', 'with_telemetry_value', 'series_complete',
                       'outside_india'), con.execute(f"""
        SELECT count(*), count(*) FILTER (n_readings > 0), count(premonsoon_trend_m_per_yr),
               count(telemetry_last_value), count(*) FILTER (series_complete),
               count(*) FILTER (NOT ("long" BETWEEN 68 AND 98 AND "lat" BETWEEN 6 AND 38)) FROM '{p}'""").fetchone()))
    codes = {f['attributes'].get('station_code') for f in stations}
    counts.update(readings=n_readings, reading_stations=len(summaries),
                  reading_stations_not_in_layer=len(set(summaries) - codes),
                  readings_by_code=dict(con.execute(f"SELECT datatypeCode, count(*) FROM '{r}' GROUP BY 1 "
                                                    "ORDER BY 2 DESC").fetchall()))
    log(json.dumps(counts))
    path['geojson'].unlink(missing_ok=True)
    write_geojson_whole(con, p, path['geojson'], gdal_geojson_available(con))
    write_kml_from_geojson(path['geojson'], LAYER_ID, path['kml'])
    bake_formats.shapefile_zip_from_geojson(path['geojson'], path['shapefile'], bake_formats.short_field_names(prop_cols))
    bake_formats.write_pmtiles(path['geojson'], path['pmtiles'], LAYER_ID, TILE_FIELDS)
    summary = {'rows': rows, 'counts': counts, 'pull': got,
               'sizes': {fmt: f.stat().st_size for fmt, f in path.items()},
               'names': pipeline.versioned_names(path)}
    pipeline.write_json(SUMMARY, summary)
    log(json.dumps(summary, indent=2))
    return summary


def upload(out_dir: Path = OUT_DIR) -> dict[str, str]:
    """Every file to its content-versioned key: unchanged files keep theirs (md5-skipped)."""
    paths = {fmt: out_dir / name for fmt, name in pipeline.plain_names(BASENAME, EXT).items()}
    paths['readings'] = out_dir / f'{READINGS_BASENAME}.parquet'
    return pipeline.upload_versioned(pipeline.r2_client(), paths, R2_PREFIX)


# ── register ─────────────────────────────────────────────────────────────────

def description() -> str:
    return ('Every India-WRIS groundwater-level monitoring station (CGWB and state ground water departments), '
            'with a summary of its manual readings in metres below ground level: first and last reading, the '
            'latest pre- and post-monsoon depth and the ten-year pre-monsoon trend.')


def notes(summ: dict, readings_url: str) -> str:
    c = summ['counts']
    return (f'Stations are the India-WRIS station layer as published: every field, the point from its long and '
            f'lat ({c["outside_india"]:,} stations sit outside India as published). Readings come from the '
            f'India-WRIS Dataset API: {c["with_readings"]:,} of {c["stations"]:,} stations have manual readings, '
            f'which end in 2024. Columns added by bharatlas from the manual "MANUAL-Water Level" readings: '
            f'first_reading and last_reading (dates), n_readings, years_of_record (calendar years with a reading), '
            f'last_depth_m (the last reading), premonsoon_depth_m and premonsoon_year (the latest year\'s last '
            f'March to May reading), postmonsoon_depth_m and postmonsoon_year (the same for October and November), '
            f'and premonsoon_trend_m_per_yr: the least-squares slope of the yearly pre-monsoon depth over '
            f'{TREND_YEARS[0]}-{TREND_YEARS[1]} where at least {MIN_TREND_YEARS} years have one (trend_n_years '
            f'says how many); a positive trend means the water table is getting deeper. Depths are metres below '
            f'ground level, so a larger number is a deeper water table; a negative depth is water above ground, '
            f'as published. Telemetric stations report every few hours and the API cannot leave those readings '
            f'out, so bharatlas reads them only for the feed\'s last week ({TELEMETRY_WINDOW[0]} to '
            f'{TELEMETRY_WINDOW[1]}): telemetry_last_value and telemetry_last_at are the last "GPRS-Water Level" '
            f'value as the sensor reports it (agencies differ in sign and datum). The API answers a large request '
            f'unreliably, so bharatlas asks for spans small enough to come back whole; where telemetry still '
            f'filled a district\'s answer, its manual readings for that span were read on the days that agency '
            f'took readings in that State. series_complete is false for those stations, whose series may miss a '
            f'reading. '
            f'The {c["readings"]:,} manual readings themselves, with every published field, are a separate '
            f'Parquet download: {readings_url}')


def level_meta() -> dict:
    return {'label': 'Groundwater levels, India-WRIS stations', 'unit': 'stations', 'description': description()}


def refresh_block(entry: dict, prev: dict, built_at: str) -> dict:
    from populate_refresh import infer, next_due
    block, _ = infer(entry)
    return {**block, 'audited_at': (prev.get('refresh') or {}).get('audited_at'),
            'next_due': next_due(block['rebuild'], built_at)}


def source_check() -> dict:
    from populate_source_check import OVERRIDES
    return dict(OVERRIDES[LAYER_ID])


def readings_url(summ: dict, r2_public: str) -> str:
    return f'{r2_public}/{R2_PREFIX}/{summ["names"]["readings"]}'


def catalog_entry(summ: dict, prev: dict, r2_public: str) -> dict:
    names, sizes, got = summ['names'], summ['sizes'], summ['pull']
    entry = {'id': LAYER_ID, 'level': LEVEL, 'source': SOURCE, 'rows': summ['rows']}
    for fmt in EXT:
        entry[fmt] = {'url': f'{r2_public}/{R2_PREFIX}/{names[fmt]}', 'bytes': sizes[fmt]}
    entry.update({'licence': LICENCE, 'attribution': {'primary': dict(ATTRIBUTION), 'publisher': None},
                  'category': CATEGORY, 'provenance': 'curated', 'notes': notes(summ, readings_url(summ, r2_public)),
                  'tags': TAGS, 'fetched_at': got['pulled_at'],
                  'source_check': {**source_check(), 'fingerprint': None, 'checked_at': None, 'changed_at': None}})
    entry['refresh'] = refresh_block(entry, prev, got['pulled_at'])
    return entry


def manifest_entry(summ: dict, r2_public: str) -> dict:
    names, sizes = summ['names'], summ['sizes']
    return {'id': LAYER_ID, 'name': level_meta()['label'], 'level': LEVEL, 'category': CATEGORY,
            'source': SOURCE, 'description': description(), 'unit': 'stations', 'features': summ['rows'],
            'license': LICENCE, 'r2_prefix': R2_PREFIX,
            'parquet_file': names['parquet'], 'parquet_bytes': sizes['parquet'],
            'pmtiles_file': names['pmtiles'], 'pmtiles_bytes': sizes['pmtiles'],
            'readings_file': names['readings'], 'readings_bytes': sizes['readings'],
            'source_url': API_DOCS,
            'source_org': 'India-WRIS (Ministry of Jal Shakti): CGWB and state ground water departments',
            'source_version': f'pulled {summ["pull"]["pulled_at"][:10]}',
            'notes': notes(summ, readings_url(summ, r2_public)), 'tags': TAGS}


def register(catalog_path: Path = CATALOG, manifest_path: Path = MANIFEST,
             summary_path: Path = SUMMARY, r2_public: str | None = None) -> None:
    """Patch catalog.json + the manifest in place (never rebuild). Idempotent."""
    r2_public = r2_public or pipeline.R2_PUBLIC
    summ = json.loads(summary_path.read_text())
    pipeline.summary_names(summ)
    catalog = json.loads(catalog_path.read_text())
    prev = next((x for x in catalog.get('layers', []) if x.get('id') == LAYER_ID), {})
    entry = pipeline.licence_labelled(catalog_entry(summ, prev, r2_public))
    pipeline.upsert_layer(catalog, entry, level_meta(), level=LEVEL, attribution=(SOURCE, ATTRIBUTION))
    # This bake makes every file of the layer, so its entry stands as built (see bake_airports.register).
    catalog['layers'] = pipeline.upsert_by_id(catalog['layers'], entry)
    pipeline.write_json(catalog_path, catalog)
    pipeline.write_json(manifest_path, pipeline.upsert_by_id(json.loads(manifest_path.read_text()),
                                                             manifest_entry(summ, r2_public)))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('step', choices=['pull', 'bake', 'upload', 'register'])
    ap.add_argument('--max-minutes', type=float, default=330)
    a = ap.parse_args()
    if a.step == 'pull':
        deadline = pipeline.Deadline(a.max_minutes)
        with pipeline.cache_backup(RAW, LAYER_ID):
            try:
                log(json.dumps(pull(deadline=deadline), indent=2))
            except pipeline.OutOfTime as e:
                log(f'stopped: {e}; run again to continue')
                sys.exit(3)
    elif a.step == 'bake':
        bake()
    elif a.step == 'upload':
        upload()
    else:
        register()


if __name__ == '__main__':
    main()
