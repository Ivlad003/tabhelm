import { runTool, releaseChat } from './browser-tools.js';

const HOST_NAME = 'com.tabhelm.host';
const panels = new Map(); // chat tabId -> side panel port
const confirms = new Map(); // id -> { resolve, chatTabId }
let nextConfirmId = 1;
let nativePort = null;

// Dev hook for scripts/tools-test.js: lets the test call tools directly from the service worker.
self.tabhelmDebug = { runTool };

// Each tab gets its own side panel instance, bound to that tab's id.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
chrome.action.onClicked.addListener((tab) => {
  // Both calls must happen synchronously inside the click gesture.
  chrome.sidePanel.setOptions({ tabId: tab.id, path: `sidepanel.html?tabId=${tab.id}`, enabled: true });
  chrome.sidePanel.open({ tabId: tab.id });
});

// UI hooks the browser tools use to ask the user or report the active tab.
const ui = {
  confirm(chatTabId, title, detail) {
    const port = panels.get(chatTabId);
    if (!port) return Promise.resolve(false);
    const id = nextConfirmId++;
    port.postMessage({ type: 'confirm', id, title, detail });
    return new Promise((resolve) => confirms.set(id, { resolve, chatTabId }));
  },
  onTarget(chatTabId, tab) {
    panels.get(chatTabId)?.postMessage({ type: 'target', tabId: tab.id, title: tab.title || tab.url, isChat: tab.id === chatTabId });
  },
};

function ensureNative() {
  if (nativePort) return nativePort;
  nativePort = chrome.runtime.connectNative(HOST_NAME);
  nativePort.onMessage.addListener(onHostMessage);
  nativePort.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message || 'Host exited';
    nativePort = null;
    for (const port of panels.values()) port.postMessage({ type: 'host_disconnected', message: reason });
  });
  return nativePort;
}

async function onHostMessage(msg) {
  if (msg.type === 'tool_call') {
    let reply;
    let label;
    try {
      const result = await runTool(msg.tabId, msg.tool, msg.args, ui);
      label = result.label;
      reply = { type: 'tool_result', id: msg.id, ok: true, content: result.content };
    } catch (err) {
      reply = { type: 'tool_result', id: msg.id, ok: false, error: err.message || String(err) };
    }
    panels.get(msg.tabId)?.postMessage({ type: 'tool_activity', tool: msg.tool, args: msg.args, label, ok: reply.ok, error: reply.error });
    nativePort?.postMessage(reply);
    return;
  }
  if (msg.tabId != null) panels.get(msg.tabId)?.postMessage(msg);
  else for (const port of panels.values()) port.postMessage(msg);
}

chrome.runtime.onConnect.addListener((port) => {
  const match = /^panel:(\d+)$/.exec(port.name);
  if (!match) return;
  const tabId = Number(match[1]);
  panels.set(tabId, port);

  port.onMessage.addListener((msg) => {
    if (msg.type === 'confirm_response') {
      confirms.get(msg.id)?.resolve(Boolean(msg.allow));
      confirms.delete(msg.id);
      return;
    }
    try {
      ensureNative().postMessage({ ...msg, tabId });
    } catch (err) {
      port.postMessage({ type: 'host_disconnected', message: err.message });
    }
  });

  port.onDisconnect.addListener(() => {
    if (panels.get(tabId) !== port) return;
    panels.delete(tabId);
    for (const [id, c] of confirms) {
      if (c.chatTabId !== tabId) continue;
      c.resolve(false);
      confirms.delete(id);
    }
    nativePort?.postMessage({ type: 'stop', tabId });
    releaseChat(tabId);
    // Let the host (and this service worker) shut down when no chat is open.
    if (!panels.size && nativePort) {
      nativePort.disconnect();
      nativePort = null;
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!panels.has(tabId)) return;
  nativePort?.postMessage({ type: 'stop', tabId });
  releaseChat(tabId);
});
