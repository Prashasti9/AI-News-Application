import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { CATEGORIES, aiKeywordScore, extractiveSummary, guessCategory } from './relevance.js';

const client = config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey }) : null;

export const claudeEnabled = () => Boolean(client);

// Server-side refusal fallback and `effort` exist only on newer models; older
// or smaller ones (e.g. claude-haiku-4-5) reject the request if they're sent.
const SUPPORTS_FALLBACKS = /^claude-(opus-5|sonnet-5-5|fable-5)/;
const SUPPORTS_EFFORT = /^claude-(opus|sonnet-5|fable|mythos)/;

const BRIEF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_ai_news', 'relevance', 'breaking', 'category', 'headline', 'summary', 'why_it_matters', 'key_points', 'context', 'tags'],
  properties: {
    is_ai_news: { type: 'boolean', description: 'False for spam, listicles, SEO filler, self-promotion, or stories where AI is incidental.' },
    relevance: { type: 'integer', description: 'Importance to a well-informed AI practitioner, 0-10.' },
    breaking: { type: 'boolean', description: 'True only for major, time-sensitive news people would want a phone alert for.' },
    category: { type: 'string', enum: Object.keys(CATEGORIES) },
    headline: { type: 'string', description: 'Clear, factual headline, at most 75 characters. No clickbait.' },
    summary: { type: 'string', description: 'The short: 55-65 words, plain language, facts first.' },
    why_it_matters: { type: 'string', description: '2-3 sentences on significance and second-order effects.' },
    key_points: { type: 'array', items: { type: 'string' }, description: '3-4 crisp takeaways with concrete specifics (numbers, names, dates).' },
    context: { type: 'string', description: '90-140 word explainer of the background a curious reader needs: the concepts, the prior state of the art, and how this fits the bigger picture.' },
    tags: { type: 'array', items: { type: 'string' }, description: '2-5 short lowercase tags (companies, models, techniques).' },
  },
};

const SYSTEM = `You are the senior editor of an AI news app in the style of Inshorts: every story becomes one card a reader can absorb in 30 seconds, with an optional "deep dive" that should teach them as much as a good Medium explainer.

Readers are technically curious people who follow AI closely: engineers, researchers, founders and students. They want signal, not hype.

Rules:
- Use only facts present in the article text. Do not invent numbers, quotes or dates. If the text is thin, say less rather than guessing.
- Write the summary as a self-contained news brief: who did what, the key specifics, and the consequence. No "In this article" framing, no hype words like "revolutionary" or "game-changing".
- "context" is where you add depth: explain the underlying ideas (e.g. what a mixture-of-experts model is, why inference cost matters) using well-established background knowledge, and connect the story to the wider field.
- Relevance scale: 9-10 = landmark (major frontier model release, major regulation passed, very large deal); 7-8 = significant news most followers should know; 5-6 = useful niche or solid technical content; 3-4 = minor; 0-2 = not worth showing.
- Medium and blog posts that are generic, promotional or beginner listicles get relevance 0-3 and is_ai_news=false when they contain no news or real insight. Genuinely insightful technical deep dives can score 6-8 and use category "explainer".`;

function articlePrompt(article, bodyText, related) {
  const lines = [
    `Source: ${article.sourceName} (${article.sourceKind})`,
    `Published: ${article.publishedAt}`,
    `Title: ${article.title}`,
    `URL: ${article.url}`,
  ];
  if (related.length) lines.push(`Also covered by: ${related.map((r) => `${r.sourceName} — "${r.title}"`).join('; ')}`);
  lines.push('', 'Article text:', bodyText.slice(0, 12000) || '(no text available beyond the title)');
  return lines.join('\n');
}

/** Brief without an API key, or when Claude fails: extractive + keyword scoring. */
export function fallbackBrief(article, bodyText) {
  const kw = aiKeywordScore(article.title, bodyText);
  return {
    is_ai_news: kw >= 3,
    relevance: Math.max(0, Math.min(8, Math.round(kw * 0.5 + (article.sourceWeight || 1) * 1.2 + (article.coverage?.length ? 1 : 0)))),
    breaking: false,
    category: guessCategory({ ...article, excerpt: bodyText }),
    headline: article.title,
    summary: extractiveSummary(bodyText || article.title),
    why_it_matters: '',
    key_points: [],
    context: '',
    tags: [],
    generatedBy: 'extractive',
  };
}

/** Ask Claude for the card + deep dive. Falls back to the extractive brief on any failure. */
export async function writeBrief(article, bodyText, related = [], log = console) {
  if (!client) return fallbackBrief(article, bodyText);
  try {
    const model = config.claudeModel;
    const fallbacks = SUPPORTS_FALLBACKS.test(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {};
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      ...fallbacks,
      output_config: {
        ...(config.claudeEffort && SUPPORTS_EFFORT.test(model) ? { effort: config.claudeEffort } : {}),
        format: { type: 'json_schema', schema: BRIEF_SCHEMA },
      },
      system: SYSTEM,
      messages: [{ role: 'user', content: articlePrompt(article, bodyText, related) }],
    });
    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
      log.warn?.(`[claude] ${response.stop_reason} for ${article.url}; using extractive brief`);
      return fallbackBrief(article, bodyText);
    }
    const textBlock = response.content.find((b) => b.type === 'text');
    const brief = JSON.parse(textBlock.text);
    brief.relevance = Math.max(0, Math.min(10, Math.round(brief.relevance)));
    if (!CATEGORIES[brief.category]) brief.category = guessCategory(article);
    brief.generatedBy = response.model;
    return brief;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) log.error?.('[claude] invalid ANTHROPIC_API_KEY');
    else if (err instanceof Anthropic.RateLimitError) log.warn?.('[claude] rate limited; using extractive brief');
    else log.warn?.(`[claude] ${err.name}: ${err.message}`);
    return fallbackBrief(article, bodyText);
  }
}
