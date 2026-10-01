const $ = (s, el = document) => el.querySelector(s);
const feedEl = $('#feed');
const tabsEl = $('#tabs');

const GLYPHS = { models: '🧠', research: '🔬', products: '📱', business: '💼', policy: '⚖️', 'open-source': '🔓', hardware: '🔌', explainer: '📚' };

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage full or blocked; non-critical
    }
  },
};

const state = {
  meta: null,
  tab: store.get('tab', 'all'),
  items: [],
  total: 0,
  loading: false,
  loadedAt: new Date().toISOString(),
  view: 'feed', // or 'saved'
  read: new Set(store.get('read', [])),
  saved: store.get('saved', []),
  prefs: store.get('prefs', null),
  hideRead: store.get('hideRead', false),
};

// ---------- helpers ----------
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h ago`;
  const d = h / 24;
  return d < 7 ? `${Math.floor(d)}d ago` : new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const categoryLabel = (c) => state.meta?.categories?.[c] || c;

// ---------- tabs ----------
function renderTabs() {
  const tabs = [
    ['all', 'My Feed'],
    ['top', 'Top'],
    ['breaking', 'Breaking'],
    ['deep', 'Deep Reads'],
    ...Object.entries(state.meta.categories),
  ];
  tabsEl.replaceChildren(
    ...tabs.map(([id, label]) =>
      el('button', {
        class: `tab${state.tab === id && state.view === 'feed' ? ' active' : ''}`,
        text: label,
        onclick: () => {
          state.view = 'feed';
          state.tab = id;
          store.set('tab', id);
          $('#bookmarksBtn').classList.remove('on');
          renderTabs();
          loadFeed(true);
        },
      }),
    ),
  );
  tabsEl.querySelector('.active')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}

// ---------- cards ----------
const tpl = $('#cardTpl');

function cardFor(a) {
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.dataset.id = a.id;
  if (state.read.has(a.id)) node.classList.add('read');

  const media = $('.media', node);
  const img = $('img', node);
  const showGlyph = () => {
    img.hidden = true;
    media.classList.add('noimg');
    media.dataset.glyph = GLYPHS[a.category] || '✦';
  };
  if (a.image) {
    img.src = a.image;
    img.onerror = showGlyph;
  } else showGlyph();

  const cat = $('.cat', node);
  cat.textContent = a.breaking ? 'BREAKING' : categoryLabel(a.category);
  if (a.breaking) cat.classList.add('breaking');

  $('.headline', node).textContent = a.headline;
  $('.summary', node).textContent = a.summary;
  const more = a.coverage?.length ? ` · +${a.coverage.length} source${a.coverage.length > 1 ? 's' : ''}` : '';
  $('.byline', node).textContent = `${a.sourceName}${a.author ? ` · ${a.author}` : ''} · ${timeAgo(a.publishedAt)}${more}`;

  const footer = $('.footer', node);
  footer.href = a.url;
  footer.append('Read the full story at ', el('b', { text: a.sourceName }), ' →');

  const hasDeep = a.whyItMatters || a.context || a.keyPoints?.length;
  const deepBtn = $('.deep', node);
  if (hasDeep) deepBtn.onclick = () => openStory(a);
  else deepBtn.remove();

  const saveBtn = $('.save', node);
  const syncSave = () => saveBtn.classList.toggle('on', state.saved.some((s) => s.id === a.id));
  syncSave();
  saveBtn.onclick = () => {
    toggleSaved(a);
    syncSave();
  };
  $('.share', node).onclick = () => share(a);
  // Tapping the text opens the deep dive, like Inshorts' tap-to-expand.
  $('.content', node).addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    if (hasDeep) openStory(a);
  });
  return node;
}

function emptyCard(message, spinner = false) {
  return el('section', { class: 'empty' }, spinner ? el('div', { class: 'spinner' }) : null, el('p', { text: message }));
}

function visibleItems() {
  const list = state.view === 'saved' ? state.saved : state.items;
  return state.hideRead && state.view === 'feed' ? list.filter((a) => !state.read.has(a.id)) : list;
}

function renderFeed() {
  const list = visibleItems();
  if (!list.length) {
    let msg = 'No stories here yet. New AI news is pulled every 30 minutes.';
    if (state.view === 'saved') msg = 'Nothing saved yet. Tap the bookmark on any story to keep it here.';
    else if (state.loading) msg = 'Loading the latest AI news…';
    else if (state.hideRead && state.items.length) msg = "You're all caught up. 🎉";
    feedEl.replaceChildren(emptyCard(msg, state.loading));
  } else {
    feedEl.replaceChildren(...list.map(cardFor));
    if (state.view === 'feed' && state.items.length >= state.total) feedEl.append(emptyCard("You're all caught up. 🎉 Check back soon."));
  }
  observeCards();
  updateProgress();
}

async function loadFeed(reset = false) {
  if (state.loading) return;
  state.loading = true;
  if (reset) {
    state.items = [];
    state.total = 0;
    feedEl.scrollTop = 0;
    renderFeed();
  }
  try {
    const params = new URLSearchParams({ offset: String(state.items.length) });
    if (state.tab !== 'all') params.set('tab', state.tab);
    else if (state.prefs?.topics?.length) params.set('topics', state.prefs.topics.join(','));
    const data = await api(`/api/news?${params}`);
    state.total = data.total;
    const known = new Set(state.items.map((a) => a.id));
    const added = data.items.filter((a) => !known.has(a.id));
    state.items.push(...added);
    if (reset) state.loadedAt = new Date().toISOString();
    if (reset) renderFeed();
    else {
      const visible = state.hideRead ? added.filter((a) => !state.read.has(a.id)) : added;
      feedEl.querySelector('.empty')?.remove();
      feedEl.append(...visible.map(cardFor));
      if (state.items.length >= state.total) feedEl.append(emptyCard("You're all caught up. 🎉 Check back soon."));
      observeCards();
    }
  } catch (err) {
    if (reset) feedEl.replaceChildren(emptyCard(`Couldn't load news (${err.message}). Tap a section above to retry.`));
  } finally {
    state.loading = false;
    if (reset && !state.items.length) renderFeed();
  }
}

// Mark as read after a card has been on screen for a moment; prefetch the next page near the end.
let io;
function observeCards() {
  io?.disconnect();
  const timers = new Map();
  io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const id = e.target.dataset.id;
        if (!id) continue;
        if (e.isIntersecting) {
          timers.set(id, setTimeout(() => markRead(id, e.target), 1500));
          const cards = [...feedEl.querySelectorAll('.card')];
          if (state.view === 'feed' && cards.indexOf(e.target) >= cards.length - 4 && state.items.length < state.total) loadFeed();
        } else clearTimeout(timers.get(id));
      }
    },
    { root: feedEl, threshold: 0.7 },
  );
  feedEl.querySelectorAll('.card').forEach((c) => io.observe(c));
}

function markRead(id, node) {
  if (state.read.has(id)) return;
  state.read.add(id);
  node.classList.add('read');
  store.set('read', [...state.read].slice(-1500));
}

function updateProgress() {
  const cards = feedEl.querySelectorAll('.card');
  const idx = Math.round(feedEl.scrollTop / Math.max(1, feedEl.clientHeight));
  $('#progress').textContent = cards.length ? `${Math.min(idx + 1, cards.length)} / ${state.view === 'saved' ? cards.length : state.total}` : '';
}
feedEl.addEventListener('scroll', () => requestAnimationFrame(updateProgress), { passive: true });

// ---------- deep dive ----------
function section(title, ...body) {
  return [el('h3', { text: title }), ...body];
}

function openStory(a) {
  const content = [
    el('p', { class: 'muted small', text: `${a.breaking ? 'BREAKING · ' : ''}${categoryLabel(a.category)} · ${a.sourceName} · ${timeAgo(a.publishedAt)}` }),
    el('h2', { class: 'title', id: 'sheetTitle', text: a.headline }),
    el('p', { text: a.summary }),
  ];
  if (a.whyItMatters) content.push(...section('Why it matters', el('p', { text: a.whyItMatters })));
  if (a.keyPoints?.length) content.push(...section('Key points', el('ul', {}, a.keyPoints.map((k) => el('li', { text: k })))));
  if (a.context) content.push(...section('The background', el('p', { text: a.context })));
  if (a.coverage?.length)
    content.push(
      ...section(
        'Also covered by',
        el('ul', { class: 'coverage' }, a.coverage.map((c) => el('li', {}, el('a', { href: c.url, target: '_blank', rel: 'noopener', text: c.sourceName }), ` — ${c.title}`))),
      ),
    );
  if (a.tags?.length) content.push(el('div', { class: 'tags' }, a.tags.map((t) => el('span', { text: `#${t}` }))));
  content.push(el('a', { class: 'read-full', href: a.url, target: '_blank', rel: 'noopener', text: `Read the full story at ${a.sourceName}` }));
  $('#sheetContent').replaceChildren(...content);
  openSheet('#sheet');
  const card = feedEl.querySelector(`[data-id="${a.id}"]`);
  if (card) markRead(a.id, card);
}

function openSheet(sel) {
  const s = $(sel);
  s.hidden = false;
  $('.sheet-body', s).scrollTop = 0;
  history.pushState({ sheet: sel }, '');
}
function closeSheets() {
  document.querySelectorAll('.sheet').forEach((s) => (s.hidden = true));
}
document.querySelectorAll('.sheet').forEach((s) =>
  s.addEventListener('click', (e) => {
    if (e.target.matches('[data-close]')) history.back();
  }),
);
window.addEventListener('popstate', closeSheets);

// ---------- save / share ----------
function toggleSaved(a) {
  const i = state.saved.findIndex((s) => s.id === a.id);
  if (i >= 0) state.saved.splice(i, 1);
  else state.saved.unshift(a);
  store.set('saved', state.saved.slice(0, 200));
  toast(i >= 0 ? 'Removed from saved' : 'Saved');
}

async function share(a) {
  const data = { title: a.headline, text: `${a.headline}\n\n${a.summary}`, url: a.url };
  try {
    if (navigator.share) await navigator.share(data);
    else {
      await navigator.clipboard.writeText(`${a.headline}\n${a.url}`);
      toast('Link copied');
    }
  } catch {
    // user cancelled
  }
}

$('#bookmarksBtn').onclick = () => {
  state.view = state.view === 'saved' ? 'feed' : 'saved';
  $('#bookmarksBtn').classList.toggle('on', state.view === 'saved');
  renderTabs();
  feedEl.scrollTop = 0;
  renderFeed();
};

// ---------- new-story polling ----------
async function checkForNew() {
  if (document.hidden || state.view !== 'feed') return;
  try {
    const params = new URLSearchParams({ since: state.loadedAt });
    if (state.tab !== 'all') params.set('tab', state.tab);
    const data = await api(`/api/news?${params}`);
    $('#newPill').hidden = !data.newSince;
    $('#newPill').textContent = `↑ ${data.newSince} new ${data.newSince === 1 ? 'story' : 'stories'}`;
  } catch {
    // offline; try later
  }
}
$('#newPill').onclick = () => {
  $('#newPill').hidden = true;
  loadFeed(true);
};
setInterval(checkForNew, 3 * 60e3);
document.addEventListener('visibilitychange', checkForNew);

// Keyboard navigation for desktop.
document.addEventListener('keydown', (e) => {
  if (!$('#sheet').hidden || !$('#settings').hidden) {
    if (e.key === 'Escape') history.back();
    return;
  }
  const dir = { ArrowDown: 1, j: 1, ' ': 1, ArrowUp: -1, k: -1 }[e.key];
  if (dir) {
    e.preventDefault();
    feedEl.scrollBy({ top: dir * feedEl.clientHeight, behavior: 'smooth' });
  }
});

// ---------- notifications ----------
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function currentSubscription() {
  if (!pushSupported) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

function readPrefsForm() {
  return {
    level: $('#level').value,
    topics: [...document.querySelectorAll('#topicChips .on')].map((b) => b.dataset.topic),
    maxPerDay: Number($('#maxPerDay').value) || 6,
    quietStart: Number($('#quietStart').value),
    quietEnd: Number($('#quietEnd').value),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

function fillPrefsForm(p) {
  $('#level').value = p.level;
  $('#maxPerDay').value = p.maxPerDay;
  $('#quietStart').value = p.quietStart;
  $('#quietEnd').value = p.quietEnd;
  document.querySelectorAll('#topicChips button').forEach((b) => b.classList.toggle('on', p.topics.includes(b.dataset.topic)));
}

async function refreshPushUi() {
  const sub = await currentSubscription().catch(() => null);
  const status = $('#pushStatus');
  $('#iosHint').hidden = !(isIos && !isStandalone);
  if (!pushSupported) {
    status.textContent = isIos ? 'Add AI Shorts to your Home Screen to get notifications.' : "This browser doesn't support push notifications.";
    $('#enablePush').hidden = true;
  } else if (Notification.permission === 'denied') {
    status.textContent = 'Notifications are blocked. Allow them for this site in your browser or phone settings, then come back.';
    $('#enablePush').hidden = true;
  } else {
    status.textContent = sub ? "Notifications are on. We'll only ping you for stories that clear your bar." : 'Get a phone alert when important AI news breaks.';
    $('#enablePush').hidden = false;
    $('#enablePush').textContent = sub ? 'Save preferences' : 'Turn on notifications';
  }
  $('#testPush').hidden = !sub;
  $('#disablePush').hidden = !sub;
  $('#bellDot').hidden = Boolean(sub) || !pushSupported || Notification.permission === 'denied';
}

async function savePrefs() {
  state.prefs = readPrefsForm();
  store.set('prefs', state.prefs);
}

$('#enablePush').onclick = async () => {
  await savePrefs();
  try {
    if (Notification.permission !== 'granted') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return refreshPushUi();
    }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(state.meta.vapidPublicKey) });
    }
    await api('/api/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), prefs: state.prefs } });
    toast(state.prefs.level === 'off' ? 'Preferences saved (alerts paused)' : 'Notifications on 🔔');
  } catch (err) {
    toast(`Couldn't enable notifications: ${err.message}`);
  }
  refreshPushUi();
  if (state.tab === 'all') loadFeed(true);
};

$('#disablePush').onclick = async () => {
  const sub = await currentSubscription();
  if (sub) {
    await api('/api/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  }
  toast('Notifications off');
  refreshPushUi();
};

$('#testPush').onclick = async () => {
  const sub = await currentSubscription();
  if (!sub) return;
  try {
    await api('/api/test-push', { method: 'POST', body: { endpoint: sub.endpoint } });
    toast('Test sent — check your notifications');
  } catch (err) {
    toast(err.message);
  }
};

$('#hideRead').onchange = (e) => {
  state.hideRead = e.target.checked;
  store.set('hideRead', state.hideRead);
  renderFeed();
};

$('#settingsBtn').onclick = () => {
  refreshPushUi();
  openSheet('#settings');
};

function buildSettings() {
  const hours = [...Array(24).keys()].map((h) => el('option', { value: h, text: new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' }) }));
  $('#quietStart').replaceChildren(...hours.map((o) => o.cloneNode(true)));
  $('#quietEnd').replaceChildren(...hours);
  $('#topicChips').replaceChildren(
    ...Object.entries(state.meta.categories).map(([id, label]) =>
      el('button', { 'data-topic': id, text: label, onclick: (e) => e.currentTarget.classList.toggle('on') }),
    ),
  );
  fillPrefsForm({ ...state.meta.defaultPrefs, ...(state.prefs || {}) });
  $('#hideRead').checked = state.hideRead;
  const lr = state.meta.lastRefresh;
  $('#aboutLine').textContent = `Briefs written by ${state.meta.claude ? 'Claude' : 'extractive summaries (add an Anthropic API key for Claude briefs)'}${
    lr ? ` · last updated ${timeAgo(lr.at)} from ${lr.sources} sources` : ''
  }.`;
}

// ---------- boot ----------
async function openDeepLink() {
  const id = new URLSearchParams(location.search).get('story');
  if (!id) return;
  history.replaceState(null, '', '/');
  try {
    const a = await api(`/api/news/${id}`);
    state.items = [a, ...state.items.filter((x) => x.id !== a.id)];
    renderFeed();
    feedEl.scrollTop = 0;
    if (a.whyItMatters || a.context) openStory(a);
  } catch {
    // story expired
  }
}

async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try {
    state.meta = await api('/api/meta');
  } catch {
    feedEl.replaceChildren(emptyCard("Can't reach the server. Check your connection."));
    return;
  }
  if (state.tab !== 'all' && !['top', 'breaking', 'deep'].includes(state.tab) && !state.meta.categories[state.tab]) state.tab = 'all';
  renderTabs();
  buildSettings();
  await loadFeed(true);
  await openDeepLink();
  refreshPushUi();
}

// Notification clicks while the app is already open.
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'open-url') {
    history.replaceState(null, '', e.data.url);
    openDeepLink();
  }
});

boot();
