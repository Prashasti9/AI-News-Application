import crypto from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';

const USER_AGENT = 'AI-News-Shorts/1.0 (+https://github.com/prashasti9/ai-news-application)';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  cdataPropName: false,
  processEntities: true,
  htmlEntities: true,
});

const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

function text(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === 'object') return text(v['#text'] ?? '');
  return '';
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

export function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

export function stripHtml(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<(script|style|figure|figcaption)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function firstImage(html) {
  const m = String(html || '').match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? decodeEntities(m[1]) : '';
}

function pickImage(item, html) {
  const candidates = [
    ...asArray(item['media:content']).map((m) => (m?.['@medium'] === 'video' ? '' : m?.['@url'])),
    ...asArray(item['media:group']).flatMap((g) => asArray(g?.['media:content']).map((m) => m?.['@url'])),
    ...asArray(item['media:thumbnail']).map((m) => m?.['@url']),
    ...asArray(item.enclosure).filter((e) => String(e?.['@type'] || '').startsWith('image')).map((e) => e?.['@url']),
    firstImage(html),
  ];
  // Skip tracking pixels and feed-stats images.
  return candidates.find((u) => u && /^https?:/.test(u) && !/stat|pixel|feedburner|gravatar/i.test(u)) || '';
}

function atomLink(entry) {
  const links = asArray(entry.link);
  const alt = links.find((l) => !l['@rel'] || l['@rel'] === 'alternate') || links[0];
  return typeof alt === 'string' ? alt : alt?.['@href'] || '';
}

// Drop tracking params so the same story from two feeds dedupes by URL.
export function canonicalUrl(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|ref$|source$|guccounter|fbclid|gclid|mc_)/i.test(k)) u.searchParams.delete(k);
    }
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

export function articleId(url) {
  return crypto.createHash('sha1').update(canonicalUrl(url)).digest('hex').slice(0, 16);
}

function toDate(v) {
  const d = new Date(text(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Parse an RSS 2.0, RSS 1.0 (RDF) or Atom document into plain items. */
export function parseFeed(xml, source) {
  const doc = parser.parse(xml);
  let raw = [];
  if (doc.rss?.channel) raw = asArray(doc.rss.channel.item).map((it) => ({ kind: 'rss', it }));
  else if (doc.feed) raw = asArray(doc.feed.entry).map((it) => ({ kind: 'atom', it }));
  else if (doc['rdf:RDF']) raw = asArray(doc['rdf:RDF'].item).map((it) => ({ kind: 'rss', it }));

  const items = [];
  for (const { kind, it } of raw) {
    const html =
      kind === 'atom'
        ? text(it.content) || text(it.summary)
        : text(it['content:encoded']) || text(it.description);
    const url = canonicalUrl(kind === 'atom' ? atomLink(it) : text(it.link) || text(it.guid));
    const title = stripHtml(text(it.title)).replace(/\s+/g, ' ');
    if (!url || !title) continue;
    const published =
      toDate(it.pubDate) || toDate(it.published) || toDate(it.updated) || toDate(it['dc:date']) || new Date();
    items.push({
      id: articleId(url),
      url,
      title,
      excerpt: stripHtml(html).slice(0, 6000),
      image: pickImage(it, html),
      author: stripHtml(text(it['dc:creator']) || text(it.author?.name) || text(it.author)),
      publishedAt: published.toISOString(),
      sourceId: source.id,
      sourceName: source.name,
      sourceKind: source.kind,
      sourceWeight: source.weight ?? 1,
    });
  }
  return items;
}

export async function fetchText(url, { timeoutMs = 15000, maxBytes = 3_000_000 } = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8' },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  return body.length > maxBytes ? body.slice(0, maxBytes) : body;
}

export async function fetchSource(source) {
  const xml = await fetchText(source.url);
  return parseFeed(xml, source);
}

/** Fetch every source in parallel (bounded), tolerating individual failures. */
export async function fetchAll(sources, { concurrency = 8, log = console } = {}) {
  const results = [];
  const queue = [...sources];
  const errors = [];
  async function worker() {
    while (queue.length) {
      const s = queue.shift();
      try {
        results.push(...(await fetchSource(s)));
      } catch (err) {
        errors.push({ source: s.id, error: err.message });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, sources.length) }, worker));
  if (errors.length) log.warn?.(`[feeds] ${errors.length} source(s) failed: ${errors.map((e) => `${e.source} (${e.error})`).join(', ')}`);
  return { items: results, errors };
}

const meta = (html, prop) => {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i');
  const tag = html.match(re)?.[0];
  return tag ? decodeEntities(tag.match(/content=["']([^"']*)["']/i)?.[1] || '') : '';
};

/**
 * Pull the article page for a richer brief: og:image plus the body paragraphs.
 * Best effort: paywalls and JS-only pages just return what the feed had.
 */
export async function fetchArticleDetails(url) {
  try {
    const html = await fetchText(url, { timeoutMs: 10000, maxBytes: 1_500_000 });
    const body = html.match(/<article[\s\S]*?<\/article>/i)?.[0] || html;
    const paragraphs = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((m) => stripHtml(m[1]))
      .filter((p) => p.split(' ').length > 8);
    return {
      image: meta(html, 'og:image') || meta(html, 'twitter:image'),
      description: meta(html, 'og:description') || meta(html, 'description'),
      text: paragraphs.join('\n').slice(0, 12000),
    };
  } catch {
    return { image: '', description: '', text: '' };
  }
}
