"""Data shapes used across the app.

Pydantic models validate data and convert it to/from JSON. The phone app's
JavaScript uses camelCase names (sourceName, publishedAt), while Python uses
snake_case (source_name, published_at). `alias_generator=to_camel` gives each
field a camelCase alias, so Python code and JSON can each use their own style.
"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    def to_json(self) -> dict:
        """Plain dict with camelCase keys, ready for json.dumps or the API."""
        return self.model_dump(mode="json", by_alias=True)


class Source(BaseModel):
    """One RSS/Atom feed we read."""

    id: str
    name: str
    url: str
    kind: str  # lab | news | analysis | community | medium
    weight: int = 1  # 1-3: how much we trust the source's judgement
    filter: bool = False  # True if the feed isn't AI-only (keyword check needed)


class FeedItem(CamelModel):
    """A raw entry from a feed, before we summarise it."""

    id: str
    url: str
    title: str
    excerpt: str = ""
    image: str = ""
    author: str = ""
    published_at: datetime
    source_id: str
    source_name: str
    source_kind: str
    source_weight: int = 1


class Coverage(CamelModel):
    """Another outlet's article about the same story."""

    source_name: str
    url: str
    title: str


class Article(CamelModel):
    """A published story card."""

    id: str
    url: str
    title: str
    author: str = ""
    image: str = ""
    published_at: datetime
    source_id: str
    source_name: str
    source_kind: str
    source_weight: int = 1
    coverage: list[Coverage] = []

    headline: str
    summary: str
    key_points: list[str] = []
    tags: list[str] = []
    category: str
    relevance: int  # 0-10
    breaking: bool = False
    is_ai_news: bool = True
    briefed_at: datetime

    # Set when the story is part of a daily edition.
    edition: str | None = None  # local date, e.g. "2026-10-02"
    edition_rank: int | None = None  # 1 = most important
