"""The owner's list of layer requests.

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_list_layer_requests.py -q
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import list_layer_requests as lr  # noqa: E402


def test_each_request_shows_its_reference_status_email_credit_and_what():
    rows = [{'id': 'req_abcdefghij', 'created_at': '2026-11-28T09:00:00Z', 'status': 'new', 'email': 'a@b.in',
             'credit_name': '', 'what': 'Anganwadi centres', 'place': 'Pune', 'source': '', 'query': 'anganwadi'}]
    out = lr.table(rows)
    assert 'req_abcdefghij' in out and '[new]' in out and 'a@b.in' in out and '(anonymous)' in out
    assert 'what: Anganwadi centres' in out and 'place: Pune' in out and 'source:' not in out


def test_no_requests_says_so():
    assert lr.table([]) == 'No requests.'
