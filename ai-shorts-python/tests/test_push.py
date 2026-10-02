from datetime import datetime, timedelta, timezone

from app.models import Article
from app.push import edition_payload, generate_vapid_keys, in_quiet_hours, payload_for, select_for_subscriber

NOON = datetime(2026, 10, 1, 12, tzinfo=timezone.utc)


def art(id, relevance, **extra):
    data = dict(
        id=id, url=f"https://x/{id}", title=id, published_at=NOON, source_id="s", source_name="S",
        source_kind="news", headline=f"H{id}", summary="S", category="models", relevance=relevance, briefed_at=NOON,
    )
    data.update(extra)
    return Article(**data)


def test_level_threshold_and_per_run_cap():
    sub = {"prefs": {"level": "top", "timezone": "UTC", "maxPerDay": 6, "topics": []}, "sentLog": []}
    picked = select_for_subscriber(sub, [art("a", 6), art("b", 8), art("c", 9), art("d", 10)], NOON)
    assert [a.id for a in picked] == ["d", "c"]


def test_topics_already_sent_and_daily_cap():
    sub = {
        "prefs": {"level": "all", "topics": ["policy"], "maxPerDay": 2, "quietStart": 0, "quietEnd": 0},
        "sentLog": [{"id": "p1", "at": (NOON - timedelta(hours=1)).isoformat()}],
    }
    stories = [art("p1", 9, category="policy"), art("p2", 8, category="policy"), art("m", 10)]
    assert [a.id for a in select_for_subscriber(sub, stories, NOON)] == ["p2"]
    sub["sentLog"].append({"id": "p2", "at": NOON.isoformat()})
    assert select_for_subscriber(sub, [art("p3", 10, category="policy")], NOON) == []


def test_quiet_hours_use_subscriber_timezone():
    prefs = {"level": "all", "timezone": "Asia/Kolkata", "quietStart": 22, "quietEnd": 7, "maxPerDay": 10, "topics": []}
    assert not in_quiet_hours(prefs, NOON)  # 17:30 in India
    late = datetime(2026, 10, 1, 17, tzinfo=timezone.utc)  # 22:30 in India
    assert in_quiet_hours(prefs, late)
    picked = select_for_subscriber({"prefs": prefs}, [art("x", 8), art("y", 9, breaking=True)], late)
    assert [a.id for a in picked] == ["y"]


def test_off_and_payloads():
    assert select_for_subscriber({"prefs": {"level": "off"}}, [art("a", 10)], NOON) == []
    digest = payload_for([art("a", 9), art("b", 8)])
    assert digest["title"] == "2 important AI stories" and digest["url"] == "/?story=a"
    edition = edition_payload([art("x", 9, headline="One", edition="2026-10-02"), art("y", 8, headline="Two")])
    assert edition["title"] == "Your 2 AI stories for today"
    assert edition["body"] == "• One\n• Two"
    assert edition["tag"] == "edition-2026-10-02"


def test_vapid_keys_have_browser_format():
    public, private = generate_vapid_keys()
    assert len(public) == 87 and len(private) == 43  # 65 and 32 bytes, base64url
