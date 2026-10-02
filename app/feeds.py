"""Downloading and parsing RSS/Atom feeds and article pages.

- httpx downloads pages asynchronously, so 30 feeds are fetched in parallel
  instead of one after another.
- feedparser understands every RSS and Atom flavour and hands back entries
  as dictionaries.
- BeautifulSoup turns HTML into plain text and finds <meta> tags.
"""

import asyncio
import hashlib
import logging
import re
import time
from calendar import timegm
from datetime import datetime, timezone
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import feedparser
import httpx
from bs4 import BeautifulSoup

from .models import FeedItem, Source

log = logging.getLogger(__name__)

USER_AGENT = "AI-Shorts/1.0 (+https://github.com/prashasti9/ai-news-application)"
TRACKING_PARAM = re.compile(r"^(utm_|ref$|source$|guccounter|fbclid|gclid|mc_)", re.I)
JUNK_IMAGE = re.compile(r"stat|pixel|feedburner|gravatar", re.I)


def strip_html(html: str) -> str:
    """HTML -> plain text, keeping paragraph breaks as newlines."""
    if not html:
        return ""
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "figure", "figcaption"]):
        tag.decompose()
    # Line breaks only after block elements; inline tags like <b> stay inline.
    for tag in soup(["p", "br", "li", "div", "h1", "h2", "h3", "h4", "blockquote", "tr"]):
        tag.insert_after("\n")
    text = soup.get_text()
    text = re.sub(r"[ \t\f\v\xa0]+", " ", text)
    text = re.sub(r"\s*\n\s*", "\n", text)
    return text.strip()


def canonical_url(url: str) -> str:
    """Drop tracking parameters, #fragments and trailing slashes so the same
    story linked from two feeds gets the same URL."""
    try:
        parts = urlsplit(url)
        query = urlencode([(k, v) for k, v in parse_qsl(parts.query) if not TRACKING_PARAM.match(k)])
        return urlunsplit((parts.scheme, parts.netloc, parts.path, query, "")).rstrip("/")
    except ValueError:
        return url


def article_id(url: str) -> str:
    """Short stable id derived from the URL."""
    return hashlib.sha1(canonical_url(url).encode()).hexdigest()[:16]


def _published(entry) -> datetime:
    # feedparser gives dates as UTC time.struct_time in *_parsed fields.
    for key in ("published_parsed", "updated_parsed", "created_parsed"):
        value = entry.get(key)
        if value:
            return datetime.fromtimestamp(timegm(value), tz=timezone.utc)
    return datetime.now(timezone.utc)


def _image(entry, html: str) -> str:
    candidates = []
    for media in entry.get("media_content", []):
        if media.get("medium") != "video":
            candidates.append(media.get("url"))
    candidates += [m.get("url") for m in entry.get("media_thumbnail", [])]
    candidates += [
        link.get("href")
        for link in entry.get("links", [])
        if link.get("rel") == "enclosure" and str(link.get("type", "")).startswith("image")
    ]
    if html:
        img = BeautifulSoup(html, "html.parser").find("img", src=True)
        if img:
            candidates.append(img["src"])
    for url in candidates:
        if url and url.startswith("http") and not JUNK_IMAGE.search(url):
            return url
    return ""


def parse_feed(text: str | bytes, source: Source) -> list[FeedItem]:
    """Turn a feed document into FeedItems."""
    parsed = feedparser.parse(text)
    items = []
    for entry in parsed.entries:
        url = canonical_url(entry.get("link") or entry.get("id") or "")
        title = re.sub(r"\s+", " ", strip_html(entry.get("title", "")))
        if not url or not title:
            continue
        content = entry.get("content") or []
        html = (content[0].get("value") if content else "") or entry.get("summary", "")
        items.append(
            FeedItem(
                id=article_id(url),
                url=url,
                title=title,
                excerpt=strip_html(html)[:6000],
                image=_image(entry, html),
                author=strip_html(entry.get("author", "")),
                published_at=_published(entry),
                source_id=source.id,
                source_name=source.name,
                source_kind=source.kind,
                source_weight=source.weight,
            )
        )
    return items


async def fetch_text(client: httpx.AsyncClient, url: str, timeout: float = 15.0) -> str:
    response = await client.get(url, timeout=timeout)
    response.raise_for_status()
    return response.text


def new_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        headers={"user-agent": USER_AGENT},
        follow_redirects=True,
        limits=httpx.Limits(max_connections=8),
    )


async def fetch_all(sources: list[Source]) -> tuple[list[FeedItem], list[dict]]:
    """Fetch every source in parallel. A broken feed is logged and skipped."""
    errors: list[dict] = []

    async def one(client: httpx.AsyncClient, source: Source) -> list[FeedItem]:
        try:
            return parse_feed(await fetch_text(client, source.url), source)
        except Exception as exc:  # network errors, HTTP errors, bad XML...
            errors.append({"source": source.id, "error": str(exc)[:200]})
            return []

    started = time.monotonic()
    async with new_client() as client:
        results = await asyncio.gather(*(one(client, s) for s in sources))
    if errors:
        log.warning("%d source(s) failed: %s", len(errors), ", ".join(e["source"] for e in errors))
    log.info("fetched %d feeds in %.1fs", len(sources), time.monotonic() - started)
    return [item for batch in results for item in batch], errors


async def fetch_article_details(client: httpx.AsyncClient, url: str) -> dict:
    """Best effort: the article's main image and body text.
    Paywalled or JavaScript-only pages simply return nothing."""
    try:
        html = await fetch_text(client, url, timeout=10.0)
    except Exception:
        return {"image": "", "description": "", "text": ""}
    soup = BeautifulSoup(html, "html.parser")

    def meta(name: str) -> str:
        tag = soup.find("meta", attrs={"property": name}) or soup.find("meta", attrs={"name": name})
        return tag.get("content", "").strip() if tag else ""

    body = soup.find("article") or soup
    paragraphs = [p.get_text(" ", strip=True) for p in body.find_all("p")]
    text = "\n".join(p for p in paragraphs if len(p.split()) > 8)
    return {
        "image": meta("og:image") or meta("twitter:image"),
        "description": meta("og:description") or meta("description"),
        "text": text[:12000],
    }


# Some feeds have a description that is only a URL; Beautiful Soup warns
# that it looks like a filename. Harmless, so hide it.
import warnings
from bs4 import MarkupResemblesLocatorWarning

warnings.filterwarnings("ignore", category=MarkupResemblesLocatorWarning)
