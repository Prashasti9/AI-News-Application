import webpush from 'web-push';
import { config } from './config.js';
import { kv, subscriptions } from './store.js';

export const LEVELS = {
  breaking: { label: 'Breaking only', minRelevance: 9, defaultMax: 3 },
  top: { label: 'Top stories', minRelevance: 8, defaultMax: 6 },
  all: { label: 'Every important story', minRelevance: 7, defaultMax: 12 },
};

export const DEFAULT_PREFS = {
  level: 'top',
  topics: [], // empty = all categories
  maxPerDay: LEVELS.top.defaultMax,
  quietStart: 22, // local hour, inclusive
  quietEnd: 7, // local hour, exclusive
  timezone: 'UTC',
};

let vapidPublicKey = '';

export function initPush(log = console) {
  let { publicKey, privateKey } = config.vapid;
  if (!publicKey || !privateKey) {
    const stored = kv.get('vapid', null);
    if (stored?.publicKey) ({ publicKey, privateKey } = stored);
    else {
      ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
      kv.set('vapid', { publicKey, privateKey });
      log.info?.('[push] generated VAPID keys and saved them to storage. Set VAPID_* env vars to pin them.');
    }
  }
  webpush.setVapidDetails(config.vapid.subject, publicKey, privateKey);
  vapidPublicKey = publicKey;
  return publicKey;
}

export const getVapidPublicKey = () => vapidPublicKey;

export function localHour(date, timezone) {
  try {
    const h = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: timezone }).format(date);
    return Number(h) % 24;
  } catch {
    return date.getUTCHours();
  }
}

export function inQuietHours(prefs, now = new Date()) {
  const { quietStart: s, quietEnd: e } = prefs;
  if (s === e || s === undefined || e === undefined) return false;
  const h = localHour(now, prefs.timezone);
  return s < e ? h >= s && h < e : h >= s || h < e;
}

/** Which of `candidates` (newest briefs) this subscriber should be alerted about now. */
export function selectForSubscriber(sub, candidates, now = new Date()) {
  const prefs = { ...DEFAULT_PREFS, ...sub.prefs };
  if (prefs.level === 'off') return [];
  const level = LEVELS[prefs.level] || LEVELS.top;
  const dayAgo = now.getTime() - 86400e3;
  const sentToday = (sub.sentLog || []).filter((e) => new Date(e.at).getTime() > dayAgo);
  const remaining = prefs.maxPerDay - sentToday.length;
  if (remaining <= 0) return [];
  const already = new Set((sub.sentLog || []).map((e) => e.id));
  const quiet = inQuietHours(prefs, now);
  return candidates
    .filter((a) => !already.has(a.id))
    .filter((a) => a.relevance >= level.minRelevance || (a.breaking && a.relevance >= 8))
    .filter((a) => !prefs.topics.length || prefs.topics.includes(a.category))
    // During quiet hours only truly breaking news gets through.
    .filter((a) => !quiet || (a.breaking && a.relevance >= 9))
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, Math.min(remaining, 2));
}

export function payloadFor(selected) {
  if (selected.length === 1) {
    const a = selected[0];
    return {
      title: a.breaking ? `Breaking: ${a.headline}` : a.headline,
      body: a.summary.length > 180 ? `${a.summary.slice(0, 177)}…` : a.summary,
      url: `/?story=${a.id}`,
      image: a.image || undefined,
      tag: `story-${a.id}`,
    };
  }
  return {
    title: `${selected.length} important AI stories`,
    body: selected.map((a) => `• ${a.headline}`).join('\n'),
    url: `/?story=${selected[0].id}`,
    image: selected[0].image || undefined,
    tag: 'digest',
  };
}

export async function sendTo(sub, payload) {
  return webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), { TTL: 6 * 3600, urgency: 'high' });
}

/** Send alerts for freshly briefed stories to every matching subscriber. */
export async function notifySubscribers(newArticles, log = console) {
  if (!newArticles.length) return { sent: 0, removed: 0 };
  const sentLogs = new Map();
  const expired = new Set();
  for (const sub of subscriptions.all()) {
    const selected = selectForSubscriber(sub, newArticles);
    if (!selected.length) continue;
    try {
      await sendTo(sub, payloadFor(selected));
      const at = new Date().toISOString();
      sentLogs.set(sub.endpoint, selected.map((a) => ({ id: a.id, at })));
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) expired.add(sub.endpoint); // subscription gone
      else log.warn?.(`[push] ${err.statusCode || ''} ${err.message}`);
    }
  }
  // Re-read so subscriptions created or edited while we were sending survive.
  const updated = subscriptions
    .all()
    .filter((s) => !expired.has(s.endpoint))
    .map((s) => (sentLogs.has(s.endpoint) ? { ...s, sentLog: [...(s.sentLog || []), ...sentLogs.get(s.endpoint)].slice(-100) } : s));
  subscriptions.save(updated);
  if (sentLogs.size || expired.size) log.info?.(`[push] sent ${sentLogs.size} notification(s), removed ${expired.size} expired subscription(s)`);
  return { sent: sentLogs.size, removed: expired.size };
}

export function editionPayload(stories) {
  return {
    title: `Your ${stories.length} AI ${stories.length === 1 ? 'story' : 'stories'} for today`,
    body: stories.map((a) => `• ${a.headline}`).join('\n'),
    url: `/?story=${stories[0].id}`,
    image: stories.find((a) => a.image)?.image,
    tag: `edition-${stories[0].edition || 'today'}`,
  };
}

/** Daily-edition mode: one notification per subscriber listing the day's stories. */
export async function notifyEdition(stories, log = console) {
  if (!stories.length) return { sent: 0, removed: 0 };
  const expired = new Set();
  let sent = 0;
  for (const sub of subscriptions.all()) {
    const prefs = { ...DEFAULT_PREFS, ...sub.prefs };
    if (prefs.level === 'off') continue;
    const mine = prefs.topics.length ? stories.filter((a) => prefs.topics.includes(a.category)) : stories;
    if (!mine.length) continue;
    try {
      await sendTo(sub, editionPayload(mine));
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) expired.add(sub.endpoint);
      else log.warn?.(`[push] ${err.statusCode || ''} ${err.message}`);
    }
  }
  if (expired.size) subscriptions.save(subscriptions.all().filter((s) => !expired.has(s.endpoint)));
  log.info?.(`[push] edition sent to ${sent} subscriber(s)`);
  return { sent, removed: expired.size };
}
