from datetime import datetime, timedelta, timezone

from app.models import Article, FeedItem
from app.relevance import ai_keyword_score, cluster_items, guess_category, is_ai_related, rank_score

NOW = datetime.now(timezone.utc)


def item(title, **extra):
    data = dict(
        id=title, url=f"https://x.com/{abs(hash(title))}", title=title, published_at=NOW,
        source_id="s", source_name="S", source_kind="news", source_weight=2,
    )
    data.update(extra)
    return FeedItem(**data)


def test_ai_filter():
    assert is_ai_related(item("Anthropic ships a new Claude model for coding"))
    assert is_ai_related(item("Why GPUs are scarce again", excerpt="Demand for training large language models keeps rising."))
    assert is_ai_related(item("EU opens probe into AI chatbots")), "uppercase AI counts"
    assert not is_ai_related(item("Ten gardening tips for autumn"))
    assert not is_ai_related(item("Thai airline adds flights to Dubai")), "'ai' inside words doesn't"
    assert ai_keyword_score("OpenAI raises $40B") > ai_keyword_score("Startup raises $40B")


def test_categories():
    assert guess_category("EU fines Meta under the AI Act for copyright violations", "", "news") == "policy"
    assert guess_category("Nvidia unveils Blackwell Ultra GPUs", "", "news") == "hardware"
    assert guess_category("Mistral raises $2 billion at $14B valuation", "", "news") == "business"
    assert guess_category("How attention really works", "", "analysis") == "explainer"


def test_clusters_same_story():
    clusters = cluster_items([
        item("OpenAI launches GPT-6 with 2M token context", source_id="a", source_weight=1),
        item("OpenAI launches GPT-6, its new flagship model with 2M context", source_id="b", source_weight=3),
        item("Google DeepMind unveils Gemini 4 robotics model", source_id="c"),
    ])
    assert len(clusters) == 2
    big = next(c for c in clusters if len(c) == 2)
    assert big[0].source_id == "b", "most trusted source leads"


def test_rank_prefers_fresh_important():
    def art(relevance, hours_old):
        return Article(
            id="x", url="u", title="t", published_at=NOW - timedelta(hours=hours_old), source_id="s",
            source_name="S", source_kind="news", headline="h", summary="s", category="models",
            relevance=relevance, briefed_at=NOW,
        )
    assert rank_score(art(8, 1), NOW) > rank_score(art(9, 72), NOW)
