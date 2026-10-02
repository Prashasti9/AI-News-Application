from app.summarize import clean_headline, extract_tags, relevance_score, split_sentences, summarize, write_brief

ARTICLE = (
    "OpenAI on Tuesday released GPT-6, a large language model that can read up to two million tokens at once. "
    "The company said the model is available to paying ChatGPT users and through its API starting today. "
    "Subscribe to our newsletter for more stories like this. "
    "GPT-6 scores 20 points higher than GPT-5 on the SWE-bench coding benchmark, according to OpenAI. "
    "Prices for the API are 40% lower than for the previous model. "
    "Analysts said the release puts pressure on Google and Anthropic, which launched rival models this summer. "
    "The model was trained on Nvidia Blackwell GPUs in data centers in Texas. "
    "OpenAI did not disclose the size of the model. "
    "Some researchers questioned whether benchmark gains translate into real-world reliability."
)


def test_split_sentences_handles_abbreviations_and_quotes():
    text = 'Dr. Smith joined OpenAI Inc. last year. She said "it works." Is it working?'
    assert split_sentences(text) == ["Dr. Smith joined OpenAI Inc. last year.", 'She said "it works."', "Is it working?"]


def test_summary_length_lead_and_no_boilerplate():
    summary, key_points = summarize("OpenAI releases GPT-6 with a 2M-token context window", ARTICLE)
    words = len(summary.split())
    assert 35 <= words <= 68, words
    assert summary.startswith("OpenAI on Tuesday released GPT-6")
    assert "newsletter" not in summary.lower()
    assert len(key_points) == 3
    assert all(point not in summary for point in key_points)


def test_short_text_still_summarised():
    assert summarize("Title", "Only one short line.")[0] == "Only one short line."


def test_tags():
    tags = extract_tags("OpenAI releases GPT-6", ARTICLE)
    assert len(tags) == 5
    for tag in ("openai", "google", "anthropic", "nvidia"):
        assert tag in tags


def test_relevance_rewards_trust_and_coverage_and_punishes_listicles():
    title = "OpenAI releases GPT-6 language model"
    alone = relevance_score(title, ARTICLE, 3, "news", 0)
    covered = relevance_score(title, ARTICLE, 3, "news", 3)
    listicle = relevance_score("Top 10 ChatGPT prompts you need to know", "ChatGPT prompts for AI.", 1, "medium", 0)
    assert covered > alone >= 6
    assert listicle <= 2


def test_clean_headline():
    assert clean_headline("Nvidia unveils new GPUs - The Verge", "The Verge") == "Nvidia unveils new GPUs"
    assert clean_headline("GPT-6 – what changed", "Wired") == "GPT-6 – what changed"


def test_breaking_needs_coverage_and_high_score():
    brief = write_brief("OpenAI releases GPT-6 language model", ARTICLE, "X", 3, "news", coverage=3)
    assert brief.is_ai_news and brief.category == "models"
    assert brief.relevance >= 8 and brief.breaking


def test_repeated_site_text_is_ignored():
    widget = "Posts from this topic will be added to your daily email digest and your homepage feed."
    body = "\n".join([widget] * 3 + [
        "OpenAI launched a new consumer AI agent on Tuesday that can book reservations and shop for users.",
        "The agent competes directly with Meta's free assistant built into WhatsApp and Instagram.",
    ])
    summary, _ = summarize("OpenAI's new agent is a shot at Meta", body)
    assert summary.startswith("OpenAI launched a new consumer AI agent")
    assert "email digest" not in summary
