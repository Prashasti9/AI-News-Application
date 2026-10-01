// Free, offline story briefs: no AI API, no cost.
//
// The summary is *extractive*: we split the article into sentences, score each
// one, and keep the best ones (in their original order) up to ~60 words.
// Scoring follows the classic frequency method (Luhn, 1958): a sentence is
// important if it contains the words the article keeps repeating, plus bonuses
// for sharing words with the headline and for appearing early (news articles
// put the key facts first).
import { CATEGORIES, aiKeywordScore, guessCategory } from './relevance.js';

const STOP = new Set(
  `a about above after again against all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its itself just let me more most my no nor not now of off on once only or other our ours out over own same she should so some such than that the their theirs them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours said says say says new one two also like get got make made use used using may might many much well even still yet however per via according told`.split(/\s+/),
);

// Lines that are site furniture rather than reporting.
const BOILERPLATE = /(subscribe|sign up|newsletter|cookie|all rights reserved|click here|read more|continue reading|appeared first on|originally (appeared|published)|follow us|share this|image credit|photo:|getty images|advertisement|sponsored|this story has been updated)/i;

// Abbreviations that end in a period but don't end a sentence.
const ABBREV = /\b(?:Mr|Mrs|Ms|Dr|Prof|Inc|Ltd|Corp|Co|Jr|Sr|St|vs|etc|e\.g|i\.e|U\.S|U\.K|No|Fig|approx)\.$/i;

export function splitSentences(text) {
  const out = [];
  for (const para of String(text || '').split(/\n+/)) {
    let buf = '';
    for (const piece of para.split(/(?<=[.!?]["”’)]?)\s+(?=["“‘(]?[A-Z0-9])/)) {
      buf = buf ? `${buf} ${piece}` : piece;
      if (!ABBREV.test(buf.trim())) {
        out.push(buf.trim());
        buf = '';
      }
    }
    if (buf.trim()) out.push(buf.trim());
  }
  return out.filter((s) => s.length > 0);
}

const words = (s) =>
  s
    .toLowerCase()
    .replace(/[’']s\b/g, '')
    .match(/[a-z0-9][a-z0-9.+-]*[a-z0-9]|[a-z0-9]/g) || [];

// Crude stemming so "model" and "models" count as the same word.
const stem = (w) => w.replace(/(ing|ed|es|s)$/, '') || w;

const contentWords = (s) => words(s).filter((w) => !STOP.has(w) && w.length > 2).map(stem);

/** Score every usable sentence of an article. Exported for tests. */
export function scoreSentences(title, body) {
  const sentences = splitSentences(body).filter((s) => {
    const n = s.split(/\s+/).length;
    return n >= 6 && n <= 60 && !BOILERPLATE.test(s);
  });
  const freq = new Map();
  for (const s of sentences) for (const w of contentWords(s)) freq.set(w, (freq.get(w) || 0) + 1);
  const maxFreq = Math.max(1, ...freq.values());
  const titleWords = new Set(contentWords(title));

  return sentences.map((text, i) => {
    const ws = contentWords(text);
    const density = ws.reduce((sum, w) => sum + (freq.get(w) || 0) / maxFreq, 0) / Math.sqrt(Math.max(ws.length, 1));
    const titleOverlap = ws.filter((w) => titleWords.has(w)).length / Math.max(titleWords.size, 1);
    const position = i === 0 ? 1.5 : i < 3 ? 0.8 : i < 6 ? 0.3 : 0;
    const hasNumber = /\d/.test(text) ? 0.3 : 0; // specifics: sizes, prices, dates
    const isQuestion = text.endsWith('?') ? -0.8 : 0;
    return { text, index: i, score: density + titleOverlap * 2 + position + hasNumber + isQuestion };
  });
}

function trimWords(text, max) {
  const w = text.split(/\s+/);
  return w.length <= max ? text : `${w.slice(0, max).join(' ').replace(/[,;:]$/, '')}…`;
}

/** ~60-word extractive summary plus up to 3 extra key points. */
export function summarize(title, body, maxWords = 60) {
  const scored = scoreSentences(title, body);
  if (!scored.length) return { summary: trimWords(body || title, maxWords), keyPoints: [] };

  const ranked = [...scored].sort((a, b) => b.score - a.score);
  const chosen = [];
  let count = 0;
  for (const s of ranked) {
    const n = s.text.split(/\s+/).length;
    if (count + n > maxWords + 8) continue; // allow a little slack for whole sentences
    chosen.push(s);
    count += n;
    if (count >= maxWords - 12) break;
  }
  if (!chosen.length) chosen.push(ranked[0]);
  const summary = trimWords(
    chosen
      .sort((a, b) => a.index - b.index)
      .map((s) => s.text)
      .join(' '),
    maxWords + 8,
  );

  const used = new Set(chosen.map((s) => s.index));
  const keyPoints =
    scored.length >= 6
      ? ranked
          .filter((s) => !used.has(s.index))
          .slice(0, 3)
          .sort((a, b) => a.index - b.index)
          .map((s) => trimWords(s.text, 32))
      : [];
  return { summary, keyPoints };
}

const TAGS = [
  ['openai', /\bopenai\b/i], ['anthropic', /\banthropic\b/i], ['google', /\bgoogle\b/i], ['deepmind', /\bdeepmind\b/i],
  ['meta', /\bmeta\b/i], ['microsoft', /\bmicrosoft\b/i], ['nvidia', /\bnvidia\b/i], ['apple', /\bapple\b/i],
  ['amazon', /\b(amazon|aws)\b/i], ['xai', /\bxai\b/i], ['mistral', /\bmistral\b/i], ['deepseek', /\bdeepseek\b/i],
  ['alibaba', /\b(alibaba|qwen)\b/i], ['hugging face', /\bhugging ?face\b/i], ['perplexity', /\bperplexity\b/i],
  ['chatgpt', /\bchatgpt\b/i], ['gpt', /\bgpt-?\d/i], ['claude', /\bclaude\b/i], ['gemini', /\bgemini\b/i],
  ['llama', /\bllama\b/i], ['grok', /\bgrok\b/i], ['agents', /\bagent(s|ic)?\b/i], ['open source', /\bopen[- ](source|weights?)\b/i],
  ['robotics', /\brobot(s|ics)?\b/i], ['regulation', /\b(regulat\w+|ai act|law)\b/i], ['chips', /\b(chips?|gpus?|semiconductor)\b/i],
  ['funding', /\b(raises?|funding|valuation)\b/i], ['research', /\b(paper|arxiv|researchers)\b/i],
];

export function extractTags(title, body) {
  const hay = `${title} ${String(body).slice(0, 3000)}`;
  return TAGS.filter(([, re]) => re.test(hay))
    .map(([t]) => t)
    .slice(0, 5);
}

// Headlines that signal real news rather than commentary.
const NEWSWORTHY = /\b(launch\w*|releas\w*|announc\w*|unveil\w*|introduc\w*|acquir\w*|raises?|billion|lawsuit|sues?|ban\w*|open[- ]sources?|open[- ]weights?|partners?\w*|breakthrough|record|first)\b/i;
// Low-value content common on Medium and SEO blogs.
const LOW_QUALITY = /\b(top \d+|\d+ (ways|tips|tools|prompts|reasons|things|ai tools)|you need to know|ultimate guide|make money|passive income|side hustle|how i (made|built|earned)|beginner'?s guide|cheat ?sheet|must[- ]know|game[- ]changer|mind[- ]blowing)\b/i;

/** 0-10 importance score built from free signals only. Exported for tests. */
export function relevanceScore(article, body) {
  const coverage = article.coverage?.length || 0;
  const bodyWords = String(body).split(/\s+/).length;
  let score =
    aiKeywordScore(article.title, body) * 0.35 + // about AI at all? (0-3.5)
    (article.sourceWeight || 1) * 0.9 + // how much we trust the source (0.9-2.7)
    Math.min(3, Math.log2(1 + coverage) * 1.5) + // other outlets covering it (0-3)
    (NEWSWORTHY.test(article.title) ? 1 : 0) +
    (bodyWords > 300 ? 0.5 : 0);
  if (LOW_QUALITY.test(article.title)) score -= 3;
  if (article.sourceKind === 'medium') score -= 1;
  return Math.max(0, Math.min(10, Math.round(score)));
}

/** Tidy feed titles: drop " - Site Name" / " | Site" suffixes. */
export function cleanHeadline(title, sourceName = '') {
  let t = title.replace(/\s+/g, ' ').trim();
  t = t.replace(/\s+[|–—-]\s+[^|–—-]{2,40}$/, (m) => (sourceName && m.toLowerCase().includes(sourceName.toLowerCase().split(' ')[0]) ? '' : m));
  return t.length > 110 ? `${t.slice(0, 107).trim()}…` : t;
}

/** Build the card + deep dive for one story. */
export function writeBrief(article, bodyText) {
  const body = bodyText || article.excerpt || '';
  const { summary, keyPoints } = summarize(article.title, body);
  const relevance = relevanceScore(article, body);
  const category = guessCategory({ ...article, excerpt: body });
  return {
    is_ai_news: aiKeywordScore(article.title, body) >= 3,
    relevance,
    // Breaking = several independent outlets on the same story, and it scores high.
    breaking: (article.coverage?.length || 0) >= 2 && relevance >= 8,
    category: CATEGORIES[category] ? category : 'products',
    headline: cleanHeadline(article.title, article.sourceName),
    summary,
    why_it_matters: '',
    key_points: keyPoints,
    context: '',
    tags: extractTags(article.title, body),
  };
}
