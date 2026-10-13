// Functions injected into page frames with chrome.scripting.executeScript.
// They are serialized, so each one must be self-contained (no outer references).
// Refs live per frame in window.__tabhelm.refs (isolated world), e.g. "e12".

export function pageSnapshot(maxChars) {
  const state = (window.__tabhelm ||= { refs: new Map(), next: 1 });
  state.refs = new Map();

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'HEAD', 'META', 'LINK', 'IFRAME', 'FRAME', 'CANVAS']);
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
        if (t === 'file') return 'file-input';
        return `textbox:${t}`;
      }
    }
    if (el.tagName === 'LABEL' && el.control) return 'label';
    const ce = el.getAttribute('contenteditable');
    if (ce === '' || ce === 'true' || ce === 'plaintext-only') return 'textbox';
    if (el.getAttribute('draggable') === 'true') return 'draggable';
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
      else if (el.type === 'file') line += `${el.multiple ? ' [multiple]' : ''}${el.accept ? ` accept=${el.accept}` : ''}${el.files?.length ? ` files=${el.files.length}` : ''}`;
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

  const seen = new Set();
  function register(el, role) {
    const ref = `e${state.next++}`;
    state.refs.set(ref, el);
    seen.add(el);
    push(describe(el, role, ref));
  }

  function walk(root) {
    for (const el of root.children) {
      if (truncated) return;
      if (SKIP.has(el.tagName)) {
        if ((el.tagName === 'IFRAME' || el.tagName === 'FRAME') && visible(el)) {
          push(`[iframe "${clamp(el.title || el.name || '', 40)}" ${clamp(el.src, 80)} — content listed below]`);
        }
        continue;
      }
      if (!visible(el) || el.hasAttribute('data-tabhelm-overlay')) continue;

      const role = interactiveRole(el);
      if (role) {
        register(el, role);
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

  // File inputs are usually hidden behind a styled button; list them anyway.
  const hiddenFiles = [...document.querySelectorAll('input[type=file]')].filter((el) => !seen.has(el));
  if (hiddenFiles.length) {
    push('— hidden file inputs (use with browser_upload_file) —');
    for (const el of hiddenFiles) register(el, 'file-input');
  }

  return { url: location.href, title: document.title, text: lines.join('\n'), truncated };
}

// Search visible text, labels and placeholders; returns ref'd matches without
// resetting refs from the last snapshot.
export function findInPage(query, max) {
  const state = (window.__tabhelm ||= { refs: new Map(), next: 1 });
  const q = String(query).toLowerCase();
  const clamp = (s, n) => {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? `${s.slice(0, n)}…` : s;
  };
  const INTERACTIVE =
    'a[href],button,summary,select,textarea,input:not([type=hidden]),[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[role=option],[role=switch],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  const refOf = (el) => {
    for (const [ref, node] of state.refs) if (node === el) return ref;
    const ref = `e${state.next++}`;
    state.refs.set(ref, el);
    return ref;
  };
  const visible = (el) =>
    el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : el.getClientRects().length > 0;

  const results = [];
  const used = new Set();
  function scan(root) {
    for (const el of root.querySelectorAll('*')) {
      if (results.length >= max) return;
      if (el.shadowRoot) scan(el.shadowRoot);
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName)) continue;
      let own = '';
      for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) own += n.textContent;
      const hay = [own, el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('title'), el.getAttribute('alt'), el.value]
        .filter((v) => typeof v === 'string')
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q) || !visible(el)) continue;
      const target = el.closest(INTERACTIVE) || el;
      if (used.has(target)) continue;
      used.add(target);
      const role = target.getAttribute('role') || target.tagName.toLowerCase();
      const label = target.getAttribute('aria-label') || target.innerText || target.placeholder || target.value || '';
      results.push(`[${refOf(target)}] ${role} "${clamp(label, 80)}"`);
    }
  }
  if (document.body) scan(document.body);
  return { url: location.href, lines: results };
}

// Center of a ref'd element in this frame's viewport. For same-origin frames
// it also walks frameElement up to report top-level viewport coordinates.
export function elementCenter(ref, scroll) {
  const el = window.__tabhelm?.refs.get(ref);
  if (!el || !el.isConnected) return { error: `Ref ${ref} is stale or unknown. Take a new browser_snapshot.` };
  if (scroll !== false) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return { error: `Element ${ref} is not visible (zero size).` };
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
  const isToggle = el.type === 'checkbox' || el.type === 'radio';
  const label = (el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.innerText || el.placeholder || (isToggle ? '' : el.value) || el.title || el.tagName.toLowerCase())
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);

  let topX = x;
  let topY = y;
  let w = window;
  try {
    while (w !== w.top) {
      const fe = w.frameElement;
      if (!fe) throw new Error('cross-origin');
      const fr = fe.getBoundingClientRect();
      topX += fr.left + fe.clientLeft;
      topY += fr.top + fe.clientTop;
      w = w.parent;
    }
  } catch {
    return { x, y, covered, label, topX: null, topY: null };
  }
  return { x, y, covered, label, topX, topY };
}

// Position of the iframe showing `frameUrl` inside this document (content box, viewport coords).
export function iframeOffset(frameUrl) {
  const frames = [...document.querySelectorAll('iframe,frame')].filter((f) => f.getClientRects().length);
  const abs = (src) => {
    try {
      return new URL(src, location.href).href;
    } catch {
      return src;
    }
  };
  let match = frames.find((f) => {
    try {
      if (f.contentWindow.location.href === frameUrl) return true;
    } catch {}
    return abs(f.getAttribute('src') || 'about:blank') === frameUrl;
  });
  if (!match && frames.length === 1) match = frames[0];
  if (!match) return null;
  const r = match.getBoundingClientRect();
  const cs = getComputedStyle(match);
  return { x: r.left + match.clientLeft + parseFloat(cs.paddingLeft), y: r.top + match.clientTop + parseFloat(cs.paddingTop) };
}

export function elementRect(ref) {
  const el = window.__tabhelm?.refs.get(ref);
  if (!el || !el.isConnected) return { error: `Ref ${ref} is stale or unknown. Take a new browser_snapshot.` };
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

export function domClick(ref) {
  const el = window.__tabhelm?.refs.get(ref);
  if (!el || !el.isConnected) return { error: `Ref ${ref} is stale or unknown. Take a new browser_snapshot.` };
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  el.focus?.();
  el.click();
  return {};
}

export function prepareTyping(ref, clear) {
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

// Fallback for cross-origin frames where a trusted click can't be positioned.
export function setValueFallback(ref, text, clear) {
  const el = window.__tabhelm?.refs.get(ref);
  if (!el || !el.isConnected) return { error: `Ref ${ref} is stale or unknown. Take a new browser_snapshot.` };
  el.focus();
  if (el.isContentEditable) {
    if (clear) el.textContent = '';
    document.execCommand('insertText', false, text);
    return {};
  }
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, clear ? text : el.value + text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return {};
}

export function selectOption(ref, value) {
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

export function scrollPage(ref, direction, amount) {
  const target = ref ? window.__tabhelm?.refs.get(ref) : document.scrollingElement || document.documentElement;
  if (!target) return { error: `Ref ${ref} is stale or unknown. Take a new browser_snapshot.` };
  const vertical = direction === 'up' || direction === 'down';
  const page = vertical ? (ref ? target.clientHeight : innerHeight) : ref ? target.clientWidth : innerWidth;
  const delta = (amount || page * 0.8) * (direction === 'up' || direction === 'left' ? -1 : 1);
  target.scrollBy({ top: vertical ? delta : 0, left: vertical ? 0 : delta, behavior: 'instant' });
  return vertical
    ? { position: Math.round(target.scrollTop), max: Math.round(target.scrollHeight - target.clientHeight) }
    : { position: Math.round(target.scrollLeft), max: Math.round(target.scrollWidth - target.clientWidth) };
}

export function markForUpload(ref, token) {
  const el = window.__tabhelm?.refs.get(ref);
  if (!el || !el.isConnected) return { error: `Ref ${ref} is stale or unknown. Take a new browser_snapshot.` };
  if (el.tagName !== 'INPUT' || el.type !== 'file') {
    const inner = el.querySelector?.('input[type=file]') || (el.htmlFor && document.getElementById(el.htmlFor));
    if (!inner || inner.type !== 'file') return { error: `${ref} is not a file input. Use the "file-input" ref from the snapshot.` };
    inner.setAttribute('data-tabhelm-upload', token);
    return {};
  }
  el.setAttribute('data-tabhelm-upload', token);
  return {};
}

export function pageText() {
  return { url: location.href, text: document.body?.innerText || '' };
}

export function hasText(text) {
  return Boolean(document.body?.innerText.includes(text));
}

// Visible "agent cursor" so the user (and recordings) can see where the agent
// points and clicks. Lives in a shadow root, ignores pointer events, fades out.
export function showPointer(x, y, kind) {
  const ID = 'tabhelm-pointer';
  let host = document.getElementById(ID);
  if (!host) {
    host = document.createElement('div');
    host.id = ID;
    host.setAttribute('data-tabhelm-overlay', '');
    const root = host.attachShadow({ mode: 'open' });
    // Constructable stylesheets are not blocked by the page's style-src CSP.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      .cursor { position: fixed; left: 0; top: 0; width: 24px; height: 24px; margin: -2px 0 0 -2px; pointer-events: none;
        z-index: 2147483647; transition: transform .3s ease, opacity .4s; filter: drop-shadow(0 1px 2px rgba(0,0,0,.45)); }
      .ripple { position: fixed; width: 40px; height: 40px; margin: -20px 0 0 -20px; border-radius: 50%; border: 3px solid #2f6fde;
        pointer-events: none; z-index: 2147483647; animation: ripple .65s ease-out forwards; }
      @keyframes ripple { from { transform: scale(.3); opacity: 1 } to { transform: scale(1.5); opacity: 0 } }
    `);
    root.adoptedStyleSheets = [sheet];
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'cursor');
    const path = document.createElementNS(svgNs, 'path');
    path.setAttribute('d', 'M3 2l7.5 19 2.6-7.6L21 10.8z');
    path.setAttribute('fill', '#2f6fde');
    path.setAttribute('stroke', '#fff');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
    root.append(svg);
    document.documentElement.append(host);
    svg.style.transform = `translate(${x}px, ${y}px)`;
  }
  const root = host.shadowRoot;
  const cursor = root.querySelector('.cursor');
  cursor.style.opacity = '1';
  cursor.style.transform = `translate(${x}px, ${y}px)`;
  if (kind === 'click') {
    const ripple = document.createElement('div');
    ripple.className = 'ripple';
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    root.append(ripple);
    setTimeout(() => ripple.remove(), 700);
  }
  clearTimeout(window.__tabhelmPointerTimer);
  window.__tabhelmPointerTimer = setTimeout(() => (cursor.style.opacity = '0'), 4000);
  return {};
}

// Outlines ref'd elements with a label for a few seconds (browser_highlight, and
// browser_find results when "Highlight finds" is on). With scroll, the first
// element is brought into view first so the user actually sees it.
export function highlightRefs(refs, label, scroll) {
  const ID = 'tabhelm-highlight';
  document.getElementById(ID)?.remove();
  if (scroll) {
    const first = refs.map((r) => window.__tabhelm?.refs.get(r)).find((el) => el?.isConnected);
    const r = first?.getBoundingClientRect();
    if (r && (r.bottom < 0 || r.top > innerHeight)) first.scrollIntoView({ block: 'center', inline: 'nearest' });
  }
  const host = document.createElement('div');
  host.id = ID;
  host.setAttribute('data-tabhelm-overlay', '');
  const root = host.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    .box { position: fixed; border: 3px solid #2a9d76; border-radius: 4px; box-shadow: 0 0 0 3px rgba(42,157,118,.25); pointer-events: none; z-index: 2147483646; }
    .tag { position: fixed; background: #1c7d5c; color: #fff; font: 600 12px system-ui, sans-serif; padding: 2px 6px; border-radius: 4px; pointer-events: none; z-index: 2147483647; }
  `);
  root.adoptedStyleSheets = [sheet];
  let n = 0;
  for (const ref of refs) {
    const el = window.__tabhelm?.refs.get(ref);
    if (!el || !el.isConnected) continue;
    const r = el.getBoundingClientRect();
    const box = document.createElement('div');
    box.className = 'box';
    Object.assign(box.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = label ? `${label} · ${ref}` : ref;
    Object.assign(tag.style, { left: `${r.left - 3}px`, top: `${Math.max(0, r.top - 24)}px` });
    root.append(box, tag);
    n++;
  }
  document.documentElement.append(host);
  setTimeout(() => host.remove(), 6000);
  return { count: n };
}

export function fieldKind(ref) {
  const el = window.__tabhelm?.refs.get(ref);
  if (!el || !el.isConnected) return { error: `Ref ${ref} is stale or unknown. Take a new browser_snapshot.` };
  if (el.tagName === 'SELECT') return 'select';
  if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) return el.type;
  return 'text';
}

export function isChecked(ref) {
  const el = window.__tabhelm?.refs.get(ref);
  if (!el || !el.isConnected) return { error: `Ref ${ref} is stale or unknown.` };
  return { checked: Boolean(el.checked) };
}

export function webStorage(kind, action, key, value) {
  const store = kind === 'localStorage' ? localStorage : sessionStorage;
  if (action === 'get') {
    if (key) return { text: store.getItem(key) == null ? `${key}: (not set)` : `${key} = ${store.getItem(key)}` };
    const lines = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      const v = store.getItem(k) || '';
      lines.push(`${k} = ${v.length > 80 ? `${v.slice(0, 80)}…` : v}`);
    }
    return { text: lines.join('\n') || `${kind} is empty.` };
  }
  if (!key) return { error: 'key is required' };
  if (action === 'set') store.setItem(key, value ?? '');
  else store.removeItem(key);
  return { text: `${kind}.${key} ${action === 'set' ? 'set' : 'removed'}.` };
}

// Guide mode (browser_guide): points at an element with an arrow and an
// instruction, then waits for the user to click it. State lives in
// window.__tabhelm.guide and is read by guideStatus() from the extension.
// The overlay is in the page, so recordings show it too.
export function guideShow(ref, text, step) {
  const ID = 'tabhelm-guide';
  document.getElementById(ID)?.remove();
  const state = (window.__tabhelm ||= { refs: new Map(), next: 1 });
  const el = state.refs.get(ref);
  if (!el || !el.isConnected) return { error: `Ref ${ref} is stale or unknown. Take a new browser_snapshot.` };
  if (state.guideListener) document.removeEventListener('click', state.guideListener, true);
  state.guide = { status: 'waiting', ref };

  const host = document.createElement('div');
  host.id = ID;
  host.setAttribute('data-tabhelm-overlay', '');
  const root = host.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    .ring { position: fixed; border: 3px solid #2a9d76; border-radius: 6px; pointer-events: none; z-index: 2147483645; animation: pulse 1.2s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { box-shadow: 0 0 0 4px rgba(42,157,118,.35); } 50% { box-shadow: 0 0 0 12px rgba(42,157,118,0); } }
    .arrow { position: fixed; width: 0; height: 0; pointer-events: none; z-index: 2147483646; animation: bob 1s ease-in-out infinite; }
    .arrow.down { border-left: 12px solid transparent; border-right: 12px solid transparent; border-top: 18px solid #1c7d5c; }
    .arrow.up { border-left: 12px solid transparent; border-right: 12px solid transparent; border-bottom: 18px solid #1c7d5c; }
    @keyframes bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(5px); } }
    .bubble { position: fixed; max-width: 320px; background: #1c7d5c; color: #fff; font: 14px/1.4 system-ui, sans-serif; padding: 10px 12px; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.25); z-index: 2147483647; pointer-events: auto; }
    .step { font-size: 11px; opacity: .8; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 2px; }
    .row { display: flex; gap: 6px; margin-top: 8px; }
    button { font: 600 12px system-ui, sans-serif; border: 0; border-radius: 6px; padding: 5px 10px; cursor: pointer; background: #fff; color: #1c7d5c; }
    button.ghost { background: rgba(255,255,255,.18); color: #fff; }
  `);
  root.adoptedStyleSheets = [sheet];

  const ring = document.createElement('div');
  ring.className = 'ring';
  const arrow = document.createElement('div');
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  const head = document.createElement('div');
  head.className = 'step';
  head.textContent = step ? `Step ${step}` : 'Your turn';
  const body = document.createElement('div');
  body.textContent = text;
  const row = document.createElement('div');
  row.className = 'row';
  const done = document.createElement('button');
  done.textContent = 'I did it';
  done.onclick = () => finish('done');
  const skip = document.createElement('button');
  skip.className = 'ghost';
  skip.textContent = 'Skip';
  skip.onclick = () => finish('skipped');
  row.append(done, skip);
  bubble.append(head, body, row);
  root.append(ring, arrow, bubble);
  document.documentElement.append(host);

  function place() {
    const r = el.getBoundingClientRect();
    Object.assign(ring.style, { left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
    const below = r.bottom + 120 < innerHeight || r.top < 140;
    arrow.className = `arrow ${below ? 'up' : 'down'}`;
    const ax = Math.min(Math.max(r.left + r.width / 2 - 12, 8), innerWidth - 32);
    Object.assign(arrow.style, { left: `${ax}px`, top: below ? `${r.bottom + 6}px` : `${r.top - 24}px` });
    const bw = Math.min(320, innerWidth - 16);
    const bx = Math.min(Math.max(r.left + r.width / 2 - bw / 2, 8), innerWidth - bw - 8);
    Object.assign(bubble.style, { width: `${bw}px`, left: `${bx}px` });
    if (below) bubble.style.top = `${r.bottom + 26}px`;
    else {
      bubble.style.top = '';
      bubble.style.bottom = `${innerHeight - r.top + 26}px`;
    }
  }
  function finish(status) {
    state.guide = { status, ref };
    document.removeEventListener('click', state.guideListener, true);
    removeEventListener('scroll', place, true);
    removeEventListener('resize', place);
    host.remove();
  }
  // The user's click on the target (or inside it) completes the step; the
  // event itself is left alone so the page reacts normally.
  state.guideListener = (e) => {
    const path = e.composedPath();
    if (path.includes(el)) finish('clicked');
  };
  document.addEventListener('click', state.guideListener, true);
  addEventListener('scroll', place, true);
  addEventListener('resize', place);
  place();
  return { ok: true, label: (el.getAttribute('aria-label') || el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 80) };
}

export function guideStatus() {
  return window.__tabhelm?.guide || { status: 'gone' };
}

export function guideHide() {
  const state = window.__tabhelm;
  document.getElementById('tabhelm-guide')?.remove();
  if (state?.guideListener) document.removeEventListener('click', state.guideListener, true);
  if (state) state.guide = { status: 'cancelled' };
}
