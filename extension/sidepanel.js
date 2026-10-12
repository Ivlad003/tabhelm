import { showNews } from './news.js';

const tabId = Number(new URLSearchParams(location.search).get('tabId'));
const $ = (id) => document.getElementById(id);
const els = {
  agent: $('agent'),
  connect: $('connect'),
  status: $('status'),
  tab: $('tab'),
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
const record = (type, data = {}) => journal.push({ ts: new Date().toISOString(), type, ...data });
const emptyTemplate = $('empty').cloneNode(true);

const port = chrome.runtime.connect({ name: `panel:${tabId}` });
port.onMessage.addListener(onMessage);
port.postMessage({ type: 'list_agents' });

// ---------- Tab binding ----------

// The agent acts on this tab unless it switched to another one via browser_tabs.
let targetTabId = tabId;

async function showTab() {
  const tab = await chrome.tabs.get(targetTabId).catch(() => null);
  const where = targetTabId === tabId ? 'Controls' : 'Controls another tab';
  els.tab.textContent = tab ? `${where}: ${tab.title || tab.url}` : 'Tab closed';
}
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

function onMessage(msg) {
  switch (msg.type) {
    case 'agents':
      fillAgents(msg.agents);
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
    case 'record_error':
      notice(`Recording failed: ${msg.message}`, true);
      stopRecording(true);
      break;
    case 'recording_saved':
      onRecordingSaved(msg);
      break;
    case 'done':
      if (msg.stopReason === 'cancelled') endTurn('Stopped');
      else if (msg.stopReason && msg.stopReason !== 'end_turn') endTurn(null, `stopped early (${msg.stopReason})`);
      else endTurn();
      break;
    case 'error':
      notice(msg.message, true);
      endTurn(null, busy ? msg.message : null);
      if (!connected) setStatus('error', 'Error');
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
    connectedAgent = msg.agent;
    currentModel = null;
    restorePrefs = true;
    setStatus('ready', msg.agent.name);
    record('agent_connected', { agent: msg.agent.name });
    notice(`${msg.agent.name} connected`);
    els.input.focus();
    if (autoContinue) {
      els.input.value = autoContinue;
      autoContinue = null;
      send();
    }
  } else {
    connected = false;
    endTurn(null, busy ? msg.detail || 'the agent exited' : null);
    els.config.hidden = true;
    els.config.replaceChildren();
    setStatus('idle', 'Not connected');
    if (msg.detail) notice(msg.detail, true);
  }
  syncControls();
}

function onUpdate(u) {
  switch (u.kind) {
    case 'agent_message_chunk':
      thoughtEl = null;
      if (!agentBubble) {
        agentBubble = add('div', 'msg agent');
        agentText = '';
        if (turn?.text) turn.text += '\n\n'; // separate answers split by tool calls
      }
      agentText += u.text;
      if (turn) turn.text += u.text;
      agentBubble.innerHTML = renderMarkdown(agentText);
      break;
    case 'agent_thought_chunk':
      if (!thoughtEl) {
        const d = add('details', 'thought');
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
  els.connect.disabled = false;
  scrollDown();
}

// ---------- Model & effort ----------

const prefsKey = () => `prefs:${els.agent.value}`;

async function renderConfig(options) {
  els.config.replaceChildren();
  els.config.hidden = !options.length;

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

  for (const opt of options) {
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
      chrome.storage.local.set({ [prefsKey()]: { ...saved, [opt.id]: select.value } });
    };
    els.config.append(select);
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
    card = { el: add('div', 'tool') };
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

function addAction({ tool, args, label: detail, ok, error }) {
  agentBubble = null;
  const el = add('div', `action ${ok ? 'ok' : 'fail'}`);
  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.textContent = ok ? '↳' : '✗';
  const label = document.createElement('span');
  const desc = describeAction(tool, args, detail);
  label.textContent = desc + (error ? ` — ${error}` : '');
  record('action', { agent: connectedAgent?.name, tool, args, desc, ok, error });
  turn?.actions.push(`${ok ? '' : '✗ '}${desc}${error ? ` (${error})` : ''}`);
  el.append(icon, label);
  scrollDown();
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
    default:
      return tool;
  }
}

// Confirmation asked by the extension itself (uploads, JS, other tabs);
// these are shown even when auto-approve is on.
function addConfirm(msg) {
  agentBubble = null;
  const card = add('div', 'card');
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = msg.title;
  const detail = document.createElement('pre');
  detail.className = 'detail';
  detail.textContent = msg.detail || '';
  const options = document.createElement('div');
  options.className = 'options';
  for (const [name, allow] of [['Allow', true], ['Deny', false]]) {
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
  agentBubble = null;
  const card = add('div', 'card');
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

els.connect.onclick = async () => {
  if (connected) {
    port.postMessage({ type: 'stop' });
    return;
  }
  const agentId = els.agent.value;
  if (!agentId) return;
  els.connect.disabled = true;
  await startAgent(agentId);
};

// Starts (or switches to) an agent. If this chat already has history, the new
// agent receives it with its first message so it can continue the work.
async function startAgent(agentId, continueText = null) {
  chrome.storage.local.set({ lastAgent: agentId });
  els.agent.value = agentId;
  pendingContext = await buildContext();
  autoContinue = continueText;
  connected = false;
  els.config.hidden = true;
  syncControls();
  port.postMessage({ type: 'start', agentId, autoApprove: els.auto.checked });
}

els.agent.onchange = () => {
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
  stopRecording(true);
  journal = [];
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
    port.postMessage({ type: 'start', agentId: els.agent.value, autoApprove: els.auto.checked });
  }
  syncControls();
};

els.auto.onchange = () => port.postMessage({ type: 'set_auto_approve', value: els.auto.checked });

chrome.storage.local.get('recordVideo').then(({ recordVideo }) => (els.record.checked = Boolean(recordVideo)));
els.record.onchange = () => {
  chrome.storage.local.set({ recordVideo: els.record.checked });
  if (!busy) return;
  if (els.record.checked) startRecording();
  else stopRecording();
};

els.send.onclick = () => (busy ? stop() : send());
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!busy) send();
  }
});

function send() {
  const text = els.input.value.trim();
  if (!text || !connected) return;
  els.input.value = '';
  add('div', 'msg user').textContent = text;
  agentBubble = null;
  thoughtEl = null;
  planEl = null;
  busy = true;
  turn = { text: '', thought: '', actions: [] };
  record('user', { text });
  setStatus('working', 'Working…');
  if (els.record.checked) startRecording();
  port.postMessage({ type: 'prompt', text, context: pendingContext });
  pendingContext = null;
  syncControls();
  scrollDown();
}

function stop() {
  port.postMessage({ type: 'cancel' });
}

// `failure` is set when the turn ended without the agent finishing its work.
function endTurn(note, failure = null) {
  if (note) notice(note);
  if (turn) {
    record('agent', { agent: connectedAgent?.name, model: currentModel, text: turn.text.trim(), thought: turn.thought.trim(), failure });
    turn = null;
  }
  stopRecording();
  const wasBusy = busy;
  busy = false;
  agentBubble = null;
  thoughtEl = null;
  if (connected) setStatus('ready', connectedAgent?.name || 'Connected');
  syncControls();
  if (failure && wasBusy) offerContinue(failure);
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
    if (e.type === 'user') blocks.push(`User: ${e.text}`);
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
  els.connect.textContent = connected ? 'Disconnect' : 'Connect';
  els.connect.disabled = !connected && !els.agent.value;
  els.agent.disabled = busy;
  els.input.disabled = !connected;
  els.send.disabled = !connected;
  els.send.textContent = busy ? 'Stop' : 'Send';
  for (const select of els.config.querySelectorAll('select')) select.disabled = busy;
}

// ---------- Export ----------

for (const b of document.querySelectorAll('[data-export]')) {
  b.onclick = async () => {
    $('export-menu').open = false;
    const tab = await chrome.tabs.get(targetTabId).catch(() => null);
    const stamp = new Date().toISOString().slice(0, 19).replace('T', '_').replaceAll(':', '-');
    if (b.dataset.export === 'md') download(`tabhelm-chat-${stamp}.md`, exportMarkdown(tab), 'text/markdown');
    else download(`tabhelm-log-${stamp}.json`, JSON.stringify({ exported: new Date().toISOString(), tab: tab && { title: tab.title, url: tab.url }, journal }, null, 2), 'application/json');
  };
}

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  Object.assign(document.createElement('a'), { href: url, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function exportMarkdown(tab) {
  const time = (ts) => new Date(ts).toLocaleTimeString();
  const agents = [...new Set(journal.filter((e) => e.type === 'agent_connected').map((e) => e.agent))];
  const out = [
    '# TabHelm chat',
    '',
    `- Exported: ${new Date().toLocaleString()}`,
    tab ? `- Tab: ${tab.title} — ${tab.url}` : null,
    agents.length ? `- Agents: ${agents.join(' → ')}` : null,
    '',
  ].filter((l) => l !== null);

  let inActions = false;
  const section = (heading) => {
    inActions = false;
    out.push('', `### ${heading}`, '');
  };
  for (const e of journal) {
    const t = time(e.ts);
    switch (e.type) {
      case 'user':
        section(`${t} · You`);
        out.push(e.text);
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
        break;
      case 'permission':
        out.push(`- ${t} 🔐 ${e.title} → ${e.answer}`);
        break;
      case 'confirm':
        out.push(`- ${t} 🔐 ${e.title} → ${e.answer}${e.detail ? ` (${e.detail.replace(/\n/g, ', ')})` : ''}`);
        break;
      case 'video':
        out.push(`- ${t} 🎥 Recording saved: \`${e.path}\``);
        break;
      case 'model':
        out.push('', `> ${t} · ${e.agent}: model ${e.model}`);
        break;
      case 'agent_connected':
        out.push('', `> ${t} · ${e.agent} connected`);
        inActions = false;
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

const videoCards = new Map(); // recording id -> status element

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
  row.append(info, download);
  const saved = document.createElement('div');
  saved.textContent = 'Saving…';
  card.append(video, row, saved);
  videoCards.set(id, saved);
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
  const el = videoCards.get(id);
  if (el) el.textContent = `Saved to ${path}`;
  videoCards.delete(id);
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
  els.status.textContent = label;
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

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Small, escape-first Markdown subset: code fences, inline code, bold, links, paragraphs.
function renderMarkdown(src) {
  const parts = src.split(/```[^\n]*\n?/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return `<pre><code>${escapeHtml(part.replace(/\n$/, ''))}</code></pre>`;
      return escapeHtml(part)
        .split(/\n{2,}/)
        .filter((p) => p.trim())
        .map((p) =>
          `<p>${p
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
            .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
            .replace(/\n/g, '<br>')}</p>`,
        )
        .join('');
    })
    .join('');
}

syncControls();

showNews($('news'));
