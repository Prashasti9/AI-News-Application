"""API tests using FastAPI's TestClient (no real server or network needed)."""

from datetime import datetime, timezone

from fastapi.testclient import TestClient

from app.main import app
from app.models import Article
from app.store import load_subscriptions, save_articles

NOW = datetime.now(timezone.utc)


def story(id, relevance, **extra):
    data = dict(
        id=id, url=f"https://x/{id}", title=id, published_at=NOW, source_id="s", source_name="S", source_kind="news",
        headline=f"Headline {id}", summary="Summary", category="models", relevance=relevance, briefed_at=NOW,
    )
    data.update(extra)
    return Article(**data)


def test_news_tabs_and_camel_case_json():
    with TestClient(app) as client:
        save_articles([
            story("a", 9, edition="2026-10-02", edition_rank=1),
            story("b", 6, category="policy"),
            story("c", 7, edition="2026-10-01", edition_rank=1),
        ])
        today = client.get("/api/news", params={"tab": "today"}).json()
        assert [a["id"] for a in today["items"]] == ["a"]
        assert today["items"][0]["sourceName"] == "S" and "editionRank" in today["items"][0]
        assert [a["id"] for a in client.get("/api/news", params={"tab": "policy"}).json()["items"]] == ["b"]
        assert client.get("/api/news/a").json()["headline"] == "Headline a"
        assert client.get("/api/news/missing").status_code == 404


def test_meta_has_vapid_key_and_edition():
    with TestClient(app) as client:
        meta = client.get("/api/meta").json()
        assert len(meta["vapidPublicKey"]) == 87
        assert meta["edition"]["perDay"] == 5
        assert "policy" in meta["categories"]


def test_subscribe_validates_and_cleans_prefs():
    with TestClient(app) as client:
        bad = client.post("/api/subscribe", json={"subscription": {"endpoint": "http://insecure", "keys": {"p256dh": "p", "auth": "a"}}})
        assert bad.status_code == 422
        ok = client.post(
            "/api/subscribe",
            json={
                "subscription": {"endpoint": "https://push.example/1", "keys": {"p256dh": "p", "auth": "a"}},
                "prefs": {"level": "breaking", "topics": ["policy", "nonsense"], "timezone": "Mars/Base"},
            },
        )
        assert ok.status_code == 200
        prefs = ok.json()["prefs"]
        assert prefs["topics"] == ["policy"] and prefs["timezone"] == "UTC"
        assert len(load_subscriptions()) == 1
        assert client.post("/api/unsubscribe", json={"endpoint": "https://push.example/1"}).json() == {"ok": True}
        assert load_subscriptions() == []


def test_admin_refresh_needs_token():
    with TestClient(app) as client:
        assert client.post("/api/refresh").status_code == 401


def test_serves_phone_app():
    with TestClient(app) as client:
        assert "AI Shorts" in client.get("/").text
        assert client.get("/sw.js").headers["cache-control"] == "no-cache"
