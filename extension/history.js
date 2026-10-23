// Chat history: every chat is saved in chrome.storage.local (journal + where it
// happened) and can be reopened — on its own tab if that tab still exists,
// otherwise by navigating the current tab back to the chat's page.

const $ = (id) => document.getElementById(id);
const MAX_CHATS = 200;
let onOpen = () => {};
let onExport = () => {};
let currentId = null;

export function initHistory({ open, export: exp }) {
  onOpen = open;
  onExport = exp || (() => {});
  $('history-open').onclick = () => toggle(true);
  $('history-close').onclick = () => toggle(false);
  $('history-search').oninput = render;
  $('history-clear').onclick = clearHistory;
}

export function setCurrentChat(id) {
  currentId = id;
}

export function newChatId() {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export async function loadChat(id) {
  return (await chrome.storage.local.get(`chat:${id}`))[`chat:${id}`] || null;
}

// Saves the chat and updates the index shown in History.
export async function saveChat(chat) {
  const firstUser = chat.journal?.find((e) => e.type === 'user');
  if (!firstUser) return;
  const meta = {
    id: chat.id,
    title: firstUser.text.replace(/\s+/g, ' ').slice(0, 90),
    updated: Date.now(),
    created: chat.created,
    tabId: chat.tabId,
    url: chat.url,
    pageTitle: chat.pageTitle,
    agent: chat.agent,
    folder: chat.folder,
    messages: chat.journal.filter((e) => e.type === 'user').length,
    // Chats from automated tests and scheduled runs are told apart by the self-analysis.
    ...(chat.test ? { test: true } : {}),
    ...(chat.scheduled ? { scheduled: true } : {}),
  };
  const { chatIndex = [] } = await chrome.storage.local.get('chatIndex');
  const index = [meta, ...chatIndex.filter((c) => c.id !== chat.id)];
  const dropped = index.splice(MAX_CHATS);
  await chrome.storage.local.set({ chatIndex: index, [`chat:${chat.id}`]: { ...chat, updated: meta.updated } });
  if (dropped.length) await chrome.storage.local.remove(dropped.map((c) => `chat:${c.id}`));
  if (typeof document !== 'undefined' && !$('history').hidden) render();
}

async function deleteChat(id) {
  const { chatIndex = [] } = await chrome.storage.local.get('chatIndex');
  await chrome.storage.local.set({ chatIndex: chatIndex.filter((c) => c.id !== id) });
  await chrome.storage.local.remove(`chat:${id}`);
  render();
}

// Everything except the chat that is open right now (its journal is still in memory).
async function clearHistory() {
  const { chatIndex = [] } = await chrome.storage.local.get('chatIndex');
  const gone = chatIndex.filter((c) => c.id !== currentId);
  if (!gone.length) return;
  if (!confirm(`Delete ${gone.length} saved chat${gone.length === 1 ? '' : 's'}? Exported files are not affected.`)) return;
  await chrome.storage.local.set({ chatIndex: chatIndex.filter((c) => c.id === currentId) });
  await chrome.storage.local.remove(gone.map((c) => `chat:${c.id}`));
  render();
}

function toggle(open) {
  $('history').hidden = !open;
  if (open) $('report').hidden = true;
  $('log').hidden = open || !$('settings').hidden || !$('report').hidden;
  $('history-open').setAttribute('aria-pressed', String(open));
  if (open) {
    $('settings').hidden = true;
    $('history-search').value = '';
    render();
  } else {
    $('log').hidden = !$('settings').hidden;
  }
}

export function closeHistory() {
  toggle(false);
}

const ago = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};

async function render() {
  const { chatIndex = [], features = {} } = await chrome.storage.local.get(['chatIndex', 'features']);
  const q = $('history-search').value.trim().toLowerCase();
  // Action database flag: the search also looks through the steps of every chat.
  const stepHits = new Map();
  if (q.length >= 3 && features.actionDb) {
    const all = await chrome.storage.local.get(chatIndex.map((c) => `chat:${c.id}`));
    for (const c of chatIndex) {
      const n = (all[`chat:${c.id}`]?.journal || []).filter((e) => e.type === 'action' && `${e.desc} ${e.error || ''}`.toLowerCase().includes(q)).length;
      if (n) stepHits.set(c.id, n);
    }
  }
  const list = chatIndex.filter((c) => !q || stepHits.has(c.id) || `${c.title} ${c.url} ${c.pageTitle} ${c.agent}`.toLowerCase().includes(q));
  // Which chats still have their tab open (decided before the click, so the
  // click handler can open that tab's side panel within the user gesture).
  const alive = new Set();
  await Promise.all(
    list.map(async (c) => {
      const tab = c.tabId != null ? await chrome.tabs.get(c.tabId).catch(() => null) : null;
      if (tab && sameDoc(tab.url, c.url)) alive.add(c.id);
    }),
  );
  $('history-empty').hidden = list.length > 0;
  $('history-clear').hidden = !chatIndex.length;
  $('history-list').replaceChildren(
    ...list.map((c) => {
      const li = document.createElement('li');
      li.className = `history-item${c.id === currentId ? ' current' : ''}`;
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'history-open';
      const title = Object.assign(document.createElement('span'), { className: 'history-title', textContent: c.title });
      let host = '';
      try {
        host = new URL(c.url).host;
      } catch {}
      const meta = Object.assign(document.createElement('span'), {
        className: 'history-meta',
        textContent: [host, c.agent, `${c.messages} msg`, ago(c.updated), alive.has(c.id) ? 'tab open' : null, stepHits.has(c.id) ? `${stepHits.get(c.id)} step(s) match` : null].filter(Boolean).join(' · '),
      });
      open.title = `${c.pageTitle || ''}\n${c.url || ''}${c.folder ? `\nFolder: ${c.folder}` : ''}`;
      open.append(title, meta);
      open.onclick = () => onOpen(c, alive.has(c.id));
      const md = Object.assign(document.createElement('button'), { className: 'btn small history-export', textContent: '⬇', title: 'Export: chat + action log (.md)' });
      md.onclick = () => onExport(c, 'md');
      const js = Object.assign(document.createElement('button'), { className: 'btn small history-export-json', textContent: '{ }', title: 'Export: full log (.json)' });
      js.onclick = () => onExport(c, 'json');
      const del = Object.assign(document.createElement('button'), { className: 'btn small history-delete', textContent: '🗑', title: 'Delete this chat' });
      del.setAttribute('aria-label', `Delete chat ${c.title}`);
      del.onclick = () => {
        if (confirm(`Delete the chat “${c.title}”?`)) deleteChat(c.id);
      };
      li.append(open, md, js, del);
      return li;
    }),
  );
}

export function sameDoc(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname;
  } catch {
    return false;
  }
}
