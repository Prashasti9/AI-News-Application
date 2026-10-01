// Heuristics for deciding what counts as AI news: is this about AI at all,
// which topic is it, which stories are duplicates, and how should the feed be
// ranked.

export const CATEGORIES = {
  models: 'Models',
  research: 'Research',
  products: 'Products',
  business: 'Business',
  policy: 'Policy & Safety',
  'open-source': 'Open Source',
  hardware: 'Chips & Compute',
  explainer: 'Explainers',
};

const AI_TERMS = [
  [/\b(artificial intelligence|machine learning|deep learning|neural net(work)?s?|generative ai|gen ?ai)\b/i, 3],
  [/\b(llms?|large language models?|foundation models?|frontier models?|language models?|multimodal|diffusion models?|transformers?)\b/i, 3],
  [/\b(chatgpt|gpt-?\d[\w.]*|openai|anthropic|claude|gemini|deepmind|llama|mistral|deepseek|qwen|grok|xai|copilot|midjourney|stable diffusion|perplexity|hugging ?face|sora|veo)\b/i, 3],
  // Case-sensitive on purpose: "AI" as a word, not "ai" inside other text.
  [/\bAI\b|\bA\.I\./, 2],
  [/\b(agents?|agentic|reasoning models?|fine-?tun\w*|rlhf|reinforcement learning|inference|embeddings?|rag|retrieval-augmented|tokens?|benchmarks?|evals?|alignment|interpretability|context window|prompt\w*)\b/i, 1],
  [/\b(gpus?|tpus?|nvidia|h100|h200|b200|blackwell|accelerators?|data ?cent(er|re)s?)\b/i, 1],
];

/** 0-10 keyword score for how much a title/excerpt is about AI. */
export function aiKeywordScore(title, excerpt = '') {
  let score = 0;
  for (const [re, w] of AI_TERMS) {
    if (re.test(title)) score += w * 2;
    else if (re.test(excerpt.slice(0, 1500))) score += w;
  }
  return Math.min(10, score);
}

export function isAiRelated(item) {
  return aiKeywordScore(item.title, item.excerpt) >= 3;
}

const CATEGORY_RULES = [
  ['policy', /\b(regulat\w*|law|lawsuit|sued|court|congress|senate|eu ai act|policy|government|ban\w*|copyright|safety|alignment|risk|ethic\w*|deepfakes?|election|privacy|military)\b/i],
  ['hardware', /\b(chips?|gpus?|tpus?|nvidia|amd|tsmc|semiconductor\w*|data ?cent(er|re)s?|compute|blackwell|h100|h200|power grid|energy)\b/i],
  ['business', /\b(raises?|funding|valuation|acquir\w*|acquisition|ipo|revenue|layoffs?|hires?|ceo|investors?|deal|partnership|billion|startup)\b/i],
  ['open-source', /\b(open[- ]source|open[- ]weights?|github|hugging ?face|apache 2\.0|mit license|released the weights|ollama|llama\.cpp)\b/i],
  ['research', /\b(paper|arxiv|study|researchers?|benchmark|dataset|novel method|we propose|state[- ]of[- ]the[- ]art|sota)\b/i],
  ['models', /\b(gpt-?\d|claude|gemini|llama|mistral|deepseek|qwen|model release|new model|launches? .*model|reasoning model)\b/i],
  ['products', /\b(launch\w*|rolls? out|feature|app|available|update|announc\w*|introduc\w*|ships?)\b/i],
];

export function guessCategory(item) {
  if (item.sourceKind === 'analysis' || item.sourceKind === 'medium') {
    if (/\b(how|why|what|guide|explained|understanding|intro\w*|deep dive|lessons)\b/i.test(item.title)) return 'explainer';
  }
  const hay = `${item.title} ${item.excerpt.slice(0, 600)}`;
  for (const [cat, re] of CATEGORY_RULES) if (re.test(item.title)) return cat;
  for (const [cat, re] of CATEGORY_RULES) if (re.test(hay)) return cat;
  return item.sourceKind === 'analysis' ? 'explainer' : 'products';
}

const STOP = new Set('a an the and or but of for to in on at by with from as is are was were be been it its this that these those how why what when who new says say said will can could may might has have had not no just more than about into over after before up out you your we our their they he she his her i via vs report reports'.split(' '));

export function titleTokens(title) {
  return new Set(
    title
      .toLowerCase()
      .replace(/[’']s\b/g, '')
      .replace(/[^a-z0-9.+\- ]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );
}

export function similarity(a, b) {
  const ta = a instanceof Set ? a : titleTokens(a);
  const tb = b instanceof Set ? b : titleTokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  // Overlap coefficient: robust when one outlet's headline is much longer.
  return inter / Math.min(ta.size, tb.size);
}

/**
 * Group items that describe the same story (within 72h of each other).
 * Returns clusters with the best-sourced item first.
 */
export function clusterItems(items, threshold = 0.6) {
  const sorted = [...items].sort((a, b) => b.sourceWeight - a.sourceWeight || new Date(a.publishedAt) - new Date(b.publishedAt));
  const clusters = [];
  for (const item of sorted) {
    const tokens = titleTokens(item.title);
    const t = new Date(item.publishedAt).getTime();
    const match = clusters.find(
      (c) =>
        tokens.size >= 3 &&
        Math.abs(c.time - t) < 72 * 3600e3 &&
        c.items.some((o) => o.url === item.url || similarity(o.tokens, tokens) >= threshold),
    );
    const entry = { ...item, tokens };
    if (match) match.items.push(entry);
    else clusters.push({ time: t, items: [entry] });
  }
  return clusters.map((c) => c.items.map(({ tokens, ...rest }) => rest));
}

/** Cheap priority score: decides which new stories get a brief first. */
export function preScore(item, coverage = 1) {
  const ageH = (Date.now() - new Date(item.publishedAt).getTime()) / 3600e3;
  const freshness = Math.max(0, 1 - ageH / 72);
  return aiKeywordScore(item.title, item.excerpt) * 0.4 + item.sourceWeight * 1.5 + Math.log2(coverage) * 2 + freshness * 3;
}

/** Feed ranking for the "Top" tab: importance decayed by age (HN-style gravity). */
export function rankScore(article, now = Date.now()) {
  const ageH = Math.max(0, (now - new Date(article.publishedAt).getTime()) / 3600e3);
  const importance = article.relevance + Math.log2(1 + (article.coverage?.length || 0)) * 1.5 + (article.sourceWeight || 1) * 0.5;
  return importance / Math.pow(ageH + 2, 0.8);
}
