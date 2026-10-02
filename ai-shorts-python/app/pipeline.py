"""The news pipeline: feeds in, published stories and notifications out.

    fetch feeds -> keep AI stories -> merge duplicates -> rank cheaply
      -> read the top candidates in full -> summarise + score
      -> publish (daily edition: only the top N) -> notify phones

Two modes:
- Daily edition (STORIES_PER_DAY > 0): once a day after EDITION_HOUR.
- Continuous (STORIES_PER_DAY = 0): every REFRESH_MINUTES.
"""

import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from .config import settings
from .feeds import fetch_all, fetch_article_details, new_client
from .models import Article, Coverage, FeedItem
from .push import notify_edition, notify_subscribers
from .relevance import cluster_items, is_ai_related, pre_score, similarity, title_tokens
from .sources import load_sources
from .store import load_articles, load_seen, save_articles, save_seen, store
from .summarize import write_brief

log = logging.getLogger(__name__)

FIRST_RUN_WINDOW_HOURS = 48  # how far back to look when there's no history
NOTIFY_WINDOW_HOURS = 12  # continuous mode: don't alert about old news

# Only one pipeline run at a time (the scheduler and an admin call could overlap).
_run_lock = asyncio.Lock()


def absorb_duplicates(existing: list[Article], items: list[FeedItem]) -> tuple[list[FeedItem], bool]:
    """New items about an already-published story are added to that story's
    "also covered by" list instead of becoming a new card."""
    fresh, changed = [], False
    known_urls = {a.url for a in existing}
    existing_tokens = [(a, title_tokens(a.title)) for a in existing]
    for item in items:
        if item.url in known_urls:
            continue
        tokens = title_tokens(item.title)
        match = None
        if len(tokens) >= 3:
            for article, a_tokens in existing_tokens:
                close = abs((article.published_at - item.published_at).total_seconds()) < 72 * 3600
                if close and similarity(a_tokens, tokens) >= 0.6:
                    match = article
                    break
        if match is None:
            fresh.append(item)
        elif match.source_id != item.source_id and all(c.url != item.url for c in match.coverage):
            match.coverage.append(Coverage(source_name=item.source_name, url=item.url, title=item.title))
            changed = True
    return fresh, changed


async def gather_clusters(window_hours: float) -> dict:
    """Fetch feeds and return new story clusters, best first."""
    sources = load_sources()
    items, errors = await fetch_all(sources)
    filtered_sources = {s.id for s in sources if s.filter}
    existing = load_articles()
    seen = load_seen()
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=window_hours)

    candidates = [
        item
        for item in items
        if item.url not in seen
        and cutoff <= item.published_at <= now + timedelta(hours=1)
        and (item.source_id not in filtered_sources or is_ai_related(item))
    ]
    fresh, changed = absorb_duplicates(existing, candidates)
    clusters = cluster_items(fresh)
    clusters.sort(key=lambda c: pre_score(c[0], len({i.source_id for i in c})), reverse=True)
    return {
        "sources": sources,
        "items": items,
        "errors": errors,
        "existing": existing,
        "seen": seen,
        "candidates": candidates,
        "clusters": clusters,
        "changed": changed,
    }


async def brief_cluster(client, cluster: list[FeedItem]) -> Article:
    """Read the lead article in full and turn the cluster into a story card."""
    primary, related = cluster[0], cluster[1:]
    body, image = primary.excerpt, primary.image
    if len(body) < 1500 or not image:
        details = await fetch_article_details(client, primary.url)
        if len(details["text"]) > len(body):
            body = details["text"]
        if not body:
            body = details["description"]
        image = image or details["image"] or next((r.image for r in related if r.image), "")

    coverage = [
        Coverage(source_name=r.source_name, url=r.url, title=r.title) for r in related if r.source_id != primary.source_id
    ]
    brief = write_brief(primary.title, body, primary.source_name, primary.source_weight, primary.source_kind, len(coverage))
    return Article(
        id=primary.id,
        url=primary.url,
        title=primary.title,
        author=primary.author,
        image=image,
        published_at=primary.published_at,
        source_id=primary.source_id,
        source_name=primary.source_name,
        source_kind=primary.source_kind,
        source_weight=primary.source_weight,
        coverage=coverage,
        headline=brief.headline,
        summary=brief.summary,
        key_points=brief.key_points,
        tags=brief.tags,
        category=brief.category,
        relevance=brief.relevance,
        breaking=brief.breaking,
        is_ai_news=brief.is_ai_news,
        briefed_at=datetime.now(timezone.utc),
    )


async def brief_all(clusters: list[list[FeedItem]]) -> list[Article]:
    async with new_client() as client:
        semaphore = asyncio.Semaphore(4)  # at most 4 article pages at once

        async def one(cluster):
            async with semaphore:
                return await brief_cluster(client, cluster)

        return await asyncio.gather(*(one(c) for c in clusters))


def mark_seen(seen: dict[str, float], clusters: list[list[FeedItem]]) -> None:
    now = time.time()
    for cluster in clusters:
        for item in cluster:
            seen[item.url] = now
    save_seen(seen)


# ---- Continuous mode ----------------------------------------------------------


async def refresh() -> dict:
    async with _run_lock:
        started = time.monotonic()
        window = settings.max_age_days * 24 if load_articles() else FIRST_RUN_WINDOW_HOURS
        g = await gather_clusters(window)
        clusters = g["clusters"][: settings.max_summaries_per_run]
        briefed = await brief_all(clusters)
        mark_seen(g["seen"], clusters)

        accepted = [a for a in briefed if a.is_ai_news and a.relevance >= settings.min_relevance]
        total = len(g["existing"])
        if accepted or g["changed"]:
            total = len(save_articles(accepted + g["existing"]))

        notify_after = datetime.now(timezone.utc) - timedelta(hours=NOTIFY_WINDOW_HOURS)
        push = await notify_subscribers([a for a in accepted if a.published_at >= notify_after])

        stats = {
            "mode": "continuous",
            "at": datetime.now(timezone.utc).isoformat(),
            "seconds": round(time.monotonic() - started, 1),
            "sources": len(g["sources"]),
            "sourceErrors": g["errors"],
            "fetched": len(g["items"]),
            "candidates": len(g["candidates"]),
            "briefed": len(briefed),
            "accepted": len(accepted),
            "total": total,
            "push": push,
        }
        store.set("last-refresh", stats)
        log.info("refresh: %d new, %d published", len(g["candidates"]), len(accepted))
        return stats


# ---- Daily edition ----------------------------------------------------------------


def local_date_hour(now: datetime, tz: str) -> tuple[str, int]:
    """Calendar date (YYYY-MM-DD) and hour in the edition's timezone."""
    local = now.astimezone(ZoneInfo(tz))
    return local.strftime("%Y-%m-%d"), local.hour


def is_edition_due(now: datetime, tz: str, hour: int, last_date: str | None) -> bool:
    """True once per local day, after the edition hour."""
    today, current_hour = local_date_hour(now, tz)
    return current_hour >= hour and last_date != today


def pick_edition(briefs: list[Article], count: int, min_relevance: int) -> list[Article]:
    """The day's stories: most important first; wider coverage, then a more
    trusted source, break ties."""
    good = [a for a in briefs if a.is_ai_news and a.relevance >= min_relevance]
    good.sort(key=lambda a: (a.relevance, len(a.coverage), a.source_weight), reverse=True)
    return good[:count]


async def run_edition() -> dict:
    async with _run_lock:
        started = time.monotonic()
        edition_date, _ = local_date_hour(datetime.now(timezone.utc), settings.edition_timezone)
        last = store.get("last-edition")
        # Cover everything since the previous edition (at most 2 days back).
        if last and last.get("at"):
            since = datetime.now(timezone.utc) - datetime.fromisoformat(last["at"])
            window = min(48.0, since.total_seconds() / 3600 + 1)
        else:
            window = 24.0

        g = await gather_clusters(window)
        shortlist = g["clusters"][: settings.shortlist_size]
        briefed = await brief_all(shortlist)
        mark_seen(g["seen"], shortlist)

        picked = pick_edition(briefed, settings.stories_per_day, settings.min_relevance)
        for rank, article in enumerate(picked, start=1):
            article.edition, article.edition_rank = edition_date, rank
        total = len(g["existing"])
        if picked or g["changed"]:
            total = len(save_articles(picked + g["existing"]))
        push = await notify_edition(picked)

        stats = {
            "mode": "edition",
            "edition": edition_date,
            "at": datetime.now(timezone.utc).isoformat(),
            "seconds": round(time.monotonic() - started, 1),
            "sources": len(g["sources"]),
            "sourceErrors": g["errors"],
            "fetched": len(g["items"]),
            "candidates": len(g["candidates"]),
            "briefed": len(briefed),
            "accepted": len(picked),
            "total": total,
            "push": push,
        }
        store.set("last-edition", {"date": edition_date, "at": stats["at"]})
        store.set("last-refresh", stats)
        log.info("edition %s: reviewed %d, published %d", edition_date, len(briefed), len(picked))
        return stats


async def run_edition_if_due(force: bool = False) -> dict | None:
    last = store.get("last-edition") or {}
    due = is_edition_due(datetime.now(timezone.utc), settings.edition_timezone, settings.edition_hour, last.get("date"))
    return await run_edition() if (force or due) else None


async def run_scheduled() -> None:
    """Called by the scheduler: do whatever the current mode needs."""
    if settings.edition_mode:
        await run_edition_if_due()
    else:
        await refresh()
