import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { config } from './config.js';

// Key-value storage for the whole app. Each key ("articles", "subscriptions",
// "seen", "vapid", ...) holds one JSON document.
//
// Reads come from an in-memory copy (fast, synchronous). Every write updates
// memory immediately and is then persisted in order, either to:
//   - JSON files in DATA_DIR (default; great for local development), or
//   - a Postgres table when DATABASE_URL is set (needed on free hosts such as
//     Render's free plan, whose disk is wiped on every restart).

const cache = new Map();
let backend = null;
let pending = Promise.resolve();

const fileBackend = {
  name: 'files',
  async loadAll() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const out = new Map();
    for (const f of fs.readdirSync(config.dataDir)) {
      if (!f.endsWith('.json') || f === 'sources.json') continue;
      try {
        out.set(f.slice(0, -5), JSON.parse(fs.readFileSync(path.join(config.dataDir, f), 'utf8')));
      } catch {
        // skip unreadable files
      }
    }
    return out;
  },
  async write(key, value) {
    const file = path.join(config.dataDir, `${key}.json`);
    // Write to a temp file and rename, so a crash never leaves half a file.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
  },
  async close() {},
};

function pgBackend(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 3 });
  return {
    name: 'postgres',
    async loadAll() {
      await pool.query(`CREATE TABLE IF NOT EXISTS app_kv (
        key text PRIMARY KEY,
        value jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
      const { rows } = await pool.query('SELECT key, value FROM app_kv');
      return new Map(rows.map((r) => [r.key, r.value]));
    },
    async write(key, value) {
      await pool.query(
        `INSERT INTO app_kv (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, JSON.stringify(value)],
      );
    },
    close: () => pool.end(),
  };
}

/** Connect and load everything into memory. Call once before using the store. */
export async function initStore(log = console) {
  backend = config.databaseUrl ? pgBackend(config.databaseUrl) : fileBackend;
  const all = await backend.loadAll();
  cache.clear();
  for (const [k, v] of all) cache.set(k, v);
  log.info?.(`[store] ${backend.name}: loaded ${cache.size} key(s)`);
}

/** Wait until every write so far has been saved. */
export const flush = () => pending;

export async function closeStore() {
  await flush();
  await backend?.close();
}

function read(key, fallback) {
  // Hand out a copy so callers can't change the cached data without saving.
  return cache.has(key) ? structuredClone(cache.get(key)) : fallback;
}

function write(key, value) {
  if (!backend) throw new Error('store not initialised: call initStore() first');
  cache.set(key, structuredClone(value));
  const snapshot = cache.get(key);
  pending = pending
    .then(() => backend.write(key, snapshot))
    .catch((err) => console.error(`[store] failed to save "${key}":`, err.message));
}

export const articles = {
  all: () => read('articles', []),
  save(list) {
    const cutoff = Date.now() - config.maxAgeDays * 86400e3;
    const kept = list
      .filter((a) => new Date(a.publishedAt).getTime() >= cutoff)
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
      .slice(0, config.maxArticles);
    write('articles', kept);
    return kept;
  },
};

// Remember URLs we've already judged (including rejected ones) so we don't
// process them again on the next run.
export const seen = {
  load: () => new Map(Object.entries(read('seen', {}))),
  save(map) {
    const cutoff = Date.now() - (config.maxAgeDays + 7) * 86400e3;
    const obj = {};
    for (const [k, t] of map) if (t >= cutoff) obj[k] = t;
    write('seen', obj);
  },
};

export const subscriptions = {
  all: () => read('subscriptions', []),
  save: (list) => write('subscriptions', list),
  upsert(sub) {
    const list = subscriptions.all();
    const i = list.findIndex((s) => s.endpoint === sub.endpoint);
    if (i >= 0) list[i] = { ...list[i], ...sub, updatedAt: new Date().toISOString() };
    else list.push({ ...sub, createdAt: new Date().toISOString(), sentLog: [] });
    subscriptions.save(list);
    return list[i >= 0 ? i : list.length - 1];
  },
  remove(endpoint) {
    const list = subscriptions.all();
    const next = list.filter((s) => s.endpoint !== endpoint);
    subscriptions.save(next);
    return list.length !== next.length;
  },
};

export const kv = {
  get: (key, fallback) => read(key, fallback),
  set: (key, value) => write(key, value),
};
