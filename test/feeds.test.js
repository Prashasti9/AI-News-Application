import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { canonicalUrl, parseFeed, stripHtml } from '../server/feeds.js';

const src = { id: 'ex', name: 'Example', kind: 'news', weight: 2 };

test('parses RSS 2.0 with content:encoded, media and tracking params', () => {
  const items = parseFeed(fs.readFileSync(new URL('./fixtures/rss.xml', import.meta.url), 'utf8'), src);
  assert.equal(items.length, 2);
  const [a] = items;
  assert.equal(a.title, 'OpenAI releases GPT-6 with a 2M-token context window');
  assert.equal(a.url, 'https://news.example.com/openai-gpt-6');
  assert.equal(a.image, 'https://cdn.example.com/gpt6.jpg');
  assert.equal(a.author, 'Jane Reporter');
  assert.equal(a.publishedAt, '2026-10-01T14:00:00.000Z');
  assert.match(a.excerpt, /two million tokens/);
  assert.match(a.excerpt, /today & via the API/);
  assert.equal(a.sourceName, 'Example');
});

test('parses Atom with html content and inline image', () => {
  const [e] = parseFeed(fs.readFileSync(new URL('./fixtures/atom.xml', import.meta.url), 'utf8'), src);
  assert.equal(e.url, 'https://blog.example.com/moe');
  assert.equal(e.image, 'https://blog.example.com/moe.png');
  assert.equal(e.author, 'Sam Writer');
  assert.match(e.excerpt, /^Mixture-of-experts models route/);
});

test('canonicalUrl strips tracking and trailing slash; ids match', () => {
  assert.equal(canonicalUrl('https://a.com/x/?utm_campaign=1&id=3#top'), 'https://a.com/x/?id=3');
  assert.equal(canonicalUrl('https://a.com/x/'), 'https://a.com/x');
});

test('stripHtml drops tags and decodes entities', () => {
  assert.equal(stripHtml('<p>A &amp; B&#8217;s <b>C</b></p><script>x()</script>'), 'A & B’s C');
});
