from pathlib import Path

from app.feeds import canonical_url, parse_feed, strip_html
from app.models import Source

FIXTURES = Path(__file__).parent / "fixtures"
SOURCE = Source(id="ex", name="Example", url="https://example.com/feed", kind="news", weight=2)


def test_parses_rss_with_media_and_tracking_params():
    items = parse_feed((FIXTURES / "rss.xml").read_text(), SOURCE)
    assert len(items) == 2
    item = items[0]
    assert item.title == "OpenAI releases GPT-6 with a 2M-token context window"
    assert item.url == "https://news.example.com/openai-gpt-6"
    assert item.image == "https://cdn.example.com/gpt6.jpg"
    assert item.author == "Jane Reporter"
    assert item.published_at.isoformat() == "2026-10-01T14:00:00+00:00"
    assert "two million tokens" in item.excerpt
    assert "today & via the API" in item.excerpt


def test_parses_atom_with_inline_image():
    (entry,) = parse_feed((FIXTURES / "atom.xml").read_text(), SOURCE)
    assert entry.url == "https://blog.example.com/moe"
    assert entry.image == "https://blog.example.com/moe.png"
    assert entry.author == "Sam Writer"
    assert entry.excerpt.startswith("Mixture-of-experts models route")


def test_canonical_url():
    assert canonical_url("https://a.com/x/?utm_campaign=1&id=3#top") == "https://a.com/x/?id=3"
    assert canonical_url("https://a.com/x/") == "https://a.com/x"


def test_strip_html():
    assert strip_html("<p>One <b>bold</b> line.</p><p>Two.</p>") == "One bold line.\nTwo."
    assert strip_html("<p>A &amp; B&#8217;s <b>C</b></p><script>x()</script>") == "A & B’s C"
