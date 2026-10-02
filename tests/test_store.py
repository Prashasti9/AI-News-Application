import os

import pytest

from app.config import settings
from app.store import Store, load_subscriptions, store, upsert_subscription


def test_copies_protect_the_cache():
    store.set("last-edition", {"date": "2026-10-02"})
    copy = store.get("last-edition")
    copy["date"] = "changed"
    assert store.get("last-edition") == {"date": "2026-10-02"}


def test_files_persist_across_restarts():
    store.set("last-edition", {"date": "2026-10-02"})
    upsert_subscription("https://push.example/1", {"p256dh": "p", "auth": "a"}, {"level": "top"})
    upsert_subscription("https://push.example/1", {"p256dh": "p", "auth": "a"}, {"level": "off"})  # update, not add
    fresh = Store()
    fresh.init()
    assert fresh.get("last-edition") == {"date": "2026-10-02"}
    assert len(fresh.get("subscriptions")) == 1
    assert load_subscriptions()[0]["prefs"] == {"level": "off"}


@pytest.mark.skipif(not os.environ.get("TEST_DATABASE_URL"), reason="set TEST_DATABASE_URL to test Postgres")
def test_postgres_persists_across_restarts(monkeypatch):
    monkeypatch.setattr(settings, "database_url", os.environ["TEST_DATABASE_URL"])
    first = Store()
    first.init()
    first.set("last-edition", {"date": "2026-10-02"})
    first.close()
    second = Store()
    second.init()
    assert second.get("last-edition") == {"date": "2026-10-02"}
    second.close()
