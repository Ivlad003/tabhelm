import { runTool, handleDialog, detach } from './browser-tools.js';

const HOST_NAME = 'com.tabhelm.host';
const panels = new Map(); // tabId -> side panel port
let nativePort = null;

// Each tab gets its own side panel instance, bound to that tab's id.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
chrome.action.onClicked.addListener((tab) => {
  // Both calls must happen synchronously inside the click gesture.
  chrome.sidePanel.setOptions({ tabId: tab.id, path: `sidepanel.html?tabId=${tab.id}`, enabled: true });
  chrome.sidePanel.open({ tabId: tab.id });
});

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
    try {
      const content =
        msg.tool === 'browser_handle_dialog' ? await handleDialog(msg.tabId, msg.args) : await runTool(msg.tabId, msg.tool, msg.args);
      reply = { type: 'tool_result', id: msg.id, ok: true, content };
    } catch (err) {
      reply = { type: 'tool_result', id: msg.id, ok: false, error: err.message || String(err) };
    }
    panels.get(msg.tabId)?.postMessage({ type: 'tool_activity', tool: msg.tool, args: msg.args, ok: reply.ok, error: reply.error });
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
    try {
      ensureNative().postMessage({ ...msg, tabId });
    } catch (err) {
      port.postMessage({ type: 'host_disconnected', message: err.message });
    }
  });

  port.onDisconnect.addListener(() => {
    if (panels.get(tabId) !== port) return;
    panels.delete(tabId);
    nativePort?.postMessage({ type: 'stop', tabId });
    detach(tabId);
    // Let the host (and this service worker) shut down when no chat is open.
    if (!panels.size && nativePort) {
      nativePort.disconnect();
      nativePort = null;
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  nativePort?.postMessage({ type: 'stop', tabId });
  detach(tabId);
});
