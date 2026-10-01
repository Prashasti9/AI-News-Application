# AI Shorts: AI news in 60 words

An Inshorts-style app for AI news. Each story is one full-screen card with a ~60-word summary; swipe up for the next. Once a day the app picks the **5 most important AI stories** from ~30 trusted sources and sends **one** phone notification listing them.

It's a Progressive Web App (PWA): you install it from the browser to your home screen on Android or iPhone. It runs **entirely on free services**, with no paid APIs.

## Features

- **Daily edition:** the top 5 stories of the last 24 hours, chosen at a time you set, with one notification. Set `STORIES_PER_DAY=0` for continuous mode, which instead alerts on every important story as it breaks.
- **Curated sources:**
  - AI labs: OpenAI, Google DeepMind, Hugging Face, Microsoft Research, NVIDIA, BAIR
  - News desks: MIT Tech Review, The Verge, TechCrunch, Ars Technica, WIRED, VentureBeat, The Decoder
  - Expert writers: Import AI, Simon Willison, Interconnects, Latent Space, Ahead of AI, Lil'Log
  - Community: Hacker News (150+ points) and Medium
- **Relevance without AI APIs:**
  - a keyword filter drops non-AI posts
  - the same story from several outlets is merged into one card ("+2 sources")
  - each story gets a 0–10 importance score from source trust, coverage, newsworthiness and freshness
  - clickbait and listicles are penalised
- **Free summaries:** extractive summarisation picks the article's most informative sentences, plus 3 key points and tags.
- **App features:**
  - sections: Today's 5, My Feed, Top, Breaking, Deep Reads, and one tab per topic
  - save stories, share them, and skip ones you've read
  - offline reading of the last feed you loaded
  - light and dark mode
- **Notifications:** Web Push with topic filters, a daily cap, and quiet hours in your timezone.

## Run it locally

Requires Node 20+.

```bash
npm install
npm start          # http://localhost:3000
npm test           # unit tests
```

There's nothing to configure locally: data is saved as JSON files in `data/`. `npm run refresh` publishes an edition immediately.

## Deploy for free

| Piece | Free service |
|---|---|
| Web server (HTTPS) | Render free plan |
| Database | Neon free Postgres |
| Daily wake-up | GitHub Actions (`.github/workflows/daily-wake.yml`) |
| Tests on every push | GitHub Actions (`.github/workflows/ci.yml`) |

1. **Database:** sign up at [neon.tech](https://neon.tech), create a project, and copy the connection string (`postgres://…?sslmode=require`).
2. **Notification keys:** run `npm run vapid` and save the two keys it prints.
3. **Render:** at [render.com](https://render.com), choose New → Blueprint and pick this repo. Fill in:
   - `DATABASE_URL`
   - `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`
   - `VAPID_SUBJECT` (`mailto:` + your email)
   - `EDITION_TIMEZONE` (e.g. `Asia/Kolkata`)
4. **Wake-up job:** Render's free plan sleeps after 15 idle minutes. In GitHub, go to Settings → Secrets and variables → Actions → Variables and add `APP_URL` = your Render URL. Then set the cron time in `daily-wake.yml` to just after your edition hour, in UTC. The default `35 2 * * *` is 8:05 AM in India.
5. **Phone:** open your Render URL.
   - **Android:** tap **Install**.
   - **iPhone:** tap **Share → Add to Home Screen** and open the app from there.
   
   Then tap 🔔 → **Turn on notifications** → **Send test**.

Free-plan trade-offs:
- The first visit after the app has been asleep takes ~30–60 s to load.
- GitHub pauses scheduled workflows in repos with no activity for 60 days. Push a commit, or use [cron-job.org](https://cron-job.org) to open `APP_URL/healthz` daily instead.

## Architecture

```
            ┌─────────────── Server (Node.js + Express) ────────────────┐
 GitHub     │ scheduler ─► fetch ~30 RSS/Atom feeds ─► AI keyword filter │
 Actions ──►│   ─► merge duplicate stories ─► cheap pre-rank, top 15     │
 (wake-up)  │   ─► fetch article pages ─► extractive summary + score     │
            │   ─► pick top 5 ─► save ─► send one Web Push notification ─┼─► Google / Apple
            │ REST API (/api/news, /api/subscribe, …)                    │   push services
            └───────────────┬───────────────────────────┬───────────────┘        │
                            │ JSON over HTTPS           │ SQL                    ▼
            ┌───────────────▼────────────┐   ┌──────────▼──────────┐   phone notification
            │ PWA on the phone           │   │ Postgres (Neon) or  │
            │ cards, deep dive, settings │   │ JSON files locally  │
            │ service worker: push+offline│  └─────────────────────┘
            └────────────────────────────┘
```

| File | Responsibility |
|---|---|
| `server/sources.js` | The curated feed list. Each source has a trust `weight` (1–3), and `filter: true` for feeds that aren't AI-only. Put a `data/sources.json` file in place to override the list. |
| `server/feeds.js` | Downloads and parses RSS/Atom. Strips tracking parameters so duplicates match, finds images, and fetches article pages for the full text and `og:image`. |
| `server/relevance.js` | AI keyword scoring, topic classification, duplicate-story clustering (headline word overlap within 72 h), and ranking for the Top tab. |
| `server/summarize.js` | Splits text into sentences, scores them (word frequency, headline overlap, position, specifics), and assembles a ~60-word summary, key points, tags and the 0–10 importance score. |
| `server/pipeline.js` | Orchestration: continuous refresh, or the daily edition (is it due? → gather → shortlist → brief → pick top N → save → notify). |
| `server/push.js` | VAPID keys, which stories each subscriber should get (level, topics, cap, quiet hours), and sending encrypted Web Push messages. |
| `server/store.js` | Key-value storage with an in-memory cache. Writes go to JSON files, or to a Postgres `app_kv` table when `DATABASE_URL` is set. |
| `server/index.js` | Express API, static hosting of the PWA, and the scheduler. |
| `public/app.js` | The phone UI: tabs, swipe cards, deep-dive sheet, saved stories, notification settings. |
| `public/sw.js` | Service worker: shows notifications, opens the story on tap, and caches the app for offline use. |

API: `GET /api/news?tab=today|top|breaking|deep|<topic>&offset=N`, `GET /api/news/:id`, `GET /api/meta`, `POST /api/subscribe`, `POST /api/unsubscribe`, `POST /api/test-push`, `POST /api/refresh` (needs `ADMIN_TOKEN`).

## Configuration

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | – | Postgres connection string; without it, data goes to files in `DATA_DIR` |
| `STORIES_PER_DAY` | `5` | Stories in the daily edition; `0` = continuous mode |
| `EDITION_HOUR` / `EDITION_TIMEZONE` | `8` / `UTC` | When the edition is published |
| `SHORTLIST_SIZE` | `15` | Candidates read in full before picking the day's stories |
| `MIN_RELEVANCE` | `5` | Stories scoring below this are hidden |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | auto | Web Push identity |
| `REFRESH_MINUTES` / `MAX_SUMMARIES_PER_RUN` | `30` / `15` | Continuous mode only |
| `ADMIN_TOKEN` | – | Enables `POST /api/refresh` |

## Ideas to build next

Each of these is a self-contained project that makes a good resume bullet:

- **Better summaries, still free:** implement TextRank (a graph of sentences scored PageRank-style), or run a small open-source summarisation model in Node with `transformers.js`.
- **Personalised ranking:** learn from what each user reads, saves and skips, and boost their topics and sources in My Feed.
- **Accounts and sync:** sign-in (e.g. email magic links) so saved stories and settings follow you across devices.
- **Search:** Postgres full-text search over past stories.
- **Better duplicate detection:** TF-IDF or MinHash similarity instead of headline word overlap.
- **App stores:** wrap the PWA with Bubblewrap (Google Play) or Capacitor (iOS App Store).
- **Admin dashboard:** source health, failed feeds, edition history, subscriber count.
- **Analytics:** privacy-friendly open and click-through rates per edition.

## Before selling it

- **Content rights:** summarising articles and showing their images commercially needs care. Link back prominently (the app does), avoid copying long passages, and check each source's terms. News aggregators often license content or use only headlines and their own summaries.
- **Privacy:** push subscriptions are personal data. Publish a privacy policy and let users delete their data.
- **Paid hosting:** free tiers sleep and have limits. Budget for a small paid plan once you have users.
