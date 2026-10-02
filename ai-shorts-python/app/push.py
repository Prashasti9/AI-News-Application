"""Phone notifications with Web Push.

How it works:
1. When you tap "Turn on notifications", the phone's browser creates a
   *subscription*: a private URL at Google's or Apple's push service plus
   encryption keys. The app sends it to POST /api/subscribe and we save it.
2. To notify you, we encrypt a small JSON message with those keys and POST
   it to that URL, signed with our VAPID key so the push service knows it's
   really us. pywebpush does the encryption and signing.
3. The service worker (static/sw.js) on the phone receives the message and
   shows the notification, even when the app is closed.
"""

import asyncio
import base64
import json
import logging
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from pywebpush import WebPushException, webpush

from .config import settings
from .models import Article
from .store import load_subscriptions, save_subscriptions, store

log = logging.getLogger(__name__)

LEVELS = {
    "breaking": {"label": "Breaking only", "min_relevance": 9, "default_max": 3},
    "top": {"label": "Top stories", "min_relevance": 8, "default_max": 6},
    "all": {"label": "Every important story", "min_relevance": 7, "default_max": 12},
}

DEFAULT_PREFS = {
    "level": "top",
    "topics": [],  # empty = every topic
    "maxPerDay": 6,
    "quietStart": 22,  # local hour, inclusive
    "quietEnd": 7,  # local hour, exclusive
    "timezone": "UTC",
}

_vapid = {"public": "", "private": ""}


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def generate_vapid_keys() -> tuple[str, str]:
    """A new P-256 key pair in the format browsers expect (base64url)."""
    key = ec.generate_private_key(ec.SECP256R1())
    private = key.private_numbers().private_value.to_bytes(32, "big")
    public = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return _b64url(public), _b64url(private)


def init_push() -> str:
    """Load VAPID keys from settings, else from storage, else create them."""
    public, private = settings.vapid_public_key, settings.vapid_private_key
    if not (public and private):
        saved = store.get("vapid")
        if saved:
            public, private = saved["publicKey"], saved["privateKey"]
        else:
            public, private = generate_vapid_keys()
            store.set("vapid", {"publicKey": public, "privateKey": private})
            log.info("generated VAPID keys and saved them to storage; set VAPID_* to pin them")
    _vapid.update(public=public, private=private)
    return public


def vapid_public_key() -> str:
    return _vapid["public"]


# ---- Who gets what ----------------------------------------------------------


def local_hour(when: datetime, tz: str) -> int:
    try:
        return when.astimezone(ZoneInfo(tz)).hour
    except Exception:  # unknown timezone name
        return when.astimezone(timezone.utc).hour


def in_quiet_hours(prefs: dict, now: datetime) -> bool:
    start, end = prefs.get("quietStart"), prefs.get("quietEnd")
    if start is None or end is None or start == end:
        return False
    hour = local_hour(now, prefs.get("timezone", "UTC"))
    # e.g. 22 -> 7 wraps past midnight
    return start <= hour < end if start < end else hour >= start or hour < end


def select_for_subscriber(sub: dict, candidates: list[Article], now: datetime | None = None) -> list[Article]:
    """Continuous mode: which of the new stories this phone should hear about."""
    now = now or datetime.now(timezone.utc)
    prefs = {**DEFAULT_PREFS, **sub.get("prefs", {})}
    if prefs["level"] == "off":
        return []
    level = LEVELS.get(prefs["level"], LEVELS["top"])

    day_ago = now - timedelta(days=1)
    sent_log = sub.get("sentLog", [])
    sent_today = [e for e in sent_log if datetime.fromisoformat(e["at"]) > day_ago]
    remaining = prefs["maxPerDay"] - len(sent_today)
    if remaining <= 0:
        return []

    already_sent = {e["id"] for e in sent_log}
    quiet = in_quiet_hours(prefs, now)
    picked = [
        a
        for a in candidates
        if a.id not in already_sent
        and (a.relevance >= level["min_relevance"] or (a.breaking and a.relevance >= 8))
        and (not prefs["topics"] or a.category in prefs["topics"])
        # During quiet hours only truly breaking news gets through.
        and (not quiet or (a.breaking and a.relevance >= 9))
    ]
    picked.sort(key=lambda a: a.relevance, reverse=True)
    return picked[: min(remaining, 2)]


def _short(text: str, limit: int = 180) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def payload_for(stories: list[Article]) -> dict:
    """The notification for continuous mode: one story, or a digest."""
    if len(stories) == 1:
        a = stories[0]
        return {
            "title": f"Breaking: {a.headline}" if a.breaking else a.headline,
            "body": _short(a.summary),
            "url": f"/?story={a.id}",
            "image": a.image or None,
            "tag": f"story-{a.id}",
        }
    return {
        "title": f"{len(stories)} important AI stories",
        "body": "\n".join(f"• {a.headline}" for a in stories),
        "url": f"/?story={stories[0].id}",
        "image": stories[0].image or None,
        "tag": "digest",
    }


def edition_payload(stories: list[Article]) -> dict:
    """The once-a-day notification listing the edition's headlines."""
    noun = "story" if len(stories) == 1 else "stories"
    return {
        "title": f"Your {len(stories)} AI {noun} for today",
        "body": "\n".join(f"• {a.headline}" for a in stories),
        "url": f"/?story={stories[0].id}",
        "image": next((a.image for a in stories if a.image), None),
        "tag": f"edition-{stories[0].edition or 'today'}",
    }


# ---- Sending ------------------------------------------------------------------


class SubscriptionGone(Exception):
    """The phone unsubscribed or uninstalled the app."""


def _send_sync(sub: dict, payload: dict) -> None:
    try:
        webpush(
            subscription_info={"endpoint": sub["endpoint"], "keys": sub["keys"]},
            data=json.dumps(payload),
            vapid_private_key=_vapid["private"],
            vapid_claims={"sub": settings.vapid_subject},
            ttl=6 * 3600,
            headers={"Urgency": "high"},
        )
    except WebPushException as exc:
        status = exc.response.status_code if exc.response is not None else None
        if status in (404, 410):
            raise SubscriptionGone() from exc
        raise


async def send_to(sub: dict, payload: dict) -> None:
    # pywebpush is blocking, so run it in a thread to keep the server responsive.
    await asyncio.to_thread(_send_sync, sub, payload)


async def notify_subscribers(new_articles: list[Article]) -> dict:
    """Continuous mode: alert each phone about the new stories it cares about."""
    if not new_articles:
        return {"sent": 0, "removed": 0}
    sent: dict[str, list[dict]] = {}
    gone: set[str] = set()
    for sub in load_subscriptions():
        selected = select_for_subscriber(sub, new_articles)
        if not selected:
            continue
        try:
            await send_to(sub, payload_for(selected))
            at = datetime.now(timezone.utc).isoformat()
            sent[sub["endpoint"]] = [{"id": a.id, "at": at} for a in selected]
        except SubscriptionGone:
            gone.add(sub["endpoint"])
        except Exception as exc:
            log.warning("push failed: %s", exc)

    # Re-read, so phones that subscribed while we were sending aren't lost.
    updated = []
    for sub in load_subscriptions():
        if sub["endpoint"] in gone:
            continue
        if sub["endpoint"] in sent:
            sub["sentLog"] = (sub.get("sentLog", []) + sent[sub["endpoint"]])[-100:]
        updated.append(sub)
    save_subscriptions(updated)
    return {"sent": len(sent), "removed": len(gone)}


async def notify_edition(stories: list[Article]) -> dict:
    """Daily-edition mode: one notification per phone listing the stories."""
    if not stories:
        return {"sent": 0, "removed": 0}
    sent, gone = 0, set()
    for sub in load_subscriptions():
        prefs = {**DEFAULT_PREFS, **sub.get("prefs", {})}
        if prefs["level"] == "off":
            continue
        mine = [a for a in stories if not prefs["topics"] or a.category in prefs["topics"]]
        if not mine:
            continue
        try:
            await send_to(sub, edition_payload(mine))
            sent += 1
        except SubscriptionGone:
            gone.add(sub["endpoint"])
        except Exception as exc:
            log.warning("push failed: %s", exc)
    if gone:
        save_subscriptions([s for s in load_subscriptions() if s["endpoint"] not in gone])
    log.info("edition sent to %d phone(s)", sent)
    return {"sent": sent, "removed": len(gone)}
