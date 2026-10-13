import { runTool, releaseChat, startRecording, stopRecording, ensureGroup, groupInfo, chatForGroupTab, chatDebugState, previewTarget } from './browser-tools.js';
import { checkPolicy, pauseChat, resumeChat, isPaused, READ_ONLY } from './policy.js';
import { getFeatures, getSetting, hostFeaturePayload } from './features.js';
import { runScheduled, SCHEDULE_PREFIX } from './scheduler.js';

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
self.tabhelmDebug = { runTool, ensureGroup, chatDebugState, runSchedule: (id) => runScheduled(id, scheduleDeps), sendPageContext, backupState, restoreState };

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
  confirm(chatTabId, title, detail) {
    if (!panels.has(chatTabId)) return Promise.resolve(false); // scheduled runs never confirm
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
  skillsChanged() {
    for (const port of panels.values()) port.postMessage({ type: 'skills_changed' });
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

export function ensureNative() {
  if (nativePort) return nativePort;
  nativePort = chrome.runtime.connectNative(HOST_NAME);
  nativePort.onMessage.addListener(onHostMessage);
  nativePort.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message || 'Host exited';
    nativePort = null;
    for (const port of panels.values()) port.postMessage({ type: 'host_disconnected', message: reason });
    for (const r of runners.values()) r({ type: 'host_disconnected', message: reason });
  });
  return nativePort;
}

async function onHostMessage(msg) {
  if (msg.type === 'tool_call') {
    let reply;
    let label;
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
      reply = { type: 'tool_result', id: msg.id, ok: true, content: result.content };
      if (!READ_ONLY.has(msg.tool)) info.actions.push(describe(msg.tool, msg.args));
      chatInfo.set(msg.tabId, info);
    } catch (err) {
      reply = { type: 'tool_result', id: msg.id, ok: false, error: err.message || String(err) };
    }
    // The panel and logs get the original args (placeholders, not secrets).
    deliver(msg.tabId, { type: 'tool_activity', tool: msg.tool, args: msg.args, label, ok: reply.ok, error: reply.error });
    nativePort?.postMessage(reply);
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
  if (msg.type === 'done') notify(msg.tabId, msg.stopReason === 'end_turn' ? 'done' : 'failed', 'Task finished');
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
  }
  if (msg.type === 'start') {
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
