// Condenses ~/.tabhelm/host.log into a small, redacted digest for the
// extension's self-analysis. The host never classifies (the extension owns the
// one ruleset) and never joins with journals; it only parses its own line
// formats, groups repeats and redacts, so no raw log line ever leaves it.
// Pure apart from readLogWindow's file reads: time always comes from the caller.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { basename } from 'node:path';

const MAX_LINES = 200_000;
const MAX_EVENTS = 500;
const MAX_GROUPS = 300;
const MAX_RUNS = 50;
const MAX_JSON = 200_000; // well under the 1 MB native messaging frame limit
const CAPPED_EVENTS = 200;
const MARGIN_MS = 60_000;
const RELAY_RUN = 20; // THRESHOLDS.relayRetryRun
const NORMAL_EXIT_AFTER_STOP_MS = 5000; // THRESHOLDS.normalExitAfterStopMs
const KEEP_CONTINUATIONS = 3;
const MAX_MESSAGE = 160; // THRESHOLDS.maxMessage
const MAX_OTHER_TABS = 10;

// dotAll: agent stderr may carry a bare \r (progress output), which must not
// turn a timestamped line into a continuation.
const LINE_RE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (?:\[(\d+)\] )?(.*)$/s;

// First match wins; the captures feed tabId / agent / code.
const KINDS = [
  ['host_started', /^host started/],
  ['ext_disconnected', /^extension disconnected/],
  ['uncaught', /^uncaught: /],
  ['unhandled', /^unhandled: /],
  ['error_handling', /^error handling (\w+): /],
  ['prompt_failed', /^prompt failed for tab (\d+): /],
  ['tool_error', /^tool error(?: \[tab (\d+|\?)\])?(?: ([\w-]+|\?))?: /],
  ['agent_exit', /^agent (\S+) for tab (\d+) exited \((\w+)\)$/],
  ['stopping_agent', /^stopping agent (\S+) for tab (\d+)/],
  ['agent_stderr', /^\[([\w-]+):(\d+)\] /],
  ['relay', /^relay: /],
  ['unknown_type', /^unknown message type /],
  ['skill_lookup', /^skill collection lookup failed/],
  ['config', /^(?:config \S+ after start|default model .* not applied)/],
];

// Same as taxonomy.js LOG_NOISE. The session-title line carries "Query closed
// before response received" and would otherwise look like 112 agent crashes.
const LOG_NOISE = /^(?:relay: (?:connected|panel|paired|pairing)|recording (?:saved|deleted)|\[[\w-]+:\d+\] (?:Unexpected case|\[session\/|.*failed to generate a session title))/;
const ERRORISH = /error|exception|fatal|traceback|ENOSPC|EACCES|ENOENT|Authentication required|denied|refused|panic/i;
const RELAY_FAIL = /^relay: (?:disconnected \(|connect |[A-Z]{4,} )/;
const RELAY_OK = /^relay: (?:connected|paired)/;
const NORMAL_EXITS = new Set(['0', '130', '143', 'SIGTERM', 'SIGINT']);
const PAIRING_LINE = /^relay: pairing code [A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}\b/;
// native-host.js writes "host started v0.31.0 node=v22.11.0 linux[ relay], tool
// server …" with its pid in the line prefix; "pid=" is the older spec format.
const STARTED_RE = /^host started v(\S+)(?: pid=(\d+))? node=(\S+) (\w+)( relay)?,/;
const ERRNO_RE = /\b(E(?:ACCES|ADDRINUSE|AI_AGAIN|CONNREFUSED|CONNRESET|HOSTUNREACH|MFILE|NOENT|NOSPC|NOTFOUND|PERM|PIPE|TIMEDOUT))\b/;
const TABLESS_EVENTS = new Set(['uncaught', 'unhandled', 'error_handling']);
const TAB_EVENTS = new Set(['prompt_failed', 'agent_exit', 'stopping_agent', 'tool_error']);

// ---------------------------------------------------------------- reading

// The newest lines of host.log (and of host.log.1 when the window reaches back
// past the current file), oldest first. The array also carries `files`
// ([{ name, bytes }]) and `bytesRead`, which digestLog copies into its meta.
export function readLogWindow(file, { since, maxBytes = 8 << 20 } = {}) {
  const main = readTail(file, maxBytes, MAX_LINES);
  let older = null;
  // The rotated file only continues the story when the current one was read
  // from its first byte and still starts after `since`.
  if (!main || (main.whole && !(firstTsMs(main.lines) <= (toMs(since) ?? -Infinity)))) {
    const bytesLeft = maxBytes - (main?.read || 0);
    const linesLeft = MAX_LINES - (main?.lines.length || 0);
    if (bytesLeft > 0 && linesLeft > 0) older = readTail(`${file}.1`, bytesLeft, linesLeft);
  }
  const parts = [older, main].filter(Boolean);
  const lines = parts.flatMap((p) => p.lines);
  lines.files = parts.map((p) => ({ name: p.name, bytes: p.bytes }));
  lines.bytesRead = parts.reduce((n, p) => n + p.read, 0);
  return lines;
}

// Reads at most `budget` bytes from the end of the file, so a 50 MB log costs
// no more than a small one. The first line is dropped when the read starts
// mid-file because it is almost always cut.
function readTail(file, budget, maxLines) {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - budget);
    const buf = Buffer.alloc(size - start);
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, start + read);
      if (!n) break;
      read += n;
    }
    let text = buf.toString('utf8', 0, read);
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl < 0 ? '' : text.slice(nl + 1);
    }
    const lines = text ? text.split('\n') : [];
    if (lines.at(-1) === '') lines.pop();
    return { name: basename(file), bytes: size, read, whole: start === 0, lines: lines.length > maxLines ? lines.slice(-maxLines) : lines };
  } finally {
    closeSync(fd);
  }
}

function firstTsMs(lines) {
  for (const line of lines) {
    const m = LINE_RE.exec(line);
    if (m) return Date.parse(m[1]);
  }
  return undefined;
}

// ---------------------------------------------------------------- digest

export function digestLog(lines = [], { since, until, tabIds, meta = {} } = {}) {
  const sinceMs = toMs(since);
  const untilMs = toMs(until);
  const from = (sinceMs ?? -Infinity) - MARGIN_MS;
  const to = (untilMs ?? Infinity) + MARGIN_MS;
  // No tabIds at all means every tab; an array (even empty) is a filter.
  const wanted = Array.isArray(tabIds) ? new Set(tabIds.map(Number)) : null;
  const st = {
    wanted,
    events: [],
    groups: new Map(),
    openRuns: new Map(),
    // Host version per pid, from its "host started" line: a group is tagged
    // with the version that wrote it, not the one running now, so the
    // extension can tell when an error stopped after an update.
    hostVersions: new Map(),
    runs: [],
    stops: new Map(),
    disconnects: new Map(),
    stderrOther: new Map(),
    nextGid: 1,
  };
  let firstTs = null;
  let started = null;
  let pairingCodesSeen = 0;
  let linesInWindow = 0;

  for (const rec of records(lines)) {
    firstTs ??= rec.ts;
    // Counted over everything read: the privacy note is about the file on disk.
    if (PAIRING_LINE.test(rec.msg)) pairingCodesSeen++;
    const s = STARTED_RE.exec(rec.msg);
    if (s) {
      started = { hostVersion: s[1], pid: s[2] ? Number(s[2]) : rec.pid, node: s[3], platform: s[4], relayMode: Boolean(s[5]) };
      st.hostVersions.set(started.pid, started.hostVersion);
    }
    if (!(rec.ms >= from && rec.ms <= to)) continue;
    linesInWindow += rec.lines;
    take(st, rec);
  }
  for (const pid of [...st.openRuns.keys()]) closeRun(st, pid);

  const groups = [...st.groups.values()]
    .sort((a, b) => b.count - a.count || cmp(a.first, b.first) || a.n - b.n);
  const runs = st.runs
    .sort((a, b) => b.length - a.length || cmp(a.first, b.first))
    .slice(0, MAX_RUNS)
    .sort((a, b) => cmp(a.first, b.first));
  const events = capEvents(st.events);
  const digest = {
    v: 1,
    events,
    groups: groups.slice(0, MAX_GROUPS).map(publicGroup),
    runs,
    meta: {
      hostVersion: meta.hostVersion ?? started?.hostVersion ?? null,
      pid: meta.pid ?? started?.pid ?? null,
      platform: meta.platform ?? started?.platform ?? null,
      node: meta.node ?? started?.node ?? null,
      relayMode: meta.relayMode ?? started?.relayMode ?? null,
      files: lines.files || [],
      window: { since: isoOf(sinceMs), until: isoOf(untilMs) },
      bytesRead: lines.bytesRead ?? null,
      linesScanned: lines.length,
      linesInWindow,
      firstTs,
      truncated: events.length < st.events.length || groups.length > MAX_GROUPS || st.runs.length > MAX_RUNS,
      pairingCodesSeen,
      stderrOther: Object.fromEntries(st.stderrOther),
    },
  };
  fitSize(digest);
  unlinkDropped(digest);
  return digest;
}

// One logical log record: a timestamped line plus the continuation lines
// (stack frames, multi-line stderr chunks) written with it.
function* records(lines) {
  let rec = null;
  for (const line of lines) {
    const m = LINE_RE.exec(line);
    if (!m) {
      // A continuation before any timestamp belongs to a record cut off by the tail read.
      if (rec) addContinuation(rec, line);
      continue;
    }
    if (rec) yield rec;
    rec = { ts: m[1], ms: Date.parse(m[1]), pid: m[2] ? Number(m[2]) : null, msg: m[3], cont: [], rpc: {}, frame: null, lines: 1 };
  }
  if (rec) yield rec;
}

function addContinuation(rec, line) {
  rec.lines++;
  if (rec.cont.length < KEEP_CONTINUATIONS) rec.cont.push(line);
  // The first frame in TabHelm's own code may sit below several node:internal
  // frames (EPIPE from a stderr write), so every line is looked at.
  if (!rec.frame && /^\s*at\s/.test(line)) rec.frame = ownFrame(line);
  // ACP errors are printed as util.inspect objects: the request first, then
  // { code, message } many lines down. Pick those out of every line so
  // "-32000 Authentication required" survives the 3-line limit.
  const rpc = rec.rpc;
  let m;
  if (!rpc.method && (m = /^\s*method: '([\w/.-]+)',?$/.exec(line))) rpc.method = m[1];
  else if (!rpc.code && (m = /^\s*code: (-?\d+),?$/.exec(line))) rpc.code = m[1];
  else if (!rpc.message && (m = /^\s*message: (['"`])(.*)\1,?$/.exec(line))) rpc.message = m[2];
}

function kindOf(msg) {
  for (const [kind, re] of KINDS) {
    const m = re.exec(msg);
    if (m) return { kind, m };
  }
  return { kind: 'other', m: null };
}

function take(st, rec) {
  const { kind, m } = kindOf(rec.msg);
  const pid = rec.pid ?? '';
  if (kind === 'relay') {
    if (RELAY_FAIL.test(rec.msg)) extendRun(st, pid, rec);
    else if (RELAY_OK.test(rec.msg)) closeRun(st, pid);
    return;
  }
  if (LOG_NOISE.test(rec.msg)) {
    if (kind === 'agent_stderr') countOther(st, m[1]);
    return;
  }
  switch (kind) {
    case 'host_started':
    case 'ext_disconnected':
      if (kind === 'ext_disconnected') st.disconnects.set(pid, rec.ms);
      return addEvent(st, rec, kind, null, null, null, null);
    case 'stopping_agent':
      st.stops.set(`${pid}|${m[2]}`, rec.ms);
      return addEvent(st, rec, kind, Number(m[2]), m[1], null, null);
    case 'agent_exit': {
      const [, agent, tab, code] = m;
      // dispose() SIGKILLs 3 s after its SIGTERM, and a closing extension takes
      // every agent down with it: both are normal, not crashes.
      const normal = NORMAL_EXITS.has(code) || after(st.stops.get(`${pid}|${tab}`), rec.ms) || after(st.disconnects.get(pid), rec.ms);
      const g = normal ? null : group(st, rec, kind, agent, code, `agent ${agent} for tab N exited (${code})`, Number(tab));
      return addEvent(st, rec, kind, Number(tab), agent, code, g);
    }
    case 'agent_stderr': {
      const text = textOf(rec, rec.msg.slice(m[0].length));
      if (!ERRORISH.test(text)) return countOther(st, m[1]);
      group(st, rec, kind, m[1], rec.rpc.code || errnoOf(text), text, Number(m[2]));
      return;
    }
    case 'prompt_failed': {
      const tab = Number(m[1]);
      const text = textOf(rec, rec.msg.slice(m[0].length));
      const code = errnoOf(text);
      return addEvent(st, rec, kind, tab, null, code, group(st, rec, kind, null, code, text, tab));
    }
    case 'tool_error': {
      const tab = m[1] && m[1] !== '?' ? Number(m[1]) : null;
      const tool = m[2] && m[2] !== '?' ? m[2] : null;
      const g = group(st, rec, kind, null, tool, textOf(rec, rec.msg.slice(m[0].length)), tab);
      return addEvent(st, rec, kind, tab, null, tool, g);
    }
    case 'other':
      if (ERRORISH.test(rec.msg)) group(st, rec, kind, null, errnoOf(rec.msg), textOf(rec, rec.msg), null);
      return;
    default: {
      // uncaught, unhandled, error_handling, unknown_type, skill_lookup, config.
      // Their prefixes stay in the text: the taxonomy's anchored rules
      // (^uncaught: , ^error handling \w+: , ^unknown message type) need them.
      const code = kind === 'error_handling' ? m[1] : errnoOf(rec.msg);
      const g = group(st, rec, kind, null, code, textOf(rec, rec.msg), null);
      if (TABLESS_EVENTS.has(kind)) addEvent(st, rec, kind, null, null, code, g);
    }
  }
}

const after = (stopMs, ms) => stopMs !== undefined && ms >= stopMs && ms - stopMs <= NORMAL_EXIT_AFTER_STOP_MS;

function textOf(rec, text) {
  const { method, code, message } = rec.rpc;
  if (code && message && /\{\s*$/.test(text)) return `${text.replace(/\s*\{\s*$/, '')}${method ? ` ${method}` : ''} → ${code} ${message}`;
  return text;
}

const errnoOf = (text) => ERRNO_RE.exec(text)?.[1] || null;

function countOther(st, agent) {
  st.stderrOther.set(agent, (st.stderrOther.get(agent) || 0) + 1);
}

function addEvent(st, rec, kind, tabId, agent, code, g) {
  if (TAB_EVENTS.has(kind) && st.wanted && !st.wanted.has(tabId)) return;
  st.events.push({ ts: rec.ts, kind, tabId, agent, code, gid: g?.gid ?? null });
}

function group(st, rec, kind, agent, code, rawText, tab) {
  const text = redactLine(rawText);
  const key = `${kind}|${agent ?? ''}|${code ?? ''}|${text}`;
  const version = st.hostVersions.get(rec.pid) ?? null;
  let g = st.groups.get(key);
  if (!g) {
    g = {
      gid: `g${st.nextGid}`, n: st.nextGid++, kind, agent, code, text, frame: rec.frame || null, count: 0, first: rec.ts, last: rec.ts, tabs: [],
      versions: { first: version, last: version },
    };
    st.groups.set(key, g);
  }
  g.count++;
  g.last = rec.ts;
  if (version) {
    g.versions.first ??= version;
    g.versions.last = version;
  }
  // Requested tabs are always listed (the extension joins on them); a few
  // others show that the error is not specific to one chat.
  if (tab != null && !g.tabs.includes(tab) && (st.wanted?.has(tab) || g.tabs.length < MAX_OTHER_TABS)) g.tabs.push(tab);
  return g;
}

function publicGroup({ n, ...g }) {
  return g;
}

// The orphan relay host of 10-13 logged 6,470 retry lines; one run says it all.
// Runs are kept per host pid so a healthy host's "connected" does not split
// another host's retry loop.
function extendRun(st, pid, rec) {
  const run = st.openRuns.get(pid);
  if (run) {
    run.length++;
    run.last = rec.ts;
  } else st.openRuns.set(pid, { kind: 'relay_retry', length: 1, first: rec.ts, last: rec.ts, version: st.hostVersions.get(rec.pid) ?? null });
}

function closeRun(st, pid) {
  const run = st.openRuns.get(pid);
  st.openRuns.delete(pid);
  if (run && run.length > RELAY_RUN) st.runs.push(run);
}

// Lifecycle lines repeat on every restart, so failures and tab events win
// the 500 slots; within a rank the newest are kept.
function capEvents(events) {
  if (events.length <= MAX_EVENTS) return events;
  const rank = (e) => (e.kind === 'host_started' ? 2 : e.kind === 'ext_disconnected' ? 1 : 0);
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank(a.e) - rank(b.e) || b.i - a.i)
    .slice(0, MAX_EVENTS)
    .sort((a, b) => a.i - b.i)
    .map(({ e }) => e);
}

function fitSize(digest) {
  const size = () => JSON.stringify(digest).length;
  if (size() <= MAX_JSON) return;
  digest.meta.truncated = true;
  digest.events = digest.events.slice(0, CAPPED_EVENTS);
  if (size() > MAX_JSON) digest.groups = digest.groups.filter((g) => g.count > 1);
  // Last resort for pathological logs: groups are sorted by count, so the tail goes first.
  while (size() > MAX_JSON && digest.groups.length) digest.groups = digest.groups.slice(0, Math.floor(digest.groups.length * 0.8));
  while (size() > MAX_JSON && digest.events.length) digest.events = digest.events.slice(0, Math.floor(digest.events.length / 2));
}

function unlinkDropped(digest) {
  const kept = new Set(digest.groups.map((g) => g.gid));
  for (const e of digest.events) if (e.gid && !kept.has(e.gid)) e.gid = null;
}

function toMs(v) {
  if (v == null || v === '') return null;
  const ms = typeof v === 'number' ? v : v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

// ISO timestamps of one format sort as strings.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const isoOf = (ms) => (ms == null ? null : new Date(ms).toISOString());

// ---------------------------------------------------------------- frames

// "file:line" of a stack frame in TabHelm's own code, else null: a copy of
// extension/redact.js topFrame for one line. A redacted "at …" line would
// keep neither (file:///… becomes "file", paths become <path>), and the file
// and line are all a finding needs. Dependencies and node internals are not ours.
const FRAME_LOC_RE = /([^\s()]+?):(\d+)(?::\d+)?\)?\s*$/;
const OWN_CODE_RE = /^chrome-extension:\/\/|[/\\](?:extension|host[/\\]src)[/\\]/;
const LOCAL_LOC_RE = /^(?:chrome-extension:\/\/|file:\/\/|\/|[A-Za-z]:[\\/])/;

function ownFrame(line) {
  const m = FRAME_LOC_RE.exec(line);
  if (!m) return null;
  const loc = m[1].replace(/[?#].*$/, '');
  if (!LOCAL_LOC_RE.test(loc) || !OWN_CODE_RE.test(loc)) return null;
  const file = loc.split(/[/\\]/).pop();
  return /\.[cm]?js$/.test(file) ? `${file}:${m[2]}` : null;
}

// ---------------------------------------------------------------- redaction

// A copy of extension/redact.js norm() without step 1 (the host has no secret
// values): the relay image ships host/ without extension/, so it cannot be
// imported. The parity test runs both over REDACTION_TABLE; change them together.
const EMAIL_RE = /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const URL_RE = /\b(?:https?|wss?|file|chrome(?:-extension|-untrusted)?|devtools|about):(?:\/\/\[[\da-f:.]+\][^\s"'<>)\]]*|(?:\/\/)?[^\s"'<>)\]]+)/gi;
const URL_TRAIL_RE = /[.,;:!?]+$/;
const PATH_RE = /(?<![\p{L}\p{N}_.~\\/-])(?:[A-Za-z]:(?:\\{1,2}|\/)|\\\\[\p{L}\p{N}_.$?-]+\\|~?\/\/?[\p{L}\p{N}_.~@+$-]+(?: [\p{L}\p{N}_.~@+$-]+)*\/)[^\r\n"`“”„‘«»]*?(?=[\r\n"`“”„‘«»]|['’](?![\p{L}\p{N}])|:[\s\d]|\sE(?:ACCES|BUSY|EXIST|INVAL|ISDIR|LOOP|MFILE|NAMETOOLONG|NOENT|NOSPC|NOTDIR|NOTEMPTY|PERM|ROFS)\b|$)/gu;
const PATH_TRAIL_RE = /[\s.,;:!?)\]]/;
const EXT_RE = /[^.]\.([A-Za-z0-9]{1,10})$/;
const PAIRING_RE = /\b[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}\b/g;
const KEY_RE = /\b(?:sk|pk|rk)-[\w-]{16,}|\bgh[pousr]_\w{20,}|\bgithub_pat_\w{20,}|\bxox[abpr]-[\w-]+|\bAKIA[0-9A-Z]{16}\b|\bAIza[\w-]{30,}|\beyJ[\w-]+\.[\w-]+\.[\w-]+|\bBearer\s+\S+/g;
const KV_SECRET_RE = /\b(api[_-]?key|token|secret|pass(?:word|wd)?|pwd|code|auth)=[^&\s]+/gi;
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;
const DIGITS_RE = /\b\d[\d -]{10,}\d\b/g;
const IPV4_RE = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?!\.?\d)/g;
const TOKEN_RE = /(?<![\w/+=-])(?=[\w+/=-]*\d)(?=[\w+/=-]*[A-Za-z])[\w+/=-]{24,}(?![\w/+=-])/g;
const TOOL_NAME_RE = /^(?:browser|skill|memory|tabhelm)_[a-z_]+$/;
const REDACTED_RE = /^<(?:path|email|ip|key|token|number|iban|code)>(?:\.[A-Za-z0-9]{1,10})?$/;
const QUOTE_PAIRS = { '"': '"', '“': '”', '„': '“”', '«': '»', '‘': '’', "'": "'" };
const APOSTROPHE_RE = /['‘’]/;
const LETTER_RE = /[\p{L}\p{N}]/u;
const REF_RE = /\b(?:f\d+:)?e\d+\b/g;
const NUMBER_RE = /\b\d{2,}\b/g;

export function redactLine(s) {
  const redacted = String(s ?? '')
    .replace(/\{\{SECRET:[^}]*\}\}/g, '{{SECRET}}')
    .replace(EMAIL_RE, '<email>')
    .replace(URL_RE, redactUrl)
    .replace(PATH_RE, redactPath)
    .replace(PAIRING_RE, '<code>')
    .replace(KEY_RE, '<key>')
    .replace(KV_SECRET_RE, '$1=<redacted>')
    .replace(IBAN_RE, '<iban>')
    .replace(DIGITS_RE, '<number>')
    .replace(IPV4_RE, redactIpv4)
    .replace(TOKEN_RE, (m) => (TOOL_NAME_RE.test(m) ? m : '<token>'));
  const text = blankQuoted(redacted)
    .replace(REF_RE, '<ref>')
    .replace(NUMBER_RE, 'N')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(text, MAX_MESSAGE);
}

function redactUrl(match) {
  const trail = match.match(URL_TRAIL_RE)?.[0] || '';
  const url = trail ? match.slice(0, -trail.length) : match;
  return (hostOf(url) ?? '<url>') + trail;
}

function redactPath(match) {
  let end = match.length;
  while (end > 0 && PATH_TRAIL_RE.test(match[end - 1])) end--;
  const ext = EXT_RE.exec(match.slice(0, end).split(/[\\/]/).pop());
  return `<path>${ext ? `.${ext[1]}` : ''}${match.slice(end)}`;
}

// redact.js blankQuotes() as normalize() calls it: a quoted span runs to the
// last closing quote of its kind in the whole text (continuation lines too),
// or to the end when it never closes or the straight quotes do not pair up;
// only a standalone "…" or redacted value stays quoted.
const isLetter = (c) => c !== undefined && LETTER_RE.test(c);
const usableCloser = (line, i, closers) => closers.includes(line[i]) && !(APOSTROPHE_RE.test(line[i]) && isLetter(line[i + 1]));

function lastCloser(line, closers) {
  for (let i = line.length - 1; i >= 0; i--) if (usableCloser(line, i, closers)) return i;
  return -1;
}

function oddQuotes(line, q) {
  let n = 0;
  for (let i = line.indexOf(q); i >= 0; i = line.indexOf(q, i + 1)) if (q === '"' || !(isLetter(line[i - 1]) && isLetter(line[i + 1]))) n++;
  return n % 2 === 1;
}

function blankQuoted(line) {
  const last = Object.fromEntries(Object.entries(QUOTE_PAIRS).map(([q, closers]) => [q, lastCloser(line, closers)]));
  const odd = { '"': oddQuotes(line, '"'), "'": oddQuotes(line, "'") };
  const openers = /["“„«‘']/g;
  let out = '';
  let from = 0;
  for (let m; (m = openers.exec(line));) {
    const p = m.index;
    const q = m[0];
    if (APOSTROPHE_RE.test(q) && isLetter(line[p - 1])) continue;
    const closes = last[q] > p && !odd[q];
    let next = p + 1;
    if (closes) while (!usableCloser(line, next, QUOTE_PAIRS[q])) next++;
    const inner = line.slice(p + 1, next);
    if (closes && !isLetter(line[p - 1]) && !isLetter(line[next + 1]) && (inner === '…' || REDACTED_RE.test(inner))) {
      out += line.slice(from, next + 1);
      from = next + 1;
    } else {
      out += line.slice(from, p) + (q === "'" ? "'…'" : '"…"');
      from = closes ? last[q] + 1 : line.length;
    }
    openers.lastIndex = from;
  }
  return out + line.slice(from);
}

function redactIpv4(ip) {
  const octets = ip.split('.').map(Number);
  return octets.some((n) => n > 255) || octets[0] === 127 ? ip : '<ip>';
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
  let end = max - 1;
  // Never leave half of a surrogate pair before the ellipsis.
  if (/[\uD800-\uDBFF]/.test(s[end - 1])) end -= 1;
  end = wordCut(s, end);
  return `${s.slice(0, end).trimEnd()}…`;
}

const WEB_SCHEMES = new Set(['http', 'https', 'ws', 'wss']);
const INTERNAL_SCHEMES = new Set(['chrome', 'chrome-untrusted', 'devtools']);
const PAGE_NAME_RE = /^[a-z0-9-]{1,40}$/;
const LOCAL_HOST_RE = new RegExp([
  /^(?:localhost|.+\.localhost)$/,
  /^(?:127|10)(?:\.\d{1,3}){3}$/,
  /^0\.0\.0\.0$/,
  /^192\.168(?:\.\d{1,3}){2}$/,
  /^172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/,
  /^169\.254(?:\.\d{1,3}){2}$/,
  /^\[(?:::1?|f[cd][\da-f]{2}:[\da-f:.]*|fe[89ab][\da-f]:[\da-f:.]*)\]$/,
].map((re) => re.source).join('|'));

// Only the schemes URL_RE can match: the site and nothing that names a page.
function hostOf(url) {
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
  if (scheme === 'chrome-extension') return 'chrome-extension';
  if (scheme === 'about') {
    const page = u.pathname.toLowerCase();
    return PAGE_NAME_RE.test(page) ? `about:${page}` : 'about:';
  }
  if (INTERNAL_SCHEMES.has(scheme)) {
    const page = (u.host || u.pathname.replace(/^\/+/, '').split('/')[0]).toLowerCase();
    return `${scheme}://${PAGE_NAME_RE.test(page) ? page : ''}`;
  }
  return null;
}
