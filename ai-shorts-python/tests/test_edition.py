from datetime import datetime, timezone

from app.models import Article
from app.pipeline import is_edition_due, local_date_hour, pick_edition


def test_local_date_hour_uses_timezone():
    when = datetime(2026, 10, 1, 20, tzinfo=timezone.utc)  # 01:30 next day in India
    assert local_date_hour(when, "Asia/Kolkata") == ("2026-10-02", 1)
    assert local_date_hour(when, "UTC") == ("2026-10-01", 20)


def test_edition_due_once_per_day_after_hour():
    before = datetime(2026, 10, 2, 2, tzinfo=timezone.utc)  # 07:30 IST
    after = datetime(2026, 10, 2, 3, tzinfo=timezone.utc)  # 08:30 IST
    assert not is_edition_due(before, "Asia/Kolkata", 8, "2026-10-01")
    assert is_edition_due(after, "Asia/Kolkata", 8, "2026-10-01")
    assert not is_edition_due(after, "Asia/Kolkata", 8, "2026-10-02")
    assert is_edition_due(after, "Asia/Kolkata", 8, None)


def test_pick_edition_keeps_top_n():
    now = datetime.now(timezone.utc)

    def b(id, relevance, coverage=0, ai=True):
        return Article(
            id=id, url=id, title=id, published_at=now, source_id="s", source_name="S", source_kind="news",
            headline=id, summary="s", category="models", relevance=relevance, is_ai_news=ai, briefed_at=now,
            coverage=[{"source_name": "o", "url": f"u{i}", "title": "t"} for i in range(coverage)],
        )

    briefs = [b("a", 6), b("b", 9), b("c", 8, coverage=2), b("d", 8), b("e", 10, ai=False), b("f", 4), b("g", 7), b("h", 7)]
    assert [a.id for a in pick_edition(briefs, 5, 5)] == ["b", "c", "d", "g", "h"]
