// Chat history: every chat is saved in chrome.storage.local (journal + where it
// happened) and can be reopened — on its own tab if that tab still exists,
// otherwise by navigating the current tab back to the chat's page.
// A chat can be marked as a favourite (★) and given labels; History filters by
// both, and favourites are never dropped — not by the 200-chat limit, not by Clear all.

const $ = (id) => document.getElementById(id);
const MAX_CHATS = 200;
let onOpen = () => {};
let onExport = () => {};
let currentId = null;
let onlyStarred = false; // History filters, kept while the panel is open
let labelFilter = '';

// ---------- Favourites and labels (pure: also run by the node tests) ----------

export const LABEL_MAX = 24;
export const LABELS_PER_CHAT = 8;
export const cleanLabel = (text) => String(text ?? '').replace(/[\s,]+/g, ' ').trim().slice(0, LABEL_MAX).trim();

// `text` may name several labels, separated by commas. A label a chat already has
// (in any letter case) is not added twice; the first spelling stays.
export function addLabels(labels = [], text = '') {
  const out = [...labels];
  for (const part of String(text).split(',')) {
    const label = cleanLabel(part);
    if (label && out.length < LABELS_PER_CHAT && !out.some((l) => l.toLowerCase() === label.toLowerCase())) out.push(label);
  }
  return out;
}

// Saving a chat rebuilds its index entry; what the user marked on it stays.
export function carryMarks(meta, prev) {
  return { ...meta, ...(prev?.starred ? { starred: true } : {}), ...(prev?.labels?.length ? { labels: prev.labels } : {}) };
}

// At most `max` chats that are not favourites are kept (newest first); favourites all stay.
export function pruneIndex(index, max) {
  const kept = [];
  const dropped = [];
  let plain = 0;
  for (const c of index) {
    if (c.starred || plain++ < max) kept.push(c);
    else dropped.push(c);
  }
  return { kept, dropped };
}

// What History lists: favourites only, one label, a search over the text and the labels.
export function filterChats(index, { q = '', starred = false, label = '' } = {}, stepHits = new Map()) {
  const query = q.trim().toLowerCase();
  const wanted = label.toLowerCase();
  return index.filter((c) => {
    if (starred && !c.starred) return false;
    if (wanted && !(c.labels || []).some((l) => l.toLowerCase() === wanted)) return false;
    return !query || stepHits.has(c.id) || `${c.title} ${c.url} ${c.pageTitle} ${c.agent} ${(c.labels || []).join(' ')}`.toLowerCase().includes(query);
  });
}

// Every label in use with the number of chats it is on, most used first.
export function labelCounts(index) {
  const counts = new Map();
  for (const c of index) {
    for (const l of c.labels || []) {
      const seen = counts.get(l.toLowerCase());
      counts.set(l.toLowerCase(), { label: seen?.label || l, n: (seen?.n || 0) + 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
}

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
  const { kept: index, dropped } = pruneIndex([carryMarks(meta, chatIndex.find((c) => c.id === chat.id)), ...chatIndex.filter((c) => c.id !== chat.id)], MAX_CHATS);
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

// Marks on a chat (favourite, labels) live in its index entry.
async function updateMeta(id, change) {
  const { chatIndex = [] } = await chrome.storage.local.get('chatIndex');
  await chrome.storage.local.set({ chatIndex: chatIndex.map((c) => (c.id === id ? change({ ...c }) : c)) });
  render();
}

const toggleStar = (id) =>
  updateMeta(id, (c) => {
    if (c.starred) delete c.starred;
    else c.starred = true;
    return c;
  });
const labelChat = (id, text) => updateMeta(id, (c) => ({ ...c, labels: addLabels(c.labels, text) }));
const unlabelChat = (id, label) =>
  updateMeta(id, (c) => {
    const labels = (c.labels || []).filter((l) => l !== label);
    if (labels.length) c.labels = labels;
    else delete c.labels;
    return c;
  });

// Everything except the chat that is open right now (its journal is still in memory) and the favourites.
async function clearHistory() {
  const { chatIndex = [] } = await chrome.storage.local.get('chatIndex');
  const stays = (c) => c.id === currentId || c.starred;
  const gone = chatIndex.filter((c) => !stays(c));
  if (!gone.length) return;
  const kept = chatIndex.filter((c) => c.starred && c.id !== currentId).length;
  if (!confirm(`Delete ${gone.length} saved chat${gone.length === 1 ? '' : 's'}?${kept ? ` Your ${kept} favourite${kept === 1 ? ' stays' : 's stay'}.` : ''} Exported files are not affected.`)) return;
  await chrome.storage.local.set({ chatIndex: chatIndex.filter(stays) });
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
  // A label that is gone from every chat cannot stay selected.
  const labels = labelCounts(chatIndex);
  if (labelFilter && !labels.some((l) => l.label.toLowerCase() === labelFilter.toLowerCase())) labelFilter = '';
  const favourites = chatIndex.filter((c) => c.starred).length;
  if (!favourites) onlyStarred = false;
  renderFilters(favourites, labels);
  const list = filterChats(chatIndex, { q, starred: onlyStarred, label: labelFilter }, stepHits);
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
  $('history-empty').textContent = chatIndex.length ? 'No chats match.' : 'No saved chats yet.';
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
      // ★ keeps a chat: favourites survive the 200-chat limit and Clear all.
      const star = Object.assign(document.createElement('button'), { type: 'button', className: `history-star${c.starred ? ' on' : ''}`, textContent: c.starred ? '★' : '☆', title: c.starred ? 'Remove from favourites' : 'Add to favourites (kept when History is cleared)' });
      star.setAttribute('aria-pressed', String(Boolean(c.starred)));
      star.setAttribute('aria-label', `${c.starred ? 'Remove from' : 'Add to'} favourites: ${c.title}`);
      star.onclick = () => toggleStar(c.id);
      li.append(star, open, md, js, del, labelRow(c));
      return li;
    }),
  );
}

// The filters above the list: favourites, and one chip per label in use.
function renderFilters(favourites, labels) {
  const bar = $('history-filters');
  bar.hidden = !favourites && !labels.length;
  const chip = (text, on, title, click) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: `history-chip${on ? ' on' : ''}`, textContent: text, title });
    b.setAttribute('aria-pressed', String(on));
    b.onclick = click;
    return b;
  };
  const same = (label) => labelFilter.toLowerCase() === label.toLowerCase();
  bar.replaceChildren(
    ...(favourites
      ? [
          chip(`★ Favourites (${favourites})`, onlyStarred, 'Show only favourites', () => {
            onlyStarred = !onlyStarred;
            render();
          }),
        ]
      : []),
    ...labels.map(({ label, n }) =>
      chip(`${label} (${n})`, same(label), `Show only chats labelled “${label}”`, () => {
        labelFilter = same(label) ? '' : label;
        render();
      }),
    ),
  );
}

// A chat's labels: click one to filter by it, × takes it off, ＋ adds (several with commas).
function labelRow(c) {
  const row = Object.assign(document.createElement('div'), { className: 'history-labels' });
  for (const label of c.labels || []) {
    const chip = Object.assign(document.createElement('span'), { className: 'history-label' });
    const name = Object.assign(document.createElement('button'), { type: 'button', className: 'history-label-name', textContent: label, title: `Show only chats labelled “${label}”` });
    name.onclick = () => {
      labelFilter = label;
      render();
    };
    const off = Object.assign(document.createElement('button'), { type: 'button', className: 'history-label-off', textContent: '×', title: `Remove the label “${label}”` });
    off.setAttribute('aria-label', `Remove the label ${label} from ${c.title}`);
    off.onclick = () => unlabelChat(c.id, label);
    chip.append(name, off);
    row.append(chip);
  }
  if ((c.labels || []).length < LABELS_PER_CHAT) {
    const add = Object.assign(document.createElement('button'), { type: 'button', className: 'history-label-add', textContent: '＋ label', title: 'Add a label to this chat (several with commas)' });
    add.onclick = () => {
      const input = Object.assign(document.createElement('input'), { className: 'history-label-input', placeholder: 'label, another…', maxLength: 80 });
      input.setAttribute('aria-label', `New label for ${c.title}`);
      // Enter adds; Escape, or leaving the field empty, cancels.
      let settled = false;
      const done = (save) => {
        if (settled) return;
        settled = true;
        if (save && cleanLabel(input.value)) labelChat(c.id, input.value);
        else input.replaceWith(add);
      };
      input.onkeydown = (e) => {
        if (e.key === 'Enter') done(true);
        else if (e.key === 'Escape') done(false);
      };
      input.onblur = () => done(Boolean(input.value.trim()));
      add.replaceWith(input);
      input.focus();
    };
    row.append(add);
  }
  return row;
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
