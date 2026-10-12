// chrome.debugger session management plus per-tab buffers filled from CDP
// events (dialogs, console, network, file choosers, intercepted drags).

const attached = new Set();
const MAX_CONSOLE = 300;
const MAX_REQUESTS = 300;

export const dialogs = new Map(); // tabId -> { type, message }
export const consoleLogs = new Map(); // tabId -> [{ level, text, ts }]
export const requests = new Map(); // tabId -> Map(requestId -> entry)
export const fileChoosers = new Map(); // tabId -> backendNodeId
export const dragData = new Map(); // tabId -> intercepted DragData

export function cdp(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

export async function attach(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (err) {
    const msg = String(err.message || err);
    if (/already attached/i.test(msg)) throw new Error('Another debugger (probably DevTools) is attached to this tab. Close DevTools and retry.');
    throw new Error(`Cannot control this tab: ${msg}`);
  }
  attached.add(tabId);
  await Promise.all([cdp(tabId, 'Page.enable'), cdp(tabId, 'Runtime.enable'), cdp(tabId, 'Log.enable'), cdp(tabId, 'Network.enable')]);
}

export function detach(tabId) {
  if (attached.has(tabId)) chrome.debugger.detach({ tabId }).catch(() => {});
  forget(tabId);
}

function forget(tabId) {
  attached.delete(tabId);
  for (const m of [dialogs, consoleLogs, requests, fileChoosers, dragData]) m.delete(tabId);
}

chrome.debugger.onDetach.addListener((source) => forget(source.tabId));

function pushLog(tabId, level, text) {
  const list = consoleLogs.get(tabId) || [];
  list.push({ level, text, ts: Date.now() });
  if (list.length > MAX_CONSOLE) list.splice(0, list.length - MAX_CONSOLE);
  consoleLogs.set(tabId, list);
}

function remoteObjectText(arg) {
  if (arg.type === 'string') return arg.value;
  if ('value' in arg) return JSON.stringify(arg.value);
  if (arg.unserializableValue) return arg.unserializableValue;
  return arg.description || arg.type;
}

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  switch (method) {
    case 'Page.javascriptDialogOpening':
      dialogs.set(tabId, { type: params.type, message: params.message });
      break;
    case 'Page.javascriptDialogClosed':
      dialogs.delete(tabId);
      break;
    case 'Page.fileChooserOpened':
      fileChoosers.set(tabId, params.backendNodeId);
      break;
    case 'Input.dragIntercepted':
      dragData.set(tabId, params.data);
      break;

    case 'Runtime.consoleAPICalled': {
      const where = params.stackTrace?.callFrames?.[0];
      const loc = where ? ` (${where.url}:${where.lineNumber + 1})` : '';
      pushLog(tabId, params.type === 'warning' ? 'warning' : params.type, params.args.map(remoteObjectText).join(' ') + loc);
      break;
    }
    case 'Runtime.exceptionThrown': {
      const d = params.exceptionDetails;
      pushLog(tabId, 'error', `Uncaught ${d.exception?.description || d.text}${d.url ? ` (${d.url}:${d.lineNumber + 1})` : ''}`);
      break;
    }
    case 'Log.entryAdded':
      pushLog(tabId, params.entry.level, `${params.entry.text}${params.entry.url ? ` (${params.entry.url})` : ''}`);
      break;

    case 'Network.requestWillBeSent': {
      const map = requests.get(tabId) || new Map();
      map.set(params.requestId, { method: params.request.method, url: params.request.url, type: params.type || 'Other', status: null, failed: null });
      if (map.size > MAX_REQUESTS) map.delete(map.keys().next().value);
      requests.set(tabId, map);
      break;
    }
    case 'Network.responseReceived': {
      const entry = requests.get(tabId)?.get(params.requestId);
      if (entry) Object.assign(entry, { status: params.response.status, mime: params.response.mimeType });
      break;
    }
    case 'Network.loadingFailed': {
      const entry = requests.get(tabId)?.get(params.requestId);
      if (entry) entry.failed = params.canceled ? 'canceled' : params.errorText;
      break;
    }
  }
});
