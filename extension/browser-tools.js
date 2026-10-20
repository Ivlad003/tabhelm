// Browser tools executed for an agent. Every chat (side panel) is bound to the
// tab it was opened on; the agent may additionally work with tabs it opened,
// tabs the page opened, or tabs the user approved. Reads go through
// chrome.scripting; mouse and keyboard go through CDP Input.* (trusted events).

import { cdp, attach, detach, dialogs, consoleLogs, requests, fileChoosers, dragData, screencastListeners } from './cdp.js';
import { getFeatures, setFeature } from './features.js';
import { listScripts, scriptMatches, saveScript } from './scripts-lib.js';
import * as P from './page-scripts.js';

const chats = new Map(); // chatTabId -> { chatTabId, current, owned: Set, notes: [] }

function chatState(chatTabId) {
  let c = chats.get(chatTabId);
  if (!c) {
    c = { chatTabId, current: chatTabId, owned: new Set([chatTabId]), notes: [], interjections: [], groupId: null };
    chats.set(chatTabId, c);
  }
  return c;
}

export function releaseChat(chatTabId) {
  stopRecording(chatTabId);
  const c = chats.get(chatTabId);
  chats.delete(chatTabId);
  const stillUsed = new Set([...chats.values()].flatMap((o) => [...o.owned]));
  for (const t of c?.owned || [chatTabId]) if (!stillUsed.has(t)) detach(t);
}

// Only tabs opened while the agent is acting (a popup after its click) are
// handed to it; tabs the user opens from the same page are not.
chrome.tabs.onCreated.addListener((tab) => {
  for (const c of chats.values()) {
    if (tab.openerTabId != null && c.owned.has(tab.openerTabId) && Date.now() < (c.actingUntil || 0)) {
      c.owned.add(tab.id);
      addToGroup(c, tab.id);
      c.notes.push(`The page opened a new tab ${tab.id} (${tab.pendingUrl || tab.url || 'loading'}). Use it with tabId ${tab.id} or browser_tabs.`);
    }
  }
});

// ---------- tab groups ----------
// A chat can own a Chrome tab group: every tab in it is available to the agent
// without asking, so the user shares tabs by dragging them into the group.

// For tests: what a chat can reach.
export function chatDebugState(chatTabId) {
  const c = chats.get(chatTabId);
  return c ? { current: c.current, owned: [...c.owned], groupId: c.groupId, recording: recordings.get(chatTabId)?.tabId ?? null } : null;
}

// The chat whose group a tab belongs to (synchronous, for the action click).
export function chatForGroupTab(tab) {
  if (tab.groupId == null || tab.groupId === -1) return null;
  for (const c of chats.values()) if (c.groupId === tab.groupId && c.chatTabId !== tab.id) return c.chatTabId;
  return null;
}

// Creates the chat's group (or adopts the group the chat tab is already in).
export async function ensureGroup(chatTabId) {
  const c = chatState(chatTabId);
  const tab = await chrome.tabs.get(chatTabId);
  if (tab.groupId !== -1) {
    c.groupId = tab.groupId;
  } else {
    c.groupId = await chrome.tabs.group({ tabIds: [chatTabId] });
    await chrome.tabGroups.update(c.groupId, { title: 'TabHelm', color: 'green' });
  }
  return groupInfo(chatTabId);
}

// The group shows what the agent is up to: yellow while it works, green when it is done.
export async function markWorking(chatTabId, working) {
  const c = chats.get(chatTabId);
  if (c?.groupId == null) return;
  await chrome.tabGroups.update(c.groupId, { title: working ? 'TabHelm ⏳' : 'TabHelm', color: working ? 'yellow' : 'green' }).catch(() => {});
}

export async function groupInfo(chatTabId) {
  const c = chatState(chatTabId);
  if (c.groupId == null) {
    // Adopt a group the user made themselves.
    const tab = await chrome.tabs.get(chatTabId).catch(() => null);
    if (tab && tab.groupId !== -1) c.groupId = tab.groupId;
  }
  if (c.groupId == null) return { grouped: false, count: 1 };
  const tabs = await chrome.tabs.query({ groupId: c.groupId }).catch(() => []);
  if (!tabs.length) {
    c.groupId = null;
    return { grouped: false, count: 1 };
  }
  return { grouped: true, count: tabs.length, groupId: c.groupId };
}

// Tabs the agent opens always land in the chat's group (created on first use),
// so the user can tell the agent's tabs from their own.
async function addToGroup(c, tabId) {
  if (c.groupId == null) await ensureGroup(c.chatTabId).catch(() => {}); // e.g. popup windows cannot group
  if (c.groupId == null) return;
  await chrome.tabs.group({ groupId: c.groupId, tabIds: [tabId] }).catch(() => {});
}

async function inGroup(c, tabId) {
  if (c.groupId == null) await groupInfo(c.chatTabId);
  if (c.groupId == null) return false;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return tab?.groupId === c.groupId;
}

// Tabs the agent may use: the chat tab, tabs it opened or was allowed, and the group.
async function chatTabs(c) {
  const ids = new Set(c.owned);
  if (c.groupId != null || (await groupInfo(c.chatTabId)).grouped) {
    for (const t of await chrome.tabs.query({ groupId: c.groupId })) ids.add(t.id);
  }
  return (await Promise.all([...ids].map((id) => chrome.tabs.get(id).catch(() => null)))).filter(Boolean);
}

// Resolves the tab a page tool acts on: tabId from the call, else the current tab.
async function targetTab(c, requested, ui) {
  if (requested == null) return c.current;
  const id = Number(requested);
  const tab = await chrome.tabs.get(id).catch(() => null);
  if (!tab) throw new Error(`No tab ${requested}. Use browser_tabs list.`);
  if (!c.owned.has(id) && !(await inGroup(c, id))) {
    const ok = await ui.confirm(c.chatTabId, 'Let the agent use another tab?', `${tab.title}\n${tab.url}`, { routine: true });
    if (!ok) throw new Error('The user did not allow using that tab.');
    c.owned.add(id);
    await addToGroup(c, id);
  }
  return id;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const c of chats.values()) {
    c.owned.delete(tabId);
    if (c.current === tabId && tabId !== c.chatTabId) {
      c.current = c.chatTabId;
      c.notes.push(`Tab ${tabId} was closed; tools act on the chat tab again.`);
      followTarget(c);
    }
  }
});

// ---------- recording ----------
// Frames come from CDP Page.startScreencast on the tab the agent acts on; the
// side panel turns them into a video. Background tabs do not render frames.

const recordings = new Map(); // chatTabId -> { tabId, onFrame }

export async function startRecording(chatTabId, onFrame, tabId = chatState(chatTabId).current) {
  await stopRecording(chatTabId);
  await assertControllable(tabId);
  await attach(tabId);
  screencastListeners.set(tabId, onFrame);
  await cdp(tabId, 'Page.startScreencast', { format: 'jpeg', quality: 75, maxWidth: 1600, maxHeight: 1000 });
  recordings.set(chatTabId, { tabId, onFrame });
}

// While recording, the tab the agent acts on (also via tabId, without switching)
// is brought to the front — Chrome renders frames only for visible tabs — and
// the recording moves there.
async function recordTab(chatTabId, tabId) {
  const rec = recordings.get(chatTabId);
  if (!rec || rec.tabId === tabId) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  if (!tab.active) await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  await startRecording(chatTabId, rec.onFrame, tabId).catch(() => {});
}

export async function stopRecording(chatTabId) {
  const rec = recordings.get(chatTabId);
  if (!rec) return;
  recordings.delete(chatTabId);
  screencastListeners.delete(rec.tabId);
  await cdp(rec.tabId, 'Page.stopScreencast').catch(() => {});
}

// Keep recording the tab the agent works on when it switches tabs.
async function followTarget(c) {
  await recordTab(c.chatTabId, c.current);
}

// ---------- helpers ----------

const text = (t) => [{ type: 'text', text: t }];
// Tools that only read: they do not pull a background tab to the front for the recording.
const READ_ONLY_TOOLS = new Set(['browser_snapshot', 'browser_find', 'browser_get_text', 'browser_console', 'browser_network', 'browser_network_body', 'browser_script_list', 'browser_script_save']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseRef(ref) {
  const m = /^(?:f(\d+):)?(e\d+)$/.exec(String(ref ?? '').trim());
  if (!m) throw new Error(`Invalid ref "${ref}". Use a ref from browser_snapshot or browser_find, e.g. "e12" or "f3:e5".`);
  return { frameId: m[1] ? Number(m[1]) : 0, ref: m[2] };
}

async function inject(tabId, func, args = [], frameId = 0) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func, args });
  return res?.result;
}

async function injectAll(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func, args });
  return results.filter((r) => r.result).sort((a, b) => a.frameId - b.frameId);
}

function checked(res) {
  if (!res) throw new Error('The page did not respond (it may be navigating). Try again.');
  if (res.error) throw new Error(res.error);
  return res;
}

async function assertControllable(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error('The tab was closed.');
  const url = tab.url || tab.pendingUrl || '';
  if (/^(chrome|chrome-extension|edge|brave|about|devtools|view-source):/.test(url) || url.startsWith('https://chromewebstore.google.com')) {
    throw new Error(`Chrome does not allow extensions to control ${url}. Navigate to a normal web page first.`);
  }
  const dialog = dialogs.get(tabId);
  if (dialog) throw new Error(`A JavaScript ${dialog.type} dialog is blocking the page: "${dialog.message}". Use browser_handle_dialog first.`);
  return tab;
}

async function waitForLoad(tabId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('The tab was closed.');
    if (tab.status === 'complete') return tab;
    await sleep(200);
  }
  return chrome.tabs.get(tabId);
}

// After an action give the page a moment; if it navigated, wait for the load.
async function settle(tabId, urlBefore) {
  await sleep(400);
  const tab = await waitForLoad(tabId, 15_000);
  let note = tab.url !== urlBefore ? ` Page navigated to ${tab.url}.` : '';
  if (dialogs.has(tabId)) note += ` A ${dialogs.get(tabId).type} dialog opened: "${dialogs.get(tabId).message}".`;
  return note;
}

function normalizeUrl(url) {
  url = String(url).trim();
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
}

// Shows the agent cursor at top-level viewport coordinates (best effort).
function pointer(tabId, x, y, kind) {
  return inject(tabId, P.showPointer, [x, y, kind]).catch(() => {});
}

// Offset of a frame's viewport inside the top-level viewport (matching iframes by URL).
async function frameOffset(tabId, frameId) {
  if (frameId === 0) return { x: 0, y: 0 };
  const frame = await chrome.webNavigation.getFrame({ tabId, frameId }).catch(() => null);
  if (!frame || frame.parentFrameId < 0) return null;
  const local = await inject(tabId, P.iframeOffset, [frame.url], frame.parentFrameId).catch(() => null);
  if (!local) return null;
  const up = await frameOffset(tabId, frame.parentFrameId);
  return up && { x: up.x + local.x, y: up.y + local.y };
}

// Resolves a ref to top-level viewport coordinates. `exact: false` means the
// element is in a cross-origin frame we could not position.
async function locate(tabId, refStr, scroll = true) {
  const { frameId, ref } = parseRef(refStr);
  const res = checked(await inject(tabId, P.elementCenter, [ref, scroll], frameId));
  if (frameId === 0) return { ...res, frameId, ref, exact: true };
  if (res.topX != null) return { ...res, x: res.topX, y: res.topY, frameId, ref, exact: true };
  const off = await frameOffset(tabId, frameId);
  if (off) return { ...res, x: res.x + off.x, y: res.y + off.y, frameId, ref, exact: true };
  return { ...res, frameId, ref, exact: false };
}

async function point(tabId, ref, xy, name) {
  if (ref) {
    const loc = await locate(tabId, ref);
    if (!loc.exact) throw new Error(`Cannot position ${ref}: it is inside a cross-origin iframe we could not locate.`);
    return { x: loc.x, y: loc.y, label: `${ref} "${loc.label}"` };
  }
  if (xy && typeof xy.x === 'number' && typeof xy.y === 'number') return { x: xy.x, y: xy.y, label: `(${xy.x}, ${xy.y})` };
  throw new Error(`Provide ${name}: a ref or x/y coordinates.`);
}

// ---------- mouse & keyboard ----------

const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const MODIFIER_ALIASES = { ctrl: 'Control', control: 'Control', shift: 'Shift', alt: 'Alt', option: 'Alt', meta: 'Meta', cmd: 'Meta', command: 'Meta', win: 'Meta' };

function modifierMask(list = []) {
  return list.reduce((mask, m) => mask | (MODIFIER_BITS[MODIFIER_ALIASES[String(m).toLowerCase()]] || 0), 0);
}

// Input events block while a page handler shows alert()/confirm(); stop
// waiting as soon as a dialog opens so the agent can handle it.
async function input(tabId, method, params) {
  let timer;
  const dialogOpened = new Promise((resolve) => {
    timer = setInterval(() => dialogs.has(tabId) && resolve('dialog'), 50);
  });
  try {
    return await Promise.race([cdp(tabId, method, params), dialogOpened]);
  } finally {
    clearInterval(timer);
  }
}

async function mouseClick(tabId, x, y, { button = 'left', count = 1, modifiers = 0 } = {}) {
  await input(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
  for (let i = 1; i <= count; i++) {
    if (dialogs.has(tabId)) return;
    await input(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i, modifiers });
    if ((await input(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i, modifiers })) === 'dialog') return;
  }
}

async function mouseDrag(tabId, from, to) {
  dragData.delete(tabId);
  await cdp(tabId, 'Input.setInterceptDrags', { enabled: true });
  try {
    await input(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
    await input(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      await input(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
      await sleep(16);
    }
    const data = dragData.get(tabId);
    if (data) {
      // Native HTML5 drag-and-drop: replay it as drag events at the target.
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        await input(tabId, 'Input.dispatchDragEvent', { type, x: to.x, y: to.y, data });
      }
    }
    await input(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
    return data ? 'html5' : 'mouse';
  } finally {
    dragData.delete(tabId);
    await cdp(tabId, 'Input.setInterceptDrags', { enabled: false }).catch(() => {});
  }
}

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  Insert: { code: 'Insert', keyCode: 45 },
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, { code: `F${i + 1}`, keyCode: 112 + i }])),
};

// Editing shortcuts need explicit commands to take effect via CDP.
const EDIT_COMMANDS = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo', y: 'redo' };

function parseCombo(combo) {
  const parts = String(combo).split('+').map((p) => p.trim()).filter(Boolean);
  if (String(combo).endsWith('++')) parts.push('+');
  const keyName = parts.pop();
  const mods = parts.map((p) => MODIFIER_ALIASES[p.toLowerCase()]);
  if (mods.some((m) => !m)) throw new Error(`Unknown modifier in "${combo}". Use Control, Shift, Alt, Meta.`);
  const modifiers = modifierMask(mods);

  let def = KEYS[keyName] || KEYS[keyName?.[0]?.toUpperCase() + keyName?.slice(1)];
  if (!def && keyName?.length === 1) {
    const ch = keyName;
    const upper = ch.toUpperCase();
    const code = /[a-z]/i.test(ch) ? `Key${upper}` : /\d/.test(ch) ? `Digit${ch}` : '';
    const printable = !(modifiers & (MODIFIER_BITS.Control | MODIFIER_BITS.Meta | MODIFIER_BITS.Alt));
    const key = modifiers & MODIFIER_BITS.Shift ? upper : ch.toLowerCase();
    def = { key, code, keyCode: upper.charCodeAt(0), text: printable ? key : undefined };
    if (!printable && EDIT_COMMANDS[ch.toLowerCase()]) {
      def.commands = [modifiers & MODIFIER_BITS.Shift && ch.toLowerCase() === 'z' ? 'redo' : EDIT_COMMANDS[ch.toLowerCase()]];
    }
  }
  if (!def) throw new Error(`Unsupported key "${keyName}". Use names like Enter, Tab, Escape, ArrowDown, F5, a single character, or combos like Control+A.`);
  return { ...def, key: def.key || keyName, modifiers };
}

async function pressKey(tabId, combo) {
  const k = parseCombo(combo);
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: k.modifiers };
  if ((await input(tabId, 'Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', text: k.text, commands: k.commands, ...base })) === 'dialog') return;
  await input(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

// Clicks may open a native file chooser; intercept it so the agent can fill it.
async function withFileChooserIntercept(tabId, fn) {
  fileChoosers.delete(tabId);
  await input(tabId, 'Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => {});
  try {
    return await fn();
  } finally {
    await input(tabId, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
  }
}

const chooserNote = (tabId) => (fileChoosers.has(tabId) ? ' A file chooser opened: call browser_upload_file with paths (no ref) to pick files.' : '');

// ---------- screenshots ----------

async function screenshot(tabId, args) {
  const dpr = (await cdp(tabId, 'Runtime.evaluate', { expression: 'devicePixelRatio', returnByValue: true })).result?.value || 1;
  const metrics = await cdp(tabId, 'Page.getLayoutMetrics');
  const vp = metrics.cssVisualViewport;
  let clip;
  let note;
  let beyond = false;

  if (args.ref) {
    const { frameId, ref } = parseRef(args.ref);
    const r = checked(await inject(tabId, P.elementRect, [ref], frameId));
    const off = (await frameOffset(tabId, frameId)) || { x: 0, y: 0 };
    clip = { x: vp.pageX + off.x + r.x, y: vp.pageY + off.y + r.y, width: Math.max(1, r.width), height: Math.max(1, r.height) };
    note = `Element ${args.ref}, ${Math.round(r.width)}×${Math.round(r.height)} CSS px.`;
    beyond = true;
  } else if (args.fullPage) {
    const size = metrics.cssContentSize;
    const width = Math.min(Math.ceil(size.width), 2000);
    const height = Math.min(Math.ceil(size.height), 12000);
    clip = { x: 0, y: 0, width, height };
    note = `Full page ${width}×${height} CSS px${size.height > height ? ' (cut at 12000px)' : ''}. These are page coordinates; for clicking by position use a viewport screenshot.`;
    beyond = true;
  } else {
    clip = { x: vp.pageX, y: vp.pageY, width: vp.clientWidth, height: vp.clientHeight };
    note = `Viewport ${Math.round(vp.clientWidth)}×${Math.round(vp.clientHeight)} CSS px. Image pixels map 1:1 to x/y for browser_click_xy, browser_hover and browser_drag.`;
  }

  const shot = cdp(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 60, clip: { ...clip, scale: 1 / dpr }, captureBeyondViewport: beyond });
  const { data } = await Promise.race([
    shot,
    sleep(20_000).then(() => {
      throw new Error('Screenshot timed out. Background tabs may not render; switch to a visible tab.');
    }),
  ]);
  return [{ type: 'text', text: note }, { type: 'image', data, mimeType: 'image/jpeg' }];
}

// ---------- tabs ----------

async function tabsTool(c, args, ui) {
  const mine = new Set((await chatTabs(c)).map((t) => t.id));
  const describe = (t) =>
    `${t.id}${t.id === c.current ? ' (current)' : ''}${t.id === c.chatTabId ? ' (chat tab)' : ''}${mine.has(t.id) ? '' : ' (needs user approval)'}: ${t.title || ''} — ${t.url || t.pendingUrl || ''}`;

  switch (args.action) {
    case 'list': {
      const tabs = args.all ? await chrome.tabs.query({}) : await chatTabs(c);
      const note = c.groupId != null ? '\nTabs in the chat\'s tab group are shared by the user. Pass tabId to any page tool to act on a tab without switching.' : '\nPass tabId to any page tool to act on a tab without switching.';
      return { content: text((tabs.map(describe).join('\n') || 'No tabs.') + note) };
    }
    case 'new': {
      // Opened in the background so the user keeps seeing the chat tab and panel.
      const tab = await chrome.tabs.create({ url: normalizeUrl(args.url || 'about:blank'), active: false, openerTabId: c.chatTabId });
      c.owned.add(tab.id);
      await addToGroup(c, tab.id);
      c.current = tab.id;
      const loaded = await waitForLoad(tab.id);
      await followTarget(c);
      ui.onTarget(c.chatTabId, loaded);
      return { content: text(`Opened tab ${tab.id} in the background: ${loaded.url}. Tools now act on it. Note: background tabs may not render screenshots.`) };
    }
    case 'switch': {
      const id = Number(args.tabId);
      const tab = await chrome.tabs.get(id).catch(() => null);
      if (!tab) throw new Error(`No tab ${args.tabId}.`);
      if (!c.owned.has(id) && !(await inGroup(c, id))) {
        const ok = await ui.confirm(c.chatTabId, 'Let the agent control another tab?', `${tab.title}\n${tab.url}`, { routine: true });
        if (!ok) throw new Error('The user did not allow controlling that tab.');
        c.owned.add(id);
        await addToGroup(c, id);
      }
      c.current = id;
      await followTarget(c);
      ui.onTarget(c.chatTabId, tab);
      return { content: text(`Tools now act on tab ${id}: ${tab.title} — ${tab.url}`) };
    }
    case 'close': {
      const id = Number(args.tabId);
      if (id === c.chatTabId) throw new Error('The chat tab cannot be closed by the agent.');
      if (!c.owned.has(id)) throw new Error('Only tabs the agent opened or was allowed to control can be closed (not tabs you shared).');
      await chrome.tabs.remove(id);
      return { content: text(`Closed tab ${id}.`) };
    }
    default:
      throw new Error('action must be list, new, switch or close.');
  }
}

// What a tool call is about to touch (element label, page) — for the policy
// layers that must decide before the action runs. Never throws.
export async function previewTarget(chatTabId, tool, args) {
  try {
    const c = chatState(chatTabId);
    const tabId = args?.tabId != null ? Number(args.tabId) : c.current;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const refs = [args?.ref, args?.fromRef, args?.toRef, ...(args?.fields || []).map((f) => f.ref)].filter(Boolean);
    const labels = [];
    for (const r of refs.slice(0, 6)) {
      const { frameId, ref } = parseRef(r);
      const res = await inject(tabId, P.elementCenter, [ref, false], frameId).catch(() => null);
      if (res?.label) labels.push(res.label);
    }
    return { tab, labels };
  } catch {
    return { tab: null, labels: [] };
  }
}

// ---------- dispatcher ----------

export async function runTool(chatTabId, tool, args, ui) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
  try {
    return await runToolInner(chatTabId, tool, args, ui);
  } catch (err) {
    // Wrong argument types surface as a clear message for the agent, not as internals.
    if (err instanceof TypeError) throw new Error(`Invalid arguments for ${tool} (${err.message}). Check the tool's parameters and try again.`);
    throw err;
  }
}

async function runToolInner(chatTabId, tool, args, ui) {
  const c = chatState(chatTabId);
  let result;
  if (tool === 'browser_tabs') result = await tabsTool(c, args, ui);
  else if (tool === 'skill_save') result = await saveSkill(args, ui);
  else if (tool === 'browser_search_tabs') result = await searchTabs(c, args);
  else if (tool === 'browser_handle_dialog') result = await handleDialog(await targetTab(c, args.tabId, ui), args);
  else {
    const tabId = await targetTab(c, args.tabId, ui);
    const tab = await assertControllable(tabId);
    if (!READ_ONLY_TOOLS.has(tool)) await recordTab(chatTabId, tabId);
    await attach(tabId);
    c.actingUntil = Infinity;
    try {
      result = await runPageTool(tabId, tab, tool, args, ui, chatTabId);
    } finally {
      // Popups may open a moment after the action finished.
      c.actingUntil = Date.now() + 3000;
    }
  }
  if (c.notes.length) {
    result.content = [...result.content, { type: 'text', text: `\n${c.notes.splice(0).join('\n')}` }];
  }
  // Messages the user typed while the agent was working ride along with the
  // next tool result, so the agent picks them up without waiting for the turn to end.
  if (c.interjections.length) {
    const texts = c.interjections.splice(0);
    result.content = [...result.content, { type: 'text', text: `\n[Message from the user while you were working — take it into account now]\n${texts.join('\n\n')}` }];
    ui.onInterjected?.(chatTabId, texts);
  }
  return result;
}

// Guide mode: a tour of steps (or one step) shown on the page. Every step on a
// page gets a numbered badge; Next/Back move the active step — scrolling to it and
// switching tabs when a step lives on another tab — and a click on the active
// element counts as done. The panel mirrors the step and its buttons.
async function guideTour(chatTabId, defaultTab, args, ui) {
  const c = chatState(chatTabId);
  const steps = (args.steps?.length ? args.steps : [{ ref: args.ref, text: args.text }]).map((st, i) => ({
    index: i,
    ref: st.ref || null,
    text: String(st.text || ''),
    tabId: st.tabId != null ? Number(st.tabId) : defaultTab,
  }));
  const single = !args.steps?.length;
  const startNumber = args.step || 1;
  const results = steps.map(() => null);
  let i = 0;
  let shownTab = null;
  let shownFrame = 0;
  const started = Date.now();
  const hide = () => (shownTab != null ? inject(shownTab, P.guideHide, [], shownFrame).catch(() => {}) : null);
  // Auto-play: the agent clicks each step itself after a pause the user can read.
  // Started by the ▶ Auto button, or by the agent's auto:true after the user agrees.
  const { guidePause = 3 } = await chrome.storage.local.get('guidePause');
  const pauseMs = Math.max(1, Number(args.pause || guidePause) || 3) * 1000;
  let auto = false;
  if (args.auto) {
    auto = await ui.confirm(chatTabId, `Play this guide automatically (${steps.length} step${steps.length > 1 ? 's' : ''})?`, `The agent will click each highlighted element itself, pausing ${pauseMs / 1000} s before every click. Press ⏸ Pause on the page or in the panel to take over.`, { routine: true });
  }

  while (i < steps.length && Date.now() - started < 30 * 60_000) {
    const step = steps[i];
    const tabId = step.tabId;
    if (!c.owned.has(tabId) && !(await inGroup(c, tabId))) throw new Error(`Step ${i + 1} points at tab ${tabId}, which this chat cannot use.`);
    // Steps on another tab bring that tab to the front.
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error(`Tab ${tabId} of step ${i + 1} is gone.`);
    if (!tab.active) await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    await attach(tabId);
    let frameId = 0;
    let ref = null;
    let label = '';
    if (step.ref) {
      const parsed = parseRef(step.ref);
      frameId = parsed.frameId;
      ref = parsed.ref;
    }
    const sameFrame = steps.filter((st) => st.tabId === tabId && (st.ref ? parseRef(st.ref).frameId === frameId : true)).map((st) => ({ index: st.index, ref: st.ref ? parseRef(st.ref).ref : null, text: st.text, canBack: single && startNumber > 1 }));
    const shown = await inject(tabId, P.guideTour, [sameFrame, i, steps.length, { auto, pauseMs }], frameId).catch(() => null);
    label = shown?.label || '';
    shownTab = tabId;
    shownFrame = frameId;
    c.guideAction = null;
    ui.guideProgress?.(chatTabId, { index: i, total: steps.length, text: step.text, target: label, found: Boolean(shown?.found), tabId, tabTitle: tab.title, number: single ? startNumber : i + 1, auto });

    let status = 'waiting';
    const shownAt = Date.now();
    while (status === 'waiting' && Date.now() - started < 30 * 60_000) {
      await sleep(auto ? 200 : 400);
      if (auto && Date.now() - shownAt >= pauseMs && !c.guideAction) {
        status = 'autoplay';
        break;
      }
      if (c.guideAction) {
        status = c.guideAction;
        c.guideAction = null;
        break;
      }
      const st = await inject(tabId, P.guideStatus, [], frameId).catch(() => ({ status: 'navigated' }));
      status = st?.status === 'gone' || st?.index !== i ? 'navigated' : st?.status || 'navigated';
    }
    await hide();
    if (status === 'auto' || status === 'pause') {
      auto = status === 'auto';
      continue; // show the same step again in the new mode
    }
    if (status === 'autoplay') {
      // The agent clicks the highlighted element itself, like the user would.
      if (ref) {
        try {
          const loc = await locate(tabId, step.ref);
          const urlBefore = (await chrome.tabs.get(tabId)).url;
          await pointer(tabId, loc.x, loc.y, 'click');
          await mouseClick(tabId, loc.x, loc.y);
          await settle(tabId, urlBefore);
          results[i] = 'auto-clicked';
        } catch (err) {
          results[i] = `auto-click failed: ${err.message}`;
          auto = false; // let the user take over this step
          continue;
        }
      } else results[i] = 'shown';
      i++;
      continue;
    }
    if (status === 'stop') {
      ui.guideDone?.(chatTabId, { stopped: true });
      throw new Error('The user stopped the guide.');
    }
    if (status === 'back') {
      if (i === 0) {
        // Nothing earlier in this tour: hand it back to the agent.
        ui.guideDone?.(chatTabId, { back: true });
        if (single) return { content: text(`The user pressed Back: show the previous step again (call browser_guide with step ${Math.max(1, startNumber - 1)}, its element and its instruction; snapshot first if the page changed), then continue from there.`), label: `step ${startNumber} → back` };
        return { content: text('The user pressed Back on the first step: there is nothing earlier in this guide. Ask what they want to revisit, or show the previous guide again.'), label: 'guide → back' };
      }
      i--;
      continue;
    }
    results[i] = status === 'skipped' ? 'skipped' : status === 'navigated' ? 'clicked (page changed)' : status === 'clicked' ? 'clicked' : 'done';
    i++;
  }
  ui.guideDone?.(chatTabId, { results });
  if (i < steps.length) throw new Error('The guide timed out after 30 minutes.');
  const summary = steps.map((st, k) => `${single ? startNumber : k + 1}. ${st.text} → ${results[k]}`).join('\n');
  const skipped = results.filter((r) => r === 'skipped').length;
  const labelText = single ? `step ${startNumber} → ${results[0]}` : `${steps.length} steps, ${skipped} skipped`;
  return { content: text(`${single ? 'The user finished the step' : 'The user finished the guide'}:\n${summary}\n${skipped ? 'Ask whether the skipped steps need help. ' : ''}Take a new browser_snapshot before continuing.`), label: labelText };
}

// CSS goes in as a removable <style>; JS runs in the page's own context through
// the debugger (so page CSP does not block it), wrapped in an async function.
export async function runScript(tabId, preset) {
  if (preset.css) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (k, css) => {
        let el = document.getElementById(k);
        if (!el) {
          el = document.createElement('style');
          el.id = k;
          (document.head || document.documentElement).append(el);
        }
        el.textContent = css;
      },
      args: [`tabhelm-preset-${preset.id}`, preset.css],
    });
  }
  if (!preset.js) return '';
  await attach(tabId);
  const res = await cdp(tabId, 'Runtime.evaluate', { expression: `(async () => {\n${preset.js}\n})()`, awaitPromise: true, returnByValue: true, userGesture: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  const v = res.result;
  if (v.type === 'undefined') return '';
  const out = 'value' in v ? JSON.stringify(v.value) : v.description || v.type;
  return out.length > 5000 ? `${out.slice(0, 5000)}…` : out;
}

export function setGuideAction(chatTabId, action) {
  const c = chats.get(chatTabId);
  if (c) c.guideAction = action;
}

export function interject(chatTabId, text) {
  chatState(chatTabId).interjections.push(text);
}

export function dropInterjections(chatTabId) {
  const c = chats.get(chatTabId);
  if (c) c.interjections = [];
}

// skill_save: a skill written by the agent (e.g. from this chat) goes into the
// panel's authored skills and the Skill authoring flag is switched on.
async function saveSkill(args, ui) {
  const name = String(args.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  const body = String(args.body || '').trim();
  if (!name || !body) throw new Error('skill_save needs a name and a Markdown body.');
  const { authoredSkills: items = [] } = await chrome.storage.local.get('authoredSkills');
  const skill = { name, description: String(args.description || name).trim().slice(0, 200), body: body.slice(0, 20_000), enabled: true, created: new Date().toISOString() };
  const i = items.findIndex((s) => s.name === name);
  if (i >= 0) items[i] = { ...items[i], ...skill };
  else items.push(skill);
  await chrome.storage.local.set({ authoredSkills: items });
  await setFeature('skillAuthoring', true);
  ui.skillsChanged?.();
  return { content: text(`Skill "${name}" saved. The user can run it with /${name} in any chat and edit it in Settings → Experimental → Skill authoring.`), label: `/${name}` };
}

// Finds text in every tab the chat can use; refs are per tab (use them with tabId).
async function searchTabs(c, args) {
  const out = [];
  for (const tab of await chatTabs(c)) {
    if (/^(chrome|chrome-extension|edge|brave|about|devtools|view-source):/.test(tab.url || '')) continue;
    const frames = await injectAll(tab.id, P.findInPage, [args.text, 15]).catch(() => []);
    const lines = frames.flatMap((f) => (f.frameId === 0 ? f.result.lines : f.result.lines.map((l) => l.replace(/^\[(e\d+)\]/, `[f${f.frameId}:$1]`))));
    out.push(`tab ${tab.id}${tab.id === c.chatTabId ? ' (chat tab)' : ''} "${tab.title}" — ${lines.length ? `${lines.length} match(es)` : 'no matches'}`);
    out.push(...lines.map((l) => `  ${l}`));
  }
  return { content: text(out.join('\n') || 'No tabs to search.'), label: `"${args.text}"` };
}

async function runPageTool(tabId, tab, tool, args, ui, chatTabId) {
  const urlBefore = tab.url;

  switch (tool) {
    case 'browser_snapshot': {
      const frames = await injectAll(tabId, P.pageSnapshot, [24_000]);
      const main = frames.find((f) => f.frameId === 0)?.result;
      if (!main) throw new Error('Could not read the page (it may still be loading).');
      let out = `URL: ${main.url}\nTitle: ${main.title}\n\n${main.text}${main.truncated ? '\n… (truncated; scroll, use browser_find or browser_get_text)' : ''}`;
      for (const f of frames) {
        if (f.frameId === 0 || !f.result.text.trim()) continue;
        const body = f.result.text.replace(/\[(e\d+)\]/g, `[f${f.frameId}:$1]`);
        out += `\n\n── iframe f${f.frameId}: ${f.result.url} ──\n${body.length > 6000 ? `${body.slice(0, 6000)}\n…` : body}`;
      }
      return { content: text(out) };
    }

    case 'browser_find': {
      const frames = await injectAll(tabId, P.findInPage, [args.text, 25]);
      const lines = frames.flatMap((f) => (f.frameId === 0 ? f.result.lines : f.result.lines.map((l) => l.replace(/^\[(e\d+)\]/, `[f${f.frameId}:$1]`))));
      // Show the user what was found (Settings → Page → Highlight finds).
      if (lines.length && (await chrome.storage.local.get('highlightFinds')).highlightFinds !== false) {
        for (const f of frames) {
          const refs = f.result.lines.map((l) => l.match(/^\[(e\d+)\]/)?.[1]).filter(Boolean);
          if (refs.length) await inject(tabId, P.highlightRefs, [refs, args.text, f.frameId === 0], f.frameId).catch(() => {});
        }
      }
      return { content: text(lines.length ? lines.join('\n') : `No visible element contains "${args.text}".`), label: `"${args.text}": ${lines.length} found` };
    }

    case 'browser_get_text': {
      const res = await inject(tabId, P.pageText);
      const body = res.text.length > 40_000 ? `${res.text.slice(0, 40_000)}\n… (truncated)` : res.text;
      return { content: text(`URL: ${res.url}\n\n${body}`) };
    }

    case 'browser_screenshot':
      return { content: await screenshot(tabId, args), label: args.fullPage ? 'full page' : args.ref || '' };

    case 'browser_click': {
      const loc = await locate(tabId, args.ref);
      const opts = { button: args.button || 'left', count: args.double ? 2 : 1, modifiers: modifierMask(args.modifiers) };
      let how = '';
      await withFileChooserIntercept(tabId, async () => {
        if (loc.exact) {
          await pointer(tabId, loc.x, loc.y, 'click');
          await mouseClick(tabId, loc.x, loc.y, opts);
        }
        else {
          checked(await inject(tabId, P.domClick, [loc.ref], loc.frameId));
          how = ' (DOM click: iframe position unknown)';
        }
        how += await settle(tabId, urlBefore);
      });
      const warn = loc.covered ? ` Warning: the point was covered by ${loc.covered}.` : '';
      return { content: text(`Clicked ${args.ref} "${loc.label}".${how}${warn}${chooserNote(tabId)}`), label: loc.label };
    }

    case 'browser_click_xy': {
      const opts = { button: args.button || 'left', count: args.double ? 2 : 1, modifiers: modifierMask(args.modifiers) };
      let nav = '';
      await withFileChooserIntercept(tabId, async () => {
        await pointer(tabId, args.x, args.y, 'click');
        await mouseClick(tabId, args.x, args.y, opts);
        nav = await settle(tabId, urlBefore);
      });
      return { content: text(`Clicked at (${args.x}, ${args.y}).${nav}${chooserNote(tabId)}`) };
    }

    case 'browser_hover': {
      const p = await point(tabId, args.ref, args, 'the element');
      await pointer(tabId, p.x, p.y, 'move');
      await input(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      await sleep(300);
      return { content: text(`Hovering over ${p.label}. Take a snapshot to see menus or tooltips that appeared.`), label: p.label };
    }

    case 'browser_drag': {
      const from = await point(tabId, args.fromRef, args.from, 'the start (fromRef or from)');
      const to = await point(tabId, args.toRef, args.to, 'the target (toRef or to)');
      await pointer(tabId, from.x, from.y, 'click');
      const kind = await mouseDrag(tabId, from, to);
      await pointer(tabId, to.x, to.y, 'move');
      const nav = await settle(tabId, urlBefore);
      return { content: text(`Dragged ${from.label} → ${to.label} (${kind === 'html5' ? 'HTML5 drag-and-drop' : 'mouse drag'}).${nav}`), label: `${from.label} → ${to.label}` };
    }

    case 'browser_type': {
      const loc = await locate(tabId, args.ref);
      const clear = args.clear !== false;
      if (loc.exact) {
        await pointer(tabId, loc.x, loc.y, 'click');
        await mouseClick(tabId, loc.x, loc.y);
        checked(await inject(tabId, P.prepareTyping, [loc.ref, clear], loc.frameId));
        await cdp(tabId, 'Input.insertText', { text: args.text });
      } else {
        checked(await inject(tabId, P.setValueFallback, [loc.ref, args.text, clear], loc.frameId));
      }
      if (args.submit) await pressKey(tabId, 'Enter');
      const nav = await settle(tabId, urlBefore);
      return { content: text(`Typed into ${args.ref} "${loc.label}".${nav}`), label: loc.label };
    }

    case 'browser_select_option': {
      const { frameId, ref } = parseRef(args.ref);
      const res = checked(await inject(tabId, P.selectOption, [ref, args.value], frameId));
      return { content: text(`Selected "${res.label}" in ${args.ref}.`) };
    }

    case 'browser_press_key': {
      await pressKey(tabId, args.key);
      const nav = await settle(tabId, urlBefore);
      return { content: text(`Pressed ${args.key}.${nav}`) };
    }

    case 'browser_scroll': {
      const { frameId, ref } = args.ref ? parseRef(args.ref) : { frameId: 0, ref: null };
      const res = checked(await inject(tabId, P.scrollPage, [ref, args.direction, args.amount || 0], frameId));
      return { content: text(`Scrolled ${args.direction}. Position ${res.position}/${res.max}px.`) };
    }

    case 'browser_upload_file': {
      const files = Array.isArray(args.paths) ? args.paths : [];
      if (!files.length) throw new Error('paths must list at least one absolute file path.');
      const host = new URL(tab.url).host;
      const ok = await ui.confirm(chatTabId, `Upload ${files.length} file(s) to ${host}?`, files.join('\n'));
      if (!ok) throw new Error('The user declined the upload.');

      if (args.ref) {
        const { frameId, ref } = parseRef(args.ref);
        if (frameId !== 0) throw new Error('File inputs inside iframes are not supported yet.');
        const token = crypto.randomUUID();
        checked(await inject(tabId, P.markForUpload, [ref, token]));
        const sel = JSON.stringify(`[data-tabhelm-upload="${token}"]`);
        const { result } = await cdp(tabId, 'Runtime.evaluate', {
          expression: `(function q(root){const el=root.querySelector(${sel});if(el)return el;for(const h of root.querySelectorAll('*'))if(h.shadowRoot){const r=q(h.shadowRoot);if(r)return r}return null})(document)`,
        });
        if (!result?.objectId) throw new Error('Could not find the file input.');
        await cdp(tabId, 'DOM.setFileInputFiles', { files, objectId: result.objectId });
        await cdp(tabId, 'Runtime.callFunctionOn', { objectId: result.objectId, functionDeclaration: 'function(){this.removeAttribute("data-tabhelm-upload")}' }).catch(() => {});
      } else if (fileChoosers.has(tabId)) {
        await cdp(tabId, 'DOM.setFileInputFiles', { files, backendNodeId: fileChoosers.get(tabId) });
        fileChoosers.delete(tabId);
      } else {
        throw new Error('Pass the ref of a file input (hidden ones are listed at the end of the snapshot), or click the upload button first so a file chooser opens.');
      }
      return { content: text(`Attached ${files.length} file(s).`), label: files.map((f) => f.split('/').pop()).join(', ') };
    }

    case 'browser_navigate': {
      const url = normalizeUrl(args.url);
      await chrome.tabs.update(tabId, { url });
      await sleep(300);
      const loaded = await waitForLoad(tabId);
      return { content: text(`Opened ${loaded.url} — "${loaded.title}". Take a snapshot to see it.`) };
    }

    case 'browser_go_back':
    case 'browser_go_forward': {
      await (tool === 'browser_go_back' ? chrome.tabs.goBack(tabId) : chrome.tabs.goForward(tabId));
      await sleep(300);
      const loaded = await waitForLoad(tabId);
      return { content: text(`Now at ${loaded.url}.`) };
    }

    case 'browser_reload': {
      await chrome.tabs.reload(tabId, { bypassCache: Boolean(args.bypassCache) });
      await sleep(300);
      const loaded = await waitForLoad(tabId);
      return { content: text(`Reloaded ${loaded.url}.`) };
    }

    case 'browser_wait': {
      if (args.text) {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          if (await inject(tabId, P.hasText, [args.text]).catch(() => false)) return { content: text(`Text "${args.text}" is on the page.`) };
          await sleep(500);
        }
        return { content: text(`Text "${args.text}" did not appear within 30s.`) };
      }
      const seconds = Math.min(Math.max(Number(args.seconds) || 1, 0), 30);
      await sleep(seconds * 1000);
      return { content: text(`Waited ${seconds}s.`) };
    }

    case 'browser_console': {
      const all = consoleLogs.get(tabId) || [];
      const levels = { error: ['error'], warning: ['error', 'warning'] }[args.level] || null;
      const list = (levels ? all.filter((e) => levels.includes(e.level)) : all).slice(-100);
      if (args.clear) consoleLogs.delete(tabId);
      const body = list.map((e) => `[${e.level}] ${e.text.length > 500 ? `${e.text.slice(0, 500)}…` : e.text}`).join('\n');
      return { content: text(body || 'No console messages captured yet (capture starts when the agent first touches the tab; reload to see load-time messages).') };
    }

    case 'browser_network': {
      let list = [...(requests.get(tabId)?.values() || [])];
      if (args.filter) list = list.filter((r) => r.url.includes(args.filter));
      if (args.failedOnly) list = list.filter((r) => r.failed || r.status >= 400);
      list = list.slice(-100);
      if (args.clear) requests.delete(tabId);
      const body = list
        .map((r) => `${r.method} ${r.failed ? `FAILED(${r.failed})` : r.status ?? 'pending'} ${r.type} ${r.url.length > 200 ? `${r.url.slice(0, 200)}…` : r.url}`)
        .join('\n');
      return { content: text(body || 'No requests captured yet (capture starts when the agent first touches the tab; reload to see page-load requests).') };
    }

    // ---- Developer tools flag ----
    case 'browser_fill_form': {
      await requireFlag('devTools', 'Developer tools');
      if (!Array.isArray(args.fields) || !args.fields.length || args.fields.some((f) => !f || typeof f !== 'object')) throw new Error('browser_fill_form needs fields: [{ ref, value }, …].');
      const done = [];
      for (const [i, f] of args.fields.entries()) {
        const loc = await locate(tabId, f.ref);
        const kind = checked(await inject(tabId, P.fieldKind, [loc.ref], loc.frameId));
        if (kind === 'select') checked(await inject(tabId, P.selectOption, [loc.ref, f.value], loc.frameId));
        else if (kind === 'checkbox' || kind === 'radio') {
          const want = /^(true|1|yes|on|checked)$/i.test(f.value);
          const now = checked(await inject(tabId, P.isChecked, [loc.ref], loc.frameId)).checked;
          if (want !== now) {
            await pointer(tabId, loc.x, loc.y, 'click');
            await mouseClick(tabId, loc.x, loc.y);
          }
        } else if (loc.exact) {
          await pointer(tabId, loc.x, loc.y, 'click');
          await mouseClick(tabId, loc.x, loc.y);
          checked(await inject(tabId, P.prepareTyping, [loc.ref, true], loc.frameId));
          await cdp(tabId, 'Input.insertText', { text: f.value });
          if (args.submit && i === args.fields.length - 1) await pressKey(tabId, 'Enter');
        } else checked(await inject(tabId, P.setValueFallback, [loc.ref, f.value, true], loc.frameId));
        done.push(`${f.ref} "${loc.label}"`);
      }
      const nav = await settle(tabId, urlBefore);
      return { content: text(`Filled ${done.length} field(s): ${done.join(', ')}.${nav}`), label: `${done.length} fields` };
    }

    case 'browser_network_body': {
      await requireFlag('devTools', 'Developer tools');
      const entry = [...(requests.get(tabId)?.values() || [])].reverse().find((r) => r.url.includes(args.url));
      if (!entry) throw new Error(`No captured request containing "${args.url}". Call browser_network first (capture starts when the agent touches the tab).`);
      const max = Math.min(args.maxChars || 20_000, 200_000);
      let reqBody = entry.postData;
      if (!reqBody && entry.hasPostData) reqBody = (await cdp(tabId, 'Network.getRequestPostData', { requestId: entry.id }).catch(() => ({}))).postData || null;
      let resBody = null;
      try {
        const r = await cdp(tabId, 'Network.getResponseBody', { requestId: entry.id });
        resBody = r.base64Encoded ? `[binary, ${Math.round((r.body.length * 3) / 4 / 1024)} KB base64]` : r.body;
      } catch (err) {
        resBody = `[unavailable: ${err.message}]`;
      }
      const cut = (s) => (s && s.length > max ? `${s.slice(0, max)}\n…(truncated)` : s);
      return { content: text(`${entry.method} ${entry.status ?? ''} ${entry.url}\n\nRequest body:\n${cut(reqBody) || '(none)'}\n\nResponse body (${entry.mime || '?'}):\n${cut(resBody)}`), label: entry.url.slice(0, 60) };
    }

    case 'browser_storage': {
      await requireFlag('devTools', 'Developer tools');
      if (args.action !== 'get') {
        const ok = await ui.confirm(chatTabId, `${args.action === 'set' ? 'Change' : 'Delete'} ${args.kind} on ${new URL(tab.url).host}?`, `${args.key || ''}${args.value ? ` = ${args.value.slice(0, 80)}` : ''}`, { routine: true });
        if (!ok) throw new Error('The user declined changing storage.');
      }
      if (args.kind === 'cookies') {
        if (args.action === 'get') {
          const { cookies } = await cdp(tabId, 'Network.getCookies', { urls: [tab.url] });
          const list = cookies.filter((c) => !args.key || c.name === args.key).map((c) => `${c.name}=${c.value.length > 60 ? `${c.value.slice(0, 60)}…` : c.value}${c.httpOnly ? ' [httpOnly]' : ''}${c.secure ? ' [secure]' : ''}`);
          return { content: text(list.join('\n') || 'No cookies.') };
        }
        if (!args.key) throw new Error('key is required');
        if (args.action === 'set') await cdp(tabId, 'Network.setCookie', { name: args.key, value: args.value || '', url: tab.url });
        else await cdp(tabId, 'Network.deleteCookies', { name: args.key, url: tab.url });
        return { content: text(`Cookie ${args.key} ${args.action === 'set' ? 'set' : 'deleted'}.`) };
      }
      const res = checked(await inject(tabId, P.webStorage, [args.kind, args.action, args.key || null, args.value ?? null]));
      return { content: text(res.text) };
    }

    case 'browser_emulate': {
      await requireFlag('devTools', 'Developer tools');
      if (args.reset) {
        await cdp(tabId, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
        await cdp(tabId, 'Emulation.clearGeolocationOverride').catch(() => {});
        await cdp(tabId, 'Emulation.setUserAgentOverride', { userAgent: '' }).catch(() => {});
        await cdp(tabId, 'Emulation.setEmulatedMedia', { features: [] }).catch(() => {});
        await cdp(tabId, 'Emulation.setTimezoneOverride', { timezoneId: '' }).catch(() => {});
        return { content: text('Emulation reset.') };
      }
      const applied = [];
      if (args.width || args.height || args.mobile != null || args.deviceScaleFactor) {
        await cdp(tabId, 'Emulation.setDeviceMetricsOverride', { width: args.width || 0, height: args.height || 0, deviceScaleFactor: args.deviceScaleFactor || 0, mobile: Boolean(args.mobile) });
        applied.push(`viewport ${args.width || 'auto'}×${args.height || 'auto'}${args.mobile ? ' mobile' : ''}`);
      }
      if (args.userAgent) {
        await cdp(tabId, 'Emulation.setUserAgentOverride', { userAgent: args.userAgent, ...(args.locale ? { acceptLanguage: args.locale } : {}) });
        applied.push('user agent');
      }
      if (args.colorScheme) {
        await cdp(tabId, 'Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: args.colorScheme }] });
        applied.push(`${args.colorScheme} scheme`);
      }
      if (args.latitude != null && args.longitude != null) {
        await cdp(tabId, 'Emulation.setGeolocationOverride', { latitude: args.latitude, longitude: args.longitude, accuracy: 50 });
        applied.push(`geolocation ${args.latitude},${args.longitude}`);
      }
      if (args.timezone) {
        await cdp(tabId, 'Emulation.setTimezoneOverride', { timezoneId: args.timezone });
        applied.push(`timezone ${args.timezone}`);
      }
      if (args.locale) {
        await cdp(tabId, 'Emulation.setLocaleOverride', { locale: args.locale }).catch(() => {});
        applied.push(`locale ${args.locale}`);
      }
      return { content: text(applied.length ? `Emulating: ${applied.join(', ')}. Reload to apply fully; pass reset: true to undo.` : 'Nothing to emulate.') };
    }

    case 'browser_highlight': {
      await requireFlag('devTools', 'Developer tools');
      if (!Array.isArray(args.refs) || !args.refs.length) throw new Error('browser_highlight needs refs: ["e12", …].');
      const byFrame = new Map();
      for (const r of args.refs) {
        const { frameId, ref } = parseRef(r);
        byFrame.set(frameId, [...(byFrame.get(frameId) || []), ref]);
      }
      let count = 0;
      for (const [frameId, refs] of byFrame) count += (await inject(tabId, P.highlightRefs, [refs, args.label || ''], frameId))?.count || 0;
      return { content: text(`Highlighted ${count} element(s) for the user.`) };
    }

    // ---- Take over / password manager flags: the panel does the work ----
    // Guide mode: an arrow and instruction on the page, then wait for the user's click.
    case 'browser_guide':
      return guideTour(chatTabId, tabId, args, ui);

    // ---- Page scripts & styles flag: presets library ----
    case 'browser_script_list': {
      await requireFlag('pageScripts', 'Page scripts & styles');
      const all = await listScripts();
      const lines = all.map((p) => `- ${p.name}${p.enabled === false ? ' (disabled)' : ''}: ${p.description || ''} [match ${p.match || '*'}${p.autoRun ? ', runs automatically' : ''}${p.js ? ', JS' : ''}${p.css ? ', CSS' : ''}]${scriptMatches(p, tab.url) ? ' ← matches this page' : ''}`);
      return { content: text(lines.length ? lines.join('\n') : 'No saved page scripts yet. Save one with browser_script_save.') };
    }

    case 'browser_script_save': {
      await requireFlag('pageScripts', 'Page scripts & styles');
      if (!args.js && !args.css) throw new Error('Give js and/or css.');
      const saved = await saveScript({ name: args.name, description: args.description, match: args.match, js: args.js, css: args.css, source: 'agent' });
      return { content: text(`Saved page script "${saved.name}" (match ${saved.match}). Automatic running stays off until the user turns it on in Settings → Experimental → Page scripts; they can run it from the ＋ menu, or you can with browser_script_run.`), label: saved.name };
    }

    case 'browser_script_run': {
      await requireFlag('pageScripts', 'Page scripts & styles');
      const preset = (await listScripts()).find((p) => p.name === args.name);
      if (!preset) throw new Error(`No page script named "${args.name}". See browser_script_list.`);
      if (preset.js) {
        const ok = await ui.confirm(chatTabId, `Run saved script “${preset.name}” on ${new URL(tab.url).host}?`, preset.js.slice(0, 2000), { routine: true });
        if (!ok) throw new Error('The user declined running this script.');
      }
      const out = await runScript(tabId, preset);
      return { content: text(`Ran "${preset.name}" on ${tab.url}.${out ? `\nResult: ${out}` : ''}`), label: preset.name };
    }

    case 'browser_style': {
      await requireFlag('pageScripts', 'Page scripts & styles');
      const key = `tabhelm-style-${args.id || 'agent'}`;
      if (args.remove) {
        await inject(tabId, (k) => document.getElementById(k)?.remove(), [key]);
        return { content: text(`Removed style "${args.id || 'agent'}".`) };
      }
      // A <style> element (replaced on repeat calls with the same id) keeps it removable.
      await inject(tabId, (k, css) => {
        let el = document.getElementById(k);
        if (!el) {
          el = document.createElement('style');
          el.id = k;
          el.setAttribute('data-tabhelm-overlay', '');
          (document.head || document.documentElement).append(el);
        }
        el.textContent = css;
      }, [key, String(args.css || '')]);
      return { content: text(`Applied CSS "${args.id || 'agent'}" to this page (only in this tab, until reload). Remove it with browser_style {id, remove: true}.`), label: args.id || 'css' };
    }

    case 'browser_request_human': {
      await requireFlag('takeOver', 'Take over');
      const reply = await ui.ask(chatTabId, 'human', { message: args.message, tab: { title: tab.title, url: tab.url } });
      if (!reply?.done) throw new Error('The user cancelled the task.');
      return { content: text(`The user says they are done${reply.note ? `: ${reply.note}` : '.'} Take a new snapshot to see the page.`), label: args.message.slice(0, 60) };
    }

    case 'browser_request_login': {
      await requireFlag('passwordManager', 'Password manager hand-off');
      const reply = await ui.ask(chatTabId, 'login', { usernameRef: args.usernameRef, passwordRef: args.passwordRef, note: args.note, tab: { title: tab.title, url: tab.url } });
      if (!reply?.done) throw new Error('The user cancelled signing in.');
      if (reply.credential) {
        // Typed here, straight from the password manager; the model only gets "done".
        const fill = async (ref, value) => {
          const loc = await locate(tabId, ref);
          await pointer(tabId, loc.x, loc.y, 'click');
          await mouseClick(tabId, loc.x, loc.y);
          checked(await inject(tabId, P.prepareTyping, [loc.ref, true], loc.frameId));
          await cdp(tabId, 'Input.insertText', { text: value });
        };
        if (args.usernameRef && reply.credential.username) await fill(args.usernameRef, reply.credential.username);
        if (args.passwordRef && reply.credential.password) await fill(args.passwordRef, reply.credential.password);
        if (reply.submit) await pressKey(tabId, 'Enter');
        const nav = await settle(tabId, urlBefore);
        return { content: text(`Credentials filled from the password manager${reply.submit ? ' and submitted' : ''}.${nav} Take a new snapshot.`), label: 'password manager' };
      }
      return { content: text('The user signed in themselves. Take a new snapshot to see the page.'), label: 'user signed in' };
    }

    case 'browser_evaluate': {
      const host = new URL(tab.url).host;
      const ok = await ui.confirm(chatTabId, `Run JavaScript on ${host}?`, args.expression, { routine: true });
      if (!ok) throw new Error('The user declined running this script.');
      const res = await cdp(tabId, 'Runtime.evaluate', { expression: args.expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
      const v = res.result;
      let out = v.type === 'undefined' ? 'undefined' : 'value' in v ? JSON.stringify(v.value, null, 2) : v.description || v.type;
      if (out && out.length > 20_000) out = `${out.slice(0, 20_000)}\n…`;
      return { content: text(out ?? 'undefined') };
    }

    default:
      throw new Error(`Unknown tool ${tool}`);
  }
}

async function requireFlag(flag, name) {
  const features = await getFeatures();
  if (!features[flag]) throw new Error(`This tool needs the "${name}" feature, which is off. The user can enable it in TabHelm → Settings → Experimental.`);
}

// Dialogs block script injection, so this path skips assertControllable().
async function handleDialog(tabId, args) {
  if (!dialogs.has(tabId)) return { content: text('No dialog is open.') };
  await cdp(tabId, 'Page.handleJavaScriptDialog', { accept: Boolean(args.accept), promptText: args.promptText });
  dialogs.delete(tabId);
  return { content: text(args.accept ? 'Dialog accepted.' : 'Dialog dismissed.') };
}
