"""Shared test setup for scripts/: uploads take the host-wide upload lock, so a
test points it at its own tmp folder (never waits on a real job's lock)."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pipeline  # noqa: E402


@pytest.fixture(autouse=True)
def _private_upload_lock(tmp_path_factory, monkeypatch):
    monkeypatch.setattr(pipeline, 'UPLOAD_LOCK', tmp_path_factory.mktemp('lock') / 'upload.lock')
