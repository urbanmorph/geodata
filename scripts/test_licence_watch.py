"""licence_watch: each layer's licence as its publisher states it, recorded at ingest and checked again
on every re-extract and every weekly source check.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_licence_watch.py -q
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import licence_watch as lw  # noqa: E402
import pipeline  # noqa: E402

PAGE = """<html><head><script>var x = 1;</script><style>p{}</style></head><body>
<p>Page views: 75,720,962</p><h2>Key Conditions:</h2><p>All downloadable content can be used for
non-commercial purposes with proper attribution (&quot;Source: NRSC&quot;) and linking to www.nrsc.gov.in.</p>
<p>Last Updated: 18-11-2026</p></body></html>"""
NEW_PAGE = PAGE.replace('non-commercial purposes', 'any purpose')

TERMS = {'id': 'nrsc', 'url': 'https://nrsc.example/terms', 'kind': 'html',
         'start': 'Key Conditions', 'end': 'www.nrsc.gov.in', 'layers': ['bhuvan_x', 'bhuvan_y']}


def fetcher(body):
    return lambda url: body


# ── reading the licence text off a page ──────────────────────────────────────

def test_the_licence_text_is_the_slice_between_the_anchors_without_markup_or_page_noise():
    text = lw.extract(TERMS, PAGE)
    assert text == ('Key Conditions: All downloadable content can be used for non-commercial purposes with proper '
                    'attribution ("Source: NRSC") and linking to www.nrsc.gov.in')
    # a page-view counter or "last updated" outside the slice never changes the fingerprint
    noisy = PAGE.replace('75,720,962', '75,999,999').replace('18-11-2026', '20-11-2026')
    assert lw.fingerprint(lw.extract(TERMS, noisy)) == lw.fingerprint(text)


def test_a_json_licence_is_read_by_its_path():
    terms = {'id': 'ckan', 'kind': 'json', 'json_path': 'result.license_id'}
    assert lw.extract(terms, json.dumps({'result': {'license_id': 'cc-by'}})) == 'cc-by'
    gh = {'id': 'gh', 'kind': 'json', 'json_path': 'license.spdx_id'}
    assert lw.extract(gh, '{"license": {"spdx_id": "CC0-1.0"}}') == 'CC0-1.0'
    assert lw.extract({**gh, 'json_path': '$.license.spdx_id'}, '{"license": {"spdx_id": "MIT"}}') == 'MIT'


def test_a_missing_anchor_is_an_error_not_an_empty_licence():
    with pytest.raises(lw.LicenceTextMissing):
        lw.extract(TERMS, '<p>This page has moved.</p>')


# ── comparing with what was recorded at ingest ───────────────────────────────

def recorded(page=PAGE):
    return {**TERMS, 'sha256': lw.fingerprint(lw.extract(TERMS, page)), 'seen_at': '2026-11-20'}


def test_the_same_terms_are_unchanged_and_new_wording_is_a_change():
    assert lw.check(recorded(), fetcher(PAGE))['status'] == 'same'
    got = lw.check(recorded(), fetcher(NEW_PAGE))
    assert got['status'] == 'changed' and 'any purpose' in got['text']


def test_an_unreachable_page_or_lost_anchor_is_reported_not_passed():
    def down(url):
        raise OSError('timed out')
    assert lw.check(recorded(), down)['status'] == 'error'
    assert lw.check(recorded(), fetcher('<p>moved</p>'))['status'] == 'missing'


def test_terms_recorded_by_hand_are_not_fetched():
    manual = {'id': 'x', 'kind': 'manual', 'stated': 'emailed permission', 'seen_at': '2026-01-01', 'layers': ['a']}
    assert lw.check(manual, lambda url: pytest.fail('fetched'))['status'] == 'manual'


# ── the gate on every re-extract ─────────────────────────────────────────────

def registry(*entries):
    return {'terms': list(entries)}


def test_a_re_extract_passes_while_the_terms_are_as_recorded():
    assert [r['status'] for r in lw.require_unchanged('bhuvan_x', registry(recorded()), fetcher(PAGE))] == ['same']


def test_a_re_extract_stops_when_the_licence_changed_since_ingest():
    with pytest.raises(lw.LicenceChanged, match='nrsc'):
        lw.require_unchanged('bhuvan_x', registry(recorded()), fetcher(NEW_PAGE))


def test_a_layer_with_no_recorded_licence_cannot_be_registered():
    with pytest.raises(lw.LicenceNotRecorded, match='new_layer'):
        lw.require_unchanged('new_layer', registry(recorded()), fetcher(PAGE))


def test_unreachable_terms_stop_the_re_extract_unless_told_to_warn(monkeypatch):
    def down(url):
        raise OSError('timed out')
    with pytest.raises(lw.LicenceUnverified):
        lw.require_unchanged('bhuvan_x', registry(recorded()), down)
    monkeypatch.setenv('LICENCE_GATE', 'warn')
    assert lw.require_unchanged('bhuvan_x', registry(recorded()), down)[0]['status'] == 'error'


def test_registering_a_layer_runs_the_gate(monkeypatch):
    seen = []
    monkeypatch.setattr(pipeline, 'LICENCE_GATE', lambda layer_id: seen.append(layer_id))
    pipeline.upsert_layer({'layers': []}, {'id': 'bhuvan_x'}, {'label': 'x'})
    assert seen == ['bhuvan_x']


# ── accepting reviewed terms, and the weekly check ───────────────────────────

def test_accepting_records_the_new_fingerprint_and_date():
    reg = registry(recorded())
    lw.accept(reg, ['nrsc'], fetcher(NEW_PAGE), today='2026-12-01')
    t = reg['terms'][0]
    assert t['sha256'] == lw.fingerprint(lw.extract(TERMS, NEW_PAGE)) and t['seen_at'] == '2026-12-01'
    assert lw.check(t, fetcher(NEW_PAGE))['status'] == 'same'


def test_seeding_records_what_it_can_read_and_lists_what_it_could_not():
    reg = registry({**TERMS, 'id': 'a'}, {**TERMS, 'id': 'b', 'url': 'https://down.example/'})

    def get(url):
        if 'down' in url:
            raise OSError('refused')
        return PAGE
    done, failed = lw.seed(reg, get, today='2026-11-20')
    assert done == ['a'] and list(failed) == ['b'] and 'sha256' not in reg['terms'][1]


def test_the_weekly_section_lists_changed_terms_with_their_layers():
    results = lw.check_all(registry(recorded()), fetcher(NEW_PAGE))
    assert lw.summary(results) == {'licence_changed': ['nrsc'], 'licence_error': [], 'licence_checked': 1}
    md = lw.issue_section(results)
    assert '### Licence terms changed (1)' in md and 'bhuvan_x, bhuvan_y' in md and '--accept nrsc' in md


def test_no_change_says_so():
    md = lw.issue_section(lw.check_all(registry(recorded()), fetcher(PAGE)))
    assert 'No licence has changed' in md


# ── the labels a layer carries, decided by its reviewed terms ────────────────

NC_LABELS = {'licence': 'NRSC-Terms', 'non_commercial': True,
             'credit': {'name': 'NRSC, ISRO/DOS', 'url': 'https://www.nrsc.gov.in/'}}


def test_a_layer_takes_the_labels_its_reviewed_terms_set():
    reg = registry({**recorded(), 'labels': NC_LABELS}, {'id': 'compiler', 'kind': 'manual', 'layers': ['bhuvan_x']})
    assert lw.labels_of('bhuvan_x', reg) == NC_LABELS
    assert lw.labels_of('other', reg) == {}


def test_two_terms_that_disagree_on_a_label_are_an_error():
    reg = registry({**recorded(), 'labels': NC_LABELS},
                   {'id': 'b', 'kind': 'manual', 'layers': ['bhuvan_x'], 'labels': {'licence': 'CC0-1.0'}})
    with pytest.raises(ValueError, match='bhuvan_x'):
        lw.labels_of('bhuvan_x', reg)


def test_labelling_an_entry_sets_licence_flag_and_credit_and_keeps_the_compiler():
    entry = {'id': 'bhuvan_x', 'licence': 'CC0-1.0',
             'attribution': {'primary': {'name': 'Bhuvan', 'url': 'https://bhuvan'}, 'publisher': {'name': 'compiler'}}}
    out = lw.labelled(entry, registry({**recorded(), 'labels': NC_LABELS}))
    assert out['licence'] == 'NRSC-Terms' and out['non_commercial'] is True
    assert out['attribution'] == {'primary': NC_LABELS['credit'], 'publisher': {'name': 'compiler'}}
    assert entry['licence'] == 'CC0-1.0'   # the input is not changed
    assert lw.labelled(entry, registry(recorded())) == entry   # no labels, no change


def test_registering_a_layer_applies_its_labels(monkeypatch):
    monkeypatch.setattr(lw, 'load_registry', lambda: registry({**recorded(), 'labels': NC_LABELS}))
    cat = pipeline.upsert_layer({'layers': []}, {'id': 'bhuvan_x', 'licence': 'CC0-1.0'}, {'label': 'x'})
    assert cat['layers'][0]['licence'] == 'NRSC-Terms' and cat['layers'][0]['non_commercial'] is True


# ── the registry itself ──────────────────────────────────────────────────────

def test_every_layer_carries_the_labels_its_terms_set():
    reg = lw.load_registry()
    catalog = json.loads((HERE.parent / 'catalog.json').read_text())
    wrong = {}
    for lyr in catalog['layers']:
        want = lw.labelled(lyr, reg)
        if want != lyr:
            wrong[lyr['id']] = {k: (lyr.get(k), want.get(k)) for k in want if want.get(k) != lyr.get(k)}
    assert wrong == {}


def test_every_layer_has_its_licence_terms_recorded():
    reg = lw.load_registry()
    catalog = json.loads((HERE.parent / 'catalog.json').read_text())
    covered = {lid for t in reg['terms'] for lid in t['layers']}
    missing = [lyr['id'] for lyr in catalog['layers'] if not lyr['id'].startswith('c_') and lyr['id'] not in covered]
    assert missing == []


def test_every_recorded_term_has_a_baseline():
    for t in lw.load_registry()['terms']:
        assert t.get('seen_at') and t.get('stated'), t['id']
        if t['kind'] != 'manual':
            assert t.get('url') and t.get('sha256'), t['id']


def test_a_republished_layer_with_reviewed_terms_says_so_in_its_notes():
    import ingest_ramseraph as ir
    d = ir.republished('bhuvan_gw_prospects', 'n', 'water', 'Bhuvan', 'r/t', 'f', 'd', 'u', 'https://bhuvan',
                       'Bhuvan (NRSC, ISRO)', 'k', 'water/x')
    assert d.license == 'NRSC terms'
    assert 'CC0' not in d.notes and 'states no open licence' not in d.notes
    assert "the publisher's terms (NRSC terms, non-commercial only)" in d.notes
    fsi = next(x for x in ir.DATASETS if x.id == 'fsi_beats')   # no labels: the compiler's CC0 stands
    assert fsi.license == 'CC0-1.0' and 'CC0 1.0 from the compiler' in fsi.notes
