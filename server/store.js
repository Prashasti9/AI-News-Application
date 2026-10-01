import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Tiny JSON-file store. The data set is small (hundreds of articles, a few
// thousand subscriptions), so a database would be overkill. Writes go to a
// temp file and are renamed into place so a crash never leaves half a file.

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(config.dataDir, name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, value) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const file = path.join(config.dataDir, name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
}

export const articles = {
  all: () => readJson('articles.json', []),
  save(list) {
    const cutoff = Date.now() - config.maxAgeDays * 86400e3;
    const kept = list
      .filter((a) => new Date(a.publishedAt).getTime() >= cutoff)
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
      .slice(0, config.maxArticles);
    writeJson('articles.json', kept);
    return kept;
  },
};

// Remember URLs we've already judged (including rejected ones) so we don't
// pay to re-brief them every refresh.
export const seen = {
  load: () => new Map(Object.entries(readJson('seen.json', {}))),
  save(map) {
    const cutoff = Date.now() - (config.maxAgeDays + 7) * 86400e3;
    const obj = {};
    for (const [k, t] of map) if (t >= cutoff) obj[k] = t;
    writeJson('seen.json', obj);
  },
};

export const subscriptions = {
  all: () => readJson('subscriptions.json', []),
  save: (list) => writeJson('subscriptions.json', list),
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
  get: (key, fallback) => readJson(`${key}.json`, fallback),
  set: (key, value) => writeJson(`${key}.json`, value),
};
