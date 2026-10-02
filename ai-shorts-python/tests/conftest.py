"""Shared test setup: every test gets its own empty data folder, and the
background scheduler is switched off."""

import pytest

from app.config import settings
from app.store import store


@pytest.fixture(autouse=True)
def isolated_settings(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(settings, "database_url", "")
    monkeypatch.setattr(settings, "scheduler_enabled", False)
    store.init()
    yield
    store.close()
