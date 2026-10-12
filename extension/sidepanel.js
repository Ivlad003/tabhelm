const tabId = Number(new URLSearchParams(location.search).get('tabId'));
const $ = (id) => document.getElementById(id);
const els = {
  agent: $('agent'),
  connect: $('connect'),
  status: $('status'),
  tab: $('tab'),
  log: $('log'),
  empty: $('empty'),
  input: $('input'),
  send: $('send'),
  auto: $('auto'),
};

let connected = false;
let busy = false;
let agentBubble = null; // current streaming agent message
let agentText = '';
let thoughtEl = null;
let planEl = null;
const toolCards = new Map();

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
    case 'target':
      targetTabId = msg.tabId;
      showTab();
      break;
    case 'done':
      endTurn(msg.stopReason === 'cancelled' ? 'Stopped' : null);
      break;
    case 'error':
      notice(msg.message, true);
      endTurn();
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
  const { lastAgent } = await chrome.storage.local.get('lastAgent');
  els.agent.replaceChildren(
    ...agents.map((a) => {
      const opt = new Option(a.name, a.id);
      opt.selected = a.id === lastAgent;
      return opt;
    }),
  );
  if (!agents.length) els.agent.append(new Option('No agents found on PATH', ''));
  syncControls();
}

function onStatus(msg) {
  if (msg.state === 'starting') {
    setStatus('starting', `Starting ${msg.agent.name}…`);
  } else if (msg.state === 'ready') {
    connected = true;
    setStatus('ready', msg.agent.name);
    notice(`${msg.agent.name} connected`);
    els.input.focus();
  } else {
    connected = false;
    endTurn();
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
      }
      agentText += u.text;
      agentBubble.innerHTML = renderMarkdown(agentText);
      break;
    case 'agent_thought_chunk':
      if (!thoughtEl) {
        const d = add('details', 'thought');
        d.innerHTML = '<summary>Thinking</summary><div></div>';
        thoughtEl = d.querySelector('div');
      }
      thoughtEl.textContent += u.text;
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
  label.textContent = describeAction(tool, args, detail) + (error ? ` — ${error}` : '');
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
      card.classList.add('resolved');
      options.replaceChildren(Object.assign(document.createElement('span'), { textContent: `→ ${opt.name}` }));
    };
    options.append(b);
  }
  card.append(title, options);
  scrollDown();
}

// ---------- Controls ----------

els.connect.onclick = () => {
  if (connected) {
    port.postMessage({ type: 'stop' });
    return;
  }
  const agentId = els.agent.value;
  if (!agentId) return;
  chrome.storage.local.set({ lastAgent: agentId });
  els.connect.disabled = true;
  port.postMessage({ type: 'start', agentId, autoApprove: els.auto.checked });
};

els.auto.onchange = () => port.postMessage({ type: 'set_auto_approve', value: els.auto.checked });

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
  setStatus('working', 'Working…');
  port.postMessage({ type: 'prompt', text });
  syncControls();
  scrollDown();
}

function stop() {
  port.postMessage({ type: 'cancel' });
}

function endTurn(note) {
  if (note) notice(note);
  busy = false;
  agentBubble = null;
  thoughtEl = null;
  if (connected) setStatus('ready', els.agent.selectedOptions[0]?.text || 'Connected');
  syncControls();
}

function syncControls() {
  els.connect.textContent = connected ? 'Disconnect' : 'Connect';
  els.connect.disabled = !connected && !els.agent.value;
  els.agent.disabled = connected;
  els.input.disabled = !connected;
  els.send.disabled = !connected;
  els.send.textContent = busy ? 'Stop' : 'Send';
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
