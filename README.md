# AI Shorts: AI news in 60 words

An Inshorts-style app for AI news. Each story is one full-screen card with a ~60-word summary; swipe up for the next. Once a day the app picks the **5 most important AI stories** from ~30 trusted sources and sends **one** phone notification listing them.

- **Backend:** Python 3.11+ and **FastAPI**
- **Phone app:** a Progressive Web App (PWA) you install from the browser on Android or iPhone, with no app store needed
- **Cost:** runs entirely on free services, with no paid APIs

## Features

- **Daily edition:** the top 5 stories of the last 24 hours, at a time you choose, with one notification. Set `STORIES_PER_DAY=0` for continuous mode, which alerts on every important story instead.
- **Curated sources:**
  - AI labs: OpenAI, Google DeepMind, Hugging Face, Microsoft Research, NVIDIA
  - News desks: MIT Tech Review, The Verge, TechCrunch, Ars Technica, WIRED
  - Experts: Import AI, Simon Willison, Interconnects, Ahead of AI
  - Community: Hacker News (150+ points) and Medium
- **Relevance without AI APIs:**
  - a keyword filter removes non-AI posts
  - the same story from several outlets becomes one card ("+2 sources")
  - each story gets a 0–10 importance score; clickbait and listicles are penalised
- **Free summaries:** extractive summarisation picks the article's most informative sentences, plus key points and tags.
- **App features:**
  - sections: Today's 5, My Feed, Top, Breaking, Deep Reads, and one tab per topic
  - save stories, share them, and skip ones you've read
  - offline reading of the last feed you loaded
  - light and dark mode

## Run it on your computer

```bash
git clone https://github.com/<your-username>/AI-News-Application.git
cd AI-News-Application

python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt

uvicorn app.main:app --reload      # http://localhost:8000
```

- **The app:** open http://localhost:8000. On first start it fetches the news and publishes today's edition (if `EDITION_HOUR` has passed). Data is saved as JSON files in `data/`.
- **The API docs:** open **http://localhost:8000/docs**. FastAPI builds interactive documentation for every endpoint, and you can call them from there.
- **Tests:** run `pytest`.
- **Publish an edition now:** run `python -m scripts.refresh_once`.

## Deploy for free

| Piece | Free service |
|---|---|
| Web server (HTTPS) | Render free plan |
| Database | Neon free Postgres |
| Daily wake-up | GitHub Actions (`.github/workflows/daily-wake.yml`) |
| Tests on every push | GitHub Actions (`.github/workflows/ci.yml`) |

1. **Database:** sign up at [neon.tech](https://neon.tech), create a project, and copy the connection string.
2. **Notification keys:** run `python -m scripts.generate_vapid` and save both keys. Never change them later, or phones stop getting notifications.
3. **Render:** at [render.com](https://render.com), choose New → Blueprint and pick your repo. Fill in:
   - `DATABASE_URL`
   - `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`
   - `VAPID_SUBJECT` (`mailto:` + your email)
   - `EDITION_TIMEZONE` (e.g. `Asia/Kolkata`)
4. **Wake-up job:** Render's free plan sleeps after 15 idle minutes. In GitHub, go to Settings → Secrets and variables → Actions → Variables and add `APP_URL` = your Render URL. Set the cron time in `daily-wake.yml` to just after your edition hour, in UTC. The default is 8:05 AM in India.
5. **Phone:** open your Render URL.
   - **Android:** tap **Install**.
   - **iPhone:** tap **Share → Add to Home Screen** and open the app from there.
   
   Then tap 🔔 → **Turn on notifications** → **Send test**.

Free-plan trade-offs:
- The first visit after the app has been asleep takes ~30–60 s to load.
- GitHub pauses scheduled workflows in repos with no activity for 60 days. Push a commit, or use [cron-job.org](https://cron-job.org) to open `APP_URL/healthz` daily instead.

## Architecture

```
            ┌──────────────── FastAPI server (Python) ────────────────┐
 GitHub     │ scheduler ─► fetch ~30 RSS/Atom feeds (httpx, parallel) │
 Actions ──►│   ─► AI keyword filter ─► merge duplicate stories       │
 (wake-up)  │   ─► cheap pre-rank, keep top 15 ─► read article pages  │
            │   ─► extractive summary + 0-10 score ─► pick top 5      │
            │   ─► save ─► send one Web Push notification ────────────┼─► Google / Apple
            │ REST API: /api/news, /api/subscribe, ... (+ /docs)      │   push services
            └──────────────┬──────────────────────────┬───────────────┘        │
                           │ JSON over HTTPS          │ SQL                    ▼
            ┌──────────────▼─────────────┐  ┌─────────▼─────────┐   notification
            │ PWA on the phone (static/) │  │ Postgres (Neon) or│   on the phone
            │ cards, deep dive, settings │  │ JSON files locally│
            │ service worker: push+offline│ └───────────────────┘
            └────────────────────────────┘
```

### Suggested reading order

| # | File | What you'll learn |
|---|---|---|
| 1 | `app/config.py` | Settings from environment variables with pydantic-settings |
| 2 | `app/models.py` | Pydantic models, camelCase JSON aliases |
| 3 | `app/sources.py` | The curated feed list and trust weights |
| 4 | `app/feeds.py` | Async HTTP with httpx, parsing RSS/Atom with feedparser, HTML with BeautifulSoup |
| 5 | `app/relevance.py` | Regex keyword scoring, topic rules, clustering duplicate stories, ranking |
| 6 | `app/summarize.py` | Extractive summarisation: sentence splitting, word frequency scoring |
| 7 | `app/store.py` | A key-value store with two backends (files / Postgres via psycopg) |
| 8 | `app/push.py` | Web Push: VAPID keys, encryption via pywebpush, per-user rules |
| 9 | `app/pipeline.py` | async orchestration: the daily edition end to end |
| 10 | `app/main.py` | FastAPI: routes, request validation, lifespan, background scheduler, static files |
| 11 | `tests/` | pytest, fixtures, FastAPI's TestClient |
| 12 | `static/` | The phone app (HTML/CSS/JavaScript) and its service worker |

The phone app is JavaScript because phone browsers only run JavaScript. All the logic lives in Python; the front end only displays what the API returns.

### API

| Endpoint | Purpose |
|---|---|
| `GET /api/news?tab=today\|top\|breaking\|deep\|<topic>&offset=N` | A page of stories |
| `GET /api/news/{id}` | One story (opened from a notification) |
| `GET /api/meta` | Topics, edition time, the public push key |
| `POST /api/subscribe` / `POST /api/unsubscribe` | Turn a phone's notifications on/off and save its preferences |
| `POST /api/test-push` | The "Send test" button |
| `POST /api/refresh` | Admin: publish now (needs `Authorization: Bearer <ADMIN_TOKEN>`) |

## Configuration

All settings are environment variables (or a `.env` file). See `.env.example`.

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

To change the sources, put a JSON list in `data/sources.json`. It uses the same fields as `Source` in `app/models.py`.

## Ideas to build next

- **Better free summaries:** TextRank (sentences scored PageRank-style with `networkx`), or a small open-source model via Hugging Face `transformers`.
- **Personalised ranking:** learn from what each user reads, saves and skips.
- **Real database tables:** move from key-value documents to proper tables with SQLAlchemy and Alembic migrations.
- **Accounts:** sign-in with FastAPI's OAuth2 utilities, so saved stories sync across devices.
- **Search:** Postgres full-text search over past stories.
- **Better duplicate detection:** TF-IDF with scikit-learn instead of headline word overlap.
- **App stores:** wrap the PWA with Bubblewrap (Google Play) or Capacitor (iOS).
- **Admin dashboard:** feed health, edition history, subscriber count.

## Before selling it

- **Content rights:** summarising articles and showing their images commercially needs care. Link back prominently (the app does), avoid copying long passages, and check each source's terms.
- **Privacy:** push subscriptions are personal data. Publish a privacy policy and let users delete their data.
- **Paid hosting:** free tiers sleep and have limits. Budget for a small paid plan once you have users.
