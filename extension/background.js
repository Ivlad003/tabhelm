import { runTool, releaseChat, startRecording, stopRecording, ensureGroup, groupInfo, chatForGroupTab, chatDebugState, previewTarget, markWorking, setGuideAction, runScript, focusVisibleTab } from './browser-tools.js';
import { listScripts, scriptMatches } from './scripts-lib.js';
import { checkPolicy, pauseChat, resumeChat, isPaused, READ_ONLY } from './policy.js';
import { getFeatures, getSetting, hostFeaturePayload } from './features.js';
import { runScheduled, SCHEDULE_PREFIX } from './scheduler.js';
import { saveChat, loadChat } from './history.js';
import { hostOf, redactText, topFrame } from './redact.js';

const HOST_NAME = 'com.tabhelm.host';
const panels = new Map(); // chat tabId -> side panel port
const runners = new Map(); // chat tabId -> scheduled-run handler (no panel)
const confirms = new Map(); // id -> { resolve, chatTabId }
const asks = new Map(); // id -> { resolve, chatTabId }
const criticWaits = new Map(); // requestId -> resolve
const chatInfo = new Map(); // chat tabId -> { task, actions: [] }
let nextConfirmId = 1;
let nextAskId = 1;
let nextCriticId = 1;
let nativePort = null;

// Dev hook for scripts/tools-test.js: lets the test call tools directly from the service worker.
self.tabhelmDebug = { runTool, ensureGroup, chatDebugState, focusVisibleTab, runSchedule: (id) => runScheduled(id, scheduleDeps), sendPageContext, backupState, restoreState, startRecording, stopRecording, ui: () => ui };

// The service worker's own errors, kept for the self-analysis (redacted, last 50).
async function recordSwError(err) {
  try {
    const { swErrors = [] } = await chrome.storage.local.get('swErrors');
    swErrors.push({ ts: new Date().toISOString(), message: redactText(String(err?.message || err || 'error')).slice(0, 200), frame: topFrame(err?.stack) });
    await chrome.storage.local.set({ swErrors: swErrors.slice(-50) });
  } catch {}
}
self.addEventListener('error', (e) => recordSwError(e.error || e.message));
self.addEventListener('unhandledrejection', (e) => recordSwError(e.reason));

// Which version ran when: lets the self-analysis say "probably fixed in 0.x".
chrome.runtime.onInstalled.addListener(async () => {
  const v = chrome.runtime.getManifest().version;
  const { versionHistory = [] } = await chrome.storage.local.get('versionHistory');
  if (versionHistory.at(-1)?.v !== v) await chrome.storage.local.set({ versionHistory: [...versionHistory, { v, at: new Date().toISOString() }].slice(-50) });
});

const autoApproveTabs = new Set(); // chats with Auto-approve on (panel checkbox)
const logWaits = new Map(); // requestId -> resolve, for host.log digests asked by the service worker
let nextLogReq = 1;
const liveChatWaits = new Map(); // requestId -> resolve, for the panel's live chat

// ---------- Page context: selection / image → chat ----------
const pendingPageContext = new Map(); // tabId -> [payload]

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus?.removeAll(() => {
    chrome.contextMenus.create({ id: 'tabhelm-selection', title: 'Add selection to TabHelm chat', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'tabhelm-image', title: 'Add image to TabHelm chat', contexts: ['image'] });
  });
});

// Opens the panel on the tab (allowed: user gesture) and hands the item to it.
function sendPageContext(tab, payload) {
  const tabId = tab.id;
  const message = { type: 'page_context', pageUrl: tab.url, pageTitle: tab.title, ...payload };
  if (panels.has(tabId)) {
    deliver(tabId, message);
    chrome.sidePanel.open({ tabId }).catch(() => {});
    return;
  }
  pendingPageContext.set(tabId, [...(pendingPageContext.get(tabId) || []), message]);
  chrome.sidePanel.setOptions({ tabId, path: `sidepanel.html?tabId=${tabId}`, enabled: true });
  chrome.sidePanel.open({ tabId }).catch(() => {});
}

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'tabhelm-selection') sendPageContext(tab, { kind: 'selection', text: info.selectionText || '' });
  if (info.menuItemId === 'tabhelm-image') sendPageContext(tab, { kind: 'image', srcUrl: info.srcUrl });
});

// Keyboard shortcut (Alt+Shift+T): add the current selection.
chrome.commands?.onCommand.addListener(async (command, tab) => {
  if (command !== 'add-selection' || !tab?.id) return;
  let text = '';
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.getSelection()?.toString() || '' });
    text = r?.result || '';
  } catch {}
  sendPageContext(tab, { kind: 'selection', text });
});

// Each tab gets its own side panel instance, bound to that tab's id.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
chrome.action.onClicked.addListener((tab) => {
  // On a tab shared through a chat's tab group, go to that chat instead.
  const chatTabId = panels.size ? chatForGroupTab(tab) : null;
  if (chatTabId != null && panels.has(chatTabId)) {
    chrome.sidePanel.open({ tabId: chatTabId });
    chrome.tabs.update(chatTabId, { active: true });
    return;
  }
  // Both calls must happen synchronously inside the click gesture.
  chrome.sidePanel.setOptions({ tabId: tab.id, path: `sidepanel.html?tabId=${tab.id}`, enabled: true });
  chrome.sidePanel.open({ tabId: tab.id });
  chrome.action.setBadgeText({ tabId: tab.id, text: '' }).catch(() => {});
});

// Keep each panel's "N tabs in group" up to date when tabs join or leave.
async function postGroupInfo(chatTabId) {
  const port = panels.get(chatTabId);
  if (port) port.postMessage({ type: 'group', ...(await groupInfo(chatTabId).catch(() => ({ grouped: false, count: 1 }))) });
}
chrome.tabs.onUpdated.addListener((id, info) => {
  if ('groupId' in info) for (const pid of panels.keys()) postGroupInfo(pid);
  // Memory and the critic want the page the chat is on.
  if (info.url && (panels.has(id) || runners.has(id))) nativePort?.postMessage({ type: 'page_url', tabId: id, url: info.url });
});
chrome.tabs.onRemoved.addListener(() => {
  for (const id of panels.keys()) postGroupInfo(id);
});

function deliver(chatTabId, message) {
  const port = panels.get(chatTabId);
  if (port) port.postMessage(message);
  else runners.get(chatTabId)?.(message);
}

// UI hooks the browser tools use to ask the user or report the active tab.
const ui = {
  // Routine confirmations (JS on the page, other tabs, storage, saved scripts) are
  // answered by Auto-approve; uploads from disk and the opt-in safety gates
  // (sensitive actions, site rules, critic) always ask.
  confirm(chatTabId, title, detail, { routine = false } = {}) {
    // Nobody can answer without a panel (scheduled runs, a closed panel). Say so,
    // instead of pretending the user declined.
    if (!panels.has(chatTabId)) return Promise.reject(new Error(`No one could approve "${title}": no panel is open (scheduled run or closed panel).`));
    if (routine && autoApproveTabs.has(chatTabId)) {
      deliver(chatTabId, { type: 'confirm_auto', title, detail });
      return Promise.resolve(true);
    }
    const id = nextConfirmId++;
    deliver(chatTabId, { type: 'confirm', id, title, detail });
    notify(chatTabId, 'needs', title);
    return new Promise((resolve) => confirms.set(id, { resolve, chatTabId }));
  },
  // Rich requests handled by the panel (take-over help, sign-in). Resolves with the panel's reply.
  ask(chatTabId, kind, payload) {
    if (!panels.has(chatTabId)) return Promise.resolve(null);
    const id = nextAskId++;
    deliver(chatTabId, { type: 'ask', id, kind, ...payload });
    notify(chatTabId, 'needs', kind === 'login' ? 'Sign-in needed' : payload.message);
    return new Promise((resolve) => asks.set(id, { resolve, chatTabId }));
  },
  // Settles open asks of a chat from the extension side (e.g. the user clicked on the page).
  resolveAsks(chatTabId, reply) {
    for (const [id, a] of asks) {
      if (a.chatTabId !== chatTabId) continue;
      a.resolve(reply);
      asks.delete(id);
      deliver(chatTabId, { type: 'ask_resolved', id, reply });
    }
  },
  guideProgress(chatTabId, step) {
    deliver(chatTabId, { type: 'guide_progress', ...step });
  },
  guideDone(chatTabId, info) {
    deliver(chatTabId, { type: 'guide_done', ...info });
  },
  // host.log digest for the agent's self-check (tabhelm_diagnose); null if the host is away.
  logDigest({ chatTabId, since, until, tabIds }) {
    return new Promise((resolve) => {
      const requestId = `sw-${nextLogReq++}`;
      logWaits.set(requestId, resolve);
      try {
        ensureNative().postMessage({ type: 'log_digest', tabId: chatTabId, requestId, since, until, tabIds });
      } catch {
        logWaits.delete(requestId);
        return resolve(null);
      }
      setTimeout(() => logWaits.has(requestId) && (logWaits.delete(requestId), resolve(null)), 10_000);
    });
  },
  skillsChanged() {
    for (const port of panels.values()) port.postMessage({ type: 'skills_changed' });
  },
  // The panel's chat as it is now, with the host version and installed agents
  // (tabhelm_diagnose). Null without a panel or when it does not answer.
  liveChat(chatTabId) {
    if (!panels.has(chatTabId)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const requestId = nextLogReq++;
      liveChatWaits.set(requestId, resolve);
      deliver(chatTabId, { type: 'live_chat_request', requestId });
      setTimeout(() => liveChatWaits.has(requestId) && (liveChatWaits.delete(requestId), resolve(null)), 2000);
    });
  },
  onTarget(chatTabId, tab) {
    deliver(chatTabId, { type: 'target', tabId: tab.id, title: tab.title || tab.url, isChat: tab.id === chatTabId });
  },
};

// Badge on the chat's tab + a system notification (Notifications flag).
async function notify(chatTabId, kind, text) {
  const features = await getFeatures();
  if (!features.notifications) return;
  const badge = kind === 'done' ? '✓' : kind === 'failed' ? '!' : '?';
  chrome.action.setBadgeBackgroundColor({ tabId: chatTabId, color: kind === 'failed' ? '#c2452f' : '#2a9d76' }).catch(() => {});
  chrome.action.setBadgeText({ tabId: chatTabId, text: badge }).catch(() => {});
  const tab = await chrome.tabs.get(chatTabId).catch(() => null);
  chrome.notifications
    ?.create(`tabhelm-${chatTabId}-${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: kind === 'done' ? 'TabHelm: task finished' : kind === 'failed' ? 'TabHelm: task stopped' : 'TabHelm needs you',
      message: `${(text || '').slice(0, 120)}${tab?.title ? `\n${tab.title}` : ''}`,
    })
    .catch(() => {});
}

// Clicking a notification brings the chat's tab forward.
chrome.notifications?.onClicked.addListener((id) => {
  const m = /^tabhelm-(\d+)-/.exec(id);
  if (!m) return;
  const tabId = Number(m[1]);
  chrome.tabs.update(tabId, { active: true }).catch(() => {});
  chrome.tabs.get(tabId).then((t) => chrome.windows.update(t.windowId, { focused: true })).catch(() => {});
  chrome.notifications.clear(id);
});

function askCritic(action) {
  return new Promise((resolve) => {
    const requestId = nextCriticId++;
    criticWaits.set(requestId, resolve);
    getSetting('critic').then((settings) => nativePort?.postMessage({ type: 'critic', tabId: action.chatTabId, requestId, settings, action }));
    setTimeout(() => criticWaits.has(requestId) && (criticWaits.delete(requestId), resolve({ decision: 'ask', reason: 'critic timed out' })), 60_000);
  });
}

// Remote host through a TabHelm relay (relay/server.js): chrome.storage.local
// `remote` = { url, token | code, name }. Set in Settings → Remote host.
let remoteConfig = null;
chrome.storage.local.get('remote').then(({ remote }) => (remoteConfig = remote || null));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.remote) remoteConfig = changes.remote.newValue || null;
});

function hostGone(reason) {
  nativePort = null;
  for (const port of panels.values()) port.postMessage({ type: 'host_disconnected', message: reason });
  for (const r of runners.values()) r({ type: 'host_disconnected', message: reason });
}

export function ensureNative() {
  if (nativePort) return nativePort;
  if (remoteConfig?.url && (remoteConfig.token || remoteConfig.code)) {
    nativePort = connectRelay(remoteConfig);
    return nativePort;
  }
  nativePort = chrome.runtime.connectNative(HOST_NAME);
  nativePort.onMessage.addListener(onHostMessage);
  nativePort.onDisconnect.addListener(() => hostGone(chrome.runtime.lastError?.message || 'Host exited'));
  return nativePort;
}

// A port-shaped wrapper around a WebSocket to the relay, so the rest of the
// service worker does not care where the host runs.
function connectRelay(cfg) {
  const target = new URL(cfg.url);
  target.protocol = target.protocol === 'http:' ? 'ws:' : target.protocol === 'https:' ? 'wss:' : target.protocol;
  target.pathname = `${target.pathname.replace(/\/$/, '')}/client`;
  if (cfg.token) target.searchParams.set('token', cfg.token);
  else target.searchParams.set('code', cfg.code);
  const ws = new WebSocket(target.href);
  const queue = [];
  let open = false;
  const port = {
    remote: true,
    postMessage(msg) {
      if (open) ws.send(JSON.stringify(msg));
      else queue.push(msg);
    },
    disconnect() {
      ws.onclose = null;
      ws.close();
      if (nativePort === port) nativePort = null;
    },
  };
  ws.onopen = () => {
    open = true;
    for (const m of queue.splice(0)) ws.send(JSON.stringify(m));
    keepAlive();
  };
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === 'relay') {
      if (msg.role === 'client' && msg.token && msg.token !== cfg.token) {
        // Paired: keep the session token, the code is spent.
        chrome.storage.local.set({ remote: { url: cfg.url, token: msg.token, name: msg.name || cfg.name || 'remote host' } });
      }
      if (msg.role === 'client' && !msg.hostOnline) broadcast({ type: 'error', message: `Paired with the relay, but the remote TabHelm host "${msg.name || ''}" is offline right now.` });
      if (msg.event === 'host_disconnected') broadcast({ type: 'status', state: 'stopped', detail: 'The remote host disconnected' });
      if (msg.event === 'host_connected') port.postMessage({ type: 'list_agents' });
      return;
    }
    onHostMessage(msg);
  };
  ws.onclose = (e) => {
    const why = e.code === 4401 ? 'The relay rejected the pairing code (unknown or expired). Get a new code from the remote host.' : e.code === 4429 ? 'Too many attempts — wait a minute.' : `Relay connection closed (${e.code}${e.reason ? ` ${e.reason}` : ''})`;
    if (nativePort === port) hostGone(why);
  };
  ws.onerror = () => {};
  // Chrome keeps the service worker alive while the socket has traffic.
  function keepAlive() {
    if (ws.readyState !== 1 || nativePort !== port) return;
    ws.send(JSON.stringify({ type: 'ping' }));
    setTimeout(keepAlive, 20_000);
  }
  return port;
}

function broadcast(msg) {
  for (const port of panels.values()) port.postMessage(msg);
}

async function onHostMessage(msg) {
  if (msg.type === 'tool_call') {
    const t0 = performance.now();
    let reply;
    let label;
    let note = null;
    let frame = null;
    let targetTab = null;
    let args = msg.args;
    try {
      const info = chatInfo.get(msg.tabId) || { task: '', actions: [] };
      const preview = READ_ONLY.has(msg.tool) ? { tab: null, labels: [] } : await previewTarget(msg.tabId, msg.tool, msg.args);
      const tab = preview.tab || (await chrome.tabs.get(msg.tabId).catch(() => null));
      const policy = await checkPolicy({
        chatTabId: msg.tabId,
        tool: msg.tool,
        args: msg.args,
        tab,
        label: describe(msg.tool, msg.args, preview.labels),
        task: info.task,
        recentActions: info.actions,
        ui,
        critic: (a) => askCritic({ ...a, chatTabId: msg.tabId }),
      });
      if (!policy.allow) throw new Error(policy.error);
      args = policy.args;
      const result = await runTool(msg.tabId, msg.tool, args, ui);
      label = result.label;
      note = result.note;
      targetTab = result.tabId;
      reply = { type: 'tool_result', id: msg.id, ok: true, content: result.content };
      if (!READ_ONLY.has(msg.tool)) info.actions.push(describe(msg.tool, msg.args));
      chatInfo.set(msg.tabId, info);
    } catch (err) {
      reply = { type: 'tool_result', id: msg.id, ok: false, error: err.message || String(err) };
      frame = err?.frame || null;
    }
    // For the journal: how long it took, on which site, soft notes and the code frame of internal errors.
    const ms = Math.round(performance.now() - t0);
    const host = hostOf((await chrome.tabs.get(targetTab ?? msg.tabId).catch(() => null))?.url);
    // The panel and logs get the original args (placeholders, not secrets).
    deliver(msg.tabId, { type: 'tool_activity', tool: msg.tool, args: msg.args, label, ok: reply.ok, error: reply.error, ms, host, note, frame });
    nativePort?.postMessage(reply);
    return;
  }
  if (msg.type === 'log_digest' && logWaits.has(msg.requestId)) {
    logWaits.get(msg.requestId)(msg.digest && !msg.digest.error ? msg.digest : null);
    logWaits.delete(msg.requestId);
    return;
  }
  if (msg.type === 'state_item' || msg.type === 'state_done') {
    onStateRestore(msg);
    return;
  }
  if (msg.type === 'critic_result') {
    criticWaits.get(msg.requestId)?.({ decision: msg.decision, reason: msg.reason });
    criticWaits.delete(msg.requestId);
    return;
  }
  if (msg.type === 'done') {
    markWorking(msg.tabId, false);
    notify(msg.tabId, msg.stopReason === 'end_turn' ? 'done' : 'failed', 'Task finished');
  }
  if (msg.type === 'permission') notify(msg.tabId, 'needs', msg.title);
  if (msg.tabId != null) deliver(msg.tabId, msg);
  else for (const port of panels.values()) port.postMessage(msg);
}

function describe(tool, a = {}, labels = []) {
  const t = tool.replace(/^browser_/, '').replace(/_/g, ' ');
  const extra = a.url || a.text || a.key || a.value || a.ref || '';
  const target = labels.length ? ` “${labels.map((l) => l.slice(0, 40)).join('”, “')}”` : '';
  return `${t}${target} ${String(extra).slice(0, 60)}`.trim();
}

// Messages from a panel (or a scheduled runner) to the host, with the bits the
// service worker adds or handles itself.
export async function fromPanel(tabId, msg, port) {
  if (msg.type === 'live_chat') {
    liveChatWaits.get(msg.requestId)?.(msg);
    liveChatWaits.delete(msg.requestId);
    return;
  }
  // The panel's last words (closing, New chat, opening another chat): saved here,
  // because an async storage write from a closing page may never finish.
  if (msg.type === 'journal_flush') {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    // The tab may be gone already (its panel is closing): keep the saved page,
    // so History can still bring the chat back to it.
    const prev = t ? null : await loadChat(msg.chat.id).catch(() => null);
    await saveChat({ ...msg.chat, url: t?.url ?? prev?.url ?? null, pageTitle: t?.title ?? prev?.pageTitle ?? null }).catch(() => {});
    return;
  }
  if (msg.type === 'confirm_response') {
    confirms.get(msg.id)?.resolve(Boolean(msg.allow));
    confirms.delete(msg.id);
    return;
  }
  if (msg.type === 'ask_response') {
    asks.get(msg.id)?.resolve(msg.reply);
    asks.delete(msg.id);
    return;
  }
  // ＋ menu / Settings: run a saved page script on this chat's tab.
  if (msg.type === 'run_page_script') {
    const preset = msg.id === 'draft' ? (await chrome.storage.local.get('pageScriptsDraft')).pageScriptsDraft : (await listScripts()).find((p) => p.id === msg.id);
    try {
      if (!preset) throw new Error('That script no longer exists.');
      const out = await runScript(msg.targetTabId || tabId, preset);
      port?.postMessage({ type: 'page_script_result', name: preset.name, ok: true, result: out });
    } catch (err) {
      port?.postMessage({ type: 'page_script_result', name: preset?.name, ok: false, error: err.message });
    }
    return;
  }
  if (msg.type === 'guide_action') {
    setGuideAction(tabId, msg.action);
    return;
  }
  if (msg.type === 'pause') {
    pauseChat(tabId);
    return;
  }
  if (msg.type === 'resume') {
    resumeChat(tabId);
    return;
  }
  if (msg.type === 'paused_state') {
    port?.postMessage({ type: 'paused', paused: isPaused(tabId) });
    return;
  }
  // Recording is handled inside the extension; frames go straight back to the panel.
  if (msg.type === 'record_start') {
    startRecording(tabId, (frame) => port?.postMessage({ type: 'frame', ...frame })).catch((err) => port?.postMessage({ type: 'record_error', message: err.message || String(err) }));
    return;
  }
  if (msg.type === 'record_stop') {
    stopRecording(tabId);
    return;
  }
  if (msg.type === 'group_tabs') {
    ensureGroup(tabId).then(() => postGroupInfo(tabId), (err) => port?.postMessage({ type: 'error', message: err.message }));
    return;
  }
  if (msg.type === 'group_info') {
    postGroupInfo(tabId);
    return;
  }
  if (msg.type === 'page_context_pending') {
    for (const m of pendingPageContext.get(tabId) || []) port?.postMessage(m);
    pendingPageContext.delete(tabId);
    return;
  }
  if (msg.type === 'run_schedule') {
    runScheduled(msg.id, scheduleDeps);
    return;
  }
  // Voice: a stream id for capturing the chat tab's audio (consumed by the panel).
  if (msg.type === 'tab_capture_id') {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }).then(
      (streamId) => port?.postMessage({ type: 'tab_capture_id', requestId: msg.requestId, streamId }),
      (err) => port?.postMessage({ type: 'tab_capture_id', requestId: msg.requestId, error: err?.message || String(err) }),
    );
    return;
  }
  if (msg.type === 'prompt') {
    const info = chatInfo.get(tabId) || { task: '', actions: [] };
    info.task = msg.text;
    info.actions = [];
    chatInfo.set(tabId, info);
    resumeChat(tabId);
    await focusVisibleTab(tabId, ui);
    // The tab the agent works on is grouped (green "TabHelm" group) from the first
    // task on, so it is obvious in the tab strip; yellow while a task runs.
    ensureGroup(tabId)
      .then(() => markWorking(tabId, true))
      .then(() => postGroupInfo(tabId))
      .catch(() => {}); // popup windows cannot group tabs
  }
  // Settings → Remote host changed: drop the current host and connect to the new one.
  if (msg.type === 'host_switch') {
    remoteConfig = (await chrome.storage.local.get('remote')).remote || null;
    const old = nativePort;
    nativePort = null;
    old?.disconnect();
    try {
      ensureNative().postMessage({ type: 'list_agents' });
    } catch (err) {
      port?.postMessage({ type: 'host_disconnected', message: err.message });
    }
    return;
  }
  if (msg.type === 'set_auto_approve') {
    if (msg.value) autoApproveTabs.add(tabId);
    else autoApproveTabs.delete(tabId);
  }
  if (msg.type === 'start') {
    if (msg.autoApprove) autoApproveTabs.add(tabId);
    else autoApproveTabs.delete(tabId);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const payload = await hostFeaturePayload();
    msg = { ...msg, pageUrl: tab?.url || null, features: payload.features, featureSettings: { critic: payload.critic, passwordManager: payload.passwordManager } };
    chatInfo.set(tabId, { task: '', actions: [] });
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  }
  if (msg.type === 'set_features') {
    const payload = await hostFeaturePayload();
    msg = { ...msg, features: payload.features, featureSettings: { critic: payload.critic, passwordManager: payload.passwordManager } };
  }
  try {
    ensureNative().postMessage({ ...msg, tabId });
  } catch (err) {
    port?.postMessage({ type: 'host_disconnected', message: err.message });
  }
}

chrome.runtime.onConnect.addListener((port) => {
  // Only this extension's own pages may drive the host.
  if (port.sender?.id !== chrome.runtime.id) return;
  const match = /^panel:(\d+)$/.exec(port.name);
  if (!match) return;
  const tabId = Number(match[1]);
  panels.set(tabId, port);

  port.onMessage.addListener((msg) => fromPanel(tabId, msg, port));

  port.onDisconnect.addListener(() => {
    if (panels.get(tabId) !== port) return;
    panels.delete(tabId);
    for (const [id, c] of confirms) {
      if (c.chatTabId !== tabId) continue;
      c.resolve(false);
      confirms.delete(id);
    }
    for (const [id, a] of asks) {
      if (a.chatTabId !== tabId) continue;
      a.resolve(null);
      asks.delete(id);
    }
    resumeChat(tabId);
    nativePort?.postMessage({ type: 'stop', tabId });
    releaseChat(tabId);
    // Let the host (and this service worker) shut down when no chat is open.
    if (!panels.size && !runners.size && nativePort) {
      nativePort.disconnect();
      nativePort = null;
    }
  });
});

// ---------- State backup: chrome.storage.local → ~/.tabhelm/state.json ----------
// Chrome wipes storage when the extension is removed (a reinstall via "Load
// unpacked" does that), so the host keeps a copy and the panel restores it.
const BACKUP_SKIP = /^(secret:|newsCache$)/; // secrets stay in Chrome only; news is re-fetched
let backupTimer = null;
let restoring = null;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || restoring) return;
  if (!Object.keys(changes).some((k) => !BACKUP_SKIP.test(k))) return;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(backupState, 5000);
});

async function backupState() {
  if (remoteConfig?.url) return; // the backup lives next to the local host only
  const all = await chrome.storage.local.get(null);
  const data = Object.fromEntries(Object.entries(all).filter(([k]) => !BACKUP_SKIP.test(k)));
  const hadPort = Boolean(nativePort);
  try {
    ensureNative().postMessage({ type: 'backup_state', data });
  } catch (err) {
    console.warn('TabHelm: backup failed', err);
  }
  // A host started only for the backup is released again.
  if (!hadPort && !panels.size && !runners.size) setTimeout(() => dropIdleNative(), 2000);
}

function dropIdleNative() {
  if (!panels.size && !runners.size && nativePort) {
    nativePort.disconnect();
    nativePort = null;
  }
}

// After a (re)install with empty storage, ask the host for its copy.
chrome.runtime.onInstalled.addListener(async () => {
  const { chatIndex } = await chrome.storage.local.get('chatIndex');
  if (!chatIndex) restoreState();
});

function restoreState() {
  if (remoteConfig?.url) return;
  restoring = { items: {} };
  try {
    ensureNative().postMessage({ type: 'restore_state' });
  } catch (err) {
    restoring = null;
    console.warn('TabHelm: restore failed', err);
  }
}

async function onStateRestore(msg) {
  if (!restoring) return;
  if (msg.type === 'state_item') {
    restoring.items[msg.key] = msg.value;
    return;
  }
  const items = restoring.items;
  // Never overwrite what the user already created since the install.
  const existing = await chrome.storage.local.get(Object.keys(items));
  const fresh = Object.fromEntries(Object.entries(items).filter(([k]) => !(k in existing)));
  if (Object.keys(fresh).length) await chrome.storage.local.set(fresh);
  restoring = null;
  console.log(`TabHelm: restored ${Object.keys(fresh).length} item(s) from the host backup`);
  for (const port of panels.values()) port.postMessage({ type: 'state_restored', count: Object.keys(fresh).length });
  setTimeout(() => dropIdleNative(), 2000);
}

// Page scripts with "run automatically" on: run them when a matching page finishes loading.
chrome.tabs.onUpdated.addListener(async (id, info, tab) => {
  if (info.status !== 'complete' || !/^https?:/.test(tab.url || '')) return;
  if (!(await getFeatures()).pageScripts) return;
  for (const p of await listScripts()) {
    if (!p.autoRun || p.enabled === false || !scriptMatches(p, tab.url)) continue;
    runScript(id, p).catch((err) => console.warn(`TabHelm: page script "${p.name}" failed on ${tab.url}: ${err.message}`));
  }
});

// Keep the panel's "Tab group: N tabs" chip current when tabs join or leave a group.
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.groupId === undefined) return;
  for (const chatTabId of panels.keys()) postGroupInfo(chatTabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!panels.has(tabId) && !runners.has(tabId)) return;
  nativePort?.postMessage({ type: 'stop', tabId });
  releaseChat(tabId);
});

// ---------- Scheduled tasks (Scheduled tasks flag) ----------

const scheduleDeps = {
  runners,
  send: (tabId, msg) => fromPanel(tabId, msg, null),
  release: (tabId) => {
    nativePort?.postMessage({ type: 'stop', tabId });
    releaseChat(tabId);
    if (!panels.size && !runners.size && nativePort) {
      nativePort.disconnect();
      nativePort = null;
    }
  },
  notify: (tabId, kind, text) => notify(tabId, kind, text),
};

chrome.alarms?.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith(SCHEDULE_PREFIX)) return;
  const features = await getFeatures();
  if (!features.schedules) return;
  runScheduled(alarm.name.slice(SCHEDULE_PREFIX.length), scheduleDeps);
});
