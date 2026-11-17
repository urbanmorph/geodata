"""Shared pipeline helpers (scripts/pipeline.py).

Run: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest scripts/test_pipeline.py -q
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import pipeline  # noqa: E402


def test_importing_the_library_creates_no_directories():
    # ingest_ramseraph made /tmp/ramseraph at import, so every script that
    # borrowed a helper from it made that directory too.
    code = ('import pathlib, sys; sys.path.insert(0, sys.argv[1])\n'
            'def boom(*a, **k): raise SystemExit("mkdir at import")\n'
            'pathlib.Path.mkdir = boom\n'
            'import pipeline, ingest_ramseraph, bake_formats, bake_extracts\n')
    r = subprocess.run([sys.executable, '-c', code, str(HERE)], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


def test_old_import_names_still_work():
    # Other scripts (and ingest scripts on other branches) import these from
    # ingest_ramseraph, bake_formats, bake_extracts and bake_mgnrega_districts.
    import bake_extracts
    import bake_formats
    import bake_mgnrega_districts
    import ingest_ramseraph as ir
    for name in ('BUCKET', 'R2_PUBLIC', 'CONTENT_TYPES', 'r2_client', 'r2_upload', 'file_md5',
                 'rebake_flatten_bbox', 'row_group_size_for', 'bake_whole_layer', 'WHOLE_LAYER_MAX_MB'):
        assert hasattr(ir, name), name
    assert bake_formats.atomic_output is pipeline.atomic_output
    assert bake_extracts.make_con is pipeline.make_con
    assert bake_mgnrega_districts.with_retries is pipeline.with_retries
    assert bake_mgnrega_districts.log is pipeline.log
