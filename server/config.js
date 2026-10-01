import fs from 'node:fs';
import path from 'node:path';

// Minimal .env loader so the app runs without extra dependencies.
function loadDotEnv(file = path.resolve('.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
loadDotEnv();

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export const config = {
  port: num(process.env.PORT, 3000),
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  claudeModel: process.env.CLAUDE_MODEL || 'claude-opus-5-5',
  claudeEffort: process.env.CLAUDE_EFFORT || 'medium',
  refreshMinutes: num(process.env.REFRESH_MINUTES, 30),
  maxSummariesPerRun: num(process.env.MAX_SUMMARIES_PER_RUN, 15),
  // Daily edition: publish only the N most important stories once a day and
  // send one notification for them. 0 = continuous mode (every refresh).
  storiesPerDay: num(process.env.STORIES_PER_DAY, 5),
  // How many top candidates Claude reviews to choose the day's stories.
  shortlistSize: num(process.env.SHORTLIST_SIZE, 15),
  editionHour: num(process.env.EDITION_HOUR, 8),
  editionTimezone: process.env.EDITION_TIMEZONE || 'UTC',
  minRelevance: num(process.env.MIN_RELEVANCE, 5),
  maxArticles: num(process.env.MAX_ARTICLES, 600),
  maxAgeDays: num(process.env.MAX_AGE_DAYS, 14),
  adminToken: process.env.ADMIN_TOKEN || '',
  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  },
};
