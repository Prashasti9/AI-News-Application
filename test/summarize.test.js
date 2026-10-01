import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanHeadline, extractTags, relevanceScore, splitSentences, summarize, writeBrief } from '../server/summarize.js';

const ARTICLE = `OpenAI on Tuesday released GPT-6, a large language model that can read up to two million tokens at once. The company said the model is available to paying ChatGPT users and through its API starting today. Subscribe to our newsletter for more stories like this. GPT-6 scores 20 points higher than GPT-5 on the SWE-bench coding benchmark, according to OpenAI. Prices for the API are 40% lower than for the previous model. Analysts said the release puts pressure on Google and Anthropic, which launched rival models this summer. The model was trained on Nvidia Blackwell GPUs in data centers in Texas. OpenAI did not disclose the size of the model. Some researchers questioned whether benchmark gains translate into real-world reliability.`;

test('splits sentences without breaking on abbreviations', () => {
  const s = splitSentences('Dr. Smith joined OpenAI Inc. last year. She leads research. Is it working?');
  assert.deepEqual(s, ['Dr. Smith joined OpenAI Inc. last year.', 'She leads research.', 'Is it working?']);
});

test('summary is ~60 words, keeps the lead, drops boilerplate', () => {
  const { summary, keyPoints } = summarize('OpenAI releases GPT-6 with a 2M-token context window', ARTICLE);
  const n = summary.split(/\s+/).length;
  assert.ok(n >= 35 && n <= 68, `got ${n} words`);
  assert.ok(summary.startsWith('OpenAI on Tuesday released GPT-6'));
  assert.ok(!/newsletter/i.test(summary));
  assert.equal(keyPoints.length, 3);
  assert.ok(keyPoints.every((k) => !summary.includes(k)));
});

test('short text still produces a summary', () => {
  assert.equal(summarize('Title', 'Only one short line.').summary, 'Only one short line.');
});

test('tags known companies and models', () => {
  const tags = extractTags('OpenAI releases GPT-6', ARTICLE);
  assert.equal(tags.length, 5);
  for (const t of ['openai', 'google', 'anthropic', 'nvidia']) assert.ok(tags.includes(t), t);
});

test('relevance rewards trusted sources and coverage, punishes listicles', () => {
  const base = { title: 'OpenAI releases GPT-6 language model', sourceWeight: 3, sourceKind: 'news', coverage: [] };
  const covered = { ...base, coverage: [{}, {}, {}] };
  const listicle = { title: 'Top 10 ChatGPT prompts you need to know', sourceWeight: 1, sourceKind: 'medium', coverage: [] };
  assert.ok(relevanceScore(covered, ARTICLE) > relevanceScore(base, ARTICLE));
  assert.ok(relevanceScore(base, ARTICLE) >= 6);
  assert.ok(relevanceScore(listicle, 'ChatGPT prompts for AI.') <= 2);
});

test('cleans site-name suffixes from headlines', () => {
  assert.equal(cleanHeadline('Nvidia unveils new GPUs - The Verge', 'The Verge'), 'Nvidia unveils new GPUs');
  assert.equal(cleanHeadline('GPT-6 – what changed', 'Wired'), 'GPT-6 – what changed');
});

test('writeBrief marks multi-outlet high scorers as breaking', () => {
  const b = writeBrief({ title: 'OpenAI releases GPT-6 language model', sourceName: 'X', sourceWeight: 3, sourceKind: 'news', coverage: [{}, {}, {}] }, ARTICLE);
  assert.equal(b.is_ai_news, true);
  assert.equal(b.category, 'models');
  assert.ok(b.relevance >= 8);
  assert.equal(b.breaking, true);
});
