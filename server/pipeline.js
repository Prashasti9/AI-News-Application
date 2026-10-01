import { config } from './config.js';
import { fetchAll, fetchArticleDetails } from './feeds.js';
import { notifySubscribers } from './push.js';
import { clusterItems, isAiRelated, preScore, similarity, titleTokens } from './relevance.js';
import { loadSources } from './sources.js';
import { articles, kv, seen } from './store.js';
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
  const brief = await writeBrief({ ...primary, coverage }, body, related, log);
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
    generatedBy: brief.generatedBy,
    briefedAt: new Date().toISOString(),
  };
}

async function doRefresh(log) {
  const started = Date.now();
  const sources = loadSources();
  const { items, errors } = await fetchAll(sources, { log });
  const filterSources = new Set(sources.filter((s) => s.filter).map((s) => s.id));

  const existing = articles.all();
  const seenMap = seen.load();
  const windowH = existing.length ? config.maxAgeDays * 24 : FIRST_RUN_WINDOW_H;
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
    .slice(0, config.maxSummariesPerRun)
    .map((x) => x.c);

  const briefed = await mapLimit(clusters, 3, (c) => briefCluster(c, log));

  for (const c of clusters) for (const it of c) seenMap.set(it.url, Date.now());
  seen.save(seenMap);

  const accepted = briefed.filter((a) => a.isAiNews && a.relevance >= config.minRelevance);
  const saved = changed || accepted.length ? articles.save([...accepted, ...existing]) : existing;

  const notifyCutoff = Date.now() - NOTIFY_WINDOW_H * 3600e3;
  const notifiable = accepted.filter((a) => new Date(a.publishedAt).getTime() >= notifyCutoff);
  const push = await notifySubscribers(notifiable, log);

  const stats = {
    at: new Date().toISOString(),
    ms: Date.now() - started,
    sources: sources.length,
    sourceErrors: errors,
    fetched: items.length,
    candidates: candidates.length,
    briefed: briefed.length,
    accepted: accepted.length,
    total: saved.length,
    push,
  };
  kv.set('last-refresh', stats);
  log.info?.(`[refresh] fetched ${items.length}, new ${candidates.length}, briefed ${briefed.length}, published ${accepted.length} in ${stats.ms}ms`);
  return stats;
}

/** Run one refresh; concurrent callers share the in-flight run. */
export function refresh(log = console) {
  running ||= doRefresh(log).finally(() => {
    running = null;
  });
  return running;
}
