import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// The store reads its settings when imported, so each backend runs in a
// child process with its own environment.
import { execFileSync } from 'node:child_process';

const script = `
  import { initStore, closeStore, kv, subscriptions } from './server/store.js';
  await initStore({});
  const step = process.argv[1];
  if (step === 'write') {
    kv.set('last-edition', { date: '2026-10-02' });
    subscriptions.upsert({ endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' }, prefs: { level: 'top' } });
    const copy = kv.get('last-edition');
    copy.date = 'mutated';
  } else {
    console.log(JSON.stringify({ edition: kv.get('last-edition'), subs: subscriptions.all().length }));
  }
  await closeStore();
`;

function run(env, step) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', script, step], { env: { ...process.env, ...env }, encoding: 'utf8' }).trim();
}

test('file backend persists across restarts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  const env = { DATA_DIR: dir, DATABASE_URL: '' };
  run(env, 'write');
  assert.deepEqual(JSON.parse(run(env, 'read')), { edition: { date: '2026-10-02' }, subs: 1 });
});

// Set TEST_DATABASE_URL to also exercise the Postgres backend.
test('postgres backend persists across restarts', { skip: !process.env.TEST_DATABASE_URL }, () => {
  const env = { DATABASE_URL: process.env.TEST_DATABASE_URL };
  run(env, 'write');
  assert.deepEqual(JSON.parse(run(env, 'read')), { edition: { date: '2026-10-02' }, subs: 1 });
});
