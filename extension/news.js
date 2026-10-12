// Update and news banner for the side panel. Reads news.json from the project
// site (generated from the latest GitHub release + site/news.json), caches it
// for an hour and shows at most one banner: a newer version first, then
// unread news. Dismissed items are remembered.

const FEED_URL = 'https://ivlad003.github.io/tabhelm/news.json';
const CACHE_MS = 60 * 60 * 1000;

const lang = /^(uk|ru)/i.test(navigator.language) ? 'uk' : 'en';
const tr = (value) => (typeof value === 'string' ? value : value?.[lang] || value?.en || '');

const TEXT = {
  en: {
    update: (v, mine) => `TabHelm ${v} is available (you have ${mine}).`,
    how: 'Update',
    notes: "What's new",
    steps: 'Run this in a terminal, then press ↻ for TabHelm on chrome://extensions:',
    copy: 'Copy',
    copied: 'Copied',
    dismiss: 'Dismiss',
  },
  uk: {
    update: (v, mine) => `Доступна нова версія TabHelm ${v} (у вас ${mine}).`,
    how: 'Оновити',
    notes: 'Що нового',
    steps: 'Виконайте в терміналі, потім натисніть ↻ біля TabHelm на chrome://extensions:',
    copy: 'Копіювати',
    copied: 'Скопійовано',
    dismiss: 'Закрити',
  },
}[lang];

// "0.10.1" > "0.9.3"
export function newerThan(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

async function loadFeed(force = false) {
  const { newsCache, newsUrl } = await chrome.storage.local.get(['newsCache', 'newsUrl']);
  const url = newsUrl || FEED_URL; // newsUrl lets tests point at a local feed
  if (!force && newsCache?.url === url && Date.now() - newsCache.fetched < CACHE_MS) return newsCache.feed;
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const feed = await res.json();
    await chrome.storage.local.set({ newsCache: { url, fetched: Date.now(), feed } });
    return feed;
  } catch {
    return newsCache?.feed || null; // offline: fall back to the last copy
  }
}

// Returns { latest, mine, newer } so Settings can report the result.
export async function showNews(container, { force = false } = {}) {
  const feed = await loadFeed(force);
  const mine = chrome.runtime.getManifest().version;
  if (!feed) return { latest: null, mine, newer: false };
  const { dismissedNews = [] } = await chrome.storage.local.get('dismissedNews');
  const dismissed = new Set(dismissedNews);
  const dismiss = (id) => chrome.storage.local.set({ dismissedNews: [...dismissed, id].slice(-100) });

  const latest = feed.latest;
  const newer = Boolean(latest?.version && newerThan(latest.version, mine));
  // A manual check shows the update banner even if it was dismissed before.
  if (newer && (force || !dismissed.has(`update:${latest.version}`))) {
    renderUpdate(container, latest, mine, () => dismiss(`update:${latest.version}`));
    return { latest: latest.version, mine, newer };
  }

  const item = (feed.news || []).find(
    (n) =>
      n.id &&
      !dismissed.has(n.id) &&
      (!n.minVersion || !newerThan(n.minVersion, mine)) &&
      (!n.maxVersion || !newerThan(mine, n.maxVersion)),
  );
  if (item) renderItem(container, item, () => dismiss(item.id));
  return { latest: latest?.version || null, mine, newer };
}

function banner(container, kind, onDismiss) {
  const el = document.createElement('div');
  el.className = `banner ${kind}`;
  el.setAttribute('role', 'status');
  const body = document.createElement('div');
  body.className = 'banner-body';
  const close = Object.assign(document.createElement('button'), { className: 'banner-close', textContent: '×', title: TEXT.dismiss });
  close.setAttribute('aria-label', TEXT.dismiss);
  close.onclick = () => {
    onDismiss();
    el.remove();
  };
  el.append(body, close);
  container.replaceChildren(el);
  container.hidden = false;
  return body;
}

function link(text, url) {
  const a = Object.assign(document.createElement('a'), { textContent: text, href: url });
  a.onclick = (e) => {
    e.preventDefault();
    chrome.tabs.create({ url });
  };
  return a;
}

function renderUpdate(container, latest, mine, onDismiss) {
  const body = banner(container, 'update', onDismiss);
  const title = Object.assign(document.createElement('div'), { className: 'banner-title', textContent: TEXT.update(latest.version, mine) });
  const actions = document.createElement('div');
  actions.className = 'banner-actions';
  const how = Object.assign(document.createElement('button'), { className: 'btn small primary', textContent: TEXT.how });
  actions.append(how);
  if (latest.url) actions.append(link(TEXT.notes, latest.url));

  const steps = document.createElement('div');
  steps.className = 'banner-steps';
  steps.hidden = true;
  const cmd = Object.assign(document.createElement('code'), { textContent: latest.install });
  const copy = Object.assign(document.createElement('button'), { className: 'btn small', textContent: TEXT.copy });
  copy.onclick = async () => {
    await navigator.clipboard.writeText(latest.install).catch(() => {});
    copy.textContent = TEXT.copied;
    setTimeout(() => (copy.textContent = TEXT.copy), 1500);
  };
  const row = document.createElement('div');
  row.className = 'banner-cmd';
  row.append(cmd, copy);
  steps.append(Object.assign(document.createElement('div'), { textContent: TEXT.steps }), row);
  how.onclick = () => (steps.hidden = !steps.hidden);

  body.append(title, actions, steps);
}

function renderItem(container, item, onDismiss) {
  const body = banner(container, 'news', onDismiss);
  body.append(Object.assign(document.createElement('div'), { className: 'banner-title', textContent: tr(item.title) }));
  if (item.text) body.append(Object.assign(document.createElement('div'), { textContent: tr(item.text) }));
  if (item.url) {
    const actions = document.createElement('div');
    actions.className = 'banner-actions';
    actions.append(link(lang === 'uk' ? 'Докладніше' : 'Learn more', item.url));
    body.append(actions);
  }
}
