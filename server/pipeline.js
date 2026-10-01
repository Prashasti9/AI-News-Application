import { config } from './config.js';
import { fetchAll, fetchArticleDetails } from './feeds.js';
import { notifyEdition, notifySubscribers } from './push.js';
import { clusterItems, isAiRelated, preScore, similarity, titleTokens } from './relevance.js';
import { loadSources } from './sources.js';
import { articles, flush, kv, seen } from './store.js';
import { writeBrief } from './summarize.js';

const FIRST_RUN_WINDOW_H = 48;
const NOTIFY_WINDOW_H = 12;

let running = null;

/** Attach new items that duplicate an already-published story to its coverage list. */
function absorbDuplicates(existing, items) {
  const fresh = [];
  const byUrl = new Map(existing.map((a) => [a.url, a]));
  const tokens = existing.map((a) => ({ a, t: titleTokens(a.title), time: new Date(a.publishedAt).getTime() }));
  let changed = false;
  for (const item of items) {
    if (byUrl.has(item.url)) continue;
    const t = titleTokens(item.title);
    const time = new Date(item.publishedAt).getTime();
    const hit = t.size >= 3 && tokens.find((e) => Math.abs(e.time - time) < 72 * 3600e3 && similarity(e.t, t) >= 0.6);
    if (hit) {
      const a = hit.a;
      a.coverage ||= [];
      if (a.sourceId !== item.sourceId && !a.coverage.some((c) => c.url === item.url)) {
        a.coverage.push({ sourceName: item.sourceName, url: item.url, title: item.title });
        changed = true;
      }
    } else fresh.push(item);
  }
  return { fresh, changed };
}

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, list.length) }, async () => {
      while (i < list.length) {
        const idx = i++;
        out[idx] = await fn(list[idx], idx);
      }
    }),
  );
  return out;
}

async function briefCluster(cluster, log) {
  const [primary, ...related] = cluster;
  let body = primary.excerpt;
  let image = primary.image;
  if (body.length < 1500 || !image) {
    const details = await fetchArticleDetails(primary.url);
    if (details.text.length > body.length) body = details.text;
    if (!body && details.description) body = details.description;
    image ||= details.image || related.find((r) => r.image)?.image || '';
  }
  const coverage = related
    .filter((r) => r.sourceId !== primary.sourceId)
    .map((r) => ({ sourceName: r.sourceName, url: r.url, title: r.title }));
  const brief = writeBrief({ ...primary, coverage }, body);
  return {
    id: primary.id,
    url: primary.url,
    title: primary.title,
    author: primary.author,
    image,
    publishedAt: primary.publishedAt,
    sourceId: primary.sourceId,
    sourceName: primary.sourceName,
    sourceKind: primary.sourceKind,
    sourceWeight: primary.sourceWeight,
    coverage,
    headline: brief.headline || primary.title,
    summary: brief.summary,
    whyItMatters: brief.why_it_matters,
    keyPoints: brief.key_points,
    context: brief.context,
    tags: brief.tags,
    category: brief.category,
    relevance: brief.relevance,
    breaking: brief.breaking,
    isAiNews: brief.is_ai_news,
    briefedAt: new Date().toISOString(),
  };
}

/** Fetch feeds and return new, AI-relevant story clusters ranked by pre-score. */
async function gatherClusters(log, windowH) {
  const sources = loadSources();
  const { items, errors } = await fetchAll(sources, { log });
  const filterSources = new Set(sources.filter((s) => s.filter).map((s) => s.id));
  const existing = articles.all();
  const seenMap = seen.load();
  const cutoff = Date.now() - windowH * 3600e3;

  const candidates = items.filter(
    (it) =>
      !seenMap.has(it.url) &&
      new Date(it.publishedAt).getTime() >= cutoff &&
      new Date(it.publishedAt).getTime() <= Date.now() + 3600e3 &&
      (!filterSources.has(it.sourceId) || isAiRelated(it)),
  );
  const { fresh, changed } = absorbDuplicates(existing, candidates);
  const clusters = clusterItems(fresh)
    .map((c) => ({ c, score: preScore(c[0], new Set(c.map((i) => i.sourceId)).size) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c);
  return { sources, items, errors, existing, seenMap, candidates, clusters, changed };
}

function markSeen(seenMap, clusters) {
  for (const c of clusters) for (const it of c) seenMap.set(it.url, Date.now());
  seen.save(seenMap);
}

async function doRefresh(log) {
  const started = Date.now();
  const existing0 = articles.all();
  const windowH = existing0.length ? config.maxAgeDays * 24 : FIRST_RUN_WINDOW_H;
  const g = await gatherClusters(log, windowH);
  const clusters = g.clusters.slice(0, config.maxSummariesPerRun);

  const briefed = await mapLimit(clusters, 3, (c) => briefCluster(c, log));
  markSeen(g.seenMap, clusters);

  const accepted = briefed.filter((a) => a.isAiNews && a.relevance >= config.minRelevance);
  const saved = g.changed || accepted.length ? articles.save([...accepted, ...g.existing]) : g.existing;

  const notifyCutoff = Date.now() - NOTIFY_WINDOW_H * 3600e3;
  const notifiable = accepted.filter((a) => new Date(a.publishedAt).getTime() >= notifyCutoff);
  const push = await notifySubscribers(notifiable, log);

  const stats = {
    mode: 'continuous',
    at: new Date().toISOString(),
    ms: Date.now() - started,
    sources: g.sources.length,
    sourceErrors: g.errors,
    fetched: g.items.length,
    candidates: g.candidates.length,
    briefed: briefed.length,
    accepted: accepted.length,
    total: saved.length,
    push,
  };
  kv.set('last-refresh', stats);
  await flush();
  log.info?.(`[refresh] fetched ${g.items.length}, new ${g.candidates.length}, briefed ${briefed.length}, published ${accepted.length} in ${stats.ms}ms`);
  return stats;
}

/** Local calendar date (YYYY-MM-DD) and hour in the edition timezone. */
export function localDateHour(now, timezone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
}

/** Has today's edition not gone out yet, and is it past the edition hour? */
export function isEditionDue(now, { timezone, hour, lastDate }) {
  const local = localDateHour(now, timezone);
  return local.hour >= hour && lastDate !== local.date;
}

/** Choose the day's stories: most important first, wider coverage breaks ties. */
export function pickEdition(briefs, count, minRelevance) {
  return briefs
    .filter((a) => a.isAiNews && a.relevance >= minRelevance)
    .sort((a, b) => b.relevance - a.relevance || b.coverage.length - a.coverage.length || (b.sourceWeight || 0) - (a.sourceWeight || 0))
    .slice(0, count);
}

async function doEdition(log) {
  const started = Date.now();
  const { date } = localDateHour(new Date(), config.editionTimezone);
  const last = kv.get('last-edition', null);
  // Cover everything since the previous edition (at most 2 days back).
  const sinceH = last?.at ? Math.min(48, (Date.now() - new Date(last.at).getTime()) / 3600e3 + 1) : 24;
  const g = await gatherClusters(log, sinceH);
  const shortlist = g.clusters.slice(0, config.shortlistSize);

  const briefed = await mapLimit(shortlist, 3, (c) => briefCluster(c, log));
  markSeen(g.seenMap, shortlist);

  const picked = pickEdition(briefed, config.storiesPerDay, config.minRelevance).map((a, i) => ({ ...a, edition: date, editionRank: i + 1 }));
  const saved = g.changed || picked.length ? articles.save([...picked, ...g.existing]) : g.existing;
  const push = await notifyEdition(picked, log);

  const stats = {
    mode: 'edition',
    edition: date,
    at: new Date().toISOString(),
    ms: Date.now() - started,
    sources: g.sources.length,
    sourceErrors: g.errors,
    fetched: g.items.length,
    candidates: g.candidates.length,
    briefed: briefed.length,
    accepted: picked.length,
    total: saved.length,
    push,
  };
  kv.set('last-edition', { date, at: stats.at });
  kv.set('last-refresh', stats);
  await flush();
  log.info?.(`[edition ${date}] reviewed ${briefed.length} of ${g.candidates.length} new stories, published ${picked.length}`);
  return stats;
}

/** Publish today's edition if it is due (or `force`). Returns null when not due. */
export function runEditionIfDue({ force = false, log = console } = {}) {
  const last = kv.get('last-edition', null);
  if (!force && !isEditionDue(new Date(), { timezone: config.editionTimezone, hour: config.editionHour, lastDate: last?.date })) return Promise.resolve(null);
  running ||= doEdition(log).finally(() => {
    running = null;
  });
  return running;
}

/** Run one refresh; concurrent callers share the in-flight run. */
export function refresh(log = console) {
  running ||= doRefresh(log).finally(() => {
    running = null;
  });
  return running;
}
