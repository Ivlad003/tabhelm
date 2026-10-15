import { showNews } from './news.js';
import { renderMarkdown } from './markdown.js';
import { initSettings, handleSettingsMessage, hostVersionMismatch, skillPayload, slashSkills, onFeaturesChanged, setAgents, skillsChanged } from './settings.js';
import { getFeatures } from './features.js';
import { initVoice, handleVoiceMessage, stop as stopVoice } from './voice.js';
import { initAttachments, takeAttachments, hasAttachments, chip, addQuote, addImageUrl, addElements } from './attachments.js';
import { pickElements } from './page-scripts.js';
import { scriptMatches } from './scripts-lib.js';
import { initFolder, currentFolder, handleFolderMessage, updateFolderWarning, restoreFolder } from './folder.js';
import { initHistory, saveChat, loadChat, newChatId, setCurrentChat, closeHistory } from './history.js';

const tabId = Number(new URLSearchParams(location.search).get('tabId'));
const $ = (id) => document.getElementById(id);
const els = {
  agent: $('agent'),

  status: $('status'),

  config: $('config'),
  newChat: $('new-chat'),
  record: $('record'),
  recIndicator: $('rec-indicator'),
  log: $('log'),
  empty: $('empty'),
  input: $('input'),
  send: $('send'),
  auto: $('auto'),
};

let connected = false;
let restorePrefs = false; // apply the saved model/effort once per connection
let busy = false;
let agentBubble = null; // current streaming agent message
let agentText = '';
let thoughtEl = null;
let planEl = null;
const toolCards = new Map();
// Chronological record of this chat. It is handed to the next agent when you
// switch (so it can continue) and is what Export writes out.
let journal = []; // { ts, type, ...data }
let turn = null; // { text, thought, actions } for the message being worked on
let pendingContext = null; // conversation handed to the next agent with its first message
let autoContinue = null; // message sent automatically once the next agent is ready
let connectedAgent = null;
let currentModel = null;
let agentsList = [];
// The chat is saved to History after changes (debounced).
let chatId = null;
let chatCreated = null;
let replaying = false; // true while a saved chat is rendered; nothing is recorded
let saveTimer = null;
const record = (type, data = {}) => {
  if (replaying) return;
  journal.push({ ts: new Date().toISOString(), type, ...data });
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCurrentChat, 600);
};

async function saveCurrentChat() {
  if (!journal.some((e) => e.type === 'user')) return;
  if (!chatId) {
    chatId = newChatId();
    chatCreated = Date.now();
    setCurrentChat(chatId);
    chrome.storage.session.set({ [`activeChat:${tabId}`]: chatId });
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  await saveChat({
    id: chatId,
    created: chatCreated,
    tabId,
    url: tab?.url,
    pageTitle: tab?.title,
    agent: connectedAgent?.name || journal.findLast?.((e) => e.agent)?.agent || null,
    folder: currentFolder(),
    journal,
  });
}
// Usage reported by the agent: running session cost and context window use.
const usage = { cost: null, currency: 'USD', context: null, lastTurn: null };
const emptyTemplate = $('empty').cloneNode(true);

const port = chrome.runtime.connect({ name: `panel:${tabId}` });
port.onMessage.addListener(onMessage);
port.postMessage({ type: 'list_agents' });

// ---------- Tab binding ----------

// The agent acts on this tab unless it switched to another one via browser_tabs.
let targetTabId = tabId;

// One chip for tabs: shown when the agent works on another tab or tabs are shared.
let groupState = { grouped: false, count: 1 };
async function showTab() {
  const chip = $('tab-chip');
  const other = targetTabId !== tabId;
  const tab = other ? await chrome.tabs.get(targetTabId).catch(() => null) : null;
  if (!other && !groupState.grouped) chip.hidden = true;
  else {
    chip.hidden = false;
    const parts = [other ? `On: ${truncate(tab?.title || tab?.url || 'closed tab', 28)}` : 'This tab', groupState.grouped ? `${groupState.count} in group` : null].filter(Boolean);
    chip.textContent = `🗂 ${parts.join(' · ')}`;
    chip.title = groupState.grouped ? 'Drag tabs into the green "TabHelm" group to share them; drag them out to stop. Click for options.' : 'Click to share more tabs with this chat';
  }
  $('context').hidden = chip.hidden && $('folder-chip').hidden;
}
$('tab-chip').onclick = () => {
  $('plus-menu').open = true;
  $('group-tabs').focus();
};
showTab();
chrome.tabs.onUpdated.addListener((id, info) => {
  if (id === targetTabId && (info.title || info.url)) showTab();
});
chrome.tabs.onRemoved.addListener((id) => {
  if (id !== targetTabId) return;
  targetTabId = tabId;
  showTab();
});

// ---------- Messages from host ----------

let versionWarned = false;

function onMessage(msg) {
  if (msg.requestId != null && hostWaits.has(`${msg.type}:${msg.requestId}`)) {
    hostWaits.get(`${msg.type}:${msg.requestId}`)(msg);
    hostWaits.delete(`${msg.type}:${msg.requestId}`);
    return;
  }
  if (handleVoiceMessage(msg) || handleSettingsMessage(msg) || handleFolderMessage(msg)) return;
  switch (msg.type) {
    case 'agents':
      fillAgents(msg.agents);
      if (!versionWarned && hostVersionMismatch()) {
        versionWarned = true;
        const m = hostVersionMismatch();
        notice(`The TabHelm host (${m.host}) and extension (${m.extension}) are different versions. Run the installer again, then press ↻ for TabHelm on chrome://extensions.`, true);
      }
      break;
    case 'status':
      onStatus(msg);
      break;
    case 'update':
      onUpdate(msg.update);
      break;
    case 'tool_activity':
      addAction(msg);
      break;
    case 'permission':
      addPermission(msg);
      break;
    case 'ask':
      addAsk(msg);
      break;
    case 'interjected':
      markInterjected(msg.texts || []);
      break;
    case 'guide_progress':
      showGuideStep(msg);
      break;
    case 'guide_done':
      finishGuideCard(msg);
      break;
    case 'page_script_result':
      if (msg.ok) notice(`Ran “${msg.name}”${msg.result ? `: ${String(msg.result).slice(0, 300)}` : '.'}`);
      else notice(`Script “${msg.name || ''}” failed: ${msg.error}`, true);
      record('page_script', { name: msg.name, ok: msg.ok, error: msg.error });
      break;
    case 'ask_resolved':
      askCards.get(msg.id)?.(msg.reply?.done ? 'Clicked on the page' : 'Closed');
      askCards.delete(msg.id);
      break;
    case 'skills_changed':
      skillsChanged();
      break;
    case 'paused':
      setPaused(msg.paused);
      break;
    case 'page_context':
      // Selection or image sent from the page (context menu, shortcut, + menu).
      if (msg.kind === 'image') addImageUrl(msg.srcUrl, msg.pageUrl);
      else addQuote({ text: msg.text, pageUrl: msg.pageUrl, pageTitle: msg.pageTitle });
      els.input.focus();
      break;
    case 'confirm':
      addConfirm(msg);
      break;
    case 'config':
      renderConfig(msg.options);
      break;
    case 'auth':
      addAuth(msg);
      break;
    case 'target':
      targetTabId = msg.tabId;
      showTab();
      break;
    case 'frame':
      onFrame(msg);
      break;
    case 'group':
      showGroup(msg);
      break;
    case 'record_error':
      notice(`Recording failed: ${msg.message}`, true);
      stopRecording(true);
      break;
    case 'recording_saved':
      onRecordingSaved(msg);
      break;
    case 'recording_deleted':
      finishDelete(msg.id);
      break;
    case 'usage':
      if (msg.cost) Object.assign(usage, { cost: msg.cost.amount, currency: msg.cost.currency || 'USD' });
      if (msg.size) usage.context = { used: msg.used, size: msg.size };
      renderUsageButton();
      break;
    case 'done':
      usage.lastTurn = msg.usage || null;
      if (msg.stopReason === 'cancelled') endTurn('Stopped');
      else if (msg.stopReason && msg.stopReason !== 'end_turn') endTurn(null, `stopped early (${msg.stopReason})`);
      else endTurn();
      break;
    case 'error':
      notice(msg.message, true);
      endTurn(null, busy ? msg.message : null);
      if (!connected) setStatus('error', 'Error');
      break;
    case 'state_restored':
      if (msg.count) notice(`Restored ${msg.count} item(s) of chat history and settings from the host backup.`);
      break;
    case 'host_disconnected':
      connected = false;
      endTurn();
      setStatus('error', 'Host offline');
      notice(`Cannot reach the TabHelm host: ${msg.message}. Run "npm run install-host" in the host folder, then reopen this panel.`, true);
      syncControls();
      break;
  }
}

async function fillAgents(agents) {
  agentsList = agents;
  setAgents(agents);
  const { lastAgent } = await chrome.storage.local.get('lastAgent');
  const installed = agents.filter((a) => a.installed);
  const preferred = installed.find((a) => a.id === lastAgent) || installed[0];
  els.agent.replaceChildren(
    ...agents.map((a) => {
      const opt = new Option(a.installed ? a.name : `${a.name} — not installed`, a.id, false, a === preferred);
      opt.disabled = !a.installed;
      if (!a.installed) opt.title = a.installHint;
      return opt;
    }),
  );
  if (!installed.length) els.agent.prepend(new Option('No agents found on PATH', '', true, true));
  showModelPlaceholder();

  // Tell the user how to add the missing ones.
  const missing = agents.filter((a) => !a.installed);
  document.getElementById('install-hints')?.remove();
  if (missing.length && els.empty?.isConnected) {
    const details = document.createElement('details');
    details.id = 'install-hints';
    details.className = 'install-hints';
    details.innerHTML = '<summary></summary><ul></ul>';
    details.querySelector('summary').textContent = `${missing.length} more agent${missing.length > 1 ? 's' : ''} available`;
    for (const a of missing) {
      const li = document.createElement('li');
      li.append(Object.assign(document.createElement('b'), { textContent: a.name }), document.createTextNode(` — ${a.installHint}`));
      details.querySelector('ul').append(li);
    }
    els.empty.append(details);
  }
  syncControls();
}

function onStatus(msg) {
  if (msg.state === 'starting') {
    setStatus('starting', msg.detail || `Starting ${msg.agent.name}…`);
  } else if (msg.state === 'ready') {
    connected = true;
    starting = false;
    connectedAgent = msg.agent;
    currentModel = null;
    Object.assign(usage, { cost: null, context: null, lastTurn: null });
    renderUsageButton();
    clearQueued();
    restorePrefs = true;
    // Any fresh agent session in a chat with history gets that history with its
    // first message (reconnects, restarts, chats reopened from History).
    if (!pendingContext && journal.some((e) => e.type === 'user')) pendingContext = buildContext();
    setStatus('ready', msg.agent.name);
    record('agent_connected', { agent: msg.agent.name });
    notice(`${msg.agent.name} connected`);
    els.input.focus();
    if (autoContinue) {
      const q = autoContinue;
      autoContinue = null;
      sendNow(q.text, q.attachments || []);
    }
  } else {
    connected = false;
    endTurn(null, busy ? msg.detail || 'the agent exited' : null);
    setStatus('idle', 'Not connected');
    showModelPlaceholder();
    if (msg.detail) notice(msg.detail, true);
  }
  syncControls();
}

function onUpdate(u) {
  switch (u.kind) {
    case 'agent_message_chunk':
      thoughtEl = null;
      if (!agentBubble) {
        breakActivity();
        agentBubble = agentMessage('');
        agentText = '';
        if (turn?.text) turn.text += '\n\n'; // separate answers split by tool calls
      }
      agentText += u.text;
      if (turn) turn.text += u.text;
      agentBubble.setMarkdown(agentText);
      break;
    case 'agent_thought_chunk':
      if (!thoughtEl) {
        // Thinking between steps stays inside the current steps block.
        const inBlock = activity && activity.el === els.log.lastElementChild;
        const d = document.createElement('details');
        d.className = 'thought';
        if (inBlock) addToActivity(d, false);
        else {
          breakActivity();
          els.empty?.remove();
          els.log.append(d);
        }
        d.innerHTML = '<summary>Thinking</summary><div></div>';
        thoughtEl = d.querySelector('div');
      }
      thoughtEl.textContent += u.text;
      if (turn) turn.thought += u.text;
      break;
    case 'tool_call':
    case 'tool_call_update':
      onToolCall(u);
      break;
    case 'plan':
      if (!planEl) planEl = add('ol', 'plan');
      planEl.replaceChildren(
        ...u.entries.map((e) => {
          const li = document.createElement('li');
          li.dataset.status = e.status;
          li.textContent = e.content;
          return li;
        }),
      );
      break;
  }
  scrollDown();
}

// The agent needs a login before it can open a session.
function addAuth(msg) {
  breakActivity();
  setStatus('starting', 'Sign-in required');
  const card = add('div', 'card');
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = `${msg.agent.name} needs you to sign in`;
  const options = document.createElement('div');
  options.className = 'options';
  const hints = document.createElement('ul');
  hints.className = 'auth-hints';
  for (const m of msg.methods) {
    if (m.description) hints.append(Object.assign(document.createElement('li'), { textContent: `${m.name}: ${m.description}` }));
    const b = document.createElement('button');
    b.className = 'btn primary';
    b.textContent = m.name;
    if (m.description) b.title = m.description;
    b.onclick = () => {
      port.postMessage({ type: 'authenticate', methodId: m.id });
      card.classList.add('resolved');
      options.replaceChildren(Object.assign(document.createElement('span'), { textContent: `→ ${m.name}. Finish signing in in the window that opens.` }));
    };
    options.append(b);
  }
  card.append(title, hints, options);
  scrollDown();
}

// ---------- Tab group ----------
// The chat's Chrome tab group: tabs dragged into it are shared with the agent.

function showGroup({ grouped, count }) {
  groupState = { grouped, count };
  const b = $('group-tabs');
  b.textContent = grouped ? `Tab group: ${count} tab${count === 1 ? '' : 's'} shared — drag more in` : 'Share tabs (tab group)';
  showTab();
}

$('group-tabs').onclick = () => {
  $('plus-menu').open = false;
  port.postMessage({ type: 'group_tabs' });
  record('group', {});
};
port.postMessage({ type: 'group_info' });

// ---------- Model & effort ----------

// Before the agent is connected the model list is not known yet: show the last
// choice for this agent; using the control connects the agent to load the list.
async function showModelPlaceholder() {
  if (connected || starting) return;
  const saved = (await chrome.storage.local.get(prefsKey()))[prefsKey()] || {};
  const name = saved.modelName || saved.model || 'default model';
  els.config.replaceChildren();
  const b = Object.assign(document.createElement('button'), { type: 'button', className: 'model-placeholder', textContent: `${name} ▾` });
  b.title = 'Model (last used). Click to connect the agent and choose from all its models.';
  b.onclick = () => {
    if (!els.agent.value) return;
    notice(`Connecting ${els.agent.selectedOptions[0]?.text} to load its models…`);
    startAgent(els.agent.value);
  };
  els.config.append(b);
  els.config.hidden = false;
  $('config-extra').replaceChildren(Object.assign(document.createElement('span'), { className: 'hint', textContent: `Model: ${name} (last used). Send a message or click the model next to the agent to connect and see all models and options.` }));
}

const prefsKey = () => `prefs:${els.agent.value}`;

async function renderConfig(options) {
  els.config.replaceChildren();
  $('config-extra').replaceChildren();
  els.config.hidden = !options.some((o) => o.category === 'model');

  if (restorePrefs) {
    restorePrefs = false;
    const saved = (await chrome.storage.local.get(prefsKey()))[prefsKey()] || {};
    let changed = false;
    for (const opt of options) {
      const want = saved[opt.id];
      const exists = opt.groups.some((g) => g.options.some((o) => o.value === want));
      if (want && want !== opt.currentValue && exists) {
        port.postMessage({ type: 'set_config', configId: opt.id, value: want });
        changed = true;
      }
    }
    // The host answers each change with a fresh config message.
    if (changed) return;
  }

  const makeSelect = (opt) => {
    const select = document.createElement('select');
    select.className = opt.category;
    select.title = opt.name;
    select.setAttribute('aria-label', opt.name);
    for (const group of opt.groups) {
      const parent = group.name ? Object.assign(document.createElement('optgroup'), { label: group.name }) : select;
      for (const o of group.options) parent.append(new Option(o.name, o.value, false, o.value === opt.currentValue));
      if (parent !== select) select.append(parent);
    }
    select.onchange = async () => {
      select.disabled = true;
      port.postMessage({ type: 'set_config', configId: opt.id, value: select.value });
      const saved = (await chrome.storage.local.get(prefsKey()))[prefsKey()] || {};
      chrome.storage.local.set({ [prefsKey()]: { ...saved, [opt.id]: select.value, [`${opt.id}Name`]: select.selectedOptions[0]?.text } });
    };
    return select;
  };
  for (const opt of options) {
    const select = makeSelect(opt);
    // The model sits next to the agent; every option (model included) is also in Settings → Model options.
    if (opt.category === 'model') els.config.append(select);
    const extra = $('config-extra');
    const wrap = document.createElement('label');
    wrap.className = 'field';
    wrap.append(Object.assign(document.createElement('span'), { textContent: opt.name }), makeSelect(opt));
    extra.append(wrap);
    if (opt.category === 'model') {
      const model = select.selectedOptions[0]?.text;
      if (model && model !== currentModel) record('model', { agent: connectedAgent?.name, model });
      currentModel = model;
    }
  }
  syncControls();
}

// Browser tool calls are shown from the extension's own action log
// (tool_activity), so agent-side cards are only kept for other tools.
function onToolCall(u) {
  let card = toolCards.get(u.toolCallId);
  if (card?.hidden) return;
  if (/browser_/.test(u.title || '')) {
    card?.el.remove();
    toolCards.set(u.toolCallId, { hidden: true });
    return;
  }
  if (!card) {
    agentBubble = null;
    card = { el: document.createElement('div') };
    card.el.className = 'tool';
    addToActivity(card.el);
    card.el.innerHTML = '<span class="title"></span> <span class="state"></span><pre hidden></pre>';
    toolCards.set(u.toolCallId, card);
  }
  if (u.title) card.el.querySelector('.title').textContent = u.title;
  if (u.status) card.el.querySelector('.state').textContent = { pending: '…', in_progress: '…', completed: '✓', failed: '✗' }[u.status] || '';
  if ((u.status === 'completed' || u.status === 'failed') && !card.recorded) {
    card.recorded = true;
    record('agent_tool', { agent: connectedAgent?.name, title: card.el.querySelector('.title').textContent, ok: u.status === 'completed' });
  }
  if (u.text) {
    const pre = card.el.querySelector('pre');
    pre.hidden = false;
    pre.textContent = u.text;
  }
}

// ---------- Activity block ----------
// Consecutive steps of the agent (browser actions and its own tool calls such as
// tool search) are collected in one scrollable message.

let activity = null; // { el, list, count }

function activityBlock() {
  // Continue the block only while it is the latest thing in the chat.
  if (activity && activity.el === els.log.lastElementChild) return activity;
  breakActivity();
  const el = add('details', 'activity');
  el.open = true;
  const summary = document.createElement('summary');
  summary.innerHTML = '<span class="activity-dot"></span><span class="activity-title">Steps</span><span class="activity-count"></span>';
  const list = document.createElement('div');
  list.className = 'activity-list';
  el.append(summary, list);
  activity = { el, list, count: 0 };
  return activity;
}

function addToActivity(node, isStep = true) {
  const a = activityBlock();
  a.list.append(node);
  if (isStep) a.count++;
  a.el.querySelector('.activity-count').textContent = String(a.count);
  a.list.scrollTop = a.list.scrollHeight;
  scrollDown();
}

// Ends the current block (new answer, message or card). It stays open — the
// list scrolls inside a fixed height — and can be collapsed by clicking it.
function breakActivity() {
  if (!activity) return;
  activity.el.classList.add('done');
  activity = null;
}

function actionRow(desc, ok, error) {
  const el = document.createElement('div');
  el.className = `action ${ok ? 'ok' : 'fail'}`;
  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.textContent = ok ? '↳' : '✗';
  const label = document.createElement('span');
  label.textContent = desc + (error ? ` — ${error}` : '');
  el.append(icon, label);
  return el;
}

function addAction({ tool, args, label: detail, ok, error }) {
  agentBubble = null;
  const desc = describeAction(tool, args, detail) + (args?.tabId != null && tool !== 'browser_tabs' ? ` · tab ${args.tabId}` : '');
  record('action', { agent: connectedAgent?.name, tool, args, desc, ok, error });
  turn?.actions.push(`${ok ? '' : '✗ '}${desc}${error ? ` (${error})` : ''}`);
  addToActivity(actionRow(desc, ok, error));
}

function describeAction(tool, a = {}, detail) {
  const target = (ref) => (detail ? `“${truncate(detail, 40)}”` : ref);
  switch (tool) {
    case 'browser_snapshot':
      return 'Read the page';
    case 'browser_find':
      return `Find ${detail || `“${truncate(a.text, 30)}”`}`;
    case 'browser_get_text':
      return 'Read page text';
    case 'browser_screenshot':
      return `Screenshot${a.fullPage ? ' (full page)' : a.ref ? ` of ${a.ref}` : ''}`;
    case 'browser_click': {
      const kind = a.double ? 'Double-click' : a.button === 'right' ? 'Right-click' : a.button === 'middle' ? 'Middle-click' : 'Click';
      return `${kind} ${target(a.ref)}`;
    }
    case 'browser_click_xy':
      return `${a.double ? 'Double-click' : a.button === 'right' ? 'Right-click' : 'Click'} at (${a.x}, ${a.y})`;
    case 'browser_hover':
      return `Hover ${detail || a.ref || `(${a.x}, ${a.y})`}`;
    case 'browser_drag':
      return `Drag ${detail || ''}`;
    case 'browser_type':
      return `Type “${truncate(a.text, 40)}” into ${target(a.ref)}${a.submit ? ' + Enter' : ''}`;
    case 'browser_select_option':
      return `Select “${a.value}” in ${a.ref}`;
    case 'browser_press_key':
      return `Press ${a.key}`;
    case 'browser_scroll':
      return `Scroll ${a.direction}`;
    case 'browser_upload_file':
      return `Upload ${detail || 'files'}`;
    case 'browser_navigate':
      return `Open ${a.url}`;
    case 'browser_go_back':
      return 'Go back';
    case 'browser_go_forward':
      return 'Go forward';
    case 'browser_reload':
      return 'Reload';
    case 'browser_tabs':
      return { list: 'List tabs', new: `New tab ${a.url || ''}`, switch: `Switch to tab ${a.tabId}`, close: `Close tab ${a.tabId}` }[a.action] || 'Tabs';
    case 'browser_search_tabs':
      return `Search tabs for ${detail || `“${truncate(a.text, 30)}”`}`;
    case 'browser_wait':
      return a.text ? `Wait for “${truncate(a.text, 30)}”` : `Wait ${a.seconds || 1}s`;
    case 'browser_handle_dialog':
      return a.accept ? 'Accept dialog' : 'Dismiss dialog';
    case 'browser_console':
      return 'Read console';
    case 'browser_network':
      return 'Read network log';
    case 'browser_evaluate':
      return `Run JS: ${truncate(a.expression, 50)}`;
    case 'browser_fill_form':
      return `Fill ${a.fields?.length || 0} field(s): ${(a.fields || []).map((f) => `${f.ref}=“${truncate(String(f.value), 25)}”`).join(', ')}`;
    case 'browser_highlight':
      return `Highlight ${(a.refs || []).join(', ')}${a.label ? ` (${a.label})` : ''}`;
    case 'browser_storage':
      return `${a.action === 'get' ? 'Read' : a.action === 'set' ? 'Set' : 'Delete'} ${a.kind}${a.key ? ` ${a.key}` : ''}`;
    case 'browser_emulate':
      return a.reset ? 'Reset emulation' : `Emulate ${[a.width && `${a.width}×${a.height || '?'}`, a.mobile && 'mobile', a.colorScheme, a.timezone, a.locale].filter(Boolean).join(', ')}`;
    case 'browser_network_body':
      return `Request body ${truncate(a.url, 40)}`;
    case 'browser_request_human':
      return `Asked you: ${truncate(a.message, 50)}`;
    case 'browser_request_login':
      return 'Asked you to sign in';
    case 'memory_save':
      return `Remember: ${truncate(a.text, 50)}`;
    case 'memory_search':
      return `Search memory ${a.query ? `“${truncate(a.query, 30)}”` : ''}`;
    case 'skill_list':
      return 'List skills';
    case 'skill_read':
      return `Read skill “${a.name}”`;
    case 'skill_read_file':
      return `Read skill file ${a.name}/${a.path}`;
    default:
      return tool;
  }
}

// Confirmation asked by the extension itself (uploads, JS, other tabs);
// these are shown even when auto-approve is on.
function addConfirm(msg) {
  breakActivity();
  agentBubble = null;
  const card = add('div', 'card ask');
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = `Allow: ${msg.title.replace(/\?$/, '')}?`;
  const detail = document.createElement('pre');
  detail.className = 'detail';
  detail.textContent = msg.detail || '';
  const options = document.createElement('div');
  options.className = 'options';
  for (const [name, allow] of [['Allow once', true], ['Reject', false]]) {
    const b = document.createElement('button');
    b.className = `btn${allow ? ' primary' : ''}`;
    b.textContent = name;
    b.onclick = () => {
      port.postMessage({ type: 'confirm_response', id: msg.id, allow });
      record('confirm', { title: msg.title, detail: msg.detail, answer: name });
      card.classList.add('resolved');
      options.replaceChildren(Object.assign(document.createElement('span'), { textContent: `→ ${name}` }));
    };
    options.append(b);
  }
  card.append(title, detail, options);
  scrollDown();
}

function addPermission(msg) {
  breakActivity();
  agentBubble = null;
  const card = add('div', 'card ask');
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = `Allow: ${msg.title}?`;
  const options = document.createElement('div');
  options.className = 'options';
  for (const opt of msg.options) {
    const b = document.createElement('button');
    b.className = `btn${opt.kind?.startsWith('allow') ? ' primary' : ''}`;
    b.textContent = opt.name;
    b.onclick = () => {
      port.postMessage({ type: 'permission_response', id: msg.id, optionId: opt.optionId });
      record('permission', { agent: connectedAgent?.name, title: msg.title, answer: opt.name });
      card.classList.add('resolved');
      options.replaceChildren(Object.assign(document.createElement('span'), { textContent: `→ ${opt.name}` }));
    };
    options.append(b);
  }
  card.append(title, options);
  scrollDown();
}

// ---------- Controls ----------

// Starts (or switches to) an agent. If this chat already has history, the new
// agent receives it with its first message so it can continue the work.
// `queued` ({ text, attachments }) is sent as soon as the agent is ready.
let starting = false;
async function startAgent(agentId, queued = null) {
  if (!agentId) return;
  chrome.storage.local.set({ lastAgent: agentId });
  els.agent.value = agentId;
  pendingContext = await buildContext();
  autoContinue = queued && typeof queued === 'string' ? { text: queued, attachments: [] } : queued;
  starting = true;
  connected = false;
  els.config.hidden = true;
  syncControls();
  port.postMessage({ type: 'start', agentId, autoApprove: els.auto.checked, ...(await skillPayload()), folder: currentFolder() });
}

// Test hook (stripped from releases): connect / disconnect without sending.
window.tabhelmTest = {
  connect: () => startAgent(els.agent.value),
  disconnect: () => port.postMessage({ type: 'stop' }),
};

els.agent.onchange = () => {
  chrome.storage.local.set({ lastAgent: els.agent.value });
  if (!connected) showModelPlaceholder();
  if (!connected || busy) return;
  const name = els.agent.selectedOptions[0]?.text;
  const hasHistory = journal.some((e) => e.type === 'user');
  notice(`Switching to ${name}${hasHistory ? '. It gets this conversation and the action log as context.' : '.'}`);
  record('agent_switch', { to: name });
  startAgent(els.agent.value);
};

// Shown when a turn fails: hand the task to another agent in one click.
function offerContinue(reason) {
  const others = agentsList.filter((a) => a.installed && a.id !== connectedAgent?.id);
  if (!others.length) return;
  const card = add('div', 'card');
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = `${connectedAgent?.name || 'The agent'} did not finish (${truncate(reason, 120)}). Continue with:`;
  const options = document.createElement('div');
  options.className = 'options';
  for (const a of others) {
    const b = Object.assign(document.createElement('button'), { className: 'btn', textContent: a.name });
    b.onclick = () => {
      card.classList.add('resolved');
      options.replaceChildren(Object.assign(document.createElement('span'), { textContent: `→ ${a.name}` }));
      record('agent_switch', { to: a.name, reason });
      startAgent(a.id, 'Continue the task from where the previous agent stopped.');
    };
    options.append(b);
  }
  card.append(title, options);
  scrollDown();
}

els.newChat.onclick = () => {
  if (busy) stop();
  stopVoice(true);
  stopRecording(true);
  journal = [];
  chatId = null;
  setCurrentChat(null);
  chrome.storage.session.remove(`activeChat:${tabId}`);
  turn = null;
  pendingContext = null;
  autoContinue = null;
  busy = false;
  agentBubble = thoughtEl = planEl = null;
  toolCards.clear();
  const empty = emptyTemplate.cloneNode(true);
  els.log.replaceChildren(empty);
  els.empty = empty;
  port.postMessage({ type: 'list_agents' }); // re-adds install hints to the empty state
  // A fresh agent session forgets the previous conversation too.
  if (connected) {
    connected = false;
    els.config.hidden = true;
    skillPayload().then((p) => port.postMessage({ type: 'start', agentId: els.agent.value, autoApprove: els.auto.checked, ...p, folder: currentFolder() }));
  }
  syncControls();
};

els.auto.onchange = () => {
  port.postMessage({ type: 'set_auto_approve', value: els.auto.checked });
  updateFolderWarning(els.auto.checked);
};

chrome.storage.local.get('recordVideo').then(({ recordVideo }) => (els.record.checked = Boolean(recordVideo)));
els.record.onchange = () => {
  chrome.storage.local.set({ recordVideo: els.record.checked });
  if (!busy) return;
  if (els.record.checked) startRecording();
  else stopRecording();
};

els.send.onclick = () => (busy ? stop() : send());
els.input.addEventListener('keydown', (e) => {
  if (slashKey(e)) return;
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send(); // while the agent works this queues the message
  }
});
els.input.addEventListener('input', () => slashUpdate());

// ---------- Slash commands (Skill authoring flag) ----------

const slash = { items: [], active: 0 };
const BUILTIN_SLASH = [
  { name: 'new', description: 'New chat', run: () => els.newChat.click() },
  { name: 'export', description: 'Export this chat (History → ⬇)', run: () => $('history-open').click() },
  { name: 'pause', description: 'Pause the agent (Take over)', run: () => $('pause').click() },
];

async function slashUpdate() {
  const menu = $('slash-menu');
  const m = /^\/([\w-]*)$/.exec(els.input.value);
  const features = await getFeatures();
  if (!m || !features.skillAuthoring) {
    menu.hidden = true;
    return;
  }
  const q = m[1].toLowerCase();
  const skillsList = await slashSkills();
  slash.items = [...skillsList.map((s) => ({ ...s, skill: true })), ...BUILTIN_SLASH].filter((s) => s.name.toLowerCase().startsWith(q)).slice(0, 8);
  slash.active = 0;
  menu.replaceChildren(
    ...slash.items.map((s, i) => {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: `slash-item${i === 0 ? ' active' : ''}` });
      b.append(Object.assign(document.createElement('b'), { textContent: `/${s.name}` }), Object.assign(document.createElement('span'), { textContent: s.description }));
      b.onclick = () => slashPick(s);
      return b;
    }),
  );
  menu.hidden = !slash.items.length;
}

function slashKey(e) {
  const menu = $('slash-menu');
  if (menu.hidden) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    slash.active = (slash.active + (e.key === 'ArrowDown' ? 1 : slash.items.length - 1)) % slash.items.length;
    [...menu.children].forEach((c, i) => c.classList.toggle('active', i === slash.active));
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    slashPick(slash.items[slash.active]);
    return true;
  }
  if (e.key === 'Escape') {
    menu.hidden = true;
    return true;
  }
  return false;
}

function slashPick(s) {
  $('slash-menu').hidden = true;
  if (!s) return;
  if (s.run) {
    els.input.value = '';
    s.run();
    return;
  }
  els.input.value = `/${s.name} `;
  els.input.focus();
}

// "/name rest" → ask the agent to apply that skill.
function expandSlash(text) {
  const m = /^\/([\w-]+)\s*([\s\S]*)$/.exec(text);
  if (!m) return text;
  return `Use the skill "${m[1]}" (read it with skill_read first and follow it).${m[2] ? ` Task: ${m[2]}` : ''}`;
}

// Text + attachments from the composer, with page quotes folded into the text.
function composeMessage() {
  let text = els.input.value.trim();
  if (!text && !hasAttachments()) return null;
  $('slash-menu').hidden = true;
  if (text.startsWith('/')) text = expandSlash(text);
  let attachments = takeAttachments();
  // Quotes from the page travel inside the message text, with their source.
  const quotes = attachments.filter((a) => a.kind === 'quote');
  attachments = attachments.filter((a) => a.kind !== 'quote');
  if (quotes.length) {
    const block = quotes.map((q) => (q.raw ? `[${q.header}]\n${q.text}` : `[Selected on the page${q.source?.url ? ` ${q.source.url}` : ''}]\n${q.text.split('\n').map((l) => `> ${l}`).join('\n')}`)).join('\n\n');
    text = text ? `${text}\n\n${block}` : `${block}\n\nLet's discuss this.`;
  }
  if (!text) text = 'Please look at the attached file(s).';
  els.input.value = '';
  return { text, attachments };
}

// Messages typed while the agent works: shown at once, handed to the agent with
// its next browser step (text only), or sent as the next message when the task ends.
const queued = []; // { text, attachments, el }
function queueMessage() {
  const m = composeMessage();
  if (!m) return;
  breakActivity();
  const el = add('div', 'msg user queued');
  el.textContent = m.text;
  if (m.attachments.length) {
    const list = document.createElement('div');
    list.className = 'attachments';
    list.append(...m.attachments.map((a) => chip(a)));
    el.append(list);
  }
  const tag = Object.assign(document.createElement('div'), { className: 'queued-tag', textContent: m.attachments.length ? '⏳ sent when the current task ends' : '⏳ the agent gets this with its next step' });
  el.append(tag);
  agentBubble = null;
  queued.push({ ...m, el, tag });
  record('user', { text: m.text, attachments: m.attachments.map((a) => ({ name: a.name, kind: a.kind, size: a.size })), queued: true });
  if (!m.attachments.length) port.postMessage({ type: 'interject', text: m.text });
  scrollDown();
}

// The agent read queued messages inside a tool result.
function markInterjected(texts) {
  for (const t of texts) {
    const i = queued.findIndex((q) => q.text === t);
    if (i < 0) continue;
    queued[i].tag.textContent = '✓ picked up by the agent';
    queued[i].el.classList.remove('queued');
    queued.splice(i, 1);
  }
}

// Whatever the agent did not pick up becomes the next message.
function flushQueued() {
  if (!queued.length || busy || !connected) return;
  const items = queued.splice(0);
  for (const q of items) {
    q.tag.textContent = '→ sent';
    q.el.classList.remove('queued');
  }
  const text = items.map((q) => q.text).join('\n\n');
  sendNow(text, items.flatMap((q) => q.attachments), { silent: true });
}

function clearQueued() {
  queued.splice(0);
}

async function send() {
  if (busy) return queueMessage();
  const m = composeMessage();
  if (!m) return;
  let { text, attachments } = m;
  // No Connect button: the first message starts the agent and is sent when it is ready.
  if (!connected) {
    if (!els.agent.value) return notice('No agent is installed. See Settings → Skills or the README to install one.', true);
    if (!starting) notice(`Starting ${els.agent.selectedOptions[0]?.text}…`);
    await startAgent(els.agent.value, { text, attachments });
    return;
  }
  sendNow(text, attachments);
}

async function sendNow(text, attachments, { silent = false } = {}) {
  const features = await getFeatures();
  awaitingPlan = Boolean(features.planPreview) && !text.startsWith('[plan approved]');
  breakActivity();
  if (!silent) {
    const bubble = add('div', 'msg user');
    bubble.textContent = text;
    if (attachments.length) {
      const list = document.createElement('div');
      list.className = 'attachments';
      list.append(...attachments.map((a) => chip(a)));
      bubble.append(list);
    }
  }
  agentBubble = null;
  thoughtEl = null;
  planEl = null;
  busy = true;
  turn = { text: '', thought: '', actions: [], started: Date.now(), costStart: usage.cost };
  usage.lastTurn = null;
  if (!silent) record('user', { text, attachments: attachments.map((a) => ({ name: a.name, kind: a.kind, size: a.size })) });
  setStatus('working', 'Working…');
  if (els.record.checked) startRecording();
  const context = pendingContext; // a string or a pending buildContext()
  pendingContext = null;
  syncControls();
  scrollDown();
  port.postMessage({
    type: 'prompt',
    text,
    context: await context,
    attachments: attachments.map(({ kind, name, mimeType, data, text: body }) => ({ kind, name, mimeType, data, text: body })),
  });
}

function stop() {
  port.postMessage({ type: 'cancel' });
}

// `failure` is set when the turn ended without the agent finishing its work.
function endTurn(note, failure = null) {
  if (note) notice(note);
  lastTurnHadNoActions = !turn || turn.actions.length === 0;
  if (turn) {
    const stats = turnStats(turn);
    showStats(stats);
    record('agent', { agent: connectedAgent?.name, model: currentModel, text: turn.text.trim(), thought: turn.thought.trim(), failure, stats });
    turn = null;
    renderUsageButton();
  }
  stopRecording();
  // The turn's steps block stops pulsing but stays open.
  if (activity) {
    activity.el.classList.add('done');
    activity = null;
  }
  const wasBusy = busy;
  busy = false;
  agentBubble = null;
  thoughtEl = null;
  if (connected) setStatus('ready', connectedAgent?.name || 'Connected');
  syncControls();
  if (failure && wasBusy) offerContinue(failure);
  else if (awaitingPlan && wasBusy && !failure && lastTurnHadNoActions) offerPlanStart();
  awaitingPlan = false;
  // Messages typed during the task that the agent did not pick up go next.
  if (wasBusy && !failure) setTimeout(flushQueued, 50);
}

// ---------- Plan preview (flag) ----------

let awaitingPlan = false;
let lastTurnHadNoActions = false;

function offerPlanStart() {
  const card = add('div', 'card ask');
  card.append(Object.assign(document.createElement('div'), { className: 'title', textContent: 'Start this plan?' }));
  const options = document.createElement('div');
  options.className = 'options';
  const start = Object.assign(document.createElement('button'), { className: 'btn primary', textContent: 'Start' });
  start.onclick = () => {
    card.classList.add('resolved');
    options.replaceChildren(Object.assign(document.createElement('span'), { textContent: '→ Started' }));
    els.input.value = '[plan approved] proceed with the plan.';
    send();
  };
  const revise = Object.assign(document.createElement('button'), { className: 'btn', textContent: 'Change the plan' });
  revise.onclick = () => {
    card.classList.add('resolved');
    options.replaceChildren(Object.assign(document.createElement('span'), { textContent: '→ Tell the agent what to change' }));
    els.input.focus();
  };
  options.append(start, revise);
  card.append(options);
  record('plan_offer', {});
  scrollDown();
}

// ---------- Take over (flag) ----------

let pausedNow = false;

$('pause').onclick = () => {
  if (pausedNow) {
    port.postMessage({ type: 'resume' });
    setPaused(false);
  } else {
    port.postMessage({ type: 'pause' });
    setPaused(true);
  }
};

function setPaused(on) {
  pausedNow = on;
  $('pause').textContent = on ? 'Resume agent' : 'Pause — I take over';
  if (on) {
    setStatus('paused', 'Paused — you have control');
    notice('Paused. Do what you need on the page, then press “Resume agent”.');
    record('pause', {});
  } else if (busy) {
    setStatus('working', 'Working…');
    record('resume', {});
  }
}

// Guide mode: one card for the whole tour, updated per step; its buttons drive the tour.
let guideCard = null;
function showGuideStep(msg) {
  if (!guideCard || !guideCard.el.isConnected) {
    breakActivity();
    agentBubble = null;
    const el = add('div', 'card ask guide');
    const title = Object.assign(document.createElement('div'), { className: 'title' });
    const hint = Object.assign(document.createElement('div'), { className: 'hint' });
    const options = Object.assign(document.createElement('div'), { className: 'options' });
    el.append(title, hint, options);
    guideCard = { el, title, hint, options, steps: [] };
  }
  const g = guideCard;
  g.title.textContent = `${msg.total > 1 ? `Step ${msg.index + 1} of ${msg.total}` : `Step ${msg.number || 1}`}: ${msg.text}`;
  g.hint.textContent = msg.auto ? `Auto-play: the agent clicks “${msg.target || 'the step'}” after a pause…` : msg.found ? `Waiting for you to click “${msg.target || 'the highlighted element'}”${msg.tabTitle ? ` on “${msg.tabTitle}”` : ''}…` : 'The element is not on this page any more — follow the instruction, then press Next.';
  const act = (action) => port.postMessage({ type: 'guide_action', action });
  const btn = (label, action, cls = 'btn') => Object.assign(document.createElement('button'), { className: cls, textContent: label, onclick: () => act(action) });
  g.options.replaceChildren(
    ...(msg.index > 0 || msg.number > 1 ? [btn('← Back', 'back')] : []),
    btn(msg.index + 1 >= msg.total ? 'Finish ✓' : 'Next →', 'done', 'btn primary'),
    msg.auto ? btn('⏸ Pause', 'pause') : btn('▶ Auto', 'auto'),
    btn('Skip', 'skipped'),
    btn('Stop guide', 'stop'),
  );
  record('ask', { kind: 'guide', message: g.title.textContent });
  scrollDown();
}

function finishGuideCard(msg) {
  if (!guideCard) return;
  const g = guideCard;
  guideCard = null;
  g.el.classList.add('resolved');
  const label = msg.stopped ? 'Stopped' : msg.back ? 'Back to the agent' : `Finished${msg.results ? ` (${msg.results.filter((r) => r === 'skipped').length} skipped)` : ''}`;
  g.options.replaceChildren(Object.assign(document.createElement('span'), { textContent: `→ ${label}` }));
  record('ask', { kind: 'guide', answer: label });
}

// Requests from the agent that the panel answers (Take over / Password manager flags).
const askCards = new Map(); // ask id -> mark resolved (when settled from the page side)
async function addAsk(msg) {
  breakActivity();
  agentBubble = null;
  const card = add('div', 'card ask');
  const title = Object.assign(document.createElement('div'), { className: 'title' });
  const options = document.createElement('div');
  options.className = 'options';
  const reply = (r, label) => {
    port.postMessage({ type: 'ask_response', id: msg.id, reply: r });
    card.classList.add('resolved');
    options.replaceChildren(Object.assign(document.createElement('span'), { textContent: `→ ${label}` }));
    record('ask', { kind: msg.kind, answer: label });
  };

  if (msg.kind === 'human') {
    title.textContent = `${connectedAgent?.name || 'The agent'} needs you: ${msg.message}`;
    const note = Object.assign(document.createElement('input'), { className: 'note', placeholder: 'Optional note for the agent' });
    const done = Object.assign(document.createElement('button'), { className: 'btn primary', textContent: "Done, continue" });
    done.onclick = () => reply({ done: true, note: note.value.trim() }, 'Done');
    const cancel = Object.assign(document.createElement('button'), { className: 'btn', textContent: 'Cancel task' });
    cancel.onclick = () => reply({ done: false }, 'Cancelled');
    options.append(done, cancel);
    card.append(title, note, options);
    record('ask', { kind: 'human', message: msg.message });
  } else if (msg.kind === 'login') {
    title.textContent = `Sign in needed on ${msg.tab?.title || 'this page'}${msg.note ? ` — ${msg.note}` : ''}`;
    const { getSetting } = await import('./features.js');
    const pm = await getSetting('passwordManager');
    if (pm.onePassword !== false && msg.usernameRef && msg.passwordRef) {
      const op = Object.assign(document.createElement('button'), { className: 'btn primary', textContent: 'Fill with 1Password' });
      op.onclick = async () => {
        op.disabled = true;
        op.textContent = 'Looking up…';
        const items = await hostRequest('password_items', { url: msg.tab?.url }, 'password_items');
        if (items.error || !items.items?.length) {
          op.disabled = false;
          op.textContent = 'Fill with 1Password';
          notice(items.error || 'No 1Password logins for this site.', true);
          return;
        }
        const pick = document.createElement('select');
        for (const it of items.items) pick.append(new Option(`${it.title}${it.username ? ` — ${it.username}` : ''}`, it.id));
        const use = Object.assign(document.createElement('button'), { className: 'btn primary', textContent: 'Fill & submit' });
        use.onclick = async () => {
          const cred = await hostRequest('password_credential', { id: pick.value }, 'password_credential');
          if (cred.error) return notice(cred.error, true);
          reply({ done: true, credential: { username: cred.username, password: cred.password }, submit: true }, `Filled from 1Password (${pick.selectedOptions[0].text})`);
        };
        options.replaceChildren(pick, use);
      };
      options.append(op);
    }
    if (pm.chrome !== false) {
      const chromePm = Object.assign(document.createElement('button'), { className: 'btn', textContent: "Chrome's passwords — I'll sign in" });
      chromePm.onclick = () => {
        notice('Click the username field on the page and pick your saved login from Chrome, then press “Done”.');
        const done = Object.assign(document.createElement('button'), { className: 'btn primary', textContent: 'Done, signed in' });
        done.onclick = () => reply({ done: true }, 'Signed in by the user');
        options.replaceChildren(done);
      };
      options.append(chromePm);
    }
    const cancel = Object.assign(document.createElement('button'), { className: 'btn', textContent: 'Cancel' });
    cancel.onclick = () => reply({ done: false }, 'Cancelled');
    options.append(cancel);
    card.append(title, options);
    record('ask', { kind: 'login', site: msg.tab?.url });
  }
  scrollDown();
}

// One request/response pair with the host (password manager lookups).
let nextHostReq = 1;
const hostWaits = new Map();
function hostRequest(type, data, replyType) {
  return new Promise((resolve) => {
    const requestId = nextHostReq++;
    hostWaits.set(`${replyType}:${requestId}`, resolve);
    port.postMessage({ type, requestId, ...data });
    setTimeout(() => hostWaits.has(`${replyType}:${requestId}`) && (hostWaits.delete(`${replyType}:${requestId}`), resolve({ error: 'No answer from the host.' })), 30_000);
  });
}

// ---------- Context & usage popup ----------
// The header button shows how full the context window is; the popup has the
// numbers: window used / left, this session's tokens and cost (summed from the
// journal, so reopened chats count too) and the last task.
function sessionTotals(entries = journal) {
  const turns = entries.filter((e) => e.type === 'agent' && e.stats);
  const sum = (f) => turns.reduce((a, e) => a + (f(e.stats) || 0), 0);
  const costs = turns.filter((e) => e.stats.cost);
  return {
    turns: turns.length,
    ms: sum((s) => s.ms),
    tokens: sum((s) => s.tokens?.total),
    input: sum((s) => s.tokens?.input),
    output: sum((s) => s.tokens?.output),
    cached: sum((s) => s.tokens?.cached),
    thought: sum((s) => s.tokens?.thought),
    cost: costs.length ? { amount: costs.reduce((a, e) => a + e.stats.cost.amount, 0), currency: costs[0].stats.cost.currency } : null,
  };
}

function renderUsageButton() {
  const btn = $('usage-open');
  const ctx = usage.context;
  const totals = sessionTotals();
  const known = Boolean(ctx?.size) || totals.tokens > 0 || usage.cost != null;
  btn.hidden = !known;
  if (!known) return;
  const pct = ctx?.size ? Math.min(100, Math.round((ctx.used / ctx.size) * 100)) : null;
  $('usage-fill').style.width = `${pct ?? 0}%`;
  btn.classList.toggle('warn', pct != null && pct >= 80);
  $('usage-label').textContent = pct != null ? `${pct}%` : totals.tokens ? fmtTokens(totals.tokens) : fmtCost({ amount: usage.cost, currency: usage.currency });
  btn.title = pct != null ? `Context window ${fmtTokens(ctx.used)} of ${fmtTokens(ctx.size)} used (${pct}%) — click for details` : 'Token usage — click for details';
  if (!$('usage-popup').hidden) renderUsagePopup();
}

function renderUsagePopup() {
  const body = $('usage-body');
  const ctx = usage.context;
  const totals = sessionTotals();
  const row = (label, value, hint) => {
    const div = document.createElement('div');
    div.className = 'usage-row';
    div.append(Object.assign(document.createElement('span'), { className: 'usage-k', textContent: label }), Object.assign(document.createElement('b'), { textContent: value }));
    if (hint) div.title = hint;
    return div;
  };
  const section = (title) => Object.assign(document.createElement('h4'), { textContent: title });
  const items = [section(`Context window${connectedAgent ? ` — ${connectedAgent.name}${currentModel ? ` · ${currentModel}` : ''}` : ''}`)];
  if (ctx?.size) {
    const pct = Math.min(100, Math.round((ctx.used / ctx.size) * 100));
    const bar = document.createElement('div');
    bar.className = 'usage-bar big';
    bar.append(Object.assign(document.createElement('span'), { className: `usage-fill${pct >= 80 ? ' warn' : ''}`, style: `width:${pct}%` }));
    items.push(bar, row('Used', `${fmtTokens(ctx.used)} tokens (${pct}%)`, `${ctx.used.toLocaleString()} tokens`), row('Left', `${fmtTokens(Math.max(0, ctx.size - ctx.used))} tokens (${100 - pct}%)`), row('Window', `${fmtTokens(ctx.size)} tokens`, `${ctx.size.toLocaleString()} tokens`));
    if (pct >= 80) items.push(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'The window is almost full: the agent may start forgetting earlier parts of the chat. Consider New chat (the conversation is handed over in a short form).' }));
  } else {
    items.push(Object.assign(document.createElement('p'), { className: 'hint', textContent: `${connectedAgent?.name || 'This agent'} does not report its context window.` }));
  }
  items.push(section('This chat'));
  items.push(row('Tasks', String(totals.turns)), row('Time', fmtTime(totals.ms)));
  if (totals.tokens) {
    items.push(row('Tokens', fmtTokens(totals.tokens), `${totals.tokens.toLocaleString()} tokens`), row('  input / output', `${fmtTokens(totals.input)} / ${fmtTokens(totals.output)}`));
    if (totals.cached) items.push(row('  cached', fmtTokens(totals.cached)));
    if (totals.thought) items.push(row('  reasoning', fmtTokens(totals.thought)));
  } else items.push(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'No token counts reported yet.' }));
  if (totals.cost) items.push(row('Cost', fmtCost(totals.cost)));
  else if (usage.cost != null) items.push(row('Cost (session)', fmtCost({ amount: usage.cost, currency: usage.currency })));
  const last = journal.filter((e) => e.type === 'agent' && e.stats).pop();
  if (last) {
    items.push(section('Last task'));
    items.push(row('Time', fmtTime(last.stats.ms)));
    if (last.stats.tokens) items.push(row('Tokens', `${fmtTokens(last.stats.tokens.total)} (in ${fmtTokens(last.stats.tokens.input)} · out ${fmtTokens(last.stats.tokens.output)})`));
    if (last.stats.cost) items.push(row('Cost', fmtCost(last.stats.cost)));
  }
  items.push(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'Claude Code, OpenCode, Kilo and the built-in agent report tokens and cost; Codex reports tokens; Cursor and Grok report neither.' }));
  body.replaceChildren(...items);
}

$('usage-open').onclick = () => {
  const pop = $('usage-popup');
  pop.hidden = !pop.hidden;
  if (!pop.hidden) renderUsagePopup();
};
$('usage-close').onclick = () => ($('usage-popup').hidden = true);

// An agent reply: rendered Markdown plus Copy buttons — the Markdown source, or
// the text as shown with every link spelled out as "label (url)".
function agentMessage(markdown) {
  const el = add('div', 'msg agent');
  const body = Object.assign(document.createElement('div'), { className: 'md-body' });
  const tools = Object.assign(document.createElement('div'), { className: 'msg-tools' });
  const mk = (label, title, fn) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'msg-copy', textContent: label, title });
    b.onclick = async () => {
      try {
        await fn();
        b.textContent = 'Copied ✓';
      } catch {
        b.textContent = 'Copy failed';
      }
      setTimeout(() => (b.textContent = label), 1500);
    };
    return b;
  };
  tools.append(
    mk('Copy', 'Copy as Markdown (links as [text](url))', () => copyText(el.markdown)),
    mk('Text', 'Copy as plain text with links written out; pastes as rich text with links into docs and mail', () => copyRich(plainTextWithLinks(body), body.innerHTML)),
  );
  el.append(body, tools);
  el.markdown = markdown;
  el.setMarkdown = (md) => {
    el.markdown = md;
    body.innerHTML = renderMarkdown(md);
  };
  el.setMarkdown(markdown);
  return el;
}

function plainTextWithLinks(body) {
  const clone = body.cloneNode(true);
  for (const a of clone.querySelectorAll('a[href]')) {
    const label = a.textContent.trim();
    if (label && label !== a.href && !a.href.startsWith(label)) a.textContent = `${label} (${a.href})`;
    else a.textContent = a.href;
  }
  for (const li of clone.querySelectorAll('li')) li.prepend(li.parentElement.tagName === 'OL' ? `${[...li.parentElement.children].indexOf(li) + 1}. ` : '• ');
  for (const code of clone.querySelectorAll('pre')) code.textContent = `\n${code.textContent}\n`;
  document.body.append(clone); // innerText needs layout
  const text = clone.innerText.replace(/\n{3,}/g, '\n\n').trim();
  clone.remove();
  return text;
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
}

async function copyRich(text, html) {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]);
  } catch {
    await navigator.clipboard.writeText(text);
  }
}

// Time, tokens and cost of one turn. Tokens and cost appear only for agents
// that report them (Claude Code, OpenCode, Codex tokens, the built-in agent…).
function turnStats(t) {
  const u = usage.lastTurn;
  const cost = usage.cost != null ? usage.cost - (t.costStart ?? 0) : null;
  return {
    ms: Date.now() - t.started,
    tokens: u ? { total: u.totalTokens, input: u.inputTokens, output: u.outputTokens, cached: (u.cachedReadTokens || 0) + (u.cachedWriteTokens || 0), thought: u.thoughtTokens || 0 } : null,
    cost: cost != null && cost >= 0 ? { amount: cost, currency: usage.currency } : null,
    context: usage.context,
  };
}

const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n));
const fmtCost = (c) => `${c.currency === 'USD' ? '$' : `${c.currency} `}${c.amount < 0.01 ? c.amount.toFixed(4) : c.amount.toFixed(2)}`;
const fmtTime = (ms) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

function statsText(s) {
  const parts = [`⏱ ${fmtTime(s.ms)}`];
  if (s.tokens) parts.push(`${fmtTokens(s.tokens.total)} tokens`);
  if (s.cost) parts.push(fmtCost(s.cost));
  if (s.context?.size) parts.push(`context ${fmtTokens(s.context.used)} / ${fmtTokens(s.context.size)}`);
  return parts.join(' · ');
}

function showStats(s) {
  const el = add('div', 'stats');
  el.textContent = statsText(s);
  if (s.tokens) {
    el.title = `input ${s.tokens.input} · output ${s.tokens.output} · cached ${s.tokens.cached}${s.tokens.thought ? ` · reasoning ${s.tokens.thought}` : ''}${s.cost ? '' : '\nThis agent does not report cost.'}`;
  } else {
    el.title = 'This agent does not report tokens or cost.';
  }
  scrollDown();
}

// The conversation for the next agent: messages, the browser actions taken,
// unfinished work and the current page. Keeps the most recent ~12k characters.
async function buildContext() {
  const blocks = [];
  let actions = [];
  const flush = (agent) => {
    if (actions.length) blocks.push(`[${agent || 'Agent'} did in the browser] ${actions.join('; ')}`);
    actions = [];
  };
  for (const e of journal) {
    if (e.type === 'user') blocks.push(`User: ${e.text}${e.attachments?.length ? ` (attached: ${e.attachments.map((a) => a.name).join(', ')})` : ''}`);
    else if (e.type === 'action') actions.push(`${e.ok ? '' : 'FAILED '}${e.desc}${e.error ? ` (${e.error})` : ''}`);
    else if (e.type === 'agent') {
      flush(e.agent);
      if (e.text) blocks.push(`${e.agent}: ${e.text}`);
      if (e.failure) blocks.push(`(${e.agent} stopped before finishing: ${e.failure})`);
    }
  }
  flush(connectedAgent?.name);
  if (!blocks.length) return null;
  let out = '';
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (out.length + blocks[i].length > 12_000) break;
    out = `${blocks[i]}\n\n${out}`;
  }
  const tab = await chrome.tabs.get(targetTabId).catch(() => null);
  if (tab) out += `Current tab: ${tab.title} — ${tab.url}\n`;
  return out.trim();
}

function syncControls() {
  els.agent.disabled = busy;
  els.send.textContent = busy ? 'Stop' : 'Send';
  els.input.placeholder = busy ? 'Add a note for the agent — Enter hands it over with its next step (Stop cancels the task)' : els.input.dataset.placeholder;
  getFeatures().then((f) => {
    $('pause').hidden = !(f.takeOver && busy);
    for (const b of document.querySelectorAll('[data-voice]')) b.hidden = !f.voice;
  });
  for (const select of document.querySelectorAll('#config select, #config-extra select')) select.disabled = busy;
}

// ---------- Export ----------

// Export lives in History (any chat, current one highlighted).
async function exportChat(meta, format) {
  const chat = meta.id === chatId ? { journal, url: (await chrome.tabs.get(targetTabId).catch(() => null))?.url, pageTitle: null } : await loadChat(meta.id);
  if (!chat) return notice('This chat is no longer saved.', true);
  const tab = { title: chat.pageTitle || meta.pageTitle || '', url: chat.url || meta.url || '' };
  const stamp = new Date(meta.updated || Date.now()).toISOString().slice(0, 19).replace('T', '_').replaceAll(':', '-');
  if (format === 'md') download(`tabhelm-chat-${stamp}.md`, exportMarkdown(tab, chat.journal), 'text/markdown');
  else download(`tabhelm-log-${stamp}.json`, JSON.stringify({ exported: new Date().toISOString(), tab, journal: chat.journal }, null, 2), 'application/json');
}

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  Object.assign(document.createElement('a'), { href: url, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function totalsLine(entries = journal) {
  const turns = entries.filter((e) => e.type === 'agent' && e.stats);
  if (!turns.length) return null;
  const ms = turns.reduce((a, e) => a + e.stats.ms, 0);
  const tokens = turns.reduce((a, e) => a + (e.stats.tokens?.total || 0), 0);
  const costs = turns.filter((e) => e.stats.cost);
  const cost = costs.reduce((a, e) => a + e.stats.cost.amount, 0);
  return `- Totals: ${turns.length} tasks · ${fmtTime(ms)}${tokens ? ` · ${fmtTokens(tokens)} tokens` : ''}${costs.length ? ` · ${fmtCost({ amount: cost, currency: costs[0].stats.cost.currency })}` : ''}`;
}

function exportMarkdown(tab, entries = journal) {
  const time = (ts) => new Date(ts).toLocaleTimeString();
  const agents = [...new Set(entries.filter((e) => e.type === 'agent_connected').map((e) => e.agent))];
  const out = [
    '# TabHelm chat',
    '',
    `- Exported: ${new Date().toLocaleString()}`,
    tab ? `- Tab: ${tab.title} — ${tab.url}` : null,
    agents.length ? `- Agents: ${agents.join(' → ')}` : null,
    totalsLine(entries),
    '',
  ].filter((l) => l !== null);

  let inActions = false;
  const section = (heading) => {
    inActions = false;
    out.push('', `### ${heading}`, '');
  };
  for (const e of entries) {
    const t = time(e.ts);
    switch (e.type) {
      case 'user':
        section(`${t} · You`);
        out.push(e.text);
        if (e.attachments?.length) out.push('', ...e.attachments.map((a) => `- 📎 ${a.name} (${a.kind}, ${Math.round(a.size / 1024)} KB)`));
        break;
      case 'action':
      case 'agent_tool':
        if (!inActions) {
          section(`${t} · ${e.agent || 'Agent'} — actions`);
          inActions = true;
        }
        if (e.type === 'action') out.push(`- ${t} ${e.ok ? '✓' : '✗'} ${e.desc}${e.error ? ` — ${e.error}` : ''}`);
        else out.push(`- ${t} ${e.ok ? '✓' : '✗'} (agent tool) ${e.title}`);
        break;
      case 'agent':
        section(`${t} · ${e.agent || 'Agent'}${e.model ? ` (${e.model})` : ''}`);
        if (e.thought) out.push('<details><summary>Thinking</summary>', '', e.thought, '', '</details>', '');
        out.push(e.text || '_No answer._');
        if (e.failure) out.push('', `> ⚠️ Stopped before finishing: ${e.failure}`);
        if (e.stats) out.push('', `_${statsText(e.stats)}_`);
        break;
      case 'permission':
        out.push(`- ${t} 🔐 ${e.title} → ${e.answer}`);
        break;
      case 'ask':
      addAsk(msg);
      break;
    case 'paused':
      setPaused(msg.paused);
      break;
    case 'page_context':
      // Selection or image sent from the page (context menu, shortcut, + menu).
      if (msg.kind === 'image') addImageUrl(msg.srcUrl, msg.pageUrl);
      else addQuote({ text: msg.text, pageUrl: msg.pageUrl, pageTitle: msg.pageTitle });
      els.input.focus();
      break;
    case 'confirm':
        out.push(`- ${t} 🔐 ${e.title} → ${e.answer}${e.detail ? ` (${e.detail.replace(/\n/g, ', ')})` : ''}`);
        break;
      case 'video':
        out.push(`- ${t} 🎥 Recording saved: \`${e.path}\``);
        break;
      case 'video_deleted':
        out.push(`- ${t} 🗑 Recording deleted${e.path ? `: \`${e.path}\`` : ''}`);
        break;
      case 'model':
        out.push('', `> ${t} · ${e.agent}: model ${e.model}`);
        break;
      case 'agent_connected':
        out.push('', `> ${t} · ${e.agent} connected`);
        inActions = false;
        break;
      case 'folder':
        out.push('', `> ${t} · Working folder: ${e.path ? `\`${e.path}\`` : 'none'}`);
        inActions = false;
        break;
      case 'ask':
        out.push(`- ${t} 🙋 ${e.kind === 'login' ? 'Sign-in requested' : e.message ? `Agent asked: ${e.message}` : `Answered: ${e.answer}`}`);
        break;
      case 'pause':
        out.push('', `> ${t} · Paused — user took over`);
        break;
      case 'resume':
        out.push('', `> ${t} · Resumed`);
        break;
      case 'plan_offer':
        out.push('', `> ${t} · Plan shown, waiting for Start`);
        break;
      case 'agent_switch':
        out.push('', `> ${t} · Switched to ${e.to}${e.reason ? ` (previous agent stopped: ${e.reason})` : ''}`);
        inActions = false;
        break;
      case 'notice':
        if (e.error) out.push('', `> ⚠️ ${t} · ${e.text}`);
        break;
    }
  }
  return `${out.join('\n')}\n`;
}

// ---------- Video recording ----------
// The extension streams JPEG frames of the tab (CDP screencast); they are
// painted on a canvas and encoded with MediaRecorder. Each finished video is
// shown in the chat and saved by the host to ~/Videos/TabHelm.

const rec = { active: false, recorder: null, canvas: null, ctx: null, img: null, chunks: [], mime: '', started: 0, heartbeat: null };

function startRecording() {
  if (rec.active) return;
  Object.assign(rec, { active: true, recorder: null, chunks: [], img: null });
  els.recIndicator.hidden = false;
  port.postMessage({ type: 'record_start' });
}

async function onFrame({ data }) {
  if (!rec.active) return;
  const img = new Image();
  img.src = `data:image/jpeg;base64,${data}`;
  try {
    await img.decode();
  } catch {
    return;
  }
  if (!rec.active) return;
  rec.img = img;
  if (!rec.recorder) {
    rec.canvas = document.createElement('canvas');
    // Even dimensions keep H.264 encoders happy.
    rec.canvas.width = img.naturalWidth & ~1;
    rec.canvas.height = img.naturalHeight & ~1;
    rec.ctx = rec.canvas.getContext('2d');
    paintFrame();
    rec.mime = ['video/mp4;codecs=avc1.42E01F', 'video/webm;codecs=vp9', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
    rec.recorder = new MediaRecorder(rec.canvas.captureStream(30), { mimeType: rec.mime, videoBitsPerSecond: 5_000_000 });
    rec.recorder.ondataavailable = (e) => e.data.size && rec.chunks.push(e.data);
    rec.recorder.start(1000);
    rec.started = Date.now();
    rec.startedAt = new Date().toISOString();
    // Screencast only sends frames on change; repaint so the timeline stays continuous.
    rec.heartbeat = setInterval(paintFrame, 500);
  } else {
    paintFrame();
  }
}

function paintFrame() {
  if (rec.img) rec.ctx.drawImage(rec.img, 0, 0, rec.canvas.width, rec.canvas.height);
}

function stopRecording(discard = false) {
  if (!rec.active) return;
  rec.active = false;
  els.recIndicator.hidden = true;
  clearInterval(rec.heartbeat);
  port.postMessage({ type: 'record_stop' });
  const recorder = rec.recorder;
  if (!recorder) {
    if (!discard) notice('No video recorded: the tab did not render any frames.', true);
    return;
  }
  const { chunks, mime, started } = rec;
  recorder.onstop = () => {
    if (discard) return;
    addVideo(new Blob(chunks, { type: mime.split(';')[0] }), Date.now() - started);
  };
  paintFrame();
  setTimeout(() => recorder.stop(), 150);
}

const videoCards = new Map(); // recording id -> { saved, card, url, path }

async function addVideo(blob, durationMs) {
  if (!blob.size) return;
  const url = URL.createObjectURL(blob);
  const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
  const stamp = new Date().toISOString().slice(0, 19).replace('T', '_').replaceAll(':', '-');
  const filename = `tabhelm-${stamp}.${ext}`;
  const id = crypto.randomUUID();

  const card = add('div', 'video');
  const video = Object.assign(document.createElement('video'), { src: url, controls: true, muted: true, playsInline: true });
  const row = document.createElement('div');
  row.className = 'row';
  const info = document.createElement('span');
  const secs = Math.round(durationMs / 1000);
  info.textContent = `Recording · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} · ${(blob.size / 1048576).toFixed(1)} MB`;
  const download = Object.assign(document.createElement('a'), { className: 'btn small', href: url, download: filename, textContent: 'Download' });
  const remove = Object.assign(document.createElement('button'), { className: 'btn small', type: 'button', textContent: 'Delete', title: 'Delete this recording from the chat and from disk' });
  const buttons = document.createElement('span');
  buttons.className = 'video-buttons';
  buttons.append(download, remove);
  row.append(info, buttons);
  const saved = document.createElement('div');
  saved.textContent = 'Saving…';
  card.append(video, row, saved);
  // Action database flag: the steps of this recording, clickable to seek.
  const features = await getFeatures();
  if (features.actionDb && rec.startedAt) {
    const start = Date.parse(rec.startedAt);
    const steps = journal.filter((e) => e.type === 'action' && Date.parse(e.ts) >= start - 500 && Date.parse(e.ts) <= start + durationMs + 500);
    if (steps.length) {
      const list = document.createElement('ol');
      list.className = 'video-steps';
      for (const e of steps) {
        const offset = Math.max(0, (Date.parse(e.ts) - start) / 1000);
        const b = Object.assign(document.createElement('button'), { type: 'button' });
        b.append(Object.assign(document.createElement('time'), { textContent: `${Math.floor(offset / 60)}:${String(Math.floor(offset % 60)).padStart(2, '0')}` }), document.createTextNode(`${e.ok ? '' : '✗ '}${e.desc}`));
        b.onclick = () => {
          video.currentTime = offset;
          video.play().catch(() => {});
        };
        list.append(b);
      }
      card.append(list);
    }
  }
  const entry = { saved, card, url, path: null };
  videoCards.set(id, entry);
  // Second click confirms, so a stray click doesn't lose the video.
  remove.onclick = () => {
    if (remove.dataset.armed !== '1') {
      remove.dataset.armed = '1';
      remove.textContent = 'Delete?';
      setTimeout(() => {
        remove.dataset.armed = '';
        remove.textContent = 'Delete';
      }, 3000);
      return;
    }
    if (entry.path) port.postMessage({ type: 'delete_recording', id, path: entry.path });
    else finishDelete(id);
  };
  scrollDown();

  // Send to the host in chunks; it writes the file to ~/Videos/TabHelm.
  const CHUNK = 768 * 1024;
  for (let offset = 0, seq = 0; offset < blob.size; offset += CHUNK, seq++) {
    const data = await blobToBase64(blob.slice(offset, offset + CHUNK));
    port.postMessage({ type: 'save_recording', id, filename, seq, last: offset + CHUNK >= blob.size, data });
  }
}

function onRecordingSaved({ id, path }) {
  record('video', { path });
  const entry = videoCards.get(id);
  if (!entry) return;
  entry.path = path;
  entry.saved.textContent = `Saved to ${path}`;
}

function finishDelete(id) {
  const entry = videoCards.get(id);
  if (!entry) return;
  videoCards.delete(id);
  URL.revokeObjectURL(entry.url);
  entry.card.remove();
  record('video_deleted', { path: entry.path });
  notice(entry.path ? `Recording deleted: ${entry.path}` : 'Recording removed.');
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function setStatus(state, label) {
  els.status.dataset.state = state;
  // Idle/ready states need no words: the agent select already says which agent.
  els.status.textContent = state === 'idle' || state === 'ready' ? '' : label;
  els.status.title = label || '';
}

// ---------- Rendering helpers ----------

function add(tag, className) {
  els.empty?.remove();
  const el = document.createElement(tag);
  el.className = className;
  els.log.append(el);
  return el;
}

function notice(text, isError = false) {
  record('notice', { text, error: isError });
  add('div', `notice${isError ? ' error' : ''}`).textContent = text;
  scrollDown();
}

function scrollDown() {
  els.log.scrollTop = els.log.scrollHeight;
}

function truncate(s = '', n) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

syncControls();

showNews($('news'));
initSettings(port);
onFeaturesChanged(() => syncControls());
// Voice: the transcript becomes one message in the box; the user edits and sends it.
initVoice(port, {
  text(text, source) {
    if (!text) return notice('Nothing was transcribed.', true);
    const prefix = source === 'tab' ? '[Transcript of the tab audio]\n' : '';
    els.input.value = `${els.input.value.trim() ? `${els.input.value.trim()}\n\n` : ''}${prefix}${text}`;
    els.input.focus();
    record('voice', { source, chars: text.length });
  },
  error: (text) => notice(text, true),
});
// Changing the folder restarts the agent there; the conversation is handed over.
initFolder(port, tabId, {
  changed(folder) {
    record('folder', { path: folder?.path || null });
    if (!connected || busy) return;
    notice(folder ? `Restarting ${connectedAgent?.name} in ${folder.path}…` : `Restarting ${connectedAgent?.name} without a working folder…`);
    startAgent(els.agent.value);
  },
});
// ---------- History: open and replay saved chats ----------

initHistory({
  export: exportChat,
  open(meta, tabAlive) {
    if (meta.id === chatId) return closeHistory();
    // The chat's own tab is still open: switch to it and open its panel there.
    // These calls must stay synchronous to keep the user gesture.
    if (tabAlive && meta.tabId !== tabId) {
      chrome.sidePanel.setOptions({ tabId: meta.tabId, path: `sidepanel.html?tabId=${meta.tabId}&chat=${meta.id}`, enabled: true });
      chrome.sidePanel.open({ tabId: meta.tabId });
      chrome.tabs.update(meta.tabId, { active: true });
      chrome.tabs.get(meta.tabId).then((t) => chrome.windows.update(t.windowId, { focused: true })).catch(() => {});
      closeHistory();
      return;
    }
    closeHistory();
    openSavedChat(meta.id, { navigate: !tabAlive });
  },
});

async function openSavedChat(id, { navigate = false } = {}) {
  // Block sending until the agent has restarted with this chat's context.
  const wasConnected = connected;
  if (wasConnected) {
    connected = false;
    setStatus('starting', 'Loading chat…');
    syncControls();
  }
  const chat = await loadChat(id);
  if (!chat) return notice('This chat is no longer saved.', true);
  // Bring this tab back to the chat's page.
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (navigate && chat.url && tab?.url !== chat.url) await chrome.tabs.update(tabId, { url: chat.url });
  if (busy) stop();
  stopRecording(true);
  replayChat(chat);
  if (chat.folder) await restoreFolder(chat.folder);
  if (wasConnected) {
    notice(`Continuing with ${connectedAgent?.name}; it gets this conversation as context.`);
    startAgent(els.agent.value);
  } else {
    notice('Chat restored. Pick an agent and press Connect to continue — it gets this conversation as context.');
  }
}

// Renders a saved journal without recording anything.
function replayChat(chat) {
  replaying = true;
  journal = [...chat.journal];
  chatId = chat.id;
  chatCreated = chat.created;
  setCurrentChat(chatId);
  chrome.storage.session.set({ [`activeChat:${tabId}`]: chatId });
  turn = null;
  busy = false;
  agentBubble = thoughtEl = planEl = null;
  activity = null;
  toolCards.clear();
  els.log.replaceChildren();
  els.empty = null;
  for (const e of journal) {
    switch (e.type) {
      case 'user': {
        breakActivity();
        const bubble = add('div', 'msg user');
        bubble.textContent = e.text;
        if (e.attachments?.length) {
          const list = document.createElement('div');
          list.className = 'attachments';
          list.append(...e.attachments.map((a) => chip(a)));
          bubble.append(list);
        }
        break;
      }
      case 'action':
        addToActivity(actionRow(e.desc, e.ok, e.error));
        break;
      case 'agent_tool': {
        const el = document.createElement('div');
        el.className = 'tool';
        el.textContent = `${e.title} ${e.ok ? '✓' : '✗'}`;
        addToActivity(el);
        break;
      }
      case 'agent':
        if (activity) {
          activity.el.classList.add('done');
          activity = null;
        }
        if (e.thought) {
          const d = add('details', 'thought');
          d.innerHTML = '<summary>Thinking</summary><div></div>';
          d.querySelector('div').textContent = e.thought;
        }
        if (e.text) agentMessage(e.text);
        if (e.failure) notice(`${e.agent || 'Agent'} stopped before finishing: ${e.failure}`, true);
        if (e.stats) {
          showStats(e.stats);
          if (e.stats.context) usage.context = e.stats.context;
          renderUsageButton();
        }
        break;
      case 'permission':
      case 'ask':
      addAsk(msg);
      break;
    case 'paused':
      setPaused(msg.paused);
      break;
    case 'page_context':
      // Selection or image sent from the page (context menu, shortcut, + menu).
      if (msg.kind === 'image') addImageUrl(msg.srcUrl, msg.pageUrl);
      else addQuote({ text: msg.text, pageUrl: msg.pageUrl, pageTitle: msg.pageTitle });
      els.input.focus();
      break;
    case 'confirm':
        notice(`🔐 ${e.title} → ${e.answer}`);
        break;
      case 'notice':
        if (e.error) notice(e.text, true);
        break;
      case 'video':
        notice(`🎥 Recording saved: ${e.path}`);
        break;
      case 'agent_connected':
        notice(`${e.agent} connected`);
        break;
      case 'agent_switch':
        notice(`Switched to ${e.to}`);
        break;
      case 'folder':
        notice(e.path ? `Working folder: ${e.path}` : 'Working folder removed');
        break;
    }
  }
  if (activity) {
    activity.el.classList.add('done');
    activity = null;
  }
  replaying = false;
  scrollDown();
}

// Reopen the chat this panel had (closing the panel stops the agent, the chat stays).
(async () => {
  const fromHistory = new URLSearchParams(location.search).get('chat');
  const active = fromHistory || (await chrome.storage.session.get(`activeChat:${tabId}`))[`activeChat:${tabId}`];
  if (active) openSavedChat(active);
})();

// Asks the connected agent to distil this chat into a skill (saved with skill_save).
$('make-skill').onclick = () => {
  $('plus-menu').open = false;
  if (!journal.some((e) => e.type === 'user')) return notice('Nothing to turn into a skill yet — do something first.', true);
  els.input.value =
    'Turn what we did in this chat into a reusable skill: the goal, the site, and the exact steps that worked (elements to click, what to type, what to check, pitfalls), written as instructions another agent can follow next time, including steps I did myself in guide mode. Save it with skill_save (short kebab-case name, one-sentence description, Markdown body), then tell me its name.';
  send();
};

// ＋ → Pick element / Select area: a picker on the page; the result becomes a chip.
async function pickOnPage(mode) {
  $('plus-menu').open = false;
  const tab = await chrome.tabs.get(targetTabId).catch(() => null);
  if (!tab || !/^(https?|file):/.test(tab.url || '')) return notice('Elements can be picked only on web pages.', true);
  await chrome.tabs.update(targetTabId, { active: true }).catch(() => {});
  notice(mode === 'area' ? 'Drag a rectangle on the page to pick everything inside it (Esc cancels).' : 'Click an element on the page to pick it (Esc cancels).');
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: targetTabId }, func: pickElements, args: [mode] });
    const res = r?.result;
    if (!res?.items?.length) return notice('Nothing was picked.');
    addElements(res);
    record('pick', { mode, count: res.items.length });
    els.input.focus();
  } catch (err) {
    notice(`Cannot pick on this page: ${err.message}`, true);
  }
}
$('pick-element').onclick = () => pickOnPage('one');
$('pick-area').onclick = () => pickOnPage('area');

// ＋ menu: saved page scripts (Page scripts & styles flag), matching ones first.
async function fillScriptsMenu() {
  const box = $('scripts-menu');
  const { pageScripts = [], features = {} } = await chrome.storage.local.get(['pageScripts', 'features']);
  box.hidden = !features.pageScripts || !pageScripts.length;
  if (box.hidden) return box.replaceChildren();
  const tab = await chrome.tabs.get(targetTabId).catch(() => null);
  const list = pageScripts.filter((p) => p.enabled !== false).sort((a, b) => scriptMatches(b, tab?.url) - scriptMatches(a, tab?.url));
  box.replaceChildren(
    Object.assign(document.createElement('div'), { className: 'menu-sep' }),
    ...list.slice(0, 12).map((p) => {
      const b = Object.assign(document.createElement('button'), { type: 'button', textContent: `▶ ${p.name}${scriptMatches(p, tab?.url) ? '' : ' (other site)'}`, title: `${p.description || ''}\nmatch: ${p.match}` });
      b.onclick = () => {
        $('plus-menu').open = false;
        port.postMessage({ type: 'run_page_script', id: p.id, targetTabId });
      };
      return b;
    }),
  );
}
$('plus-menu').addEventListener('toggle', () => $('plus-menu').open && fillScriptsMenu());

$('add-selection').onclick = async () => {
  $('plus-menu').open = false;
  const tab = await chrome.tabs.get(targetTabId).catch(() => null);
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: targetTabId }, func: () => window.getSelection()?.toString() || '' });
    addQuote({ text: r?.result, pageUrl: tab?.url, pageTitle: tab?.title });
    els.input.focus();
  } catch (err) {
    notice(`Cannot read the selection on this page: ${err.message}`, true);
  }
};
port.postMessage({ type: 'page_context_pending' });

initAttachments({
  list: $('attachments'),
  button: $('attach'),
  input: $('file-input'),
  dropTarget: document.body,
  pasteTarget: els.input,
  onError: (text) => notice(text, true),
});
