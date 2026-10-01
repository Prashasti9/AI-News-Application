import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Curated feeds. `weight` (1-3) is how much we trust the source's editorial
// judgement; `filter: true` means the feed is not AI-only, so items must pass
// the keyword check before they are considered.
//   lab       – first-party announcements from AI labs
//   news      – reporting from AI desks of major outlets
//   analysis  – expert newsletters and blogs (the "Medium-depth" reading)
//   community – what practitioners are upvoting
//   medium    – Medium tag feeds; high volume, so Claude's relevance bar applies
export const DEFAULT_SOURCES = [
  // Labs
  { id: 'openai', name: 'OpenAI', url: 'https://openai.com/news/rss.xml', kind: 'lab', weight: 3 },
  { id: 'deepmind', name: 'Google DeepMind', url: 'https://deepmind.google/blog/rss.xml', kind: 'lab', weight: 3 },
  { id: 'google-ai', name: 'Google AI', url: 'https://blog.google/technology/ai/rss/', kind: 'lab', weight: 2 },
  { id: 'google-research', name: 'Google Research', url: 'https://research.google/blog/rss/', kind: 'lab', weight: 2 },
  { id: 'msr', name: 'Microsoft Research', url: 'https://www.microsoft.com/en-us/research/feed/', kind: 'lab', weight: 2, filter: true },
  { id: 'nvidia', name: 'NVIDIA', url: 'https://blogs.nvidia.com/feed/', kind: 'lab', weight: 2, filter: true },
  { id: 'huggingface', name: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml', kind: 'lab', weight: 2 },
  { id: 'bair', name: 'Berkeley AI Research', url: 'https://bair.berkeley.edu/blog/feed.xml', kind: 'lab', weight: 2 },
  { id: 'aws-ml', name: 'AWS Machine Learning', url: 'https://aws.amazon.com/blogs/machine-learning/feed/', kind: 'lab', weight: 1 },

  // News desks
  { id: 'mit-tr', name: 'MIT Technology Review', url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed', kind: 'news', weight: 3 },
  { id: 'verge', name: 'The Verge', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', kind: 'news', weight: 2 },
  { id: 'techcrunch', name: 'TechCrunch', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', kind: 'news', weight: 2 },
  { id: 'venturebeat', name: 'VentureBeat', url: 'https://venturebeat.com/category/ai/feed/', kind: 'news', weight: 2 },
  { id: 'ars', name: 'Ars Technica', url: 'https://arstechnica.com/ai/feed/', kind: 'news', weight: 2 },
  { id: 'wired', name: 'WIRED', url: 'https://www.wired.com/feed/tag/ai/latest/rss', kind: 'news', weight: 2 },
  { id: 'decoder', name: 'The Decoder', url: 'https://the-decoder.com/feed/', kind: 'news', weight: 2 },
  { id: 'marktechpost', name: 'MarkTechPost', url: 'https://www.marktechpost.com/feed/', kind: 'news', weight: 1 },

  // Expert analysis
  { id: 'importai', name: 'Import AI', url: 'https://importai.substack.com/feed', kind: 'analysis', weight: 3 },
  { id: 'simonw', name: 'Simon Willison', url: 'https://simonwillison.net/atom/everything/', kind: 'analysis', weight: 3, filter: true },
  { id: 'interconnects', name: 'Interconnects', url: 'https://www.interconnects.ai/feed', kind: 'analysis', weight: 3 },
  { id: 'latent-space', name: 'Latent Space', url: 'https://www.latent.space/feed', kind: 'analysis', weight: 2 },
  { id: 'raschka', name: 'Ahead of AI', url: 'https://magazine.sebastianraschka.com/feed', kind: 'analysis', weight: 3 },
  { id: 'mollick', name: 'One Useful Thing', url: 'https://www.oneusefulthing.org/feed', kind: 'analysis', weight: 2 },
  { id: 'gradient', name: 'The Gradient', url: 'https://thegradient.pub/rss/', kind: 'analysis', weight: 2 },
  { id: 'lilianweng', name: "Lil'Log", url: 'https://lilianweng.github.io/index.xml', kind: 'analysis', weight: 3 },
  { id: 'huyenchip', name: 'Chip Huyen', url: 'https://huyenchip.com/feed.xml', kind: 'analysis', weight: 2 },
  { id: 'tds', name: 'Towards Data Science', url: 'https://towardsdatascience.com/feed', kind: 'analysis', weight: 1, filter: true },

  // Community + Medium
  { id: 'hn', name: 'Hacker News', url: 'https://hnrss.org/newest?q=AI+OR+LLM+OR+OpenAI+OR+Anthropic+OR+Gemini+OR+GPT&points=150', kind: 'community', weight: 2, filter: true },
  { id: 'medium-ai', name: 'Medium', url: 'https://medium.com/feed/tag/artificial-intelligence', kind: 'medium', weight: 1, filter: true },
  { id: 'medium-llm', name: 'Medium', url: 'https://medium.com/feed/tag/large-language-models', kind: 'medium', weight: 1, filter: true },
  { id: 'medium-ml', name: 'Medium', url: 'https://medium.com/feed/tag/machine-learning', kind: 'medium', weight: 1, filter: true },
];

// data/sources.json, if present, replaces the default list so feeds can be
// added or removed without a code change.
export function loadSources() {
  const file = path.join(config.dataDir, 'sources.json');
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(list) && list.length) return list;
  } catch {
    // fall through to defaults
  }
  return DEFAULT_SOURCES;
}
