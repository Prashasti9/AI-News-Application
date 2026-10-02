"""Free story summaries: no AI API, no cost.

The summary is *extractive*: split the article into sentences, score each
one, and keep the best (in their original order) up to about 60 words.
The scoring follows the classic word-frequency method (Luhn, 1958): a
sentence matters if it contains the words the article keeps repeating. We
add bonuses for sharing words with the headline and for appearing early,
because news articles put the key facts first.
"""

import math
import re
from dataclasses import dataclass

from .relevance import CATEGORIES, ai_keyword_score, guess_category

STOP_WORDS = set(
    """a about above after again against all also am an and any are as at be because been before being below
    between both but by can could did do does doing down during each few for from further had has have having
    he her here hers him his how i if in into is it its itself just let me more most my no nor not now of off on
    once only or other our ours out over own same she should so some such than that the their theirs them then
    there these they this those through to too under until up very was we were what when where which while who
    whom why will with would you your yours said says say new one two like get got make made use used using may
    might many much well even still yet however per via according told""".split()
)

# Lines that are website furniture rather than reporting.
BOILERPLATE = re.compile(
    r"(subscribe|sign up|newsletter|cookie|all rights reserved|click here|read more|continue reading|"
    r"appeared first on|originally (appeared|published)|follow us|share this|image credit|photo:|"
    r"getty images|advertisement|sponsored|this story has been updated)",
    re.I,
)

# Abbreviations that end with a period but don't end a sentence.
ABBREVIATION = re.compile(r"\b(?:Mr|Mrs|Ms|Dr|Prof|Inc|Ltd|Corp|Co|Jr|Sr|St|vs|etc|e\.g|i\.e|U\.S|U\.K|No|Fig|approx)\.$", re.I)
# Sentence end: . ! or ? (plus an optional closing quote/bracket), then a space,
# then something that starts a sentence. The group keeps the punctuation.
SENTENCE_END = re.compile(r"([.!?][\"”’)]?)\s+(?=[\"“‘(]?[A-Z0-9])")


def split_sentences(text: str) -> list[str]:
    sentences = []
    for paragraph in (text or "").split("\n"):
        buffer = ""
        parts = SENTENCE_END.split(paragraph)
        # split() alternates text and captured punctuation: [text, ".", text, "?", text]
        pieces = [parts[i] + (parts[i + 1] if i + 1 < len(parts) else "") for i in range(0, len(parts), 2)]
        for piece in pieces:
            buffer = f"{buffer} {piece}" if buffer else piece
            if not ABBREVIATION.search(buffer.strip()):
                sentences.append(buffer.strip())
                buffer = ""
        if buffer.strip():
            sentences.append(buffer.strip())
    return [s for s in sentences if s]


def _stem(word: str) -> str:
    """Very rough stemming so 'model' and 'models' count as one word."""
    return re.sub(r"(ing|ed|es|s)$", "", word) or word


def content_words(text: str) -> list[str]:
    words = re.findall(r"[a-z0-9][a-z0-9.+-]*[a-z0-9]|[a-z0-9]", re.sub(r"[’']s\b", "", text.lower()))
    return [_stem(w) for w in words if w not in STOP_WORDS and len(w) > 2]


@dataclass
class ScoredSentence:
    text: str
    index: int
    score: float

    @property
    def words(self) -> int:
        return len(self.text.split())


def score_sentences(title: str, body: str) -> list[ScoredSentence]:
    sentences = [s for s in split_sentences(body) if 6 <= len(s.split()) <= 60 and not BOILERPLATE.search(s)]

    frequency: dict[str, int] = {}
    for sentence in sentences:
        for word in content_words(sentence):
            frequency[word] = frequency.get(word, 0) + 1
    max_frequency = max(frequency.values(), default=1)
    title_words = set(content_words(title))

    scored = []
    for i, text in enumerate(sentences):
        words = content_words(text)
        # How many of the article's key words this sentence contains.
        density = sum(frequency.get(w, 0) / max_frequency for w in words) / math.sqrt(max(len(words), 1))
        # How much it overlaps with the headline.
        title_overlap = sum(1 for w in words if w in title_words) / max(len(title_words), 1)
        position = 1.5 if i == 0 else 0.8 if i < 3 else 0.3 if i < 6 else 0.0
        has_number = 0.3 if re.search(r"\d", text) else 0.0  # specifics: prices, sizes, dates
        is_question = -0.8 if text.endswith("?") else 0.0
        scored.append(ScoredSentence(text, i, density + title_overlap * 2 + position + has_number + is_question))
    return scored


def trim_words(text: str, limit: int) -> str:
    words = text.split()
    if len(words) <= limit:
        return text
    return " ".join(words[:limit]).rstrip(",;:") + "…"


def summarize(title: str, body: str, max_words: int = 60) -> tuple[str, list[str]]:
    """Returns (summary of ~60 words, up to 3 extra key points)."""
    scored = score_sentences(title, body)
    if not scored:
        return trim_words(body or title, max_words), []

    ranked = sorted(scored, key=lambda s: s.score, reverse=True)
    chosen: list[ScoredSentence] = []
    count = 0
    for sentence in ranked:
        if count + sentence.words > max_words + 8:  # a little slack for whole sentences
            continue
        chosen.append(sentence)
        count += sentence.words
        if count >= max_words - 12:
            break
    if not chosen:
        chosen = [ranked[0]]
    chosen.sort(key=lambda s: s.index)  # read in the original order
    summary = trim_words(" ".join(s.text for s in chosen), max_words + 8)

    key_points: list[str] = []
    if len(scored) >= 6:
        used = {s.index for s in chosen}
        extras = sorted([s for s in ranked if s.index not in used][:3], key=lambda s: s.index)
        key_points = [trim_words(s.text, 32) for s in extras]
    return summary, key_points


TAGS = [
    ("openai", r"\bopenai\b"), ("anthropic", r"\banthropic\b"), ("google", r"\bgoogle\b"), ("deepmind", r"\bdeepmind\b"),
    ("meta", r"\bmeta\b"), ("microsoft", r"\bmicrosoft\b"), ("nvidia", r"\bnvidia\b"), ("apple", r"\bapple\b"),
    ("amazon", r"\b(amazon|aws)\b"), ("xai", r"\bxai\b"), ("mistral", r"\bmistral\b"), ("deepseek", r"\bdeepseek\b"),
    ("alibaba", r"\b(alibaba|qwen)\b"), ("hugging face", r"\bhugging ?face\b"), ("perplexity", r"\bperplexity\b"),
    ("chatgpt", r"\bchatgpt\b"), ("gpt", r"\bgpt-?\d"), ("claude", r"\bclaude\b"), ("gemini", r"\bgemini\b"),
    ("llama", r"\bllama\b"), ("grok", r"\bgrok\b"), ("agents", r"\bagent(s|ic)?\b"), ("open source", r"\bopen[- ](source|weights?)\b"),
    ("robotics", r"\brobot(s|ics)?\b"), ("regulation", r"\b(regulat\w+|ai act|law)\b"), ("chips", r"\b(chips?|gpus?|semiconductor)\b"),
    ("funding", r"\b(raises?|funding|valuation)\b"), ("research", r"\b(paper|arxiv|researchers)\b"),
]


def extract_tags(title: str, body: str) -> list[str]:
    haystack = f"{title} {body[:3000]}"
    return [tag for tag, pattern in TAGS if re.search(pattern, haystack, re.I)][:5]


# Headlines that signal real news rather than commentary.
NEWSWORTHY = re.compile(
    r"\b(launch\w*|releas\w*|announc\w*|unveil\w*|introduc\w*|acquir\w*|raises?|billion|lawsuit|sues?|ban\w*|"
    r"open[- ]sources?|open[- ]weights?|partners?\w*|breakthrough|record|first)\b",
    re.I,
)
# Low-value content common on Medium and SEO blogs.
LOW_QUALITY = re.compile(
    r"\b(top \d+|\d+ (ways|tips|tools|prompts|reasons|things|ai tools)|you need to know|ultimate guide|make money|"
    r"passive income|side hustle|how i (made|built|earned)|beginner'?s guide|cheat ?sheet|must[- ]know|"
    r"game[- ]changer|mind[- ]blowing)\b",
    re.I,
)


def relevance_score(title: str, body: str, source_weight: int, source_kind: str, coverage: int) -> int:
    """0-10 importance, built only from free signals."""
    score = (
        ai_keyword_score(title, body) * 0.35  # about AI at all? (0-3.5)
        + source_weight * 0.9  # how much we trust the source (0.9-2.7)
        + min(3.0, math.log2(1 + coverage) * 1.5)  # other outlets covering it (0-3)
        + (1 if NEWSWORTHY.search(title) else 0)
        + (0.5 if len(body.split()) > 300 else 0)
    )
    if LOW_QUALITY.search(title):
        score -= 3
    if source_kind == "medium":
        score -= 1
    return max(0, min(10, round(score)))


def clean_headline(title: str, source_name: str = "") -> str:
    """Drop ' - The Verge' / ' | WIRED' style suffixes naming the source."""
    title = re.sub(r"\s+", " ", title).strip()
    first_word = source_name.split(" ")[0].lower() if source_name else ""
    match = re.search(r"\s+[|–—-]\s+([^|–—-]{2,40})$", title)
    if match and first_word and first_word in match.group(1).lower():
        title = title[: match.start()]
    return title if len(title) <= 110 else title[:107].strip() + "…"


@dataclass
class Brief:
    is_ai_news: bool
    relevance: int
    breaking: bool
    category: str
    headline: str
    summary: str
    key_points: list[str]
    tags: list[str]


def write_brief(title: str, body: str, source_name: str, source_weight: int, source_kind: str, coverage: int) -> Brief:
    """Build the card and deep-dive content for one story."""
    summary, key_points = summarize(title, body)
    relevance = relevance_score(title, body, source_weight, source_kind, coverage)
    category = guess_category(title, body, source_kind)
    return Brief(
        is_ai_news=ai_keyword_score(title, body) >= 3,
        relevance=relevance,
        # Breaking = several independent outlets on one story, and it scores high.
        breaking=coverage >= 2 and relevance >= 8,
        category=category if category in CATEGORIES else "products",
        headline=clean_headline(title, source_name),
        summary=summary,
        key_points=key_points,
        tags=extract_tags(title, body),
    )
