import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inQuietHours, payloadFor, selectForSubscriber } from '../server/push.js';

const art = (id, relevance, extra = {}) => ({ id, relevance, breaking: false, category: 'models', headline: `H${id}`, summary: 'S', ...extra });
const noon = new Date('2026-10-01T12:00:00Z');

test('level thresholds and per-run cap', () => {
  const sub = { prefs: { level: 'top', timezone: 'UTC', quietStart: 22, quietEnd: 7, maxPerDay: 6, topics: [] }, sentLog: [] };
  const picked = selectForSubscriber(sub, [art('a', 6), art('b', 8), art('c', 9), art('d', 10)], noon);
  assert.deepEqual(picked.map((a) => a.id), ['d', 'c']);
});

test('respects topics, already-sent and daily cap', () => {
  const sub = {
    prefs: { level: 'all', topics: ['policy'], maxPerDay: 2, timezone: 'UTC', quietStart: 0, quietEnd: 0 },
    sentLog: [{ id: 'p1', at: new Date(noon - 3600e3).toISOString() }],
  };
  const picked = selectForSubscriber(sub, [art('p1', 9, { category: 'policy' }), art('p2', 8, { category: 'policy' }), art('m', 10)], noon);
  assert.deepEqual(picked.map((a) => a.id), ['p2']);
  sub.sentLog.push({ id: 'p2', at: noon.toISOString() });
  assert.equal(selectForSubscriber(sub, [art('p3', 10, { category: 'policy' })], noon).length, 0);
});

test('quiet hours in the subscriber timezone let only breaking 9+ through', () => {
  // 12:00 UTC is 21:30 in Kolkata → not quiet; 17:00 UTC is 22:30 → quiet.
  const prefs = { level: 'all', timezone: 'Asia/Kolkata', quietStart: 22, quietEnd: 7, maxPerDay: 10, topics: [] };
  assert.equal(inQuietHours(prefs, noon), false);
  const late = new Date('2026-10-01T17:00:00Z');
  assert.equal(inQuietHours(prefs, late), true);
  const picked = selectForSubscriber({ prefs, sentLog: [] }, [art('x', 8), art('y', 9, { breaking: true })], late);
  assert.deepEqual(picked.map((a) => a.id), ['y']);
});

test('off level sends nothing; digest payload for multiple', () => {
  assert.equal(selectForSubscriber({ prefs: { level: 'off' } }, [art('a', 10)], noon).length, 0);
  const p = payloadFor([art('a', 9), art('b', 8)]);
  assert.equal(p.title, '2 important AI stories');
  assert.equal(p.url, '/?story=a');
});
