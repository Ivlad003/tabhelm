// Browser tools executed on behalf of the agent, always scoped to one tabId.
// Reads go through chrome.scripting (isolated world); clicks and typing go
// through chrome.debugger (CDP Input.*) so pages receive trusted events.

const attached = new Set();
const dialogs = new Map(); // tabId -> { type, message }

chrome.debugger.onDetach.addListener((source) => {
  attached.delete(source.tabId);
  dialogs.delete(source.tabId);
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === 'Page.javascriptDialogOpening') dialogs.set(source.tabId, { type: params.type, message: params.message });
  if (method === 'Page.javascriptDialogClosed') dialogs.delete(source.tabId);
});

export function detach(tabId) {
  if (attached.has(tabId)) chrome.debugger.detach({ tabId }).catch(() => {});
  attached.delete(tabId);
}

async function attach(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (err) {
    const msg = String(err.message || err);
    if (/already attached/i.test(msg)) throw new Error('Another debugger (probably DevTools) is attached to this tab. Close DevTools and retry.');
    throw new Error(`Cannot control this tab: ${msg}`);
  }
  attached.add(tabId);
  await cdp(tabId, 'Page.enable');
}

function cdp(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function inject(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res?.result;
}

const text = (t) => [{ type: 'text', text: t }];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function assertControllable(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error('The tab this chat belongs to was closed.');
  const url = tab.url || tab.pendingUrl || '';
  if (/^(chrome|chrome-extension|edge|brave|about|devtools):/.test(url) || url.startsWith('https://chromewebstore.google.com')) {
    throw new Error(`Chrome does not allow extensions to control ${url}. Navigate to a normal web page first.`);
  }
  const dialog = dialogs.get(tabId);
  if (dialog) {
    throw new Error(`A JavaScript ${dialog.type} dialog is blocking the page: "${dialog.message}". Use browser_handle_dialog first.`);
  }
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

// After an action, give the page a moment; if it started navigating, wait for it.
async function settle(tabId, urlBefore) {
  await sleep(400);
  const tab = await waitForLoad(tabId, 15_000);
  return tab.url !== urlBefore ? ` Page navigated to ${tab.url}` : '';
}

async function resolveRef(tabId, ref) {
  const res = await inject(tabId, elementCenter, [ref]);
  if (!res || res.error) throw new Error(res?.error || `Element ${ref} not found`);
  return res;
}

async function mouseClick(tabId, x, y) {
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
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
};

async function pressKey(tabId, name) {
  const k = KEYS[name] || (name.length === 1 ? { key: name, code: '', keyCode: name.toUpperCase().charCodeAt(0), text: name } : null);
  if (!k) throw new Error(`Unsupported key "${name}". Supported: ${Object.keys(KEYS).join(', ')} or a single character.`);
  const base = { key: k.key || name, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', text: k.text, ...base });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

export async function runTool(tabId, tool, args) {
  const tab = await assertControllable(tabId);
  const urlBefore = tab.url;

  switch (tool) {
    case 'browser_snapshot': {
      const snap = await inject(tabId, pageSnapshot, [24_000]);
      return text(`URL: ${snap.url}\nTitle: ${snap.title}\n\n${snap.text}${snap.truncated ? '\n… (truncated, scroll or use browser_get_text for more)' : ''}`);
    }

    case 'browser_click': {
      await attach(tabId);
      const { x, y, covered } = await resolveRef(tabId, args.ref);
      await mouseClick(tabId, x, y);
      const nav = await settle(tabId, urlBefore);
      return text(`Clicked ${args.ref}.${covered ? ` Warning: the point was covered by ${covered}.` : ''}${nav}`);
    }

    case 'browser_type': {
      await attach(tabId);
      const { x, y } = await resolveRef(tabId, args.ref);
      await mouseClick(tabId, x, y);
      const prep = await inject(tabId, prepareTyping, [args.ref, args.clear !== false]);
      if (prep?.error) throw new Error(prep.error);
      await cdp(tabId, 'Input.insertText', { text: args.text });
      if (args.submit) await pressKey(tabId, 'Enter');
      const nav = await settle(tabId, urlBefore);
      return text(`Typed into ${args.ref}.${nav}`);
    }

    case 'browser_select_option': {
      const res = await inject(tabId, selectOption, [args.ref, args.value]);
      if (res?.error) throw new Error(res.error);
      return text(`Selected "${res.label}" in ${args.ref}.`);
    }

    case 'browser_press_key': {
      await attach(tabId);
      await pressKey(tabId, args.key);
      const nav = await settle(tabId, urlBefore);
      return text(`Pressed ${args.key}.${nav}`);
    }

    case 'browser_scroll': {
      const res = await inject(tabId, scrollPage, [args.ref || null, args.direction]);
      if (res?.error) throw new Error(res.error);
      return text(`Scrolled ${args.direction}. Position ${res.position}/${res.max}px.`);
    }

    case 'browser_navigate': {
      let url = String(args.url).trim();
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
      await chrome.tabs.update(tabId, { url });
      await sleep(300);
      const loaded = await waitForLoad(tabId);
      return text(`Opened ${loaded.url} — "${loaded.title}". Take a snapshot to see it.`);
    }

    case 'browser_go_back': {
      await chrome.tabs.goBack(tabId);
      await sleep(300);
      const loaded = await waitForLoad(tabId);
      return text(`Went back to ${loaded.url}.`);
    }

    case 'browser_screenshot': {
      await attach(tabId);
      const { data } = await cdp(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 60 });
      return [{ type: 'image', data, mimeType: 'image/jpeg' }];
    }

    case 'browser_get_text': {
      const res = await inject(tabId, () => ({ url: location.href, text: document.body?.innerText || '' }));
      const body = res.text.length > 40_000 ? `${res.text.slice(0, 40_000)}\n… (truncated)` : res.text;
      return text(`URL: ${res.url}\n\n${body}`);
    }

    case 'browser_wait': {
      if (args.text) {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const found = await inject(tabId, (t) => document.body?.innerText.includes(t), [args.text]).catch(() => false);
          if (found) return text(`Text "${args.text}" is on the page.`);
          await sleep(500);
        }
        return text(`Text "${args.text}" did not appear within 30s.`);
      }
      const seconds = Math.min(Math.max(Number(args.seconds) || 1, 0), 30);
      await sleep(seconds * 1000);
      return text(`Waited ${seconds}s.`);
    }

    default:
      throw new Error(`Unknown tool ${tool}`);
  }
}

// Dialogs block script injection, so this path skips assertControllable().
export async function handleDialog(tabId, args) {
  if (!dialogs.has(tabId)) return text('No dialog is open.');
  await cdp(tabId, 'Page.handleJavaScriptDialog', { accept: Boolean(args.accept), promptText: args.promptText });
  dialogs.delete(tabId);
  return text(args.accept ? 'Dialog accepted.' : 'Dialog dismissed.');
}

// ---- Functions below are serialized and run inside the page (isolated world).
// They must not reference anything outside their own body.

function pageSnapshot(maxChars) {
  const state = (window.__tabhelm ||= { refs: new Map(), next: 1 });
  state.refs = new Map();

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'HEAD', 'META', 'LINK', 'IFRAME', 'CANVAS']);
  const ROLES = new Set([
    'button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'option', 'switch', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem',
  ]);
  const clamp = (s, n) => {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? `${s.slice(0, n)}…` : s;
  };

  const lines = [];
  let size = 0;
  let truncated = false;
  const push = (line) => {
    if (truncated) return;
    if (size + line.length > maxChars) {
      truncated = true;
      return;
    }
    if (lines[lines.length - 1] === line) return;
    lines.push(line);
    size += line.length + 1;
  };

  const visible = (el) =>
    el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : el.getClientRects().length > 0;

  function interactiveRole(el) {
    const role = el.getAttribute('role');
    if (role && ROLES.has(role)) return role;
    switch (el.tagName) {
      case 'A':
        return el.hasAttribute('href') ? 'link' : null;
      case 'BUTTON':
      case 'SUMMARY':
        return 'button';
      case 'SELECT':
        return 'combobox';
      case 'TEXTAREA':
        return 'textbox';
      case 'INPUT': {
        const t = (el.type || 'text').toLowerCase();
        if (t === 'hidden') return null;
        if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
        if (t === 'checkbox' || t === 'radio') return t;
        return `textbox:${t}`;
      }
    }
    const ce = el.getAttribute('contenteditable');
    if (ce === '' || ce === 'true' || ce === 'plaintext-only') return 'textbox';
    if (el.hasAttribute('onclick')) return 'clickable';
    const ti = el.getAttribute('tabindex');
    if (ti !== null && Number(ti) >= 0) return 'focusable';
    return null;
  }

  function labelOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return clamp(aria, 80);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ');
      if (t.trim()) return clamp(t, 80);
    }
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) {
      return clamp(el.labels?.[0]?.innerText || el.placeholder || el.getAttribute('name') || el.title || '', 80);
    }
    const inner = clamp(el.innerText, 80);
    if (inner) return inner;
    const img = el.querySelector?.('img[alt]');
    return clamp(img?.alt || el.title || '', 80);
  }

  function describe(el, role, ref) {
    let line = `[${ref}] ${role.replace(/^textbox:text$/, 'textbox')} "${labelOf(el)}"`;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      if (el.type === 'checkbox' || el.type === 'radio') line += el.checked ? ' [checked]' : '';
      else if (el.type === 'password') line += el.value ? ' value=•••' : '';
      else if (el.value) line += ` value="${clamp(el.value, 60)}"`;
    } else if (el.tagName === 'SELECT') {
      const opts = [...el.options].slice(0, 15).map((o) => clamp(o.text, 30));
      line += ` selected="${clamp(el.selectedOptions[0]?.text, 40)}" options=[${opts.join(' | ')}${el.options.length > 15 ? ' | …' : ''}]`;
    } else if (el.tagName === 'A') {
      const href = el.getAttribute('href') || '';
      if (href && !href.startsWith('javascript:')) line += ` → ${clamp(href, 60)}`;
    }
    const aria = (n) => el.getAttribute(n);
    if (aria('aria-checked') === 'true') line += ' [checked]';
    if (aria('aria-expanded')) line += aria('aria-expanded') === 'true' ? ' [expanded]' : ' [collapsed]';
    if (aria('aria-selected') === 'true') line += ' [selected]';
    if (el.disabled || aria('aria-disabled') === 'true') line += ' [disabled]';
    return line;
  }

  function ownText(el) {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
    return clamp(t, 300);
  }

  function walk(root) {
    for (const el of root.children) {
      if (truncated) return;
      if (SKIP.has(el.tagName)) {
        if (el.tagName === 'IFRAME' && visible(el)) push(`[iframe ${clamp(el.title || el.src, 60)} — not readable yet]`);
        continue;
      }
      if (!visible(el)) continue;

      const role = interactiveRole(el);
      if (role) {
        const ref = `e${state.next++}`;
        state.refs.set(ref, el);
        push(describe(el, role, ref));
        if (!['A', 'BUTTON', 'SUMMARY', 'SELECT', 'INPUT', 'TEXTAREA'].includes(el.tagName) && role !== 'textbox') {
          walk(el);
          if (el.shadowRoot) walk(el.shadowRoot);
        }
        continue;
      }

      const h = /^H([1-6])$/.exec(el.tagName);
      const t = ownText(el);
      if (h) push(`${'#'.repeat(+h[1])} ${clamp(el.innerText, 150)}`);
      else if (t) push(t);
      else if (el.tagName === 'IMG' && el.alt) push(`img "${clamp(el.alt, 80)}"`);

      if (!h) walk(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  }

  if (document.body) walk(document.body);
  return { url: location.href, title: document.title, text: lines.join('\n'), truncated };
}

function elementCenter(ref) {
  const el = window.__tabhelm?.refs.get(ref);
  if (!el || !el.isConnected) return { error: `Ref ${ref} is stale or unknown. Take a new browser_snapshot.` };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return { error: `Element ${ref} is not visible.` };
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  let hit = document.elementFromPoint(x, y);
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  const ok = !hit || el === hit || el.contains(hit) || hit.contains(el);
  const covered = ok ? null : `<${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ''}> "${(hit.innerText || '').trim().slice(0, 40)}"`;
  return { x, y, covered };
}

function prepareTyping(ref, clear) {
  const el = window.__tabhelm?.refs.get(ref);
  if (!el || !el.isConnected) return { error: `Ref ${ref} is stale or unknown. Take a new browser_snapshot.` };
  el.focus();
  if (!clear) return {};
  if (typeof el.select === 'function' && ['INPUT', 'TEXTAREA'].includes(el.tagName)) {
    el.select();
  } else if (el.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  return {};
}

function selectOption(ref, value) {
  const el = window.__tabhelm?.refs.get(ref);
  if (!el || !el.isConnected) return { error: `Ref ${ref} is stale or unknown. Take a new browser_snapshot.` };
  if (el.tagName !== 'SELECT') return { error: `${ref} is not a <select>; click it and pick the option instead.` };
  const want = String(value).trim().toLowerCase();
  const opt = [...el.options].find((o) => o.value.toLowerCase() === want || o.text.trim().toLowerCase() === want);
  if (!opt) return { error: `No option matching "${value}".` };
  el.value = opt.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { label: opt.text.trim() };
}

function scrollPage(ref, direction) {
  const target = ref ? window.__tabhelm?.refs.get(ref) : document.scrollingElement || document.documentElement;
  if (!target) return { error: `Ref ${ref} is stale or unknown. Take a new browser_snapshot.` };
  const amount = (ref ? target.clientHeight : innerHeight) * 0.8;
  target.scrollBy({ top: direction === 'down' ? amount : -amount, behavior: 'instant' });
  return { position: Math.round(target.scrollTop), max: Math.round(target.scrollHeight - target.clientHeight) };
}
