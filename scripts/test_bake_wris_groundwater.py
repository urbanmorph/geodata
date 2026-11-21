"""wris_groundwater_levels: every India-WRIS groundwater-level station, with summaries of its manual
readings from the India-WRIS Dataset API. The pull pages each (state, district, agency, date window)
and caches every answer; a window too heavy with telemetry is read only on the days manual readings
were taken; the bake keeps every published station field and adds the summaries.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_bake_wris_groundwater.py -q
"""
from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bake_wris_groundwater as w  # noqa: E402
import pipeline  # noqa: E402

NO_DATA = {'statusCode': 500, 'message': 'Data not found', 'data': None}


def reading(code='S1', when='2023-05-01T06:00:00', value=5.0, dtype='HGZ', mode='Manual', **kw):
    desc = {'HGZ': 'MANUAL-Water Level', 'MSL': 'Manual Water Level - AMSL', 'GGZ': 'GPRS-Water Level',
            'MS4': 'GPRS Water Level - AMSL4'}[dtype]
    return {'stationCode': code, 'stationName': code, 'stationType': 'Ground Water', 'latitude': 21.5,
            'longitude': 86.9, 'agencyName': 'CGWB', 'state': 'Odisha', 'district': 'Baleshwar',
            'majorBasin': None, 'tributary': None, 'dataAcquisitionMode': mode, 'stationStatus': 'Active',
            'tehsil': 'X', 'datatypeCode': dtype, 'description': desc, 'dataValue': value, 'dataTime': when,
            'unit': 'm', 'block': None, 'village': None, 'wellType': 'Dug Well', 'wellDepth': 10.0,
            'wellAquiferType': '', **kw}


class FakeApi:
    """The API over a list of rows: filtered by group and date window, paged by `page_size`."""

    def __init__(self, rows: list[dict], page_size: int):
        self.rows, self.size, self.calls = rows, page_size, []

    def __call__(self, params: dict) -> dict:
        self.calls.append(dict(params))
        rows = [r for r in self.rows
                if (r['state'], r['district'], r['agencyName']) == (params['stateName'], params['districtName'],
                                                                    params['agencyName'])
                and params['startdate'] <= r['dataTime'][:10] <= params['enddate']]
        start = params['page'] * params['size']
        chunk = rows[start:start + params['size']]
        return {'statusCode': 200, 'message': 'Data fetched successfully', 'data': chunk} if chunk else NO_DATA

    def asked(self):
        return [(c['startdate'], c['enddate'], c['page']) for c in self.calls]


COMBO = ('Odisha', 'Baleshwar', 'CGWB')


def params(start, end):
    return {'stateName': COMBO[0], 'districtName': COMBO[1], 'agencyName': COMBO[2], 'startdate': start,
            'enddate': end}


# ── answers ──────────────────────────────────────────────────────────────────

def test_no_data_is_an_empty_answer_and_anything_else_unexpected_stops():
    assert w.rows_of(NO_DATA) == []
    assert w.rows_of({'statusCode': 200, 'data': [reading()]}) == [reading()]
    with pytest.raises(ValueError, match='401'):
        w.rows_of({'statusCode': 401, 'message': 'nope', 'data': None})


def test_groups_differing_only_in_case_are_asked_once():
    # the API matches names case-insensitively: ANANTAPUR and Anantapur answer the same rows
    stations = [{'attributes': {'state_name': 'Andhra Pradesh', 'district_name': d, 'agency_name': 'CGWB',
                                'telemetry': t}} for d, t in [('Anantapur', 2), ('ANANTAPUR', 1), ('Guntur', 2)]]
    assert w.combos(stations) == {('Andhra Pradesh', 'ANANTAPUR', 'CGWB'): True,
                                  ('Andhra Pradesh', 'Guntur', 'CGWB'): False}
    assert w.group_key('Andhra Pradesh', 'Anantapur', 'CGWB') == w.group_key('Andhra Pradesh', 'ANANTAPUR', 'CGWB')


def test_a_group_is_asked_by_the_spelling_most_of_its_stations_use():
    # a variant label ("Tarn Taran " with a trailing space, "Janjgir-champa") answers nothing
    stations = [{'attributes': {'state_name': 'Punjab', 'district_name': d, 'agency_name': 'CGWB', 'telemetry': 2}}
                for d in ['TARN-TARAN'] * 3 + ['Tarn Taran'] * 4]
    assert w.combos(stations) == {('Punjab', 'Tarn Taran', 'CGWB'): False}


def test_the_windows_are_one_early_span_then_one_per_year():
    assert w.manual_windows(2019, 2021) == [('1900-01-01', '2018-12-31'), ('2019-01-01', '2019-12-31'),
                                            ('2020-01-01', '2020-12-31'), ('2021-01-01', '2021-12-31')]


# ── one window: answered in one page, else split by date ──────────────────
# The API pages a large answer unreliably (pages overlap and rows go missing), so a
# window is read only when its first page holds all of it.

def pull(api, tmp_path, start, end, heavy_ok=True, deadline=None):
    return w.pull_window(api, tmp_path, COMBO, start, end, heavy_ok, deadline)


def leaf_rows(tmp_path, start, end):
    return sorted((r['dataTime'], r['datatypeCode']) for _, _, st, wdir in w.leaves(tmp_path, COMBO, start, end)
                  if st in ('full', 'paged') for r in w.window_rows(wdir))


def test_a_window_answered_in_one_page_is_cached_so_a_rerun_asks_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr(w, 'PAGE', 3)
    rows = [reading(when=f'2023-0{m}-01T06:00:00') for m in (1, 5)]
    api = FakeApi(rows, 3)
    assert pull(api, tmp_path, '2023-01-01', '2023-12-31')['status'] == 'full'
    assert api.asked() == [('2023-01-01', '2023-12-31', 0)]
    wdir = w.window_dir(tmp_path, COMBO, '2023-01-01', '2023-12-31')
    assert json.loads(gzip.decompress((wdir / 'page_00000.json.gz').read_bytes()))['data'] == rows   # as it arrived
    assert w.window_rows(wdir) == rows
    api.calls.clear()
    pull(api, tmp_path, '2023-01-01', '2023-12-31')
    assert api.calls == []


def test_a_window_with_no_data_is_cached_too(tmp_path):
    api = FakeApi([], 1000)
    assert pull(api, tmp_path, '1900-01-01', '2018-12-31')['status'] == 'full'
    assert w.window_rows(w.window_dir(tmp_path, COMBO, '1900-01-01', '2018-12-31')) == []


def test_a_full_first_page_of_manual_readings_splits_the_window_in_halves_never_asking_page_two(tmp_path, monkeypatch):
    monkeypatch.setattr(w, 'PAGE', 3)
    rows = [reading(when=f'20{y:02d}-05-01T06:00:00') for y in range(1, 11)]          # 2001-2010
    api = FakeApi(rows, 3)
    got = pull(api, tmp_path, '1900-01-01', '2018-12-31')
    assert got['status'] == 'split' and got['children'] == [['1900-01-01', '1959-07-02'], ['1959-07-03', '2018-12-31']]
    assert all(page == 0 for *_, page in api.asked())
    assert leaf_rows(tmp_path, '1900-01-01', '2018-12-31') == [(r['dataTime'], 'HGZ') for r in rows]
    api.calls.clear()
    pull(api, tmp_path, '1900-01-01', '2018-12-31')
    assert api.calls == []


def test_telemetry_filling_a_year_makes_it_heavy_after_one_request(tmp_path, monkeypatch):
    monkeypatch.setattr(w, 'PAGE', 3)
    rows = [reading(dtype='GGZ', mode='Telemetric', when=f'2023-01-{d:02d}T00:00:00') for d in range(1, 30)]
    api = FakeApi(rows, 3)
    assert pull(api, tmp_path, '2023-01-01', '2023-12-31')['status'] == 'heavy'
    assert api.asked() == [('2023-01-01', '2023-12-31', 0)]


def test_telemetry_over_more_than_a_year_is_split_until_a_year_or_less(tmp_path, monkeypatch):
    monkeypatch.setattr(w, 'PAGE', 3)
    rows = [reading(dtype='GGZ', mode='Telemetric', when=f'{y}-01-{d:02d}T00:00:00')
            for y in (2010, 2017) for d in range(1, 10)]
    api = FakeApi(rows, 3)
    assert pull(api, tmp_path, '1900-01-01', '2018-12-31')['status'] == 'split'
    statuses = [(s, e, st) for s, e, st, _ in w.leaves(tmp_path, COMBO, '1900-01-01', '2018-12-31')]
    heavy = [(s, e) for s, e, st in statuses if st == 'heavy']
    assert heavy and all(w.span_days(s, e) <= w.HEAVY_SPAN_DAYS for s, e in heavy)
    assert {st for *_, st in statuses} <= {'full', 'heavy'}


def test_without_heavy_windows_a_week_splits_to_days_and_a_day_over_a_page_is_paged(tmp_path, monkeypatch):
    monkeypatch.setattr(w, 'PAGE', 3)
    rows = [reading(code=f'T{i}', dtype='GGZ', mode='Telemetric', when=f'2026-06-0{d}T00:00:00')
            for d in (1, 4) for i in range(2 if d == 1 else 5)]
    api = FakeApi(rows, 3)
    assert pull(api, tmp_path, '2026-05-29', '2026-06-04', heavy_ok=False)['status'] == 'split'
    statuses = {(s, e): st for s, e, st, _ in w.leaves(tmp_path, COMBO, '2026-05-29', '2026-06-04')}
    assert statuses[('2026-06-04', '2026-06-04')] == 'paged'
    assert 'heavy' not in statuses.values()
    assert len(leaf_rows(tmp_path, '2026-05-29', '2026-06-04')) == 7


def test_a_window_from_the_paging_design_is_asked_again_from_its_cached_first_page(tmp_path, monkeypatch):
    monkeypatch.setattr(w, 'PAGE', 3)
    rows = [reading(when=f'2023-0{m}-01T06:00:00') for m in range(1, 6)]
    wdir = w.window_dir(tmp_path, COMBO, '2023-01-01', '2023-12-31')
    w._write_gz(wdir / 'page_00000.json.gz', {'statusCode': 200, 'data': rows[:3]})
    pipeline.write_json(wdir / 'window.json', {'status': 'full', 'pages': 2, 'rows': 5})      # no "v": old design
    api = FakeApi(rows, 3)
    assert pull(api, tmp_path, '2023-01-01', '2023-12-31')['status'] == 'split'
    assert ('2023-01-01', '2023-12-31', 0) not in api.asked()                             # page 0 was cached
    assert len(leaf_rows(tmp_path, '2023-01-01', '2023-12-31')) == 5


def test_out_of_time_stops_before_asking_and_keeps_the_pages_so_far(tmp_path, monkeypatch):
    monkeypatch.setattr(w, 'PAGE', 1)
    api = FakeApi([reading(), reading(when='2023-11-01T06:00:00')], 1)
    ticks = iter([0, 0, 10_000, 10_000])
    deadline = pipeline.Deadline(1, clock=lambda: next(ticks))
    with pytest.raises(pipeline.OutOfTime):
        pull(api, tmp_path, '2023-01-01', '2023-12-31', deadline=deadline)
    wdir = w.window_dir(tmp_path, COMBO, '2023-01-01', '2023-12-31')
    assert (wdir / 'page_00000.json.gz').exists() and not (wdir / 'window.json').exists()


# ── heavy windows: read on the days manual readings were taken ───────────────

def test_manual_days_come_from_the_same_state_and_agency_within_the_window():
    rows = [reading(when='2023-01-05T06:00:00'), reading(when='2023-05-25T06:00:00'),
            reading(when='2023-05-25T06:00:00', stationCode='S2'),
            reading(when='2022-11-05T06:00:00'),                                  # outside the window
            reading(when='2023-08-25T00:00:00', dtype='GGZ', mode='Telemetric'),  # not a manual reading
            reading(when='2023-08-26T06:00:00', agencyName='Odisha GW')]          # another agency
    days = w.manual_days(rows)
    assert w.days_for(days, 'Odisha', 'CGWB', '2023-01-01', '2023-12-31') == ['2023-01-05', '2023-05-25']
    # an agency with no light window that year borrows the State's manual days
    assert w.days_for(days, 'Odisha', 'Odisha GW', '2023-01-01', '2023-12-31') == ['2023-08-26']
    assert w.days_for(days, 'Odisha', 'APWRIMS', '2023-01-01', '2023-12-31') == \
        ['2023-01-05', '2023-05-25', '2023-08-26']
    assert w.days_for(days, 'Kerala', 'CGWB', '2023-01-01', '2023-12-31') == []


def test_too_many_manual_days_keeps_the_busiest(monkeypatch):
    monkeypatch.setattr(w, 'MAX_DAYS', 2)
    rows = [reading(when='2023-01-05T06:00:00'), reading(when='2023-01-05T06:00:00', stationCode='S2'),
            reading(when='2023-02-01T06:00:00'), reading(when='2023-03-09T06:00:00'),
            reading(when='2023-03-09T06:00:00', stationCode='S3')]
    assert w.days_for(w.manual_days(rows), 'Odisha', 'CGWB', '2023-01-01', '2023-12-31') == \
        ['2023-01-05', '2023-03-09']


# ── summaries ────────────────────────────────────────────────────────────────

def test_a_station_summary_from_its_manual_below_ground_readings():
    rows = [reading(when=f'{y}-{m}T06:00:00', value=v) for y, m, v in [
        (2015, '05-01', 5.0), (2016, '05-01', 5.5), (2017, '05-01', 6.0), (2018, '05-01', 6.5),
        (2019, '05-01', 7.0), (2019, '11-01', 3.0), (2020, '01-10', 4.0), (2020, '08-31', 2.0)]]
    rows.append(reading(when='2021-05-01T06:00:00', value=99.0, dtype='MSL'))          # level above sea level
    rows.append(reading(when='2021-05-01T06:00:00', value=None))                       # no value
    s = w.summarise(rows, trend_years=(2011, 2020), min_trend_years=5)
    assert s == {'first_reading': '2015-05-01', 'last_reading': '2020-08-31', 'n_readings': 8,
                 'years_of_record': 6, 'last_depth_m': 2.0,
                 'premonsoon_depth_m': 7.0, 'premonsoon_year': 2019,
                 'postmonsoon_depth_m': 3.0, 'postmonsoon_year': 2019,
                 'premonsoon_trend_m_per_yr': 0.5, 'trend_n_years': 5}


def test_the_trend_needs_enough_premonsoon_years_and_the_latest_reading_in_a_season_wins():
    rows = [reading(when='2019-03-02T06:00:00', value=5.0), reading(when='2019-05-30T06:00:00', value=6.0),
            reading(when='2019-10-01T06:00:00', value=2.0), reading(when='2020-04-01T06:00:00', value=7.0)]
    s = w.summarise(rows, trend_years=(2011, 2020), min_trend_years=5)
    assert s['premonsoon_depth_m'] == 7.0 and s['premonsoon_year'] == 2020
    assert s['postmonsoon_depth_m'] == 2.0 and s['postmonsoon_year'] == 2019     # October counts
    assert s['premonsoon_trend_m_per_yr'] is None and s['trend_n_years'] == 2


def test_a_station_without_readings_has_empty_summaries():
    s = w.summarise([], trend_years=(2011, 2020), min_trend_years=5)
    assert set(s) == set(w.SUMMARY_COLUMNS) and all(v in (None, 0) for v in s.values())
    assert s['n_readings'] == 0


def test_the_last_telemetric_reading_is_the_latest_gprs_water_level():
    rows = [reading(dtype='GGZ', mode='Telemetric', when='2026-06-03T18:00:00', value=-3.1),
            reading(dtype='GGZ', mode='Telemetric', when='2026-06-04T12:00:00', value=-3.2),
            reading(dtype='MS4', mode='Telemetric', when='2026-06-04T18:00:00', value=280.0),
            reading(dtype='HGZ', when='2026-06-04T18:00:00', value=4.0)]
    assert w.last_telemetry(rows) == {'S1': (-3.2, '2026-06-04T12:00:00')}


# ── bake: the cached windows into readings and the station table ─────────────

def station(code='S1', telemetry=2, lat=21.5, lon=86.9, **kw):
    return {'attributes': {'objectid': 1, 'station_id': None, 'station_code': code, 'station_name': code,
                           'lat': lat, 'long': lon, 'telemetry': telemetry, 'agency_name': 'CGWB',
                           'state_name': 'Odisha', 'district_name': 'Baleshwar', 'created_date': 1574640000000,
                           'remarks': None, **kw},
            'geometry': {'x': lon, 'y': lat}}


def cache_window(raw, combo, start, end, rows=None, status='full'):
    wdir = w.window_dir(raw, combo, start, end)
    wdir.mkdir(parents=True, exist_ok=True)
    if status == 'full':
        w._write_gz(wdir / 'page_00000.json.gz', {'statusCode': 200, 'data': rows} if rows else NO_DATA)
    pipeline.write_json(wdir / 'window.json', {'v': w.WINDOW_VERSION, 'status': status, 'pages': 1})


def test_gather_keeps_manual_rows_and_the_telemetry_week_and_names_heavy_groups(tmp_path):
    other = ('Odisha', 'Khordha', 'CGWB')
    cache_window(tmp_path, COMBO, '1900-01-01', '2018-12-31',
                 [reading(), reading(dtype='GGZ', mode='Telemetric'), reading(dtype='MSL', value=12.0)])
    cache_window(tmp_path, COMBO, '2023-01-01', '2023-12-31', status='heavy')
    cache_window(tmp_path, COMBO, '2023-05-25', '2023-05-25', [reading(when='2023-05-25T06:00:00')])
    cache_window(tmp_path, COMBO, *w.TELEMETRY_WINDOW,
                 [reading(dtype='GGZ', mode='Telemetric', when='2026-06-04T00:00:00', value=-3.0),
                  reading(dtype='MS4', mode='Telemetric', when='2026-06-04T00:00:00', value=280.0)])
    cache_window(tmp_path, other, '1900-01-01', '2018-12-31', [reading(code='S9', district='Khordha')])
    with (tmp_path / 'm.ndjson').open('w') as out:
        tele = []
        heavy = w.gather(tmp_path, [COMBO, other], out, tele)
    got = [json.loads(x) for x in (tmp_path / 'm.ndjson').read_text().splitlines()]
    assert heavy == {w.group_key(*COMBO)}
    assert sorted((r['stationCode'], r['datatypeCode'], r['dataTime']) for r in got) == [
        ('S1', 'HGZ', '2023-05-01T06:00:00'), ('S1', 'HGZ', '2023-05-25T06:00:00'),
        ('S1', 'MSL', '2023-05-01T06:00:00'), ('S9', 'HGZ', '2023-05-01T06:00:00')]
    assert list(got[0]) == list(w.READING_FIELDS)
    assert [(r['datatypeCode'], r['dataValue']) for r in tele] == [('GGZ', -3.0)]


def test_readings_are_distinct_typed_and_ordered_and_feed_the_summaries(tmp_path):
    src = tmp_path / 'm.ndjson'
    rows = [reading(when='2019-05-01T06:00:00', value=7.0), reading(when='2015-05-01T06:00:00', value=5.0),
            reading(when='2015-05-01T06:00:00', value=5.0), reading(code='S2', when='2020-11-01T06:00:00')]
    src.write_text(''.join(json.dumps({k: r[k] for k in w.READING_FIELDS}) + '\n' for r in rows))
    out = tmp_path / 'r.parquet'
    con = pipeline.make_con()
    assert w.build_readings(con, src, out) == 3
    types = dict(con.execute(f"SELECT column_name, column_type FROM (DESCRIBE SELECT * FROM '{out}')").fetchall())
    assert list(types) == list(w.READING_FIELDS)
    assert types['dataTime'] == 'TIMESTAMP' and types['dataValue'] == 'DOUBLE' and types['stationCode'] == 'VARCHAR'
    assert con.execute(f"SELECT stationCode, strftime(dataTime, '%Y') FROM '{out}'").fetchall() == \
        [('S1', '2015'), ('S1', '2019'), ('S2', '2020')]
    s = w.station_summaries(con, out)
    assert s['S1']['first_reading'] == '2015-05-01' and s['S1']['last_depth_m'] == 7.0
    assert s['S1']['n_readings'] == 2 and s['S2']['postmonsoon_year'] == 2020


def test_the_station_table_keeps_published_fields_then_adds_the_summaries(tmp_path):
    stations = [station(), station(code='S2', telemetry=1, lat=2.27, lon=86.6, district_name='Khordha')]
    summ = {'S1': w.summarise([reading(when='2015-05-01T06:00:00', value=5.0)])}
    out = tmp_path / 's.parquet'
    con = pipeline.make_con()
    n = w.build_station_table(con, stations, summ, {'S2': (-3.2, '2026-06-04T12:00:00')},
                              {w.group_key(*COMBO)}, out)
    assert n == 2
    cols = dict(con.execute(f"SELECT column_name, column_type FROM (DESCRIBE SELECT * FROM '{out}')").fetchall())
    assert list(cols) == [*stations[0]['attributes'], *w.SUMMARY_TYPES, 'geometry']
    assert cols['lat'] == 'DOUBLE' and cols['telemetry'] == 'BIGINT' and cols['station_id'] == 'VARCHAR'
    # ISO text, not DATE: GDAL's GeoJSON writer fails on dates before 1970 (readings start in 1931)
    assert cols['first_reading'] == 'VARCHAR' and cols['telemetry_last_at'] == 'TIMESTAMP'
    got = con.execute(f"""SELECT station_code, n_readings, first_reading, telemetry_last_value,
                                 series_complete, ST_X(geometry), ST_Y(geometry) FROM '{out}' ORDER BY 1""").fetchall()
    assert got == [('S1', 1, '2015-05-01', None, False, 86.9, 21.5),
                   ('S2', 0, None, -3.2, True, 86.6, 2.27)]       # the published point, even off India


# ── register ─────────────────────────────────────────────────────────────────

PULL = {'stations': 92973, 'groups': 1827, 'pulled_at': '2026-11-21T10:00:00+00:00'}
NAMES = {**{f: f'WRIS_Groundwater_Levels.0123abcd.{e}' for f, e in w.EXT.items()},
         'readings': 'WRIS_Groundwater_Manual_Readings.89abcdef.parquet'}
COUNTS = {'stations': 92973, 'with_readings': 60000, 'with_trend': 30000, 'with_telemetry_value': 20000,
          'series_complete': 40000, 'outside_india': 445, 'readings': 4000000}


def summary():
    return {'rows': 92973, 'counts': COUNTS, 'sizes': {f: 100 for f in NAMES}, 'names': NAMES, 'pull': PULL}


def test_the_entry_credits_india_wris_under_its_terms_and_links_the_readings():
    e = w.catalog_entry(summary(), {}, 'https://r2')
    assert e['id'] == 'wris_groundwater_levels' and e['rows'] == 92973 and e['licence'] == 'India-WRIS terms'
    assert e['attribution']['primary']['name'] == 'India-WRIS / CGWB and state ground water departments'
    assert e['parquet'] == {'url': 'https://r2/water/wris-groundwater-levels/WRIS_Groundwater_Levels.0123abcd.parquet',
                            'bytes': 100}
    assert 'readings' not in e
    assert 'https://r2/water/wris-groundwater-levels/WRIS_Groundwater_Manual_Readings.89abcdef.parquet' in e['notes']
    assert e['category'] == 'water' and e['fetched_at'] == PULL['pulled_at'] and e['refresh']['class'] == 'slow'
    assert e['source_check']['method'] == 'manual'
    for text in (e['notes'], w.description()):
        assert 'metres below ground level' in text and '—' not in text and 'catalog' not in text.lower()


def test_registering_twice_changes_nothing_and_keeps_the_reviewed_labels(tmp_path):
    cat, man, sm = tmp_path / 'catalog.json', tmp_path / 'manifest.json', tmp_path / 'summary.json'
    cat.write_text(json.dumps({'layers': [], 'level_meta': {}, 'level_order': [], 'attribution': {}}))
    man.write_text('[]')
    sm.write_text(json.dumps(summary()))
    w.register(cat, man, sm, 'https://r2')
    once = cat.read_text(), man.read_text()
    w.register(cat, man, sm, 'https://r2')
    assert (cat.read_text(), man.read_text()) == once
    c = json.loads(once[0])
    assert [x['id'] for x in c['layers']] == ['wris_groundwater_levels']
    import licence_watch
    assert licence_watch.labelled(c['layers'][0]) == c['layers'][0]
    assert licence_watch.terms_of('wris_groundwater_levels', licence_watch.load_registry())


def test_populate_scripts_agree_with_the_bake():
    import populate_refresh
    import populate_source_check
    e = w.catalog_entry(summary(), {}, 'https://r2')
    assert populate_refresh.infer(e)[0]['class'] == e['refresh']['class']
    assert populate_source_check.merge(e['source_check'], populate_source_check.infer(e, None)) == e['source_check']
