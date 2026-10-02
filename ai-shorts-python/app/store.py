"""Key-value storage for the whole app.

Each key ("articles", "subscriptions", "seen", "vapid", ...) holds one JSON
document. Reads come from an in-memory copy (fast). Every write updates the
copy and is saved immediately to one of two backends:

- JSON files in DATA_DIR: the default, ideal for local development.
- A Postgres table, when DATABASE_URL is set. Needed on free hosts such as
  Render's free plan, whose disk is wiped on every restart.

At this app's size (hundreds of stories, a few phones) storing whole
documents is simpler than designing tables, and fast enough.
"""

import copy
import json
import logging
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .config import settings
from .models import Article

log = logging.getLogger(__name__)


class FileBackend:
    name = "files"

    def __init__(self, folder: Path):
        self.folder = folder
        self.folder.mkdir(parents=True, exist_ok=True)

    def load_all(self) -> dict[str, Any]:
        data = {}
        for path in self.folder.glob("*.json"):
            if path.name == "sources.json":  # that's config, not app state
                continue
            try:
                data[path.stem] = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                log.warning("skipping unreadable %s", path)
        return data

    def write(self, key: str, value: Any) -> None:
        path = self.folder / f"{key}.json"
        # Write a temp file, then rename: a crash never leaves half a file.
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(value), encoding="utf-8")
        tmp.replace(path)

    def close(self) -> None:
        pass


class PostgresBackend:
    name = "postgres"

    def __init__(self, url: str):
        import psycopg  # imported here so file-only setups don't need it

        self._psycopg = psycopg
        self.url = url
        self.conn = None

    def _connection(self):
        if self.conn is None or self.conn.closed:
            self.conn = self._psycopg.connect(self.url, autocommit=True)
        return self.conn

    def _execute(self, sql: str, params: tuple = ()):
        # Free databases (e.g. Neon) drop idle connections, so retry once.
        for attempt in (1, 2):
            try:
                with self._connection().cursor() as cur:
                    cur.execute(sql, params)
                    return cur.fetchall() if cur.description else None
            except self._psycopg.OperationalError:
                self.conn = None
                if attempt == 2:
                    raise

    def load_all(self) -> dict[str, Any]:
        self._execute(
            """CREATE TABLE IF NOT EXISTS app_kv (
                   key text PRIMARY KEY,
                   value jsonb NOT NULL,
                   updated_at timestamptz NOT NULL DEFAULT now()
               )"""
        )
        rows = self._execute("SELECT key, value FROM app_kv")
        return {key: value for key, value in rows}

    def write(self, key: str, value: Any) -> None:
        self._execute(
            """INSERT INTO app_kv (key, value, updated_at) VALUES (%s, %s, now())
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()""",
            (key, json.dumps(value)),
        )

    def close(self) -> None:
        if self.conn is not None:
            self.conn.close()


class Store:
    def __init__(self):
        self._cache: dict[str, Any] = {}
        self._backend = None
        self._lock = threading.Lock()  # endpoints can run in parallel threads

    def init(self) -> None:
        """Connect and load everything into memory. Call once at startup."""
        if settings.database_url:
            self._backend = PostgresBackend(settings.database_url)
        else:
            self._backend = FileBackend(settings.data_dir)
        self._cache = self._backend.load_all()
        log.info("storage: %s, loaded %d key(s)", self._backend.name, len(self._cache))

    def close(self) -> None:
        if self._backend:
            self._backend.close()

    def get(self, key: str, default: Any = None) -> Any:
        # Hand out a copy so callers can't change cached data without saving.
        with self._lock:
            return copy.deepcopy(self._cache[key]) if key in self._cache else default

    def set(self, key: str, value: Any) -> None:
        if self._backend is None:
            raise RuntimeError("store not initialised: call store.init() first")
        with self._lock:
            self._cache[key] = copy.deepcopy(value)
            self._backend.write(key, value)


store = Store()


# ---- Helpers for each kind of data ------------------------------------------


def load_articles() -> list[Article]:
    return [Article.model_validate(a) for a in store.get("articles", [])]


def save_articles(articles: list[Article]) -> list[Article]:
    """Save, dropping stories older than MAX_AGE_DAYS and keeping the newest MAX_ARTICLES."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=settings.max_age_days)
    kept = sorted((a for a in articles if a.published_at >= cutoff), key=lambda a: a.published_at, reverse=True)
    kept = kept[: settings.max_articles]
    store.set("articles", [a.to_json() for a in kept])
    return kept


def load_seen() -> dict[str, float]:
    """URLs already processed (url -> unix time), so we never redo work."""
    return store.get("seen", {})


def save_seen(seen: dict[str, float]) -> None:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=settings.max_age_days + 7)).timestamp()
    store.set("seen", {url: t for url, t in seen.items() if t >= cutoff})


def load_subscriptions() -> list[dict]:
    return store.get("subscriptions", [])


def save_subscriptions(subs: list[dict]) -> None:
    store.set("subscriptions", subs)


def upsert_subscription(endpoint: str, keys: dict, prefs: dict) -> dict:
    """Add a phone, or update its preferences if it's already subscribed."""
    now = datetime.now(timezone.utc).isoformat()
    subs = load_subscriptions()
    for sub in subs:
        if sub["endpoint"] == endpoint:
            sub.update(keys=keys, prefs=prefs, updatedAt=now)
            break
    else:
        sub = {"endpoint": endpoint, "keys": keys, "prefs": prefs, "createdAt": now, "sentLog": []}
        subs.append(sub)
    save_subscriptions(subs)
    return sub


def remove_subscription(endpoint: str) -> bool:
    subs = load_subscriptions()
    remaining = [s for s in subs if s["endpoint"] != endpoint]
    save_subscriptions(remaining)
    return len(remaining) != len(subs)
