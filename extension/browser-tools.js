// Browser tools executed for an agent. Every chat (side panel) is bound to the
// tab it was opened on; the agent may additionally work with tabs it opened,
// tabs the page opened, or tabs the user approved. Reads go through
// chrome.scripting; mouse and keyboard go through CDP Input.* (trusted events).

import { cdp, attach, detach, dialogs, consoleLogs, requests, fileChoosers, dragData } from './cdp.js';
import * as P from './page-scripts.js';

const chats = new Map(); // chatTabId -> { chatTabId, current, owned: Set, notes: [] }

function chatState(chatTabId) {
  let c = chats.get(chatTabId);
  if (!c) {
    c = { chatTabId, current: chatTabId, owned: new Set([chatTabId]), notes: [] };
    chats.set(chatTabId, c);
  }
  return c;
}

export function releaseChat(chatTabId) {
  const c = chats.get(chatTabId);
  chats.delete(chatTabId);
  const stillUsed = new Set([...chats.values()].flatMap((o) => [...o.owned]));
  for (const t of c?.owned || [chatTabId]) if (!stillUsed.has(t)) detach(t);
}

chrome.tabs.onCreated.addListener((tab) => {
  for (const c of chats.values()) {
    if (tab.openerTabId != null && c.owned.has(tab.openerTabId)) {
      c.owned.add(tab.id);
      c.notes.push(`The page opened a new tab ${tab.id} (${tab.pendingUrl || tab.url || 'loading'}). Use browser_tabs to switch to it.`);
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const c of chats.values()) {
    c.owned.delete(tabId);
    if (c.current === tabId && tabId !== c.chatTabId) {
      c.current = c.chatTabId;
      c.notes.push(`Tab ${tabId} was closed; tools act on the chat tab again.`);
    }
  }
});

// ---------- helpers ----------

const text = (t) => [{ type: 'text', text: t }];
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
  const describe = (t) =>
    `${t.id}${t.id === c.current ? ' (current)' : ''}${t.id === c.chatTabId ? ' (chat tab)' : ''}${c.owned.has(t.id) ? '' : ' (needs user approval)'}: ${t.title || ''} — ${t.url || t.pendingUrl || ''}`;

  switch (args.action) {
    case 'list': {
      const tabs = args.all
        ? await chrome.tabs.query({})
        : (await Promise.all([...c.owned].map((id) => chrome.tabs.get(id).catch(() => null)))).filter(Boolean);
      return { content: text(tabs.map(describe).join('\n') || 'No tabs.') };
    }
    case 'new': {
      // Opened in the background so the user keeps seeing the chat tab and panel.
      const tab = await chrome.tabs.create({ url: normalizeUrl(args.url || 'about:blank'), active: false, openerTabId: c.chatTabId });
      c.owned.add(tab.id);
      c.current = tab.id;
      const loaded = await waitForLoad(tab.id);
      ui.onTarget(c.chatTabId, loaded);
      return { content: text(`Opened tab ${tab.id} in the background: ${loaded.url}. Tools now act on it. Note: background tabs may not render screenshots.`) };
    }
    case 'switch': {
      const id = Number(args.tabId);
      const tab = await chrome.tabs.get(id).catch(() => null);
      if (!tab) throw new Error(`No tab ${args.tabId}.`);
      if (!c.owned.has(id)) {
        const ok = await ui.confirm(c.chatTabId, 'Let the agent control another tab?', `${tab.title}\n${tab.url}`);
        if (!ok) throw new Error('The user did not allow controlling that tab.');
        c.owned.add(id);
      }
      c.current = id;
      ui.onTarget(c.chatTabId, tab);
      return { content: text(`Tools now act on tab ${id}: ${tab.title} — ${tab.url}`) };
    }
    case 'close': {
      const id = Number(args.tabId);
      if (id === c.chatTabId) throw new Error('The chat tab cannot be closed by the agent.');
      if (!c.owned.has(id)) throw new Error('Only tabs the agent opened or was allowed to control can be closed.');
      await chrome.tabs.remove(id);
      return { content: text(`Closed tab ${id}.`) };
    }
    default:
      throw new Error('action must be list, new, switch or close.');
  }
}

// ---------- dispatcher ----------

export async function runTool(chatTabId, tool, args, ui) {
  const c = chatState(chatTabId);
  let result;
  if (tool === 'browser_tabs') result = await tabsTool(c, args, ui);
  else if (tool === 'browser_handle_dialog') result = await handleDialog(c.current, args);
  else {
    const tabId = c.current;
    const tab = await assertControllable(tabId);
    await attach(tabId);
    result = await runPageTool(tabId, tab, tool, args, ui, chatTabId);
  }
  if (c.notes.length) {
    result.content = [...result.content, { type: 'text', text: `\n${c.notes.splice(0).join('\n')}` }];
  }
  return result;
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
        if (loc.exact) await mouseClick(tabId, loc.x, loc.y, opts);
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
        await mouseClick(tabId, args.x, args.y, opts);
        nav = await settle(tabId, urlBefore);
      });
      return { content: text(`Clicked at (${args.x}, ${args.y}).${nav}${chooserNote(tabId)}`) };
    }

    case 'browser_hover': {
      const p = await point(tabId, args.ref, args, 'the element');
      await input(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      await sleep(300);
      return { content: text(`Hovering over ${p.label}. Take a snapshot to see menus or tooltips that appeared.`), label: p.label };
    }

    case 'browser_drag': {
      const from = await point(tabId, args.fromRef, args.from, 'the start (fromRef or from)');
      const to = await point(tabId, args.toRef, args.to, 'the target (toRef or to)');
      const kind = await mouseDrag(tabId, from, to);
      const nav = await settle(tabId, urlBefore);
      return { content: text(`Dragged ${from.label} → ${to.label} (${kind === 'html5' ? 'HTML5 drag-and-drop' : 'mouse drag'}).${nav}`), label: `${from.label} → ${to.label}` };
    }

    case 'browser_type': {
      const loc = await locate(tabId, args.ref);
      const clear = args.clear !== false;
      if (loc.exact) {
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

    case 'browser_evaluate': {
      const host = new URL(tab.url).host;
      const ok = await ui.confirm(chatTabId, `Run JavaScript on ${host}?`, args.expression);
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

// Dialogs block script injection, so this path skips assertControllable().
async function handleDialog(tabId, args) {
  if (!dialogs.has(tabId)) return { content: text('No dialog is open.') };
  await cdp(tabId, 'Page.handleJavaScriptDialog', { accept: Boolean(args.accept), promptText: args.promptText });
  dialogs.delete(tabId);
  return { content: text(args.accept ? 'Dialog accepted.' : 'Dialog dismissed.') };
}
