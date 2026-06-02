"""Lock the airtight guarantee: a full `build_catalog.py` rebuild must NOT
drop community layers.

Community submissions are baked straight into catalog.json by
bake_community.py (id `c_<id>`, provenance:'community'); build_catalog.py
never reconstructs them from its curated sources. The only thing that keeps
them alive across a rebuild is carry_forward_unbuilt -- so we pin it here.
A future refactor that breaks this fails loudly instead of silently
nuking every community contribution.

Run: python3 -m pytest scripts/test_build_catalog_community.py -v"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts'))


def test_carry_forward_preserves_community_entries() -> None:
    import build_catalog
    built = [{'id': 'lgd_states', 'provenance': 'curated'}]
    prev = {
        'lgd_states': {'id': 'lgd_states', 'provenance': 'curated'},
        'c_nL7zNStsW3': {'id': 'c_nL7zNStsW3', 'provenance': 'community', 'rows': 779},
    }
    out = build_catalog.carry_forward_unbuilt(built, prev)
    ids = [l['id'] for l in out]
    assert 'c_nL7zNStsW3' in ids, 'community entry was dropped by a full rebuild'
    assert ids.count('lgd_states') == 1, 'a freshly-built layer must not be duplicated'
    # The carried-forward entry is the prev one, verbatim.
    community = next(l for l in out if l['id'] == 'c_nL7zNStsW3')
    assert community['rows'] == 779


def test_carry_forward_does_not_clobber_rebuilt_layers() -> None:
    import build_catalog
    built = [{'id': 'lgd_states', 'provenance': 'curated', 'rows': 36}]
    prev = {'lgd_states': {'id': 'lgd_states', 'provenance': 'curated', 'rows': 999}}
    out = build_catalog.carry_forward_unbuilt(built, prev)
    # The fresh build wins for ids it produced; prev is only a fallback.
    assert [l['rows'] for l in out if l['id'] == 'lgd_states'] == [36]
