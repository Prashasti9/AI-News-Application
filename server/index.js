import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { refresh, runEditionIfDue } from './pipeline.js';
import { DEFAULT_PREFS, LEVELS, getVapidPublicKey, initPush, sendTo } from './push.js';
import { CATEGORIES, rankScore } from './relevance.js';
import { articles, kv, subscriptions } from './store.js';
import { claudeEnabled } from './summarize.js';

const app = express();
app.use(express.json({ limit: '32kb' }));
app.disable('x-powered-by');

const PAGE = 20;

function publicArticle(a) {
  const { isAiNews, sourceWeight, ...rest } = a;
  return rest;
}

function filterByTab(list, tab) {
  const dayAgo = Date.now() - 48 * 3600e3;
  switch (tab) {
    case 'today': {
      const latest = list.reduce((max, a) => (a.edition && a.edition > max ? a.edition : max), '');
      return list.filter((a) => a.edition && a.edition === latest).sort((a, b) => a.editionRank - b.editionRank);
    }
    case 'top':
      return [...list].sort((a, b) => rankScore(b) - rankScore(a));
    case 'breaking':
      return list.filter((a) => (a.breaking || a.relevance >= 9) && new Date(a.publishedAt).getTime() > dayAgo);
    case 'deep':
      return list.filter((a) => a.category === 'explainer' || a.sourceKind === 'analysis' || a.sourceKind === 'medium');
    case 'all':
    case undefined:
    case '':
      return list;
    default:
      return list.filter((a) => a.category === tab);
  }
}

app.get('/api/meta', (_req, res) => {
  res.json({
    categories: CATEGORIES,
    levels: Object.fromEntries(Object.entries(LEVELS).map(([k, v]) => [k, v.label])),
    defaultPrefs: DEFAULT_PREFS,
    vapidPublicKey: getVapidPublicKey(),
    claude: claudeEnabled(),
    lastRefresh: kv.get('last-refresh', null),
    edition: config.storiesPerDay > 0 ? { perDay: config.storiesPerDay, hour: config.editionHour, timezone: config.editionTimezone } : null,
  });
});

// GET /api/news?tab=top|breaking|deep|<category>&topics=a,b&offset=0
app.get('/api/news', (req, res) => {
  let list = articles.all();
  const topics = String(req.query.topics || '').split(',').filter(Boolean);
  if (topics.length && !req.query.tab) list = list.filter((a) => topics.includes(a.category));
  list = filterByTab(list, req.query.tab);
  const since = req.query.since ? new Date(String(req.query.since)).getTime() : 0;
  const offset = Math.max(0, Number(req.query.offset) || 0);
  res.set('cache-control', 'no-store');
  res.json({
    total: list.length,
    newSince: since ? list.filter((a) => new Date(a.briefedAt || a.publishedAt).getTime() > since).length : 0,
    items: list.slice(offset, offset + PAGE).map(publicArticle),
  });
});

app.get('/api/news/:id', (req, res) => {
  const a = articles.all().find((x) => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  res.json(publicArticle(a));
});

function validSubscription(sub) {
  return (
    sub &&
    typeof sub.endpoint === 'string' &&
    /^https:\/\//.test(sub.endpoint) &&
    sub.endpoint.length < 1000 &&
    typeof sub.keys?.p256dh === 'string' &&
    typeof sub.keys?.auth === 'string'
  );
}

function cleanPrefs(p = {}) {
  const level = p.level === 'off' || LEVELS[p.level] ? p.level : DEFAULT_PREFS.level;
  const hour = (h, d) => (Number.isInteger(h) && h >= 0 && h <= 23 ? h : d);
  let timezone = DEFAULT_PREFS.timezone;
  try {
    if (p.timezone) {
      new Intl.DateTimeFormat('en-US', { timeZone: p.timezone });
      timezone = p.timezone;
    }
  } catch {
    // keep default
  }
  return {
    level,
    topics: Array.isArray(p.topics) ? p.topics.filter((t) => CATEGORIES[t]) : [],
    maxPerDay: Math.max(1, Math.min(30, Number(p.maxPerDay) || LEVELS[level]?.defaultMax || DEFAULT_PREFS.maxPerDay)),
    quietStart: hour(p.quietStart, DEFAULT_PREFS.quietStart),
    quietEnd: hour(p.quietEnd, DEFAULT_PREFS.quietEnd),
    timezone,
  };
}

// Subscribing again with the same endpoint updates preferences.
app.post('/api/subscribe', (req, res) => {
  const { subscription, prefs } = req.body || {};
  if (!validSubscription(subscription)) return res.status(400).json({ error: 'invalid subscription' });
  const saved = subscriptions.upsert({ endpoint: subscription.endpoint, keys: subscription.keys, prefs: cleanPrefs(prefs) });
  res.json({ ok: true, prefs: saved.prefs });
});

app.post('/api/unsubscribe', (req, res) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== 'string') return res.status(400).json({ error: 'endpoint required' });
  res.json({ ok: subscriptions.remove(endpoint) });
});

const lastTest = new Map();
app.post('/api/test-push', async (req, res) => {
  const sub = subscriptions.all().find((s) => s.endpoint === req.body?.endpoint);
  if (!sub) return res.status(404).json({ error: 'subscribe first' });
  if (Date.now() - (lastTest.get(sub.endpoint) || 0) < 15000) return res.status(429).json({ error: 'wait a few seconds' });
  lastTest.set(sub.endpoint, Date.now());
  const top = articles.all().sort((a, b) => b.relevance - a.relevance)[0];
  try {
    await sendTo(sub, {
      title: 'Notifications are on ✅',
      body: top ? `Top story right now: ${top.headline}` : "You'll get alerts here when big AI news breaks.",
      url: top ? `/?story=${top.id}` : '/',
      tag: 'test',
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/refresh', async (req, res) => {
  if (!config.adminToken || req.get('authorization') !== `Bearer ${config.adminToken}`) return res.status(401).json({ error: 'unauthorized' });
  res.json(config.storiesPerDay > 0 ? await runEditionIfDue({ force: true }) : await refresh());
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

const publicDir = path.resolve('public');
app.get('/sw.js', (_req, res) => {
  res.set('cache-control', 'no-cache');
  res.sendFile(path.join(publicDir, 'sw.js'));
});
app.use(express.static(publicDir, { maxAge: '1h' }));

initPush();
app.listen(config.port, () => {
  console.log(`AI News Shorts on http://localhost:${config.port} (Claude briefs: ${claudeEnabled() ? config.claudeModel : 'off — set ANTHROPIC_API_KEY'})`);
  if (config.storiesPerDay > 0) console.log(`Daily edition: top ${config.storiesPerDay} stories at ${config.editionHour}:00 ${config.editionTimezone}`);
});

const editionMode = config.storiesPerDay > 0;
const tick = () =>
  (editionMode ? runEditionIfDue() : refresh()).catch((err) => console.error('[refresh] failed:', err));
tick();
// In edition mode, check every 10 minutes whether today's edition is due.
setInterval(tick, (editionMode ? 10 : config.refreshMinutes) * 60e3);
