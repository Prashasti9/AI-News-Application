"""Deciding what counts as AI news: is this about AI at all, which topic is
it, which stories are duplicates, and how should the feed be ranked."""

import math
import re
from datetime import datetime, timezone

from .models import Article, FeedItem

CATEGORIES = {
    "models": "Models",
    "research": "Research",
    "products": "Products",
    "business": "Business",
    "policy": "Policy & Safety",
    "open-source": "Open Source",
    "hardware": "Chips & Compute",
    "explainer": "Explainers",
}

# (pattern, weight). A match in the headline counts double.
AI_TERMS = [
    (re.compile(r"\b(artificial intelligence|machine learning|deep learning|neural net(work)?s?|generative ai|gen ?ai)\b", re.I), 3),
    (re.compile(r"\b(llms?|large language models?|foundation models?|frontier models?|language models?|multimodal|diffusion models?|transformers?)\b", re.I), 3),
    (re.compile(r"\b(chatgpt|gpt-?\d[\w.]*|openai|anthropic|claude|gemini|deepmind|llama|mistral|deepseek|qwen|grok|xai|copilot|midjourney|stable diffusion|perplexity|hugging ?face|sora|veo)\b", re.I), 3),
    # Case-sensitive on purpose: "AI" as a word, not "ai" inside other text.
    (re.compile(r"\bAI\b|\bA\.I\."), 2),
    (re.compile(r"\b(agents?|agentic|reasoning models?|fine-?tun\w*|rlhf|reinforcement learning|inference|embeddings?|rag|retrieval-augmented|tokens?|benchmarks?|evals?|alignment|interpretability|context window|prompt\w*)\b", re.I), 1),
    (re.compile(r"\b(gpus?|tpus?|nvidia|h100|h200|b200|blackwell|accelerators?|data ?cent(er|re)s?)\b", re.I), 1),
]


def ai_keyword_score(title: str, excerpt: str = "") -> int:
    """0-10: how much a headline and text are about AI."""
    score = 0
    for pattern, weight in AI_TERMS:
        if pattern.search(title):
            score += weight * 2
        elif pattern.search(excerpt[:1500]):
            score += weight
    return min(10, score)


def is_ai_related(item: FeedItem) -> bool:
    return ai_keyword_score(item.title, item.excerpt) >= 3


CATEGORY_RULES = [
    ("policy", re.compile(r"\b(regulat\w*|law|lawsuit|sued|court|congress|senate|eu ai act|policy|government|ban\w*|copyright|safety|alignment|risk|ethic\w*|deepfakes?|election|privacy|military)\b", re.I)),
    ("hardware", re.compile(r"\b(chips?|gpus?|tpus?|nvidia|amd|tsmc|semiconductor\w*|data ?cent(er|re)s?|compute|blackwell|h100|h200|power grid|energy)\b", re.I)),
    ("business", re.compile(r"\b(raises?|funding|valuation|acquir\w*|acquisition|ipo|revenue|layoffs?|hires?|ceo|investors?|deal|partnership|billion|startup)\b", re.I)),
    ("open-source", re.compile(r"\b(open[- ]source|open[- ]weights?|github|hugging ?face|apache 2\.0|mit license|released the weights|ollama|llama\.cpp)\b", re.I)),
    ("research", re.compile(r"\b(paper|arxiv|study|researchers?|benchmark|dataset|novel method|we propose|state[- ]of[- ]the[- ]art|sota)\b", re.I)),
    ("models", re.compile(r"\b(gpt-?\d|claude|gemini|llama|mistral|deepseek|qwen|model release|new model|launches? .*model|reasoning model)\b", re.I)),
    ("products", re.compile(r"\b(launch\w*|rolls? out|feature|app|available|update|announc\w*|introduc\w*|ships?)\b", re.I)),
]

EXPLAINER = re.compile(r"\b(how|why|what|guide|explained|understanding|intro\w*|deep dive|lessons)\b", re.I)


def guess_category(title: str, text: str, source_kind: str) -> str:
    """Pick a topic: rules are checked against the headline first, then the text."""
    if source_kind in ("analysis", "medium") and EXPLAINER.search(title):
        return "explainer"
    for category, pattern in CATEGORY_RULES:
        if pattern.search(title):
            return category
    for category, pattern in CATEGORY_RULES:
        if pattern.search(f"{title} {text[:600]}"):
            return category
    return "explainer" if source_kind == "analysis" else "products"


STOP_WORDS = set(
    "a an the and or but of for to in on at by with from as is are was were be been it its this that these "
    "those how why what when who new says say said will can could may might has have had not no just more than "
    "about into over after before up out you your we our their they he she his her i via vs report reports".split()
)


def title_tokens(title: str) -> set[str]:
    text = re.sub(r"[’']s\b", "", title.lower())
    text = re.sub(r"[^a-z0-9.+\- ]", " ", text)
    return {w for w in text.split() if len(w) > 1 and w not in STOP_WORDS}


def similarity(a: set[str], b: set[str]) -> float:
    """Overlap coefficient: shared words / size of the smaller set.
    Robust when one outlet's headline is much longer than another's."""
    if not a or not b:
        return 0.0
    return len(a & b) / min(len(a), len(b))


def cluster_items(items: list[FeedItem], threshold: float = 0.6) -> list[list[FeedItem]]:
    """Group items describing the same story (published within 72h of each
    other). Each group starts with its most trusted source."""
    ordered = sorted(items, key=lambda i: (-i.source_weight, i.published_at))
    clusters: list[dict] = []
    for item in ordered:
        tokens = title_tokens(item.title)
        match = None
        if len(tokens) >= 3:
            for cluster in clusters:
                close_in_time = abs((cluster["time"] - item.published_at).total_seconds()) < 72 * 3600
                if close_in_time and any(
                    other.url == item.url or similarity(title_tokens(other.title), tokens) >= threshold
                    for other in cluster["items"]
                ):
                    match = cluster
                    break
        if match:
            match["items"].append(item)
        else:
            clusters.append({"time": item.published_at, "items": [item]})
    return [c["items"] for c in clusters]


def hours_since(when: datetime, now: datetime | None = None) -> float:
    now = now or datetime.now(timezone.utc)
    return max(0.0, (now - when).total_seconds() / 3600)


def pre_score(item: FeedItem, coverage: int = 1) -> float:
    """Cheap priority score: decides which new stories get read in full first."""
    freshness = max(0.0, 1 - hours_since(item.published_at) / 72)
    return ai_keyword_score(item.title, item.excerpt) * 0.4 + item.source_weight * 1.5 + math.log2(coverage) * 2 + freshness * 3


def rank_score(article: Article, now: datetime | None = None) -> float:
    """Ranking for the Top tab: importance divided by age (like Hacker News),
    so a big story from yesterday can still beat a small one from an hour ago."""
    importance = article.relevance + math.log2(1 + len(article.coverage)) * 1.5 + article.source_weight * 0.5
    return importance / (hours_since(article.published_at, now) + 2) ** 0.8
