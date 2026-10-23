// Redaction and normalization for self-analysis. Pure: no chrome.*, no DOM,
// no clock, so the panel, the service worker and the node tests share it.
// Every free-text value that leaves a journal (reports, exports, bug reports,
// the agent's digest) goes through norm(), so nothing typed, read from a page
// or stored as a secret reaches them. The steps run in a fixed order because
// later patterns rely on earlier ones: a URL must shrink to its host before
// the path rule sees its path, and a JWT must become <key> before the token
// rule would call it <token>. host/src/log-digest.js redactLine() mirrors
// steps 2–13 for host.log lines; REDACTION_TABLE is the shared parity table.

const MAX_MESSAGE = 160;

// 1. Known secret values shorter than this would hit ordinary words.
const MIN_SECRET = 4;
// 2.
const SECRET_PLACEHOLDER_RE = /\{\{SECRET:[^}]*\}\}/g;
// 3. The lookbehind only lets a match start where a run starts; without it a
// long run with no "@" is rescanned from every offset (seconds per 50 KB).
const EMAIL_RE = /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// 4. The first branch admits a bracketed IPv6 host: the generic branch stops
// at "]" (so Markdown links end cleanly) and would cut http://[::1]:9229/x.
const URL_RE = /\b(?:https?|wss?|file|chrome(?:-extension|-untrusted)?|devtools|about):(?:\/\/\[[\da-f:.]+\][^\s"'<>)\]]*|(?:\/\/)?[^\s"'<>)\]]+)/gi;
// Sentence punctuation after a URL is not part of it ("Open https://x.com/a.").
const URL_TRAIL_RE = /[.,;:!?]+$/;
// 5. Absolute paths keep only the file extension. A path starts at a drive
// ("C:\", "C:/"), a share ("\\server\", "//server/") or a first folder
// ("/home/", "~/.tabhelm/") and runs on through spaces and any script
// ("/home/Ivan Petrenko/Документи") up to a newline, a quote (an apostrophe
// inside a name such as "Ivan's" does not end it), ": ", a ":line" number or
// an errno code ("spawn /usr/bin/x ENOENT"). The lookbehind keeps relative
// code paths such as "host/src/session.js" and one-segment commands such as
// "/login" readable. Windows paths need a drive or a share: a bare backslash
// run is more often an escape sequence than a path.
const PATH_RE = /(?<![\p{L}\p{N}_.~\\/-])(?:[A-Za-z]:(?:\\{1,2}|\/)|\\\\[\p{L}\p{N}_.$?-]+\\|~?\/\/?[\p{L}\p{N}_.~@+$-]+(?: [\p{L}\p{N}_.~@+$-]+)*\/)[^\r\n"`“”„‘«»]*?(?=[\r\n"`“”„‘«»]|['’](?![\p{L}\p{N}])|:[\s\d]|\sE(?:ACCES|BUSY|EXIST|INVAL|ISDIR|LOOP|MFILE|NAMETOOLONG|NOENT|NOSPC|NOTDIR|NOTEMPTY|PERM|ROFS)\b|$)/gu;
// Spaces and sentence punctuation after a path are not part of it.
const PATH_TRAIL_RE = /[\s.,;:!?)\]]/;
// A short alphanumeric suffix only: "report.my-project" must not keep its tail.
const EXT_RE = /[^.]\.([A-Za-z0-9]{1,10})$/;
// 6. The relay's own alphabet and format (relay/server.js); the dash is what
// keeps words such as AUTHORS or HTTPS out.
const PAIRING_RE = /\b[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}\b/g;
// 7.
const KEY_RE = /\b(?:sk|pk|rk)-[\w-]{16,}|\bgh[pousr]_\w{20,}|\bgithub_pat_\w{20,}|\bxox[abpr]-[\w-]+|\bAKIA[0-9A-Z]{16}\b|\bAIza[\w-]{30,}|\beyJ[\w-]+\.[\w-]+\.[\w-]+|\bBearer\s+\S+/g;
// 8.
const KV_SECRET_RE = /\b(api[_-]?key|token|secret|pass(?:word|wd)?|pwd|code|auth)=[^&\s]+/gi;
// 9.
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;
// 10. Card, phone and account numbers; then IPv4 outside loopback (local
// addresses already became "local" in URLs and say nothing about the user).
const DIGITS_RE = /\b\d[\d -]{10,}\d\b/g;
const IPV4_RE = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?!\.?\d)/g;
// 11. A digit and a letter, 24+ chars: catches hex ids, base64 and session
// tokens while tool names and code paths (no digits) stay readable.
const TOKEN_RE = /(?<![\w/+=-])(?=[\w+/=-]*\d)(?=[\w+/=-]*[A-Za-z])[\w+/=-]{24,}(?![\w/+=-])/g;
const TOOL_NAME_RE = /^(?:browser|skill|memory|tabhelm)_[a-z_]+$/;
// 12. Quoted text is almost always typed or page text (blankQuotes below);
// refs and numbers vary between runs and would split one error into many
// fingerprints. A value redaction already replaced ("open '<path>.pdf'") is
// not typed text and stays quoted.
const REDACTED_RE = /^<(?:path|email|ip|key|token|number|iban|code)>(?:\.[A-Za-z0-9]{1,10})?$/;
const REF_RE = /\b(?:f\d+:)?e\d+\b/g;
const NUMBER_RE = /\b\d{2,}\b/g;

function replaceSecretValues(s, secrets) {
  const values = [...new Set(secrets)]
    .filter((v) => typeof v === 'string' && v.length >= MIN_SECRET)
    .sort((a, b) => b.length - a.length);
  for (const v of values) s = s.split(v).join('{{SECRET}}');
  return s;
}

function redactUrl(match, onHost) {
  const trail = match.match(URL_TRAIL_RE)?.[0] || '';
  const url = trail ? match.slice(0, -trail.length) : match;
  const host = hostOf(url);
  if (host && onHost) onHost(host);
  return (host ?? '<url>') + trail;
}

function redactPath(match) {
  let end = match.length;
  while (end > 0 && PATH_TRAIL_RE.test(match[end - 1])) end--;
  const ext = EXT_RE.exec(match.slice(0, end).split(/[\\/]/).pop());
  return `<path>${ext ? `.${ext[1]}` : ''}${match.slice(end)}`;
}

function redactIpv4(ip) {
  const octets = ip.split('.').map(Number);
  if (octets.some((n) => n > 255) || octets[0] === 127) return ip;
  return '<ip>';
}

// Steps 1–11 of the redaction (no normalization). onHost(host) hears every
// host a URL was cut down to, so a caller can alias it wherever it appears.
export function redactText(s, { secrets = [], onHost = null } = {}) {
  let out = typeof s === 'string' ? s : String(s ?? '');
  if (!out) return out;
  out = replaceSecretValues(out, secrets || []);
  return out
    .replace(SECRET_PLACEHOLDER_RE, '{{SECRET}}')
    .replace(EMAIL_RE, '<email>')
    .replace(URL_RE, (m) => redactUrl(m, onHost))
    .replace(PATH_RE, redactPath)
    .replace(PAIRING_RE, '<code>')
    .replace(KEY_RE, '<key>')
    .replace(KV_SECRET_RE, '$1=<redacted>')
    .replace(IBAN_RE, '<iban>')
    .replace(DIGITS_RE, '<number>')
    .replace(IPV4_RE, redactIpv4)
    .replace(TOKEN_RE, (m) => (TOOL_NAME_RE.test(m) ? m : '<token>'));
}

// Step 12: makes two occurrences of one error compare equal.
export function normalize(s) {
  return blankQuotes(String(s ?? ''), { keep: (inner) => inner === '…' || REDACTED_RE.test(inner), blank: (q) => (q === "'" ? "'…'" : '"…"') })
    .replace(REF_RE, '<ref>')
    .replace(NUMBER_RE, 'N');
}

// Opening quote → its closing quotes. Straight and curly single quotes are
// apostrophes too, so they open only after a non-letter and close only
// before one ("don't", "Ivan's" stay).
const QUOTE_PAIRS = { '"': '"', '“': '”', '„': '“”', '«': '»', '‘': '’', "'": "'" };
const APOSTROPHE_RE = /['‘’]/;
const LETTER_RE = /[\p{L}\p{N}]/u;
const isLetter = (c) => c !== undefined && LETTER_RE.test(c);
const usableCloser = (line, i, closers) => closers.includes(line[i]) && !(APOSTROPHE_RE.test(line[i]) && isLetter(line[i + 1]));

function lastCloser(line, closers) {
  for (let i = line.length - 1; i >= 0; i--) if (usableCloser(line, i, closers)) return i;
  return -1;
}

// An odd number of straight quotes (not counting apostrophes inside words)
// means one of them is unpaired, and no pair in that text can be trusted.
function oddQuotes(line, q) {
  let n = 0;
  for (let i = line.indexOf(q); i >= 0; i = line.indexOf(q, i + 1)) if (q === '"' || !(isLetter(line[i - 1]) && isLetter(line[i + 1]))) n++;
  return n % 2 === 1;
}

// Replaces quoted text. Only a pair that stands apart from the words around
// it and that keep(inner) accepts is left as it is. Any other quote blanks the
// text up to the LAST closing quote of its kind, so quotes inside quotes
// ("Delete "Invoice 42"?") stay inside the span, or up to the end when it
// never closes (text truncated upstream), when the straight quotes do not
// pair up, or when `toEnd` is set. The whole text is one span: a dialog
// message or a typed value may hold line breaks ("Delete?\n\nIvan Petrenko"),
// and a span cut at a line would let its second line out. Linear: the text
// is scanned a fixed number of times.
export function blankQuotes(s, { keep = () => false, toEnd = false, blank = (q) => `${q}…${QUOTE_PAIRS[q].at(-1)}` } = {}) {
  const text = String(s ?? '');
  const last = Object.fromEntries(Object.entries(QUOTE_PAIRS).map(([q, closers]) => [q, lastCloser(text, closers)]));
  const odd = { '"': oddQuotes(text, '"'), "'": oddQuotes(text, "'") };
  const openers = /["“„«‘']/g;
  let out = '';
  let from = 0;
  for (let m; (m = openers.exec(text));) {
    const p = m.index;
    const q = m[0];
    if (APOSTROPHE_RE.test(q) && isLetter(text[p - 1])) continue;
    const closes = last[q] > p && !odd[q];
    let next = p + 1;
    if (closes) while (!usableCloser(text, next, QUOTE_PAIRS[q])) next++;
    if (closes && !isLetter(text[p - 1]) && !isLetter(text[next + 1]) && keep(text.slice(p + 1, next))) {
      out += text.slice(from, next + 1);
      from = next + 1;
    } else {
      out += text.slice(from, p) + blank(q);
      from = closes && !toEnd ? last[q] + 1 : text.length;
    }
    openers.lastIndex = from;
  }
  return out + text.slice(from);
}

// A cut inside a dotted word (a host or file name) drops the whole word: a
// fragment such as "portal.privatb" could no longer be recognised and hidden.
function wordCut(s, end) {
  if (end <= 0 || !/\S/.test(s[end] || '') || !/\S/.test(s[end - 1])) return end;
  let start = end;
  while (start > 0 && /\S/.test(s[start - 1])) start--;
  let stop = end;
  while (stop < s.length && /\S/.test(s[stop])) stop++;
  return s.slice(start, stop).includes('.') ? start : end;
}

function truncate(s, max) {
  if (s.length <= max) return s;
  let end = Math.max(0, max - 1);
  // Never leave half of a surrogate pair before the ellipsis.
  if (end > 0 && /[\uD800-\uDBFF]/.test(s[end - 1])) end -= 1;
  end = wordCut(s, end);
  return `${s.slice(0, end).trimEnd()}…`;
}

// The one form free text takes in any self-analysis output.
export function norm(s, { secrets = [], max = MAX_MESSAGE } = {}) {
  const text = normalize(redactText(s, { secrets })).replace(/\s+/g, ' ').trim();
  return truncate(text, max);
}

const WEB_SCHEMES = new Set(['http', 'https', 'ws', 'wss', 'ftp']);
const INTERNAL_SCHEMES = new Set(['chrome', 'chrome-untrusted', 'devtools', 'edge', 'brave']);
// Schemes whose name is useful but whose content (inline data, script, a
// mail address) must never be shown.
const OPAQUE_SCHEMES = new Set(['data', 'blob', 'javascript', 'view-source', 'mailto', 'tel', 'filesystem']);
const PAGE_NAME_RE = /^[a-z0-9-]{1,40}$/;
const LOCAL_HOST_RE = new RegExp([
  /^(?:localhost|.+\.localhost)$/,
  /^(?:127|10)(?:\.\d{1,3}){3}$/,
  /^0\.0\.0\.0$/,
  /^192\.168(?:\.\d{1,3}){2}$/,
  /^172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/,
  /^169\.254(?:\.\d{1,3}){2}$/,
  // IPv6 loopback, unspecified, unique-local (fc00::/7) and link-local (fe80::/10).
  /^\[(?:::1?|f[cd][\da-f]{2}:[\da-f:.]*|fe[89ab][\da-f]:[\da-f:.]*)\]$/,
].map((re) => re.source).join('|'));

// The site part of a URL, with nothing that identifies a page on it:
// hostname for the web (local addresses become "local", since dev-server
// ports and LAN addresses only split findings), the scheme plus first segment
// for browser pages, and null when it is not a URL.
export function hostOf(url) {
  if (typeof url !== 'string' || !url) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  if (WEB_SCHEMES.has(scheme)) {
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (!host) return null;
    return LOCAL_HOST_RE.test(host) ? 'local' : host;
  }
  if (scheme === 'file') return 'file';
  // The extension id says nothing useful and differs per install.
  if (scheme === 'chrome-extension') return 'chrome-extension';
  if (scheme === 'about') {
    const page = u.pathname.toLowerCase();
    return PAGE_NAME_RE.test(page) ? `about:${page}` : 'about:';
  }
  if (INTERNAL_SCHEMES.has(scheme)) {
    const page = (u.host || u.pathname.replace(/^\/+/, '').split('/')[0]).toLowerCase();
    return `${scheme}://${PAGE_NAME_RE.test(page) ? page : ''}`;
  }
  return OPAQUE_SCHEMES.has(scheme) ? scheme : null;
}

// "file:line" of the first stack frame in TabHelm's own code, so a TypeError
// finding points at a line instead of at the tool that happened to run.
// Only local code counts: a page's https://…/extension/… script is not ours.
const FRAME_LOC_RE = /([^\s()]+?):(\d+)(?::\d+)?\)?\s*$/;
const OWN_CODE_RE = /^chrome-extension:\/\/|[/\\](?:extension|host[/\\]src)[/\\]/;
const LOCAL_LOC_RE = /^(?:chrome-extension:\/\/|file:\/\/|\/|[A-Za-z]:[\\/])/;

export function topFrame(stack) {
  if (typeof stack !== 'string') return null;
  for (const line of stack.split('\n')) {
    const m = FRAME_LOC_RE.exec(line);
    if (!m) continue;
    const loc = m[1].replace(/[?#].*$/, '');
    if (!LOCAL_LOC_RE.test(loc) || !OWN_CODE_RE.test(loc)) continue;
    const file = loc.split(/[/\\]/).pop();
    if (/\.[cm]?js$/.test(file)) return `${file}:${m[2]}`;
  }
  return null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Replaces hosts (or skill names) by their aliases in exports. One combined
// pattern, longest key first, so "shop.example.com" wins over "example.com"
// and an alias is never re-aliased. Whole names only: "example.com" must not
// touch "shop.example.com" or "example.com.ua". Case-insensitive, because an
// error may spell a host in capitals. A key that is a common word (such as
// "local") also replaces that word; the caller decides which keys to pass.
export function aliasHosts(text, map) {
  if (typeof text !== 'string' || !text || !map) return text;
  const lookup = new Map();
  for (const [k, v] of map instanceof Map ? map : Object.entries(map)) {
    if (typeof k === 'string' && k && v != null && !lookup.has(k.toLowerCase())) lookup.set(k.toLowerCase(), String(v));
  }
  if (!lookup.size) return text;
  const keys = [...lookup.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const re = new RegExp(`(?<![\\w.-])(?:${keys.map(escapeRe).join('|')})(?![\\w-]|\\.[\\w-])`, 'gi');
  return text.replace(re, (m) => lookup.get(m.toLowerCase()) ?? m);
}

// Keys browser-tools.js accepts by name (KEYS and MODIFIER_ALIASES there).
// A single character is not a name: pressed one by one, characters are typing.
const NAMED_KEYS = new Map([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'PageUp', 'PageDown', 'Home', 'End', 'Space', 'Insert',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
].map((k) => [k.toLowerCase(), k]));
const MODIFIERS = { ctrl: 'Control', control: 'Control', shift: 'Shift', alt: 'Alt', option: 'Alt', meta: 'Meta', cmd: 'Meta', command: 'Meta', win: 'Meta' };

function namedKey(combo) {
  if (typeof combo !== 'string') return null;
  const parts = combo.split('+').map((p) => p.trim());
  const key = NAMED_KEYS.get(parts.pop()?.toLowerCase());
  const mods = parts.map((p) => MODIFIERS[p.toLowerCase()]);
  if (!key || mods.some((m) => !m)) return null;
  return [...mods, key].join('+');
}

const VERBS = {
  browser_snapshot: 'Read the page',
  browser_find: 'Find an element',
  browser_get_text: 'Read page text',
  browser_screenshot: 'Take a screenshot',
  browser_upload_file: 'Upload files',
  browser_go_back: 'Go back',
  browser_go_forward: 'Go forward',
  browser_reload: 'Reload',
  browser_search_tabs: 'Search tabs',
  browser_console: 'Read console',
  browser_network: 'Read network log',
  browser_network_body: 'Read a request body',
  browser_evaluate: 'Run JS',
  browser_highlight: 'Highlight elements',
  browser_storage: 'Use page storage',
  browser_emulate: 'Emulate a device',
  browser_request_human: 'Ask you for help',
  browser_request_login: 'Ask you to sign in',
  browser_guide: 'Guide you',
  memory_save: 'Remember a note',
  memory_search: 'Search memory',
  skill_list: 'List skills',
  skill_read: 'Read a skill',
  skill_read_file: 'Read a skill file',
};
const TAB_VERBS = { list: 'List tabs', switch: 'Switch tab', close: 'Close tab' };
const DIRECTIONS = new Set(['up', 'down', 'left', 'right']);

function toolVerb(tool) {
  if (VERBS[tool]) return VERBS[tool];
  if (!/^[\w-]{1,64}$/.test(tool)) return 'Use a tool';
  const words = tool.replace(/^browser_/, '').replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// A step description without values: no typed text, option values, URL paths
// or key presses that spell something. Labels (the element's visible name)
// appear only when `labels` is set, which only local skill drafts do.
export function safeDesc(tool, args, label, { labels = false } = {}) {
  const a = args && typeof args === 'object' ? args : {};
  const name = typeof tool === 'string' ? tool : '';
  const shown = labels && label != null && String(label).trim() ? truncate(redactText(String(label)).replace(/\s+/g, ' ').trim(), 40) : '';
  const target = (fallback = '<ref>') => (shown ? `“${shown}”` : fallback);
  const clickKind = a.double ? 'Double-click' : a.button === 'right' ? 'Right-click' : a.button === 'middle' ? 'Middle-click' : 'Click';
  switch (name) {
    case 'browser_click':
      return `${clickKind} ${target()}`;
    case 'browser_click_xy':
      return `${clickKind} ${target('a point')}`;
    case 'browser_hover':
      return `Hover ${target(a.ref ? '<ref>' : 'a point')}`;
    case 'browser_drag':
      return `Drag ${target(a.fromRef ? '<ref>' : 'a point')}`;
    case 'browser_type': {
      const n = typeof a.text === 'string' ? a.text.length : 0;
      return `Type <${plural(n, 'char')}> into ${target()}${a.submit ? ' + Enter' : ''}`;
    }
    case 'browser_select_option':
      return `Select an option in ${target()}`;
    case 'browser_fill_form':
      return `Fill ${plural(Array.isArray(a.fields) ? a.fields.length : 0, 'field')}`;
    case 'browser_navigate':
      return `Open ${hostOf(a.url) ?? 'a page'}`;
    case 'browser_tabs':
      if (a.action === 'new') return `Open ${hostOf(a.url) ?? 'a page'}`;
      return TAB_VERBS[a.action] || 'Use tabs';
    case 'browser_press_key': {
      const key = namedKey(a.key);
      return key ? `Press ${key}` : 'Press a key';
    }
    case 'browser_scroll':
      return DIRECTIONS.has(a.direction) ? `Scroll ${a.direction}` : 'Scroll';
    case 'browser_wait':
      return a.text ? 'Wait for a text' : 'Wait';
    case 'browser_handle_dialog':
      return a.accept ? 'Accept dialog' : 'Dismiss dialog';
    default:
      return toolVerb(name);
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// Key names are expected to be identifiers; anything else may be data the
// agent used as a key (a header value, a label), so it is not repeated.
const KEY_NAME_RE = /^[A-Za-z_$][\w$-]{0,39}$/;
const keyName = (k) => (KEY_NAME_RE.test(k) ? k : '?');

// Sorted argument key names, one level deep ("fields.ref"), never values.
// Objects inside arrays count as that level, so fill_form shows its field keys.
export function argKeys(args) {
  if (!isPlainObject(args)) return [];
  const keys = new Set();
  for (const [k, v] of Object.entries(args)) {
    const children = Array.isArray(v) ? v.filter(isPlainObject).flatMap(Object.keys) : isPlainObject(v) ? Object.keys(v) : [];
    if (!children.length) keys.add(keyName(k));
    for (const c of children) keys.add(`${keyName(k)}.${keyName(c)}`);
  }
  return [...keys].sort();
}

// JSON with object keys sorted at every level, so equal args hash equally
// whatever order the agent wrote them in.
function stableStringify(v, seen) {
  if (v === undefined || typeof v === 'function' || typeof v === 'symbol') return undefined;
  if (typeof v === 'bigint') return JSON.stringify(String(v));
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (typeof v.toJSON === 'function') return stableStringify(v.toJSON(), seen);
  if (seen.has(v)) return '"[Circular]"';
  seen.add(v);
  const out = Array.isArray(v)
    ? `[${v.map((x) => stableStringify(x, seen) ?? 'null').join(',')}]`
    : `{${Object.keys(v).sort().flatMap((k) => {
      const s = stableStringify(v[k], seen);
      return s === undefined ? [] : [`${JSON.stringify(k)}:${s}`];
    }).join(',')}}`;
  seen.delete(v);
  return out;
}

export function stableHash(obj) {
  return fnv1a32(stableStringify(obj, new WeakSet()) ?? 'null');
}

// 32-bit FNV-1a as 8 lowercase hex digits, for local ids and loop detection
// (not for security). It hashes UTF-16 code units, like taxonomy.js, so ids
// match whichever copy computed them; for ASCII that is standard FNV-1a.
export function fnv1a32(s) {
  const str = String(s ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// [input, norm(input)] with no secret values: steps 2–13, the part
// log-digest.js redactLine() must reproduce. Inputs stay under 160 chars so
// the two truncation limits never matter.
export const REDACTION_TABLE = Object.freeze([
  ['Signed in as ada.lovelace+test@example.co.uk', 'Signed in as <email>'],
  ['Typed {{SECRET:card_pin}} into e14', 'Typed {{SECRET}} into <ref>'],
  ['{{SECRET:x}}', '{{SECRET}}'],
  ['GET https://shop.example.com/cart/checkout?session=abc123&user=42#top failed', 'GET shop.example.com failed'],
  ['Open https://example.com/a/b.', 'Open example.com.'],
  ['net::ERR_CONNECTION_REFUSED at http://localhost:41234/fixture/form.html', 'net::ERR_CONNECTION_REFUSED at local'],
  ['Cannot reach http://192.168.1.20:8080/admin or ws://[::1]:9229/devtools', 'Cannot reach local or local'],
  ['GET http://93.184.216.34/api?id=7 failed', 'GET <ip> failed'],
  ['Cannot control chrome://settings/passwords', 'Cannot control chrome://settings'],
  ['Cannot access a chrome:// URL', 'Cannot access a chrome:// URL'],
  ['Navigated to about:blank', 'Navigated to about:blank'],
  ['Error in chrome-extension://abcdefghijklmnopabcdefghijklmnop/sidepanel.html', 'Error in chrome-extension'],
  ['Not allowed to load file:///home/ivanko/Documents/cv.pdf', 'Not allowed to load file'],
  ['/home/ivanko/x/y.pdf', '<path>.pdf'],
  ["ENOENT: no such file or directory, open '/home/ivanko/x/y.pdf'", "ENOENT: no such file or directory, open '<path>.pdf'"],
  ['Not a folder: /Users/ada/Documents/Taxes', 'Not a folder: <path>'],
  ['Saved to /home/ivanko/notes.txt', 'Saved to <path>.txt'],
  ['Cannot read C:\\Users\\Ada\\Downloads\\report.pdf', 'Cannot read <path>.pdf'],
  ['Cannot open D:\\Projects\\acme\\build.log', 'Cannot open <path>.log'],
  // Names with spaces, in other scripts, under a Windows profile with a space, on a share.
  ['Not a folder: /home/ivan/My Projects/Acme Clinic Patients', 'Not a folder: <path>'],
  ['Not a folder: C:\\Users\\Ivan Petrenko\\Desktop\\Taxes 2025', 'Not a folder: <path>'],
  ["EACCES: permission denied, open 'C:\\Users\\Olena Petrenko\\.claude\\settings.json'", "EACCES: permission denied, open '<path>.json'"],
  ["ENOENT: open '/Users/ivan/Library/Mobile Documents/com~apple~CloudDocs/Patients/Olena Koval.pdf'", "ENOENT: open '<path>.pdf'"],
  ["uncaught: Error: ENOENT: no such file or directory, scandir '/home/ivan/Документи/Податки'", "uncaught: Error: ENOENT: no such file or directory, scandir '<path>'"],
  ['Not a folder: /srv/Клієнти/ТОВ Ромашка', 'Not a folder: <path>'],
  ['Cannot open \\\\fileserver\\share\\HR\\salaries.xlsx', 'Cannot open <path>.xlsx'],
  ["open '/home/u/Ivan's Files/x.pdf'", "open '<path>.pdf'"],
  // Glued to a word and a colon, a long-path prefix, a share as a URL.
  ['Bad cwd:/home/ivan/Acme Clinic/Patients', 'Bad cwd:<path>'],
  ['ERROR:C:\\Users\\Ivan Petrenko\\Desktop', 'ERROR:<path>'],
  ['Cannot open \\\\?\\C:\\Users\\Ivan Petrenko\\x.txt', 'Cannot open <path>.txt'],
  ['Cannot open smb://fileserver/HR/Ivan Petrenko.xlsx', 'Cannot open smb:<path>.xlsx'],
  // A path ends at ": ", a line number or an errno code; one segment is a command, not a path.
  ['Failed to set up watcher for /home/kos/My Notes/settings.json: Error: ENOSPC', 'Failed to set up watcher for <path>.json: Error: ENOSPC'],
  ['at run (/home/u/.tabhelm/app/host/src/session.js:181:11)', 'at run (<path>.js:N:N)'],
  ['spawn /usr/local/bin/claude ENOENT', 'spawn <path> ENOENT'],
  ['Delete host.log in ~/.tabhelm or run /login', 'Delete host.log in ~/.tabhelm or run /login'],
  ['relay: pairing code K7PM-3QWX (valid 10 minutes)', 'relay: pairing code <code> (valid N minutes)'],
  ['See AUTHORS and HTTPS docs (UTF-8)', 'See AUTHORS and HTTPS docs (UTF-8)'],
  // Fake keys are split in two so secret scanners do not report them as leaks.
  ['Invalid API key sk-' + 'test-0000example0000example', 'Invalid API key <key>'],
  ['Bad credentials ghp' + '_exampleExampleExample0123456789ab', 'Bad credentials <key>'],
  ['jwt eyJhbGciOiJIUzI1NiJ9' + '.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlMTIz expired', 'jwt <key> expired'],
  ['Authorization: Bearer abc.def-123 rejected', 'Authorization: <key> rejected'],
  ['AKIA' + 'IOSFODNN7EXAMPLE is not valid', '<key> is not valid'],
  ['Retry with token=abc123def&mode=fast', 'Retry with token=<redacted>&mode=fast'],
  ['password=hunter2 rejected', 'password=<redacted> rejected'],
  ['Pay to UA213223130000026007233566001 now', 'Pay to <iban> now'],
  ['Card 4111 1111 1111 1111 declined', 'Card <number> declined'],
  ['Call +380 67 123 45 67', 'Call +<number>'],
  ['connect ECONNREFUSED 10.0.0.12:8080', 'connect ECONNREFUSED <ip>:N'],
  ['connect ECONNREFUSED 127.0.0.1:41234', 'connect ECONNREFUSED N.0.0.1:N'],
  ['session 9f86d081884c7d659a2feaa0c55ad015 expired', 'session <token> expired'],
  ['browser_select_option and browser_handle_dialog failed in extension/browser-tools', 'browser_select_option and browser_handle_dialog failed in extension/browser-tools'],
  ['Cannot read properties of null at host/src/session.js', 'Cannot read properties of null at host/src/session.js'],
  ['No option matching "Ada Lovelace" in f1:e12', 'No option matching "…" in <ref>'],
  ['Typed “my secret words” into e40', 'Typed "…" into <ref>'],
  // Quotes inside quotes, and other quote styles; apostrophes are not quotes.
  ['A JavaScript confirm dialog is blocking the page: "Delete "Invoice 42 for Ivan Petrenko"?". Use browser_handle_dialog first.', 'A JavaScript confirm dialog is blocking the page: "…". Use browser_handle_dialog first.'],
  ['No option matching "Ivan "Vanya" in e12', 'No option matching "…"'],
  ['Value "Ivan" Petrenko" and "x" rejected', 'Value "…"'],
  ['A JavaScript confirm dialog is blocking the page: "Delete invoice?\n\nIvan Petrenko will be notified". Use browser_handle_dialog first.', 'A JavaScript confirm dialog is blocking the page: "…". Use browser_handle_dialog first.'],
  ["SyntaxError: Failed to execute 'querySelector' on 'Document': 'li:has-text(Ivan Petrenko)' is not a valid selector.", "SyntaxError: Failed to execute '…' is not a valid selector."],
  ['Cannot find element «Іван Петренко» or „Олена“', 'Cannot find element "…" or "…"'],
  ["It doesn't work for 'Ada Lovelace'", "It doesn't work for '…'"],
  ["Cannot read properties of null (reading 'x')", "Cannot read properties of null (reading '…')"],
  ['Ref e12 is stale or unknown (snapshot 41234 ms old)', 'Ref <ref> is stale or unknown (snapshot N ms old)'],
  ['  Tool "browser_wait"\n  timed   out after 30s ', 'Tool "…" timed out after 30s'],
].map((row) => Object.freeze(row)));
