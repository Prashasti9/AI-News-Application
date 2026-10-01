import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isEditionDue, localDateHour, pickEdition } from '../server/pipeline.js';
import { editionPayload } from '../server/push.js';

test('local date/hour respects the edition timezone', () => {
  // 2026-10-01 20:00 UTC is 2026-10-02 01:30 in Kolkata.
  assert.deepEqual(localDateHour(new Date('2026-10-01T20:00:00Z'), 'Asia/Kolkata'), { date: '2026-10-02', hour: 1 });
  assert.deepEqual(localDateHour(new Date('2026-10-01T20:00:00Z'), 'UTC'), { date: '2026-10-01', hour: 20 });
});

test('edition is due once per local day, after the edition hour', () => {
  const opts = { timezone: 'Asia/Kolkata', hour: 8 };
  const before = new Date('2026-10-02T02:00:00Z'); // 07:30 IST
  const after = new Date('2026-10-02T03:00:00Z'); // 08:30 IST
  assert.equal(isEditionDue(before, { ...opts, lastDate: '2026-10-01' }), false);
  assert.equal(isEditionDue(after, { ...opts, lastDate: '2026-10-01' }), true);
  assert.equal(isEditionDue(after, { ...opts, lastDate: '2026-10-02' }), false);
  assert.equal(isEditionDue(after, { ...opts, lastDate: undefined }), true);
});

test('pickEdition keeps the N most important AI stories', () => {
  const b = (id, relevance, extra = {}) => ({ id, relevance, isAiNews: true, coverage: [], sourceWeight: 1, ...extra });
  const picked = pickEdition(
    [b('a', 6), b('b', 9), b('c', 8, { coverage: [{}, {}] }), b('d', 8), b('e', 10, { isAiNews: false }), b('f', 4), b('g', 7), b('h', 7)],
    5,
    5,
  );
  assert.deepEqual(picked.map((a) => a.id), ['b', 'c', 'd', 'g', 'h']);
});

test('edition notification lists the headlines', () => {
  const p = editionPayload([{ id: 'x', headline: 'One', edition: '2026-10-02' }, { id: 'y', headline: 'Two' }]);
  assert.equal(p.title, 'Your 2 AI stories for today');
  assert.equal(p.body, '• One\n• Two');
  assert.equal(p.tag, 'edition-2026-10-02');
});
