import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiKeywordScore, clusterItems, guessCategory, isAiRelated, rankScore } from '../server/relevance.js';

const item = (title, extra = {}) => ({
  title,
  excerpt: '',
  url: `https://x.com/${encodeURIComponent(title)}`,
  publishedAt: new Date().toISOString(),
  sourceWeight: 2,
  sourceId: 's',
  sourceKind: 'news',
  ...extra,
});

test('AI keyword filter keeps AI stories and drops others', () => {
  assert.ok(isAiRelated(item('Anthropic ships a new Claude model for coding')));
  assert.ok(isAiRelated(item('Why GPUs are scarce again', { excerpt: 'Demand for training large language models keeps rising.' })));
  assert.ok(!isAiRelated(item('Ten gardening tips for autumn')));
  assert.ok(isAiRelated(item('EU opens probe into AI chatbots')), 'uppercase AI counts');
  assert.ok(!isAiRelated(item('Thai airline adds flights to Dubai')), 'ai inside words does not');
  assert.ok(aiKeywordScore('OpenAI raises $40B') > aiKeywordScore('Startup raises $40B'));
});

test('categorises by title first', () => {
  assert.equal(guessCategory(item('EU fines Meta under the AI Act for copyright violations')), 'policy');
  assert.equal(guessCategory(item('Nvidia unveils Blackwell Ultra GPUs')), 'hardware');
  assert.equal(guessCategory(item('Mistral raises $2 billion at $14B valuation')), 'business');
  assert.equal(guessCategory(item('How attention really works', { sourceKind: 'analysis' })), 'explainer');
});

test('clusters the same story from different outlets', () => {
  const clusters = clusterItems([
    item('OpenAI launches GPT-6 with 2M token context', { sourceId: 'a', sourceWeight: 1 }),
    item('OpenAI launches GPT-6, its new flagship model with 2M context', { sourceId: 'b', sourceWeight: 3 }),
    item('Google DeepMind unveils Gemini 4 robotics model', { sourceId: 'c' }),
  ]);
  assert.equal(clusters.length, 2);
  const big = clusters.find((c) => c.length === 2);
  assert.equal(big[0].sourceId, 'b', 'highest-weight source leads the cluster');
});

test('rank favours important fresh stories', () => {
  const now = Date.now();
  const fresh = { relevance: 8, publishedAt: new Date(now - 3600e3).toISOString() };
  const stale = { relevance: 9, publishedAt: new Date(now - 72 * 3600e3).toISOString() };
  assert.ok(rankScore(fresh, now) > rankScore(stale, now));
});
