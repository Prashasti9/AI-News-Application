# AI Shorts: AI news in 60 words

An Inshorts-style app for AI news. Each story is one full-screen card with a 60-word summary; swipe up for the next one. If you want more, **Deep dive** opens why it matters, the key points, and a background explainer written to teach you something, much like a good Medium post. Important stories reach your phone as **push notifications**.

It's a Progressive Web App (PWA). You install it from the browser onto your home screen. There's no app store and nothing to build for iOS or Android separately.

## What it does

| | |
|---|---|
| **Sources** | ~30 curated feeds in four groups. **Labs:** OpenAI, Google DeepMind, Google Research, Microsoft Research, NVIDIA, Hugging Face, BAIR. **News desks:** MIT Tech Review, The Verge, TechCrunch, Ars Technica, WIRED, VentureBeat, The Decoder. **Expert analysis:** Import AI, Simon Willison, Interconnects, Latent Space, Ahead of AI, One Useful Thing, The Gradient, Lil'Log, Chip Huyen. **Community and Medium:** Hacker News (150+ points only) and Medium's AI, LLM and ML tags. |
| **Relevance** | 1. A keyword filter drops non-AI items from general feeds.<br>2. When several outlets cover the same story, it's merged into one card ("+2 sources").<br>3. Claude rates every story 0–10 for importance to someone who follows AI closely. Anything under `MIN_RELEVANCE` (default 5) is hidden, which removes Medium listicles, SEO filler and promotional posts. |
| **Briefs** | Claude writes a factual headline, a 55–65 word summary, *why it matters*, 3–4 key points, a 90–140 word background explainer and tags. It works only from the article text and is told not to invent numbers or quotes. |
| **Sections** | My Feed (latest), Top (importance weighted by age), Breaking, Deep Reads (expert analysis and explainers), plus one tab per topic: Models, Research, Products, Business, Policy & Safety, Open Source, Chips & Compute, Explainers. |
| **Notifications** | Choose *Breaking only* (9+), *Top stories* (8+) or *Every important story* (7+). You can limit them to certain topics and set a daily cap. Quiet hours follow your own timezone, and only 9+ breaking news gets through them. Several stories at once arrive as one digest notification. |
| **Reading** | Save stories, share them, skip ones you've read, a "N new stories" prompt, and offline reading of the last feed you loaded. Light and dark mode follow your phone. |

## Run it locally

Requires Node 20+.

```bash
npm install
cp .env.example .env        # add your ANTHROPIC_API_KEY
npm start                   # http://localhost:3000
```

On first start the server pulls every feed and briefs the most important new stories. After that it refreshes every `REFRESH_MINUTES` (default 30).

Without `ANTHROPIC_API_KEY` the app still runs, but the briefs are extractive (the first sentences of each article), relevance is scored by keywords, and there are no deep dives. Add a key for the real experience.

`npm test` runs the unit tests. `npm run refresh` runs a single fetch → brief → notify cycle and exits.

## Get it on your phone (with notifications)

Push notifications need the app served over **HTTPS**, so deploy it first:

- **Render:** push this repo to GitHub, then in Render choose **New → Blueprint** and select the repo. `render.yaml` sets up the service and a persistent disk. Fill in `ANTHROPIC_API_KEY` and the VAPID keys when asked.
- **Any Docker host** (Fly.io, Railway, a VPS behind Caddy): `docker build -t ai-shorts . && docker run -p 3000:3000 -v ai-shorts-data:/data --env-file .env ai-shorts`

Generate your push (VAPID) keys once with `npm run vapid` and set them as environment variables. If they ever change, every existing subscriber silently stops receiving notifications.

Then on your phone:

- **Android (Chrome):** open your URL, tap **Install app** (or ⋮ → *Add to Home screen*), open it, tap the 🔔 and choose **Turn on notifications**.
- **iPhone (iOS 16.4+):** open your URL in Safari, tap **Share → Add to Home Screen**, then open AI Shorts *from the home screen* and tap the 🔔. iOS only allows web push for apps added to the home screen.

Use **Send test** in the settings sheet to confirm alerts arrive.

## Configuration

All settings are environment variables (see `.env.example`):

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | – | Turns on Claude briefs and scoring |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Model that writes the briefs |
| `CLAUDE_EFFORT` | `medium` | `low` is cheaper and faster; leave it empty for models that don't support effort |
| `REFRESH_MINUTES` | `30` | How often feeds are pulled |
| `MAX_SUMMARIES_PER_RUN` | `15` | Cap on new briefs per refresh (controls cost) |
| `MIN_RELEVANCE` | `5` | Stories below this score are hidden |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | auto | Web Push identity |
| `ADMIN_TOKEN` | – | Enables `POST /api/refresh` with `Authorization: Bearer <token>` |
| `DATA_DIR` | `./data` | Where articles, subscriptions and keys are stored (JSON files) |

**Changing sources:** put a JSON array in `data/sources.json` and it replaces the built-in list. The entries use the same shape as `server/sources.js`: `{ id, name, url, kind, weight, filter }`.

**Cost:** each brief is one Claude request with about 3–4k input tokens. With the defaults that's roughly a few cents per story. A typical day has 100–250 new AI stories across all feeds, about $5–10/day on `claude-opus-5-5`. To cut that, lower `MAX_SUMMARIES_PER_RUN`, set `CLAUDE_EFFORT=low`, or set `CLAUDE_MODEL=claude-sonnet-5-5`. Requests use server-side refusal fallback, and any failed request falls back to an extractive brief, so the feed never stalls.

## How it's built

```
server/
  index.js      Express API + static hosting + refresh scheduler
  pipeline.js   fetch → filter → dedupe/cluster → prioritise → brief → store → notify
  feeds.js      RSS/Atom parsing, article page fetch (og:image + body text)
  relevance.js  AI keyword scoring, categories, story clustering, ranking
  summarize.js  Claude brief (structured JSON output) with extractive fallback
  push.js       Web Push (VAPID), per-subscriber selection, quiet hours, caps
  store.js      atomic JSON-file storage
public/         the PWA: swipe cards, deep-dive sheet, settings, service worker
```

API: `GET /api/news?tab=top|breaking|deep|<category>&offset=N`, `GET /api/news/:id`, `GET /api/meta`, `POST /api/subscribe`, `POST /api/unsubscribe`, `POST /api/test-push`.
