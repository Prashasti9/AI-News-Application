"""The curated list of feeds the app reads.

kind:
  lab       - first-party announcements from AI labs
  news      - reporting from AI desks of major outlets
  analysis  - expert newsletters and blogs (the deeper reading)
  community - what practitioners are upvoting
  medium    - Medium tag feeds; high volume, so the quality penalty applies

weight (1-3) is how much we trust the source. filter=True means the feed
isn't AI-only, so each item must pass the AI keyword check.
"""

import json

from .config import settings
from .models import Source

DEFAULT_SOURCES = [
    # AI labs
    Source(id="openai", name="OpenAI", url="https://openai.com/news/rss.xml", kind="lab", weight=3),
    Source(id="deepmind", name="Google DeepMind", url="https://deepmind.google/blog/rss.xml", kind="lab", weight=3),
    Source(id="google-ai", name="Google AI", url="https://blog.google/technology/ai/rss/", kind="lab", weight=2),
    Source(id="google-research", name="Google Research", url="https://research.google/blog/rss/", kind="lab", weight=2),
    Source(id="msr", name="Microsoft Research", url="https://www.microsoft.com/en-us/research/feed/", kind="lab", weight=2, filter=True),
    Source(id="nvidia", name="NVIDIA", url="https://blogs.nvidia.com/feed/", kind="lab", weight=2, filter=True),
    Source(id="huggingface", name="Hugging Face", url="https://huggingface.co/blog/feed.xml", kind="lab", weight=2),
    Source(id="bair", name="Berkeley AI Research", url="https://bair.berkeley.edu/blog/feed.xml", kind="lab", weight=2),
    Source(id="aws-ml", name="AWS Machine Learning", url="https://aws.amazon.com/blogs/machine-learning/feed/", kind="lab", weight=1),
    # News desks
    Source(id="mit-tr", name="MIT Technology Review", url="https://www.technologyreview.com/topic/artificial-intelligence/feed", kind="news", weight=3),
    Source(id="verge", name="The Verge", url="https://www.theverge.com/rss/ai-artificial-intelligence/index.xml", kind="news", weight=2),
    Source(id="techcrunch", name="TechCrunch", url="https://techcrunch.com/category/artificial-intelligence/feed/", kind="news", weight=2),
    Source(id="venturebeat", name="VentureBeat", url="https://venturebeat.com/category/ai/feed/", kind="news", weight=2),
    Source(id="ars", name="Ars Technica", url="https://arstechnica.com/ai/feed/", kind="news", weight=2),
    Source(id="wired", name="WIRED", url="https://www.wired.com/feed/tag/ai/latest/rss", kind="news", weight=2),
    Source(id="decoder", name="The Decoder", url="https://the-decoder.com/feed/", kind="news", weight=2),
    Source(id="marktechpost", name="MarkTechPost", url="https://www.marktechpost.com/feed/", kind="news", weight=1),
    # Expert analysis
    Source(id="importai", name="Import AI", url="https://importai.substack.com/feed", kind="analysis", weight=3),
    Source(id="simonw", name="Simon Willison", url="https://simonwillison.net/atom/everything/", kind="analysis", weight=3, filter=True),
    Source(id="interconnects", name="Interconnects", url="https://www.interconnects.ai/feed", kind="analysis", weight=3),
    Source(id="latent-space", name="Latent Space", url="https://www.latent.space/feed", kind="analysis", weight=2),
    Source(id="raschka", name="Ahead of AI", url="https://magazine.sebastianraschka.com/feed", kind="analysis", weight=3),
    Source(id="mollick", name="One Useful Thing", url="https://www.oneusefulthing.org/feed", kind="analysis", weight=2),
    Source(id="gradient", name="The Gradient", url="https://thegradient.pub/rss/", kind="analysis", weight=2),
    Source(id="lilianweng", name="Lil'Log", url="https://lilianweng.github.io/index.xml", kind="analysis", weight=3),
    Source(id="huyenchip", name="Chip Huyen", url="https://huyenchip.com/feed.xml", kind="analysis", weight=2),
    Source(id="tds", name="Towards Data Science", url="https://towardsdatascience.com/feed", kind="analysis", weight=1, filter=True),
    # Community + Medium
    Source(id="hn", name="Hacker News", url="https://hnrss.org/newest?q=AI+OR+LLM+OR+OpenAI+OR+Anthropic+OR+Gemini+OR+GPT&points=150", kind="community", weight=2, filter=True),
    Source(id="medium-ai", name="Medium", url="https://medium.com/feed/tag/artificial-intelligence", kind="medium", weight=1, filter=True),
    Source(id="medium-llm", name="Medium", url="https://medium.com/feed/tag/large-language-models", kind="medium", weight=1, filter=True),
    Source(id="medium-ml", name="Medium", url="https://medium.com/feed/tag/machine-learning", kind="medium", weight=1, filter=True),
]


def load_sources() -> list[Source]:
    """data/sources.json, if present, replaces the default list."""
    path = settings.data_dir / "sources.json"
    try:
        items = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(items, list) and items:
            return [Source(**s) for s in items]
    except (OSError, ValueError):
        pass
    return DEFAULT_SOURCES
