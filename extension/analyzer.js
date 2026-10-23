// Self-analysis core: turns saved chat journals, the host.log digest and the
// panel's live state into a ranked list of findings (what failed, why, who can
// fix it, what to do). Pure: no chrome.*, no DOM and no clock — `now` comes
// from the input — so the panel, the service worker and the node tests run the
// same code. Deterministic: the same input gives byte-identical JSON whatever
// the order of chats, index entries or object keys.
// Raw journal text lives only in the internal Event and Turn objects, which are
// never returned; a Finding carries normalized, redacted text only.

import {
  RULESET_VERSION, RULESET_HASH, COMPLAINT_RE, TIPS, PREAMBLE_HINTS,
  classify, ownerFor, templateFor, featureOf, componentMatch,
} from './taxonomy.js';
import { norm, hostOf, topFrame, safeDesc, argKeys, stableHash, fnv1a32 } from './redact.js';
import { replayOp, mdEntry, contextText, browserToolOf } from './journal-format.js';

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
};

export const THRESHOLDS = deepFreeze({
  dedupeMs: 2000, logJoinMs: 120_000, normalExitAfterStopMs: 5000,
  cluster: { minChats: 2 }, recurring: { minChats: 3, minDays: 2 },
  tool: { minCalls: 5, minFails: 3, minRate: 0.2, highRate: 0.5, watchFails: 2 },
  agent: { minTurns: 10, minSuccess: 0.8, altMinTurns: 5 },
  slowTurn: { factor: 3, minTurns: 5, minMs: 45_000 }, // tables only, no finding
  loop: { sameCall: 3, sameToolRun: 5, failsPerTurn: 8, snapshotShare: 0.5, snapshotMinActions: 10 },
  ignoredSnapshot: { minEvents: 3, minChats: 2 },
  mk: { minEvents: 3, minChats: 2, dropdownMin: 2, handoffChats: 2, correctionTurns: 2, correctionWindowMs: 600_000, restrictedChats: 2, softMin: 3 },
  skill: { unusedTurns: 2, staleEvents: 3, staleChats: 2, minLabel: 4 },
  preambleGap: { minAgents: 2 },
  hintFailedSteps: 3, relayRetryRun: 20, fixedLaterUses: 5, hideRegrowth: 3,
  live: { turnHungMs: 600_000, idleMs: 300_000, notSavingMs: 5000 },
  backupLimitBytes: 900_000, bigChatBytes: 2_000_000,
  maxEvidence: 5, maxFindings: 50, maxEntriesPerChat: 5000, digestBytes: 6000, maxMessage: 160,
});
const TH = THRESHOLDS;

export const ANALYZER_VERSION = 1;

const DAY = 86_400_000;
const SCOPES = new Set(['chat', '7d', '30d', '90d', 'all']);
const SCOPE_DAYS = { '7d': 7, '30d': 30, '90d': 90 };
const OUTCOMES = ['ok', 'failed', 'cancelled', 'declined', 'panel_closed', 'start_failed', 'crashed', 'unknown', 'legacy_unknown'];
const ELIGIBLE = new Set(['ok', 'failed', 'crashed', 'start_failed']);
const FAILED_OUTCOMES = new Set(['failed', 'crashed', 'start_failed']);
const NORMAL_EXITS = new Set(['0', '130', '143', 'SIGTERM', 'SIGINT']);

const EXPECTED_CATS = new Set(['USER_DECISION', 'POLICY', 'UI_INPUT']);
const TOOL_HEALTH_SKIP = new Set(['USER_DECISION', 'POLICY', 'SCHEDULE_NO_APPROVAL', 'FEATURE_OFF']);
const SITE_CATS = new Set(['PAGE_ELEMENT', 'PAGE_STATE', 'AGENT_MISUSE', 'CHROME_LIMIT']);
const AGENT_CATS = new Set(['AGENT_CRASH', 'BUDGET', 'MODEL_REFUSAL', 'QUOTA']);
const MK_CATS = new Set(['PAGE_ELEMENT', 'PAGE_STATE', 'AGENT_MISUSE']);
const PAGE_CATS = new Set(['PAGE_ELEMENT', 'PAGE_STATE', 'AGENT_MISUSE']);
const START_FAIL_CATS = new Set(['AGENT_CRASH', 'SETUP', 'AUTH', 'HOST_LINK']);

// Sources that are error texts (see extractEvents); the rank decides which of
// two copies of one error survives dedupe.
const SOURCE_RANK = { F: 5, A: 4, T: 3, P: 2, N: 1 };
const CLUSTER_SOURCES = new Set(['A', 'F', 'N', 'P', 'T', 'C']);
const FAIL_SOURCES = new Set(['A', 'F', 'N', 'P', 'T']);

const NAV_TOOLS = new Set(['browser_navigate', 'browser_go_back', 'browser_go_forward', 'browser_reload']);
const REF_TOOLS = new Set(['browser_click', 'browser_type', 'browser_select_option', 'browser_hover', 'browser_drag', 'browser_fill_form']);
const LOOK_TOOLS = new Set(['browser_snapshot', 'browser_find']);
const HUMAN_TOOLS = new Set(['browser_request_human', 'browser_request_login', 'browser_guide']);
// Reading the page again is not a loop by itself; the snapshot-share rule covers it.
const SAME_CALL_EXEMPT = new Set(['browser_snapshot', 'browser_screenshot']);
// Typing into one field after another is how forms are filled, not a loop.
const RUN_EXEMPT = new Set(['browser_type']);

// Soft notes on successful actions (browser-tools.js result.note).
const SOFT = {
  no_match: { rule: 'page.element-soft', category: 'PAGE_ELEMENT', text: 'No visible element contains "…".' },
  covered: { rule: 'page.element-soft', category: 'PAGE_ELEMENT', text: 'Warning: the point was covered by another element.' },
  wait_timeout: { rule: 'page.element-soft', category: 'PAGE_ELEMENT', text: 'Text "…" did not appear within 30s.' },
  auto_click_failed: { rule: 'page.element-soft', category: 'PAGE_ELEMENT', text: 'auto-click failed.' },
  dom_click_fallback: { rule: 'gap.dom-click', category: 'TABHELM_GAP', text: 'DOM click: iframe position unknown.' },
};
const MK_SOFT = new Set(['no_match', 'wait_timeout', 'covered']);

const W = { 1: 16, 2: 8, 3: 4, 4: 2, 5: 1 };
const STATUS_F = { open: 1, regressed: 1, recovered: 0.5, probably_fixed: 0.1, hidden: 0.05 };
// Findings about stored state rather than events: "fixed" makes no sense for them.
const STATEFUL_RULES = new Set(['inv.too-big', 'inv.index-desync', 'inv.test-chats', 'inv.version-mismatch', 'log.pairing-codes']);
const STATE_CAP = 500;
const RESERVED_SKILLS = new Set(['diagnose', 'report', 'new', 'export', 'pause']);

// ---------------------------------------------------------------- helpers

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const present = (x) => x !== null && x !== undefined && x !== '';
const uniq = (xs) => [...new Set(xs.filter(present).map(String))].sort(cmp);
const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  const ms = typeof v === 'number' ? v : v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

const isoOf = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
const textOf = (v) => (typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim());
const isSelfTool = (tool) => typeof tool === 'string' && tool.startsWith('tabhelm_');

// A word that may be (part of) a host name: hideSites aliases a host only when
// it is whole, so the cut must never split one ("portal.privatbank…").
const HOSTISH_RE = /[\p{L}\p{N}-]\.[\p{L}\p{N}]/u;

// norm() cut to maxMessage at a word that is not a host: a host the cut would
// split is left out whole. Text cut upstream (host.log lines) loses a host-like
// word right before its ellipsis the same way. `cut`: the text is known to have
// been cut upstream, so its last word goes whatever it looks like — "privatbank…"
// has lost the dot that would show it is part of a host.
function normMessage(text, secrets = [], { cut = false } = {}) {
  const s = norm(text, { secrets, max: Infinity });
  if (s.length <= TH.maxMessage) {
    const tail = (cut ? /(\S+)…?$/ : /(\S+)…$/).exec(s);
    return tail && (cut || HOSTISH_RE.test(tail[1]) || /[\p{L}\p{N}]\.$/u.test(tail[1])) ? `${s.slice(0, tail.index).trimEnd()}…` : s;
  }
  let end = TH.maxMessage - 1;
  // Never leave half of a surrogate pair before the ellipsis.
  if (/[\uD800-\uDBFF]/.test(s[end - 1])) end -= 1;
  const start = s.lastIndexOf(' ', end - 1) + 1;
  const stop = s.indexOf(' ', end);
  // Redaction can make the text longer, so this cut may fall in that last word too.
  if (s[end] !== ' ' && ((cut && stop < 0) || HOSTISH_RE.test(s.slice(start, stop < 0 ? s.length : stop)))) return `${s.slice(0, start).trimEnd()}…`;
  return `${s.slice(0, end)}…`;
}

// Texts TabHelm stores cut to a fixed length: host.log lines (log-digest.js,
// 160 with "…"), panel and service-worker errors (200), failed agent tools (300).
// At that length the end may be part of a host; one short of it allows for a
// surrogate pair the cut stepped back from.
const wasCut = (text, limit) => typeof text === 'string' && text.length >= limit - 1;

function groupBy(xs, keyOf) {
  const m = new Map();
  for (const x of xs) {
    const k = keyOf(x);
    const list = m.get(k);
    if (list) list.push(x);
    else m.set(k, [x]);
  }
  return m;
}

const distinct = (xs) => new Set(xs.filter(present)).size;

// Most frequent value; ties go to the one seen first, which is deterministic
// because every list here is built in sorted chat and journal order.
function mostCommon(xs) {
  const counts = new Map();
  for (const x of xs) if (present(x)) counts.set(x, (counts.get(x) || 0) + 1);
  let best = null;
  let n = 0;
  for (const [x, c] of counts) {
    if (c > n) {
      best = x;
      n = c;
    }
  }
  return best;
}

function minMax(values) {
  let lo = null;
  let hi = null;
  for (const v of values) {
    if (v === null) continue;
    if (lo === null || v < lo) lo = v;
    if (hi === null || v > hi) hi = v;
  }
  return [lo, hi];
}

// Numeric dotted versions; an unknown side compares equal, so it never makes
// a finding hidden, regressed or fixed on its own.
function cmpVersion(a, b) {
  if (!a || !b) return 0;
  const pa = String(a).split(/[.+-]/);
  const pb = String(b).split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = Number(x);
    const ny = Number(y);
    const d = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : cmp(x, y);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

const sortVersions = (vs) => [...new Set(vs.filter(present).map(String))].sort((a, b) => cmpVersion(a, b) || cmp(a, b));

function versionAt(history, ms) {
  if (ms === null) return null;
  let best = null;
  for (const h of history) if (h.at <= ms) best = h.v;
  return best;
}

function cleanHistory(list) {
  return (Array.isArray(list) ? list : [])
    .map((h) => ({ v: h && present(h.v) ? String(h.v) : null, at: toMs(h?.at) }))
    .filter((h) => h.v && h.at !== null)
    .sort((a, b) => a.at - b.at || cmpVersion(a.v, b.v));
}

// Journal entries worth reading, as [index, entry]; very long chats keep their
// newest entries.
function entriesOf(chat) {
  const j = Array.isArray(chat?.journal) ? chat.journal : [];
  const out = [];
  for (let i = Math.max(0, j.length - TH.maxEntriesPerChat); i < j.length; i++) {
    const e = j[i];
    if (e && typeof e === 'object' && typeof e.type === 'string') out.push([i, e]);
  }
  return out;
}

function chatFacts(chat, entries) {
  return {
    id: chat?.id ?? null,
    host: hostOf(typeof chat?.url === 'string' ? chat.url : ''),
    agent: typeof chat?.agent === 'string' && chat.agent ? chat.agent : null,
    // A schedule cannot answer confirmations, so "The user declined" there is not the user.
    scheduled: Boolean(chat?.scheduled) || entries.some(([, e]) => e.type === 'notice' && /^Scheduled run of "/.test(textOf(e.text))),
    connected: entries.filter(([, e]) => e.type === 'agent_connected'),
    models: entries.filter(([, e]) => e.type === 'model'),
  };
}


// The critic's reason in a confirm it asked (policy.js writes "<action>\n\nCritic:
// <reason>"), or null. Only the critic's own card counts: another card's detail
// holds the page title and URL, which may read "Critic: …" too. The reason is
// the last "Critic:": the action label before it holds typed text.
function criticReason(e) {
  if (e.type !== 'confirm' || typeof e.detail !== 'string' || !/^The action critic\b/i.test(textOf(e.title))) return null;
  const m = /^[\s\S]*(?:^|\n)Critic:[ \t]*([\s\S]*)$/.exec(e.detail);
  return m ? textOf(m[1]) : null;
}

// TabHelm's own words when the critic could not answer (critic.js, background.js);
// a model's reason that merely mentions them is the model's text, not a setup problem.
const CRITIC_DOWN_RE = /^critic (?:unavailable|timed out)\b/;

// The error text an entry carries, with its event source, or null.
function rawError(e) {
  switch (e.type) {
    case 'action':
      return e.ok === false && !isSelfTool(e.tool) ? { source: 'A', text: textOf(e.error), tool: e.tool || null } : null;
    case 'agent':
      return e.failure && e.failure !== 'panel closed' ? { source: 'F', text: textOf(e.failure), tool: null } : null;
    case 'notice':
      return e.error ? { source: 'N', text: textOf(e.text), tool: null } : null;
    case 'page_script':
      return e.ok === false ? { source: 'P', text: textOf(e.error), tool: null } : null;
    case 'agent_tool':
      return e.browser && e.ok === false ? { source: 'T', text: textOf(e.error), tool: browserToolOf(e.title) } : null;
    case 'confirm': {
      const reason = criticReason(e);
      return reason !== null ? { source: 'C', text: reason, tool: null } : null;
    }
    default:
      return null;
  }
}

const classifyRaw = (raw, facts) => classify(raw.text, { source: raw.source, tool: raw.tool, scheduled: facts.scheduled });

// ---------------------------------------------------------------- test chats

const LOCAL_TEST_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Automated test runs (e2e servers on ephemeral ports, temp folders) must not
// count as the user's problems.
export function isTestChat(chat) {
  if (!chat || typeof chat !== 'object') return false;
  if (chat.test === true) return true;
  const folder = typeof chat.folder === 'string' ? chat.folder : chat.folder?.path;
  if (typeof folder === 'string' && folder.startsWith('/tmp/tabhelm-')) return true;
  if (typeof chat.url === 'string') {
    try {
      const u = new URL(chat.url);
      if (/^https?:$/.test(u.protocol) && LOCAL_TEST_HOSTS.has(u.hostname) && Number(u.port) >= 32768) return true;
    } catch {}
  }
  return (Array.isArray(chat.journal) ? chat.journal : []).some((e) => e?.type === 'video' && typeof e.path === 'string' && e.path.includes('/tmp/tabhelm-e2e-'));
}

// ---------------------------------------------------------------- turns

function newTurn(facts, id, instrumented) {
  return {
    chatId: facts.id, id, key: `${facts.id}#${instrumented ? 't' : 'l'}${id}`, instrumented,
    start: null, end: null, agent: null, model: null, host: null, stopReason: null, ms: null,
    outcome: null, approximate: false, version: null,
    actions: [], skillReads: [], firstFailIdx: null, complaintNext: false,
    // Local only, never returned.
    entries: [], errors: [], failure: null, waitedOnUser: false, inProgress: false,
  };
}

// Splits a chat into turns (one user request each) and decides how each ended.
// Instrumented chats carry turn ids; older chats are split at user messages.
// `digest` (host.log) explains turns whose outcome was never written.
export function segmentTurns(chat, digest = null, { versionHistory = [] } = {}) {
  const entries = entriesOf(chat);
  const facts = chatFacts(chat, entries);
  const turns = [];
  const byId = new Map();
  let cur = null;
  let numbered = false;
  let ordinal = 0;
  for (const pair of entries) {
    const e = pair[1];
    const tid = typeof e.turn === 'number' && Number.isFinite(e.turn) ? e.turn : null;
    if (tid !== null) {
      numbered = true;
      let t = byId.get(tid);
      if (!t) {
        t = newTurn(facts, tid, true);
        byId.set(tid, t);
        turns.push(t);
        cur = t;
      }
      t.entries.push(pair);
      continue;
    }
    if (!numbered && e.type === 'user' && !e.queued) {
      cur = newTurn(facts, ++ordinal, false);
      turns.push(cur);
    }
    if (cur) cur.entries.push(pair);
  }
  const history = cleanHistory(versionHistory);
  for (const t of turns) describeTurn(t, facts, chat, digest, history);
  for (let i = 0; i < turns.length; i++) turns[i].complaintNext = complainedAfter(turns[i], turns[i + 1]);
  return turns;
}

function describeTurn(t, facts, chat, digest, history) {
  const { entries } = t;
  const lastIdx = entries.at(-1)[0];
  t.start = entries[0][1].ts ?? null;
  t.end = entries.at(-1)[1].ts ?? null;
  let lastAgent = null;
  let lastAgentIdx = -1;
  let prevAgentIdx = -1;
  for (const [idx, e] of entries) {
    const raw = rawError(e);
    const cls = raw?.text ? classifyRaw(raw, facts) : null;
    if (cls) t.errors.push({ idx, source: raw.source, category: cls.category, rule: cls.rule });
    if (e.type === 'action' && !isSelfTool(e.tool)) t.actions.push(actionOf(idx, e, cls, facts));
    if (e.type === 'action' && e.tool === 'skill_read' && e.ok !== false && present(e.args?.name)) t.skillReads.push({ name: String(e.args.name), idx });
    if (e.type === 'ask' || e.type === 'confirm' || e.type === 'permission') t.waitedOnUser = true;
    if (e.type === 'agent') {
      prevAgentIdx = lastAgentIdx;
      lastAgent = e;
      lastAgentIdx = idx;
    }
  }
  t.agent = lastAgent?.agent || mostCommon(t.actions.map((a) => a.agent)) || latestBefore(facts.connected, lastIdx)?.agent || facts.agent;
  t.model = lastAgent?.model || [...facts.models].reverse().find(([i, e]) => i <= lastIdx && (!e.agent || e.agent === t.agent))?.[1].model || null;
  t.host = mostCommon(t.actions.map((a) => a.host)) || facts.host;
  t.stopReason = lastAgent?.stopReason ?? null;
  t.failure = lastAgent?.failure ?? null;
  const span = toMs(t.end) - toMs(t.start);
  t.ms = typeof lastAgent?.stats?.ms === 'number' ? lastAgent.stats.ms : Number.isFinite(span) ? span : null;
  t.version = latestBefore(facts.connected.filter(([, e]) => present(e.ext)), lastIdx)?.ext ?? versionAt(history, toMs(t.start));
  const firstFail = t.errors.find((x) => FAIL_SOURCES.has(x.source) && !EXPECTED_CATS.has(x.category));
  t.firstFailIdx = firstFail ? firstFail.idx : null;
  Object.assign(t, outcomeOf(t, chat, digest, lastAgent, lastAgentIdx, prevAgentIdx));
}

function actionOf(idx, e, cls, facts) {
  return {
    idx, ts: e.ts ?? null, tool: String(e.tool || ''), ok: e.ok !== false,
    rule: cls?.rule || null, category: cls?.category || null,
    argsHash: stableHash(e.args ?? null), argKeys: argKeys(e.args), note: e.note || null, label: e.label || null,
    // Local only.
    host: e.host || facts.host, agent: e.agent || null, args: e.args, emptyError: e.ok === false && !textOf(e.error),
  };
}

const latestBefore = (pairs, idx) => {
  let found = null;
  for (const [i, e] of pairs) if (i <= idx) found = e;
  return found;
};

// How the turn ended (spec 6.5, first match wins).
function outcomeOf(t, chat, digest, agent, agentIdx, prevAgentIdx) {
  const { entries } = t;
  if (entries.some(([, e]) => e.type === 'agent' && e.failure === 'panel closed')) return { outcome: 'panel_closed', approximate: false };
  if (agent) {
    const stopped = entries.some(([, e]) => e.type === 'notice' && /^Stopped\.?$/.test(textOf(e.text)));
    // A note typed while the agent works interrupts it; older journals show
    // that only as a queued message right before a quiet agent entry.
    const interrupted = agent.stopReason === undefined && entries.some(([i, e]) => i > prevAgentIdx && i < agentIdx && e.type === 'user' && e.queued);
    if (agent.stopReason === 'cancelled' || (!agent.failure && (stopped || interrupted))) return { outcome: 'cancelled', approximate: false };
    if (agent.failure) {
      const own = t.errors.find((x) => x.idx === agentIdx && x.source === 'F');
      const before = t.errors.filter((x) => x.idx < agentIdx && x.source !== 'F' && x.source !== 'C').at(-1);
      // The failure itself decides; an earlier decline counts only when the
      // failure says nothing ("Agent exited" after a refused upload is a crash).
      const declined = own?.category === 'USER_DECISION' || ((!own || own.category === 'UNCLASSIFIED') && before?.category === 'USER_DECISION');
      return { outcome: declined ? 'declined' : 'failed', approximate: false };
    }
    return { outcome: 'ok', approximate: false };
  }
  const userIdx = entries.find(([, e]) => e.type === 'user')?.[0] ?? entries[0][0];
  const connected = entries.some(([i, e]) => i > userIdx && e.type === 'agent_connected');
  // A start that failed leaves the user entry and an error notice, no agent
  // entry and no step: any real error then ("Cannot list … models", a 429) is why.
  const worked = entries.some(([i, e]) => i > userIdx && (e.type === 'action' || e.type === 'agent_tool'));
  const startError = !worked && t.errors.some((x) => x.source === 'N' && !EXPECTED_CATS.has(x.category));
  if (!connected && (startError || t.errors.some((x) => START_FAIL_CATS.has(x.category)))) return { outcome: 'start_failed', approximate: false };
  const joined = logJoin(t, chat, digest);
  if (joined) return { outcome: joined, approximate: true };
  return { outcome: t.instrumented ? 'unknown' : 'legacy_unknown', approximate: false };
}

function logJoin(t, chat, digest) {
  const events = Array.isArray(digest?.events) ? digest.events : [];
  const tab = Number(chat?.tabId);
  const start = toMs(t.start);
  const end = toMs(t.end);
  if (!events.length || !Number.isFinite(tab) || start === null || end === null) return null;
  const inWindow = events.filter((ev) => {
    const ms = toMs(ev?.ts);
    return ms !== null && ms >= start - 5000 && ms <= end + TH.logJoinMs;
  });
  if (inWindow.some((ev) => ev.tabId === tab && (ev.kind === 'prompt_failed' || (ev.kind === 'agent_exit' && abnormalExit(ev, events))))) return 'crashed';
  if (inWindow.some((ev) => ev.kind === 'ext_disconnected')) return 'panel_closed';
  return null;
}

// Exit 0/130/143/SIGTERM/SIGINT, or any exit right after TabHelm stopped the
// agent (dispose() SIGKILLs 3 s after SIGTERM) or the extension went away.
function abnormalExit(ev, events) {
  if (NORMAL_EXITS.has(String(ev.code))) return false;
  const ms = toMs(ev.ts);
  return !events.some((o) => {
    if (!(o?.kind === 'ext_disconnected' || (o?.kind === 'stopping_agent' && o.tabId === ev.tabId))) return false;
    const at = toMs(o.ts);
    return at !== null && ms >= at && ms - at <= TH.normalExitAfterStopMs;
  });
}

function complainedAfter(t, next) {
  const u = next?.entries.find(([, e]) => e.type === 'user')?.[1];
  if (!u) return false;
  const gap = toMs(u.ts) - toMs(t.end);
  return Number.isFinite(gap) && gap >= 0 && gap <= TH.mk.correctionWindowMs && COMPLAINT_RE.test(textOf(u.text));
}

// ---------------------------------------------------------------- events

// Every error a chat recorded, classified and normalized (spec 6.6), with
// copies of one error collapsed (dedupe). Soft notes come back with soft: true.
export function extractEvents(chat, turns = [], { secrets = [] } = {}) {
  const entries = entriesOf(chat);
  const facts = chatFacts(chat, entries);
  const turnOf = new Map();
  for (const t of turns) for (const [idx] of t.entries || []) turnOf.set(idx, t);
  const events = [];
  for (const [idx, e] of entries) {
    const t = turnOf.get(idx) || null;
    const base = {
      chatId: facts.id, idx, ts: e.ts ?? null, turn: t ? t.id : null, turnKey: t ? t.key : null,
      agent: e.agent || t?.agent || facts.agent, model: t?.model ?? null, version: t?.version ?? null,
    };
    if (e.type === 'panel_error') {
      const text = textOf(e.message) || 'unknown error';
      events.push({
        ...base, source: 'E', tool: null, host: facts.host, raw: text, inner: text, norm: normMessage(text, secrets, { cut: wasCut(e.message, 200) }),
        category: 'TABHELM_BUG', rule: 'rt.panel-error', confidence: 'high', code: null, severity: e.where === 'replay' ? 1 : 2, owner: 'tabhelm',
        frame: e.frame || null, where: e.where || null, entryType: e.entryType || null, soft: false, recovered: null,
      });
      continue;
    }
    if (e.type === 'agent_exit') {
      const code = present(e.code) ? String(e.code) : present(e.signal) ? String(e.signal) : null;
      events.push({
        ...base, source: 'X', tool: null, host: t?.host || facts.host, raw: null, inner: null, norm: norm(`Agent exited (${code ?? 'unknown'})`),
        category: 'AGENT_CRASH', rule: 'health.crash', confidence: 'high', code: null, severity: e.code === 0 ? 3 : 2, owner: 'agent',
        frame: null, exitCode: code, quit: e.code === 0 || e.code === '0', soft: false, recovered: null,
      });
      continue;
    }
    if (e.type === 'action' && SOFT[e.note] && !isSelfTool(e.tool)) {
      const s = SOFT[e.note];
      events.push({
        ...base, source: 'S', tool: e.tool || null, host: e.host || facts.host, raw: null, inner: null, norm: norm(s.text),
        category: s.category, rule: s.rule, confidence: 'medium', code: null, severity: 4, owner: ownerFor(s.category, s.rule),
        frame: null, note: e.note, soft: true, recovered: null,
      });
    }
    const raw = rawError(e);
    if (!raw?.text) continue;
    const c = classifyRaw(raw, facts);
    // A confirm detail matters only when the critic itself was unavailable.
    if (raw.source === 'C' && (c.rule !== 'setup.critic' || !CRITIC_DOWN_RE.test(raw.text))) continue;
    events.push({
      ...base, source: raw.source, tool: raw.tool, host: (raw.source === 'A' && e.host) || t?.host || facts.host,
      raw: raw.text, inner: c.inner, norm: normMessage(c.inner, secrets, { cut: raw.source === 'T' && wasCut(e.error, 300) }),
      category: c.category, rule: c.rule, confidence: c.confidence, code: c.code, severity: c.severity, owner: c.owner,
      frame: e.frame || null, soft: false, recovered: null,
    });
  }
  return collapseCrashes(dedupe(events));
}

// The panel ends a failed task with the agent's failure and an error notice
// whose texts differ ("host disconnected" / "Cannot reach the TabHelm host: …"):
// one rule in one turn is one error.
const endTwins = (a, b) => a.turnKey !== null && a.turnKey === b.turnKey && a.rule === b.rule && a.rule !== 'unclassified'
  && (a.source === 'F' || a.source === 'N') && (b.source === 'F' || b.source === 'N');

// One error often lands twice (a host error as notice and failure, a page
// script as result and notice): equal text within 2 s from two different
// sources counts once, keeping the most specific source. Two failed actions
// with the same text are two failures, so a source never merges with itself.
function dedupe(events) {
  const out = [];
  for (const ev of events) {
    if (!SOURCE_RANK[ev.source]) {
      out.push(ev);
      continue;
    }
    const ms = toMs(ev.ts);
    let twin = null;
    for (let i = out.length - 1; i >= 0 && i >= out.length - 50; i--) {
      const o = out[i];
      if (SOURCE_RANK[o.source] && o.source !== ev.source && !o.merged?.includes(ev.source) && (o.norm === ev.norm || endTwins(o, ev)) && Math.abs(toMs(o.ts) - ms) <= TH.dedupeMs) {
        twin = o;
        break;
      }
    }
    if (!twin) out.push(ev);
    else {
      const merged = [...(twin.merged || [twin.source]), ev.source];
      if (SOURCE_RANK[ev.source] > SOURCE_RANK[twin.source]) Object.assign(twin, { ...ev, tool: ev.tool ?? twin.tool });
      else twin.tool ??= ev.tool;
      twin.merged = merged;
    }
  }
  return out;
}

// A dying agent says so several ways ("ACP connection closed", "Agent exited
// (SIGKILL)"); one crash per turn is one event, the first, closest to the cause.
function collapseCrashes(events) {
  const seen = new Map();
  return events.filter((ev) => {
    if (ev.category !== 'AGENT_CRASH' || !SOURCE_RANK[ev.source]) return true;
    const ms = toMs(ev.ts);
    const key = ev.turnKey ?? `chat:${ev.chatId}`;
    const first = seen.get(key);
    if (first !== undefined && (ev.turnKey !== null || Math.abs(ms - first) <= TH.dedupeMs)) return false;
    seen.set(key, ms);
    return true;
  });
}

// Did the agent get past a failed step? true: a later action in the turn
// worked and the turn ended well; false: the turn failed or the same error
// came 3 or more times; null: cannot tell (spec 6.6).
export function markRecovery(turns, events) {
  const byKey = new Map(turns.map((t) => [t.key, t]));
  const repeats = new Map();
  for (const ev of events) {
    if (ev.soft || ev.turnKey === null) continue;
    const k = `${ev.turnKey}|${ev.norm}`;
    repeats.set(k, (repeats.get(k) || 0) + 1);
  }
  for (const ev of events) {
    if (ev.soft) continue;
    const t = byKey.get(ev.turnKey);
    if (!t) {
      ev.recovered = null;
      continue;
    }
    if (ev.source === 'A' || ev.source === 'T' || ev.source === 'P') {
      const laterOk = t.actions.some((a) => a.idx > ev.idx && a.ok);
      const repeated = (repeats.get(`${ev.turnKey}|${ev.norm}`) || 0) >= 3;
      ev.recovered = laterOk && t.outcome === 'ok' ? true : t.outcome === 'failed' || t.outcome === 'crashed' || repeated ? false : null;
    } else {
      ev.recovered = FAILED_OUTCOMES.has(t.outcome) ? false : null;
    }
  }
  return events;
}

// ---------------------------------------------------------------- sequences

const usesRef = (a) => {
  const x = a.args;
  if (!x || typeof x !== 'object') return false;
  return present(x.ref) || present(x.fromRef) || present(x.toRef) || (Array.isArray(x.fields) && x.fields.some((f) => present(f?.ref)));
};

const navigates = (a) => a.ok && (NAV_TOOLS.has(a.tool) || (a.tool === 'browser_tabs' && (a.args?.action === 'new' || a.args?.action === 'switch')));

// Per-turn patterns: the agent going round in circles (LOOP) and refs used
// after the page changed without a fresh snapshot (IGNORED_SNAPSHOT).
export function detectSequences(turns) {
  const hits = [];
  for (const t of turns) {
    const acts = t.actions || [];
    const reasons = loopReasons(t, acts);
    if (reasons.length) hits.push({ type: 'LOOP', turn: t, reasons, idx: acts[0]?.idx ?? t.entries?.[0]?.[0] ?? null, ts: t.end });
    let nav = null;
    for (const a of acts) {
      if (navigates(a)) nav = a;
      else if (LOOK_TOOLS.has(a.tool)) nav = null;
      else if (nav && REF_TOOLS.has(a.tool) && usesRef(a)) {
        hits.push({ type: 'IGNORED_SNAPSHOT', turn: t, idx: a.idx, ts: a.ts, tool: a.tool, stale: a.rule === 'page.stale-ref' });
        nav = null;
      }
    }
  }
  return hits;
}

// Repeating a step is a loop only without progress: scrolling down a page,
// pressing ArrowDown through a list or ticking boxes one by one repeats a tool
// and works. So the repeat rules count failed calls only, and the snapshot
// share needs a turn that did not simply succeed.
function loopReasons(t, acts) {
  const reasons = [];
  const calls = new Map();
  for (const a of acts) {
    if (a.ok || SAME_CALL_EXEMPT.has(a.tool)) continue;
    const k = `${a.tool}|${a.argsHash}`;
    calls.set(k, (calls.get(k) || 0) + 1);
  }
  if ([...calls.values()].some((n) => n >= TH.loop.sameCall)) reasons.push('same_call');
  let run = 0;
  let longest = 0;
  for (let i = 0; i < acts.length; i++) {
    run = acts[i].ok ? 0 : i && !acts[i - 1].ok && acts[i].tool === acts[i - 1].tool ? run + 1 : 1;
    if (!RUN_EXEMPT.has(acts[i].tool)) longest = Math.max(longest, run);
  }
  if (longest >= TH.loop.sameToolRun) reasons.push('same_tool_run');
  if (acts.filter((a) => !a.ok).length >= TH.loop.failsPerTurn) reasons.push('many_failures');
  const snaps = acts.filter((a) => a.tool === 'browser_snapshot').length;
  const clean = t.outcome === 'ok' && acts.every((a) => a.ok && !MK_SOFT.has(a.note));
  if (!clean && acts.length > TH.loop.snapshotMinActions && snaps / acts.length > TH.loop.snapshotShare) reasons.push('snapshot_share');
  if (t.stopReason === 'max_turn_requests' || t.failure === 'stopped early (max_turn_requests)') reasons.push('max_turn_requests');
  return reasons;
}

// ---------------------------------------------------------------- hosts

// Second-level suffixes where the site name is one label further left.
const MULTI_SUFFIX = new Set([
  'com.ua', 'org.ua', 'net.ua', 'gov.ua', 'edu.ua', 'in.ua', 'kiev.ua', 'kyiv.ua',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'co.nz', 'co.il', 'co.in', 'co.za',
  'com.br', 'com.pl', 'com.tr', 'com.cn', 'com.mx', 'com.ar',
]);

// The registrable label of a host ("shop" for www.shop.com.ua), or null when
// it is too short or not a web host.
function siteLabel(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h.includes('.') || /[:/[\]]/.test(h) || /^[\d.]+$/.test(h)) return null;
  const parts = h.split('.');
  const label = MULTI_SUFFIX.has(parts.slice(-2).join('.')) && parts.length >= 3 ? parts.at(-3) : parts.at(-2);
  return label && label.length >= TH.skill.minLabel && label !== 'www' ? label : null;
}

// Does this skill look like it is about this site? Its name or description
// mentions the site's registrable label.
export function matchesHost(skill, host) {
  const label = siteLabel(host);
  if (!label || !skill) return false;
  return `${skill.name || ''} ${skill.desc ?? skill.description ?? ''}`.toLowerCase().includes(label);
}

// ---------------------------------------------------------------- findings

function evidenceOrder(a, b) {
  return (b.recovered === false) - (a.recovered === false) || (toMs(b.ts) ?? 0) - (toMs(a.ts) ?? 0) || cmp(String(a.chatId), String(b.chatId)) || (a.idx ?? 0) - (b.idx ?? 0);
}

// One Finding from a detector's description. `occ` are the occurrences (events,
// turns or actions) it counts; texts come from the taxonomy templates.
function makeFinding(A, s) {
  const occ = (s.occ || []).filter(Boolean);
  const count = s.count ?? occ.length;
  const chatIds = uniq(occ.map((o) => o.chatId));
  const turns = new Set(occ.filter((o) => present(o.chatId) && present(o.turn)).map((o) => `${o.chatId}#${o.turn}`));
  const times = occ.map((o) => toMs(o.ts)).filter((ms) => ms !== null);
  const [lo, hi] = minMax(times);
  const versions = sortVersions(occ.map((o) => o.version));
  const agents = uniq([...(s.agents || []), ...occ.map((o) => o.agent)]);
  const models = uniq(occ.map((o) => o.model));
  const tools = uniq([...(s.tools || []), ...occ.map((o) => o.tool)]);
  const hosts = uniq([...(s.hosts || []), ...occ.map((o) => o.host)]);
  const skills = uniq(s.skills || []);
  const severity = Math.min(5, Math.max(1, s.severity || 3));
  const owner = s.owner || ownerFor(s.category, s.rule);
  const message = s.message ?? null;
  const t = templateFor(s.rule, {
    tool: tools[0], host: hosts[0], message, agent: agents[0], model: models[0], count, chats: chatIds.length,
    agents: agents.length, category: s.category, scope: A.history ? 'history' : 'chat', skill: skills[0],
    ...otherAgents(A, agents[0]), ...(s.ctx || {}),
  });
  return {
    id: `f${fnv1a32(s.fingerprint)}`,
    fingerprint: s.fingerprint,
    kind: s.kind,
    category: s.category,
    rule: s.rule,
    owner,
    severity,
    confidence: s.confidence || 'high',
    title: t.title,
    explain: t.explain,
    why: s.why || `rule ${s.rule}`,
    message,
    count,
    chats: s.chats ?? chatIds.length,
    turns: turns.size,
    days: new Set(times.map((ms) => isoOf(ms).slice(0, 10))).size,
    agents, models, tools, hosts, skills,
    first: s.first ?? isoOf(lo),
    last: s.last ?? isoOf(hi),
    versions: { first: versions[0] ?? null, last: versions.at(-1) ?? null },
    // Some outcome behind it was inferred from host.log, not recorded.
    approximate: Boolean(s.approximate) || occ.some((o) => o.approximate === true),
    status: 'open',
    recovered: { yes: occ.filter((o) => o.recovered === true).length, no: occ.filter((o) => o.recovered === false).length },
    seenElsewhere: 0,
    evidence: occ.filter((o) => present(o.chatId)).sort(evidenceOrder).slice(0, TH.maxEvidence)
      .map((o) => ({ chatId: o.chatId, idx: o.idx ?? null, ts: o.ts ?? null, turn: o.turn ?? null })),
    frame: s.frame ?? null,
    code: s.code ?? null,
    ...(s.entryType ? { entryType: s.entryType } : {}),
    remedy: { type: t.remedy.type, text: t.remedy.text, actions: t.remedy.actions.map((a) => ({ ...a })) },
    isNew: false,
    problemMatch: false,
    score: 0,
  };
}

// Another installed agent to suggest: the best measured one (≥ altMinTurns
// tasks), else the first other one; installHint for the agent at fault.
function otherAgents(A, current) {
  const env = A.envAgents;
  const others = env.filter((a) => a.name !== current && a.id !== current);
  let best = null;
  for (const a of others) {
    const r = A.agentRate.get(a.name);
    if (r && r.turns >= TH.agent.altMinTurns && (!best || r.rate > best.rate)) best = { id: a.id, name: a.name, rate: r.rate };
  }
  const own = env.find((a) => a.name === current || a.id === current);
  return {
    other: best ? { id: best.id, name: best.name } : others[0] ? { id: others[0].id, name: others[0].name } : null,
    best: best ? { id: best.id, name: best.name } : null,
    installHint: own?.installHint || null,
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---- error clusters

function scopeKey(ev) {
  if (SITE_CATS.has(ev.category)) return `site:${ev.host || '-'}`;
  if (AGENT_CATS.has(ev.category)) return `agent:${ev.agent || '-'}`;
  return '*';
}

function clusterFindings(A) {
  const groups = new Map();
  for (const ev of A.events) {
    if (!CLUSTER_SOURCES.has(ev.source) || ev.covered || A.absorbed.has(ev) || ev.owner === 'expected') continue;
    // A recovered single-tab refusal is the setting doing its job.
    if (ev.rule === 'misuse.single-tab' && ev.recovered === true) continue;
    const fp = `error|${ev.rule}|${ev.tool || '-'}|${scopeKey(ev)}|${ev.norm}${ev.escalated ? `|${ev.escalated}` : ''}`;
    const list = groups.get(fp);
    if (list) list.push(ev);
    else groups.set(fp, [ev]);
  }
  const out = [];
  for (const [fp, evs] of groups) {
    const e0 = evs[0];
    const chats = distinct(evs.map((e) => e.chatId));
    // One chat where the agent got past every occurrence: a site quirk, not a finding.
    if (A.history && SITE_CATS.has(e0.category) && chats === 1 && evs.every((e) => e.recovered === true)) {
      A.sitesOnly++;
      continue;
    }
    const days = new Set(evs.map((e) => isoOf(toMs(e.ts))?.slice(0, 10)).filter(Boolean)).size;
    const recurring = chats >= TH.recurring.minChats || days >= TH.recurring.minDays;
    const unrecovered = evs.filter((e) => e.recovered === false).length;
    let severity = e0.severity;
    if (severity === 4 && recurring) severity = 3;
    if (severity === 4 && PAGE_CATS.has(e0.category) && unrecovered) severity = 3;
    if (e0.category === 'NETWORK' && severity === 3 && chats >= TH.recurring.minChats) severity = 2;
    const notes = [recurring ? 'recurring (≥ 3 chats or ≥ 2 days)' : null, unrecovered ? `${unrecovered} not recovered` : null, e0.escalated === 'hang' ? 'not waiting for the user' : null, e0.escalated === 'host-crash' ? 'within 10 s of a host crash' : null].filter(Boolean);
    const provider = /^([\w-]+) is not configured|^No model for ([\w-]+)/.exec(e0.inner || '');
    out.push(makeFinding(A, {
      fingerprint: fp, kind: 'error', category: e0.category, rule: e0.rule, owner: e0.owner, severity, confidence: e0.confidence,
      why: [`rule ${e0.rule} · ${evs.length}× in ${plural(chats, 'chat')}`, ...notes].join(' · '),
      message: e0.norm, occ: evs, frame: evs.find((e) => e.frame)?.frame ?? null, code: e0.code,
      ctx: { feature: featureOf(e0.inner)?.id, provider: provider?.[1] || provider?.[2] },
    }));
    if (e0.rule === 'unclassified') A.unclassified.push({ message: e0.norm, count: evs.length });
  }
  return out;
}

// ---- knowledge (MK-A … MK-F)

function mkDropdown(A) {
  const out = [];
  for (const [host, evs] of groupBy(A.events.filter((ev) => ev.rule === 'page.not-select' && ev.host), (ev) => ev.host)) {
    if (evs.length < TH.mk.dropdownMin) continue;
    for (const ev of evs) A.absorbed.add(ev);
    out.push(makeFinding(A, {
      fingerprint: `mk.dropdown|${host}`, kind: 'missing_knowledge', category: 'MISSING_KNOWLEDGE', rule: 'mk.dropdown', owner: 'knowledge',
      severity: 3, confidence: 'high', why: `rule mk.dropdown · page.not-select ${evs.length}× on this site (threshold ${TH.mk.dropdownMin})`,
      message: mostCommon(evs.map((e) => e.norm)), occ: evs, hosts: [host],
    }));
  }
  return out;
}

function mkRepeat(A) {
  const out = [];
  const add = (key, evs, why) => out.push(makeFinding(A, {
    fingerprint: `mk.repeat|${key}`, kind: 'missing_knowledge', category: 'MISSING_KNOWLEDGE', rule: 'mk.repeat', owner: 'knowledge', severity: 3,
    confidence: distinct(evs.map((e) => e.chatId)) >= 3 ? 'high' : 'medium', why, message: evs[0].norm, occ: evs,
  }));
  const hard = A.events.filter((ev) => MK_CATS.has(ev.category) && ev.rule !== 'misuse.single-tab' && ev.host && !A.absorbed.has(ev));
  for (const [key, evs] of groupBy(hard, (ev) => `${ev.host}|${ev.tool || '-'}|${ev.norm}`)) {
    const chats = distinct(evs.map((e) => e.chatId));
    if (evs.length < TH.mk.minEvents || chats < TH.mk.minChats) continue;
    for (const ev of evs) A.absorbed.add(ev);
    add(key, evs, `rule mk.repeat (${evs[0].rule}) · ${evs.length}× in ${chats} chats on one site (threshold ${TH.mk.minEvents} in ${TH.mk.minChats})`);
  }
  const soft = A.soft.filter((ev) => MK_SOFT.has(ev.note) && ev.host);
  for (const [key, evs] of groupBy(soft, (ev) => `${ev.host}|${ev.tool || '-'}|note:${ev.note}`)) {
    const chats = distinct(evs.map((e) => e.chatId));
    if (evs.length < TH.mk.softMin || chats < TH.mk.minChats) continue;
    add(key, evs, `rule mk.repeat (soft note ${evs[0].note}) · ${evs.length}× in ${chats} chats (threshold ${TH.mk.softMin} in ${TH.mk.minChats})`);
  }
  return out;
}

function mkNoSkill(A) {
  const evs = A.events.filter((ev) => ev.rule === 'misuse.no-skill' || ev.rule === 'setup.skill-url');
  if (!evs.length) return [];
  for (const ev of evs) A.absorbed.add(ev);
  return [makeFinding(A, {
    fingerprint: 'mk.no-skill', kind: 'missing_knowledge', category: 'MISSING_KNOWLEDGE', rule: 'mk.no-skill', owner: 'knowledge', severity: 3,
    confidence: 'high', why: `rule mk.no-skill · ${evs.length}× a skill was missing or could not be loaded`, message: mostCommon(evs.map((e) => e.norm)), occ: evs,
  })];
}

// The user had to step in: agent switch after a failure, a request for human
// help, a pause, or guide steps they skipped.
function mkHandoff(A) {
  const signals = [];
  for (const t of A.turns) {
    for (const [idx, e] of t.entries) {
      const handoff = (e.type === 'agent_switch' && present(e.reason)) || (e.type === 'ask' && e.kind === 'human') || e.type === 'pause'
        || (e.type === 'ask' && e.kind === 'guide' && /\b[1-9]\d* skipped\b/.test(textOf(e.answer)));
      if (handoff && t.host) signals.push({ chatId: t.chatId, idx, ts: e.ts ?? null, turn: t.id, agent: t.agent, model: t.model, host: t.host, version: t.version });
    }
  }
  const out = [];
  for (const [host, occ] of groupBy(signals, (s) => s.host)) {
    const chats = distinct(occ.map((o) => o.chatId));
    if (chats < TH.mk.handoffChats) continue;
    const latest = [...occ].sort(evidenceOrder)[0];
    out.push(makeFinding(A, {
      fingerprint: `mk.handoff|${host}`, kind: 'missing_knowledge', category: 'MISSING_KNOWLEDGE', rule: 'mk.handoff', owner: 'knowledge', severity: 4,
      confidence: 'medium', why: `rule mk.handoff · ${occ.length} hand-offs in ${chats} chats on one site (threshold ${TH.mk.handoffChats} chats)`,
      message: null, occ, ctx: { chatId: latest.chatId },
    }));
  }
  return out;
}

// The user's next message complained right after a failed or empty turn.
function mkCorrection(A) {
  const hits = A.turns.filter((t) => t.complaintNext && t.host && (t.outcome === 'failed' || !t.actions.length || t.actions.some((a) => !a.ok)));
  const out = [];
  for (const [host, ts] of groupBy(hits, (t) => t.host)) {
    if (ts.length < TH.mk.correctionTurns) continue;
    out.push(makeFinding(A, {
      fingerprint: `mk.correction|${host}`, kind: 'missing_knowledge', category: 'MISSING_KNOWLEDGE', rule: 'mk.correction', owner: 'knowledge', severity: 3,
      confidence: ts.length >= 4 ? 'medium' : 'low', why: `rule mk.correction · ${ts.length} complaints after failed or empty tasks on one site (threshold ${TH.mk.correctionTurns})`,
      message: null, occ: ts.map(turnOcc),
    }));
  }
  return out;
}

const turnOcc = (t) => ({
  chatId: t.chatId, idx: t.entries[0]?.[0] ?? null, ts: t.end ?? t.start, turn: t.id, agent: t.agent, model: t.model, host: t.host, version: t.version,
  recovered: FAILED_OUTCOMES.has(t.outcome) ? false : null, approximate: t.approximate,
});

// The first page action of a task was refused on about:blank or chrome://.
function mkRestrictedStart(A) {
  const occ = [];
  for (const t of A.turns) {
    const first = t.actions.find((a) => a.tool.startsWith('browser_') && a.tool !== 'browser_tabs');
    if (!first || first.ok || first.category !== 'CHROME_LIMIT') continue;
    const ev = A.eventAt.get(`${t.chatId}:${first.idx}`);
    const restricted = /^(?:about:|chrome:)/.test(first.host || '') || /\b(?:about:|chrome:\/\/)/.test(ev?.raw || '');
    if (restricted) occ.push(ev || { chatId: t.chatId, idx: first.idx, ts: first.ts, turn: t.id, agent: t.agent, tool: first.tool, host: first.host, version: t.version });
  }
  const chats = distinct(occ.map((o) => o.chatId));
  if (chats < TH.mk.restrictedChats) return [];
  return [makeFinding(A, {
    fingerprint: 'mk.restricted-start', kind: 'missing_knowledge', category: 'MISSING_KNOWLEDGE', rule: 'mk.restricted-start', owner: 'tabhelm', severity: 3,
    confidence: 'medium', why: `rule mk.restricted-start · ${chats} chats began on a page Chrome protects (threshold ${TH.mk.restrictedChats})`,
    message: mostCommon(occ.map((o) => o.norm)), occ, code: PREAMBLE_HINTS['mk.restricted-start'].code.join('; '),
  })];
}

// ---- skills

// The skills the agent had in that task (agent_connected), with descriptions
// from the current skill list; older journals fall back to that list.
function sessionSkills(A, t) {
  const withSkills = (A.connectedByChat.get(t.chatId) || []).filter(([, e]) => Array.isArray(e.skills));
  const names = latestBefore(withSkills, t.entries.at(-1)?.[0] ?? -1)?.skills;
  if (!names) return A.skills;
  return names.map((s) => {
    const name = typeof s === 'string' ? s : s?.name;
    const known = A.skills.find((k) => k.name === name);
    return { name: String(name || ''), desc: (typeof s === 'object' && s?.desc) || known?.desc || '' };
  }).filter((s) => s.name);
}

function skillFindings(A) {
  const unused = [];
  const stale = [];
  for (const t of A.turns) {
    if (t.firstFailIdx === null || !t.host) continue;
    for (const skill of sessionSkills(A, t)) {
      if (!matchesHost(skill, t.host)) continue;
      const read = t.skillReads.find((r) => r.name === skill.name && r.idx < t.firstFailIdx);
      if (!read) {
        unused.push({ ...turnOcc(t), skill: skill.name });
        continue;
      }
      for (const ev of A.eventsByTurn.get(t.key) || []) {
        if (ev.idx > read.idx && FAIL_SOURCES.has(ev.source) && !EXPECTED_CATS.has(ev.category)) stale.push({ ev, skill: skill.name, host: t.host });
      }
    }
  }
  const out = [];
  for (const [key, occ] of groupBy(unused, (o) => `${o.skill}|${o.host}`)) {
    if (occ.length < TH.skill.unusedTurns) continue;
    out.push(makeFinding(A, {
      fingerprint: `skill.unused|${key}`, kind: 'skill_unused', category: 'SKILL_UNUSED', rule: 'skill.unused', owner: 'knowledge', severity: 3, confidence: 'low',
      why: `rule skill.unused · ${occ.length} failed tasks on this site without reading the matching skill first (threshold ${TH.skill.unusedTurns})`,
      message: null, occ, skills: [occ[0].skill],
    }));
  }
  for (const [key, list] of groupBy(stale, (s) => `${s.skill}|${s.host}|${s.ev.norm}`)) {
    const evs = list.map((s) => s.ev);
    const chats = distinct(evs.map((e) => e.chatId));
    if (evs.length < TH.skill.staleEvents || chats < TH.skill.staleChats) continue;
    out.push(makeFinding(A, {
      fingerprint: `skill.stale|${key}`, kind: 'skill_stale', category: 'SKILL_STALE', rule: 'skill.stale', owner: 'knowledge', severity: 3, confidence: 'medium',
      why: `rule skill.stale · the same error ${evs.length}× in ${chats} chats after reading the skill (threshold ${TH.skill.staleEvents} in ${TH.skill.staleChats})`,
      message: evs[0].norm, occ: evs, skills: [list[0].skill], hosts: [list[0].host],
    }));
  }
  // Several skills ignored the same way: the instructions, not one skill, are at fault.
  const ignored = uniq(out.filter((f) => f.rule === 'skill.unused').flatMap((f) => f.skills));
  if (ignored.length >= 2) {
    const occ = unused.filter((o) => ignored.includes(o.skill));
    out.push(makeFinding(A, {
      fingerprint: 'preamble|skill.unused', kind: 'preamble_gap', category: 'SKILL_UNUSED', rule: 'preamble_gap', owner: 'tabhelm', severity: 3, confidence: 'low',
      why: `rule preamble_gap (skill.unused) · ${ignored.length} different skills were not read before failing`,
      message: 'Agents failed on sites with a matching skill without reading it.', occ, skills: ignored, tools: ['skill_read'],
      code: PREAMBLE_HINTS['skill.unused'].code.join('; '),
    }));
  }
  return out;
}

// ---- agents and tools

function toolStats(A) {
  const stats = new Map();
  for (const a of A.actions) {
    if (a.category && TOOL_HEALTH_SKIP.has(a.category)) continue;
    let s = stats.get(a.tool);
    if (!s) stats.set(a.tool, (s = { tool: a.tool, calls: 0, failed: 0, fails: [] }));
    s.calls++;
    if (!a.ok) {
      s.failed++;
      s.fails.push(a);
    }
  }
  return [...stats.values()].sort((a, b) => cmp(a.tool, b.tool));
}

const toolFlagged = (s) => s.calls >= TH.tool.minCalls && s.failed >= TH.tool.minFails && s.failed / s.calls >= TH.tool.minRate;

function healthTool(A) {
  const out = [];
  for (const s of toolStats(A)) {
    if (!toolFlagged(s)) continue;
    const rate = s.failed / s.calls;
    const category = mostCommon(s.fails.map((a) => a.category || 'UNCLASSIFIED'));
    const occ = s.fails.map(actionOcc(A));
    out.push(makeFinding(A, {
      fingerprint: `health.tool|${s.tool}`, kind: 'tool_health', category, rule: 'health.tool', owner: ownerFor(category), severity: rate >= TH.tool.highRate ? 2 : 3,
      confidence: 'high', why: `rule health.tool · ${s.failed} of ${s.calls} calls failed (${Math.round(rate * 100)}%) · threshold ≥ ${TH.tool.minCalls} calls, ≥ ${TH.tool.minFails} failures, ≥ ${TH.tool.minRate * 100}%`,
      message: mostCommon(occ.map((o) => o.norm)), occ, tools: [s.tool], ctx: { calls: s.calls, rate: round(rate) },
    }));
  }
  return out;
}

const actionOcc = (A) => (a) => {
  const ev = A.eventAt.get(`${a.chatId}:${a.idx}`);
  return { chatId: a.chatId, idx: a.idx, ts: a.ts, turn: a.turn, agent: a.agent || a.turnAgent, model: a.model, tool: a.tool, host: a.host, version: a.version, recovered: ev ? ev.recovered : null, norm: a.norm };
};

function agentTable(A) {
  const rows = new Map();
  for (const t of A.turns) {
    if (!ELIGIBLE.has(t.outcome) || !t.agent) continue;
    const key = `${t.agent}|${t.model ?? ''}`;
    let r = rows.get(key);
    if (!r) rows.set(key, (r = { agent: t.agent, model: t.model ?? null, turns: [], }));
    r.turns.push(t);
  }
  return [...rows.values()].sort((a, b) => cmp(a.agent, b.agent) || cmp(a.model ?? '', b.model ?? ''));
}

function healthAgent(A) {
  const out = [];
  for (const r of agentTable(A)) {
    const ok = r.turns.filter((t) => t.outcome === 'ok').length;
    const rate = ok / r.turns.length;
    if (r.turns.length < TH.agent.minTurns || rate >= TH.agent.minSuccess) continue;
    const failed = r.turns.filter((t) => t.outcome !== 'ok');
    const category = mostCommon(failed.map((t) => (A.eventsByTurn.get(t.key) || []).filter((e) => FAIL_SOURCES.has(e.source)).at(-1)?.category)) || 'AGENT_CRASH';
    const others = otherAgents(A, r.agent);
    out.push(makeFinding(A, {
      fingerprint: `health.agent|${r.agent}|${r.model ?? ''}`, kind: 'agent_health', category, rule: 'health.agent', owner: 'agent', severity: 3, confidence: 'high',
      why: `rule health.agent · ${ok} of ${r.turns.length} tasks finished (${Math.round(rate * 100)}%) · threshold ≥ ${TH.agent.minTurns} tasks, < ${TH.agent.minSuccess * 100}%`,
      message: null, occ: failed.map(turnOcc), agents: [r.agent], ctx: { rate: round(rate), best: others.best },
    }));
  }
  return out;
}

// agent_exit entries: the agent process ended in the middle of a chat.
function healthCrash(A) {
  const out = [];
  const exits = A.events.filter((ev) => ev.source === 'X');
  for (const [key, evs] of groupBy(exits, (ev) => `${ev.agent || '-'}|${ev.quit ? 'quit' : 'crash'}`)) {
    const quit = evs[0].quit;
    out.push(makeFinding(A, {
      fingerprint: `health.crash|${key}`, kind: 'agent_health', category: 'AGENT_CRASH', rule: 'health.crash', owner: 'agent', severity: quit ? 3 : 2, confidence: 'high',
      why: `rule health.crash · the agent process ${quit ? 'quit (code 0)' : 'exited'} ${evs.length}× during a chat`,
      message: mostCommon(evs.map((e) => e.norm)), occ: evs, ctx: quit ? { code: 0 } : {},
    }));
  }
  return out;
}

function loopFindings(A) {
  // Repeated failures a knowledge finding already explains (mk.dropdown, mk.repeat)
  // are that finding; the loop counts only if it remains without them.
  const explained = new Set([...A.absorbed].map((ev) => `${ev.chatId}#${ev.idx}`));
  const loops = A.sequences.filter((h) => h.type === 'LOOP' && loopReasons(h.turn, (h.turn.actions || []).filter((a) => !explained.has(`${h.turn.chatId}#${a.idx}`))).length);
  const out = [];
  for (const [key, hits] of groupBy(loops, (h) => `${h.turn.agent || '-'}|${h.turn.host || '-'}`)) {
    const reasons = uniq(hits.flatMap((h) => h.reasons));
    out.push(makeFinding(A, {
      fingerprint: `loop|${key}`, kind: 'loop', category: 'LOOP', rule: 'derived.loop', owner: 'agent', severity: 3, confidence: 'medium',
      why: `rule derived.loop · ${plural(hits.length, 'task')} (${reasons.join(', ')})`, message: null,
      occ: hits.map((h) => ({ ...turnOcc(h.turn), idx: h.idx, tool: mostCommon(h.turn.actions.map((a) => a.tool)) })),
    }));
  }
  return out;
}

function ignoredSnapshot(A) {
  const hits = A.sequences.filter((h) => h.type === 'IGNORED_SNAPSHOT');
  const out = [];
  for (const [agent, list] of groupBy(hits, (h) => h.turn.agent || '-')) {
    const chats = distinct(list.map((h) => h.turn.chatId));
    if (list.length < TH.ignoredSnapshot.minEvents || chats < TH.ignoredSnapshot.minChats) continue;
    out.push(makeFinding(A, {
      fingerprint: `ignored|${agent}`, kind: 'ignored_snapshot', category: 'IGNORED_SNAPSHOT', rule: 'derived.ignored-snapshot', owner: 'agent', severity: 4,
      confidence: list.some((h) => h.stale) ? 'high' : 'medium',
      why: `rule derived.ignored-snapshot · ${list.length}× refs used after navigating, in ${chats} chats (threshold ${TH.ignoredSnapshot.minEvents} in ${TH.ignoredSnapshot.minChats})`,
      message: null, occ: list.map((h) => ({ ...turnOcc(h.turn), idx: h.idx, ts: h.ts, tool: h.tool })),
    }));
  }
  return out;
}

// One misuse made by different agents points at TabHelm's instructions.
function preambleGaps(A) {
  const misuse = A.events.filter((ev) => ev.category === 'AGENT_MISUSE' && ev.rule !== 'misuse.single-tab' && CLUSTER_SOURCES.has(ev.source));
  const out = [];
  for (const [rule, evs] of groupBy(misuse, (ev) => ev.rule)) {
    const agents = distinct(evs.map((e) => e.agent));
    if (agents < TH.preambleGap.minAgents) continue;
    out.push(makeFinding(A, {
      fingerprint: `preamble|${rule}`, kind: 'preamble_gap', category: 'AGENT_MISUSE', rule: 'preamble_gap', owner: 'tabhelm', severity: 3, confidence: 'medium',
      why: `rule preamble_gap (${rule}) · ${agents} different agents (threshold ${TH.preambleGap.minAgents})`,
      message: mostCommon(evs.map((e) => e.norm)), occ: evs, code: PREAMBLE_HINTS[rule]?.code.join('; ') ?? null,
    }));
  }
  return out;
}

function gapDomClick(A) {
  const soft = A.soft.filter((ev) => ev.note === 'dom_click_fallback');
  const out = [];
  for (const [host, evs] of groupBy(soft, (ev) => ev.host || '-')) {
    if (evs.length < 3) continue;
    out.push(makeFinding(A, {
      fingerprint: `gap.dom-click|${host}`, kind: 'error', category: 'TABHELM_GAP', rule: 'gap.dom-click', owner: 'tabhelm', severity: 4, confidence: 'medium',
      why: `rule gap.dom-click · ${evs.length} clicks fell back to a DOM click (threshold 3)`, message: evs[0].norm, occ: evs,
    }));
  }
  return out;
}

// The critic asked about an action and the user allowed it anyway, over and
// over for one tool on one site: the critic is too strict there. A critic that
// could not answer at all is setup.critic, not strictness.
function criticFp(A) {
  const occ = [];
  for (const t of A.turns) {
    t.entries.forEach(([idx, e], k) => {
      const reason = criticReason(e);
      if (reason === null || !/^Allow/i.test(textOf(e.answer)) || CRITIC_DOWN_RE.test(reason)) return;
      const next = t.entries.slice(k + 1).find(([, x]) => x.type === 'action')?.[1];
      if (!next) return;
      occ.push({ chatId: t.chatId, idx, ts: e.ts ?? null, turn: t.id, agent: t.agent, model: t.model, tool: next.tool || null, host: next.host || t.host, version: t.version });
    });
  }
  const out = [];
  for (const [key, list] of groupBy(occ, (o) => `${o.tool || '-'}|${o.host || '-'}`)) {
    if (list.length < 3) continue;
    out.push(makeFinding(A, {
      fingerprint: `critic.fp|${key}`, kind: 'error', category: 'POLICY', rule: 'critic.fp', owner: 'setup', severity: 3, confidence: 'medium',
      why: `rule critic.fp · you allowed ${list.length} actions the critic questioned (threshold 3)`, message: null, occ: list,
    }));
  }
  return out;
}

// ---- TabHelm self-checks

// Runs the pure journal functions (replay, Markdown export, hand-over context)
// over every saved journal: a throw there is a TabHelm bug that loses data.
function probeFindings(A) {
  const P = { replayOp, mdEntry, contextText, ...(A.input.probes || {}) };
  const hits = new Map();
  const time = (ts) => String(ts ?? '');
  for (const chat of A.chats) {
    const entries = entriesOf(chat);
    const once = new Set();
    const hit = (probe, err, e, idx) => {
      const frame = topFrame(err?.stack);
      const entryType = e ? String(e.type) : 'journal';
      const fp = `probe|${probe}|${frame || '-'}|${entryType}`;
      if (once.has(fp)) return;
      once.add(fp);
      const name = err?.name || 'Error';
      const message = normMessage(`${name}: ${err?.message ?? err}`, A.secrets);
      if (!hits.has(fp)) hits.set(fp, { probe, frame, entryType, message, occ: [] });
      hits.get(fp).occ.push({ chatId: chat.id, idx, ts: e?.ts ?? entries.at(-1)?.[1].ts ?? null, turn: e?.turn ?? null, version: A.chatVersion.get(chat.id) ?? null });
    };
    for (const [idx, e] of entries) {
      try {
        P.replayOp(e);
      } catch (err) {
        hit('replay', err, e, idx);
      }
    }
    const st = { out: [], inActions: false };
    for (const [idx, e] of entries) {
      try {
        P.mdEntry(e, st, time);
      } catch (err) {
        hit('export', err, e, idx);
      }
    }
    try {
      P.contextText(entries.map(([, e]) => e));
    } catch (err) {
      hit('context', err, null, null);
    }
  }
  return [...hits.entries()].map(([fp, h]) => makeFinding(A, {
    fingerprint: fp, kind: 'probe', category: 'TABHELM_BUG', rule: `probe.${h.probe}`, owner: 'tabhelm', severity: 1, confidence: 'high',
    why: `rule probe.${h.probe} · ${h.probe === 'replay' ? 'reopening' : h.probe === 'export' ? 'exporting' : 'handing over'} ${plural(h.occ.length, 'chat')} throws on “${h.entryType}” entries`,
    message: h.message, occ: h.occ, frame: h.frame, entryType: h.entryType, ctx: { entryType: h.entryType },
  }));
}

function invariantFindings(A) {
  const out = [];
  const lost = A.turns.filter((t) => t.instrumented && t.outcome === 'unknown' && !t.inProgress);
  if (lost.length) {
    out.push(makeFinding(A, {
      fingerprint: 'inv|lost-outcome', kind: 'invariant', category: 'TABHELM_BUG', rule: 'inv.lost-outcome', owner: 'tabhelm', severity: 2, confidence: 'high',
      why: `rule inv.lost-outcome · ${plural(lost.length, 'task')} recorded no outcome`, message: null, occ: lost.map(turnOcc),
    }));
  }
  const empty = A.actions.filter((a) => a.emptyError);
  if (empty.length) {
    out.push(makeFinding(A, {
      fingerprint: 'inv|empty-error', kind: 'invariant', category: 'TABHELM_BUG', rule: 'inv.empty-error', owner: 'tabhelm', severity: 3, confidence: 'high',
      why: `rule inv.empty-error · ${plural(empty.length, 'failed step')} without an error text`, message: null, occ: empty.map(actionOcc(A)),
    }));
  }
  if (A.history) out.push(...indexDesync(A));
  const sizes = A.input.sizes && typeof A.input.sizes === 'object' ? A.input.sizes : {};
  const big = A.chats.filter((c) => Number(sizes[c.id]) > TH.backupLimitBytes);
  if (big.length) {
    const bytes = Math.max(...big.map((c) => Number(sizes[c.id])));
    out.push(makeFinding(A, {
      fingerprint: 'inv|too-big', kind: 'invariant', category: 'DATA_QUALITY', rule: 'inv.too-big', owner: 'tabhelm', severity: 2, confidence: 'high',
      why: `rule inv.too-big · ${plural(big.length, 'chat')} over ${TH.backupLimitBytes} bytes`, message: null,
      occ: big.map((c) => ({ chatId: c.id, idx: null, ts: lastEntryTs(c), version: A.chatVersion.get(c.id) ?? null })), ctx: { bytes },
    }));
  }
  const mismatch = [];
  for (const chat of A.chats) {
    for (const [idx, e] of entriesOf(chat)) {
      if (e.type === 'agent_connected' && present(e.ext) && present(e.host) && String(e.ext) !== String(e.host)) {
        mismatch.push({ chatId: chat.id, idx, ts: e.ts ?? null, turn: e.turn ?? null, agent: e.agent || null, version: String(e.ext), ext: String(e.ext), host: String(e.host) });
      }
    }
  }
  for (const [key, occ] of groupBy(mismatch, (o) => `${o.ext}|${o.host}`)) {
    out.push(makeFinding(A, {
      fingerprint: `inv|version-mismatch|${key}`, kind: 'invariant', category: 'SETUP', rule: 'inv.version-mismatch', owner: 'setup', severity: 2, confidence: 'high',
      why: `rule inv.version-mismatch · extension ${occ[0].ext}, host ${occ[0].host}`, message: null, occ, ctx: { extVersion: occ[0].ext, hostVersion: occ[0].host },
    }));
  }
  if (A.history && A.excludedTests) {
    out.push(makeFinding(A, {
      fingerprint: 'inv|test-chats', kind: 'invariant', category: 'DATA_QUALITY', rule: 'inv.test-chats', owner: 'tabhelm', severity: 4, confidence: 'high',
      why: `rule inv.test-chats · ${plural(A.excludedTests, 'chat')} from automated tests left out`, message: null, occ: [], count: A.excludedTests,
    }));
  }
  return out;
}

const lastEntryTs = (chat) => {
  const j = Array.isArray(chat?.journal) ? chat.journal : [];
  for (let i = j.length - 1; i >= 0; i--) if (j[i]?.ts) return j[i].ts;
  return null;
};

// History index and stored chats disagree.
function indexDesync(A) {
  const index = Array.isArray(A.input.index) ? A.input.index.filter((m) => m && present(m.id)) : null;
  const stored = Array.isArray(A.input.storageIds) ? new Set(A.input.storageIds.map(String)) : null;
  if (!index) return [];
  const bad = new Set();
  const indexed = new Set(index.map((m) => String(m.id)));
  if (stored) {
    for (const id of indexed) if (!stored.has(id)) bad.add(id);
    for (const id of stored) if (!indexed.has(id)) bad.add(id);
  }
  for (const m of index) {
    const chat = A.allChatsById.get(String(m.id));
    if (!chat || typeof m.messages !== 'number') continue;
    // A chat still being written is newer than its index entry; that is not a desync.
    if ((toMs(lastEntryTs(chat)) ?? 0) > (toMs(m.updated) ?? Infinity)) continue;
    if (chat.journal.filter((e) => e?.type === 'user').length !== m.messages) bad.add(String(m.id));
  }
  if (!bad.size) return [];
  const ids = [...bad].sort(cmp);
  return [makeFinding(A, {
    fingerprint: 'inv|index-desync', kind: 'invariant', category: 'TABHELM_BUG', rule: 'inv.index-desync', owner: 'tabhelm', severity: 4, confidence: 'high',
    why: `rule inv.index-desync · ${plural(ids.length, 'chat')} listed or stored inconsistently`, message: null, count: ids.length,
    occ: ids.map((id) => ({ chatId: A.chatById.has(id) ? id : null, idx: null, ts: A.chatById.has(id) ? lastEntryTs(A.chatById.get(id)) : null })),
  })];
}

function runtimeFindings(A) {
  const out = [];
  const panel = A.events.filter((ev) => ev.source === 'E');
  for (const [key, evs] of groupBy(panel, (ev) => `${ev.where === 'replay' ? 'replay' : 'window'}|${ev.frame || '-'}|${ev.norm}`)) {
    const replay = evs[0].where === 'replay';
    out.push(makeFinding(A, {
      fingerprint: `rt|panel|${key}`, kind: 'runtime', category: 'TABHELM_BUG', rule: 'rt.panel-error', owner: 'tabhelm', severity: replay ? 1 : 2, confidence: 'high',
      why: `rule rt.panel-error · ${evs.length}× ${replay ? 'while reopening a chat' : 'in the side panel'}`, message: evs[0].norm, occ: evs, frame: evs[0].frame,
      entryType: replay ? evs[0].entryType || null : null, ctx: { panel: 'panel' },
    }));
  }
  const sw = Array.isArray(A.input.swErrors) ? A.input.swErrors : [];
  const [from, to] = A.swWindow;
  const items = sw
    .filter((x) => x && present(x.message))
    .map((x) => ({ ts: x.ts ?? null, ms: toMs(x.ts), frame: x.frame || null, norm: normMessage(x.message, A.secrets, { cut: wasCut(x.message, 200) }) }))
    .filter((x) => (from === null || (x.ms !== null && x.ms >= from)) && (to === null || (x.ms !== null && x.ms <= to)))
    .sort((a, b) => (a.ms ?? 0) - (b.ms ?? 0) || cmp(a.norm, b.norm) || cmp(a.frame || '', b.frame || ''));
  for (const [key, list] of groupBy(items, (x) => `${x.frame || '-'}|${x.norm}`)) {
    const pageScripts = /^page-scripts\.js:/.test(list[0].frame || '');
    out.push(makeFinding(A, {
      fingerprint: `rt|sw|${key}`, kind: 'runtime', category: 'TABHELM_BUG', rule: 'rt.sw-error', owner: 'tabhelm', severity: pageScripts ? 3 : 2, confidence: 'high',
      why: `rule rt.sw-error · ${list.length}× in the service worker`, message: list[0].norm,
      occ: list.map((x) => ({ chatId: null, ts: x.ts, version: versionAt(A.versionHistory, x.ms) })), frame: list[0].frame, ctx: { panel: 'service worker' },
    }));
  }
  return out;
}

// ---- host log (digest groups, runs and events; spec 6.9)

const JS_ERROR_RULES = new Set(['bug.host-uncaught', 'bug.js-error']);
const frameFile = (line) => /([\w.-]+\.[cm]?js):(\d+|N)\b/.exec(String(line || ''))?.slice(1, 3).join(':') || null;

// host.log names agents by id ("claude"), journals by name ("Claude Code"):
// one name per agent keeps log and journal findings about it together.
function agentName(A, id) {
  if (!present(id)) return null;
  const known = A.envAgents.find((a) => a.id === id || a.name === id);
  return known ? known.name : String(id);
}

// Per chat, only host.log lines of this chat's tabs and time count: the agent
// tool shares a chat report without asking, and other chats reach the model
// only after the user agrees (spec 10.5). Tab-less lines (host errors) count
// when they fall in the chat's time.
function chatRelated(A, x) {
  if (A.history) return true;
  if (!x || typeof x !== 'object') return false;
  const tabs = Array.isArray(x.tabs) ? x.tabs.map(Number) : [];
  if (tabs.length && !tabs.some((t) => A.scopeTabs.has(t))) return false;
  const [from, to] = A.logWindow;
  const first = toMs(x.first);
  const last = toMs(x.last) ?? first;
  return first === null || (first <= to && last >= from);
}

function logFindings(A) {
  const d = A.digest;
  if (!d) return [];
  const out = [];
  const groups = Array.isArray(d.groups) ? d.groups.filter((g) => g && typeof g === 'object' && chatRelated(A, g)) : [];
  const fromGroups = (list, s) => {
    if (!list.length) return;
    const [first] = minMax(list.map((g) => toMs(g.first)));
    const [, last] = minMax(list.map((g) => toMs(g.last)));
    out.push(makeFinding(A, {
      kind: 'host_log', confidence: 'high', count: list.reduce((n, g) => n + (Number(g.count) || 1), 0),
      // The version of the host that wrote the line (log-digest tags each
      // group); the host running now may be newer, which is how a fixed
      // error shows up as fixed.
      occ: list.flatMap((g) => [[g.first, g.versions?.first], [g.last, g.versions?.last]].map(([ts, version]) => ({ chatId: null, ts, agent: agentName(A, g.agent), version: version ?? null }))),
      first: isoOf(first), last: isoOf(last), approximate: Boolean(d.meta?.relayMode),
      ...s,
    }));
  };
  const text = (g) => normMessage(String(g.text || ''), A.secrets, { cut: wasCut(g.text, TH.maxMessage) && /…$/.test(g.text) });
  for (const [msg, list] of groupBy(groups.filter((g) => g.kind === 'uncaught' || g.kind === 'unhandled'), (g) => text(g).replace(/^(?:uncaught|unhandled): /, ''))) {
    fromGroups(list, {
      fingerprint: `log|uncaught|${msg}`, category: 'TABHELM_BUG', rule: 'log.uncaught', owner: 'tabhelm', severity: 1,
      why: `rule log.uncaught · ${list.reduce((n, g) => n + (Number(g.count) || 1), 0)}× in host.log`, message: msg, frame: frameFile(list[0].frame), code: 'host/src/native-host.js uncaughtException',
    });
  }
  for (const g of groups.filter((x) => x.kind === 'error_handling')) {
    if (!JS_ERROR_RULES.has(classify(g.text, { source: 'L', kind: g.kind }).rule)) continue;
    fromGroups([g], {
      fingerprint: `log|error-handling|${g.code || '-'}|${text(g)}`, category: 'TABHELM_BUG', rule: 'log.error-handling', owner: 'tabhelm', severity: 2,
      why: `rule log.error-handling · a JavaScript error while handling a ${g.code || 'host'} message`, message: text(g), frame: frameFile(g.frame),
    });
  }
  for (const g of groups.filter((x) => x.kind === 'tool_error')) {
    const c = classify(g.text, { source: 'L', kind: g.kind, tool: g.code || undefined });
    const tabs = Array.isArray(g.tabs) ? g.tabs.map(Number) : [];
    const inScope = tabs.some((t) => A.scopeTabs.has(t)) || (!tabs.length && (c.owner === 'tabhelm' || c.owner === 'setup'));
    // Page-level errors without a site say nothing a journal does not; the panel records them itself.
    if (!inScope || c.owner === 'expected' || c.owner === 'site') continue;
    fromGroups([g], {
      fingerprint: `log|tool-error|${g.code || '-'}|${c.rule}|${text(g)}`, category: c.category, rule: 'log.tool-error', owner: c.owner, severity: c.severity, confidence: c.confidence,
      why: `rule log.tool-error (${c.rule}) · ${Number(g.count) || 1}× in host.log`, message: text(g), tools: g.code ? [g.code] : [], code: c.code,
    });
  }
  const stderr = groups.filter((g) => g.kind === 'agent_stderr');
  fromGroups(stderr.filter((g) => g.code === 'ENOSPC' || /ENOSPC/.test(g.text || '')), {
    fingerprint: 'log|enospc', category: 'SETUP', rule: 'log.enospc', owner: 'setup', severity: 3,
    why: 'rule log.enospc · an agent hit the file-watcher limit (ENOSPC)', message: 'ENOSPC: System limit for number of file watchers reached',
  });
  for (const [agent, list] of groupBy(stderr.filter((g) => /Authentication required/i.test(g.text || '')), (g) => agentName(A, g.agent) || '-')) {
    fromGroups(list, {
      fingerprint: `log|agent-auth|${agent}`, category: 'AUTH', rule: 'log.agent-auth', owner: 'setup', severity: 2,
      why: 'rule log.agent-auth · the agent reported that authentication is required', message: text(list[0]), agents: agent === '-' ? [] : [agent],
    });
  }
  for (const [key, list] of groupBy(stderr.filter((g) => classify(g.text, { source: 'L', kind: 'agent_stderr' }).rule === 'crash.agent-stderr'), (g) => `${agentName(A, g.agent) || '-'}|${text(g)}`)) {
    fromGroups(list, {
      fingerprint: `log|stderr-crash|${key}`, category: 'AGENT_CRASH', rule: 'crash.agent-stderr', owner: 'agent', severity: 2,
      why: 'rule crash.agent-stderr · a JavaScript error on the agent\'s stderr', message: text(list[0]), agents: list[0].agent ? [agentName(A, list[0].agent)] : [],
    });
  }
  for (const [msg, list] of groupBy(groups.filter((g) => g.kind === 'unknown_type'), text)) {
    fromGroups(list, {
      fingerprint: `log|unknown-type|${msg}`, category: 'TABHELM_BUG', rule: 'log.unknown-type', owner: 'tabhelm', severity: 3,
      why: 'rule log.unknown-type · the host got a message type it does not know', message: msg,
    });
  }
  out.push(...logAgentCrashes(A, d), ...relayOrphan(A, d));
  // Counted over the whole file, not this chat's window: a note about the
  // file for the full report, not something that went wrong in one chat.
  const codes = Number(d.meta?.pairingCodesSeen) || 0;
  if (A.history && codes > 0) {
    out.push(makeFinding(A, {
      fingerprint: 'log|pairing-codes', kind: 'host_log', category: 'DATA_QUALITY', rule: 'log.pairing-codes', owner: 'tabhelm', severity: 4, confidence: 'high',
      why: `rule log.pairing-codes · ${plural(codes, 'line')} with a pairing code`, message: null, occ: [], count: codes,
    }));
  }
  return out;
}

// Abnormal agent exits of this scope's tabs that no journal recorded.
function logAgentCrashes(A, d) {
  const events = Array.isArray(d.events) ? d.events.filter((ev) => ev && typeof ev === 'object') : [];
  const crashes = [];
  for (const ev of events) {
    if (ev.kind !== 'agent_exit' || !A.scopeTabs.has(Number(ev.tabId)) || !abnormalExit(ev, events)) continue;
    const ms = toMs(ev.ts);
    const chat = A.chats.find((c) => Number(c.tabId) === Number(ev.tabId) && ms >= (A.chatSpan.get(c.id)?.[0] ?? Infinity) - 60_000 && ms <= (A.chatSpan.get(c.id)?.[1] ?? -Infinity) + TH.logJoinMs);
    // Older journals record a crash only as a notice ("ACP connection closed",
    // "Agent exited (SIGKILL)"), so any crash event of that chat counts.
    const journaled = chat && A.events.some((x) => x.chatId === chat.id && x.category === 'AGENT_CRASH' && Math.abs(toMs(x.ts) - ms) <= 10_000);
    if (journaled) continue;
    crashes.push({ chatId: chat?.id ?? null, idx: null, ts: ev.ts, agent: agentName(A, ev.agent), version: d.meta?.hostVersion ?? null, code: present(ev.code) ? String(ev.code) : '?' });
  }
  return [...groupBy(crashes, (c) => c.agent || '-')].map(([agent, occ]) => makeFinding(A, {
    fingerprint: `log|agent-crash|${agent}`, kind: 'host_log', category: 'AGENT_CRASH', rule: 'log.agent-crash', owner: 'agent', severity: 2, confidence: 'high',
    why: `rule log.agent-crash · ${occ.length} unexpected exits (${uniq(occ.map((o) => o.code)).join(', ')}) not after a stop`,
    message: norm(`Agent exited (${occ[0].code})`), occ, approximate: true,
  }));
}

function relayOrphan(A, d) {
  const runs = (Array.isArray(d.runs) ? d.runs : []).filter((r) => r && r.kind === 'relay_retry' && Number(r.length) > TH.relayRetryRun && chatRelated(A, r));
  if (!runs.length) return [];
  const tries = runs.reduce((n, r) => n + Number(r.length), 0);
  return [makeFinding(A, {
    fingerprint: 'log|relay-orphan', kind: 'host_log', category: 'TABHELM_BUG', rule: 'log.relay-orphan', owner: 'tabhelm', severity: 3, confidence: 'high',
    why: `rule log.relay-orphan · ${tries} relay retries in a row (threshold ${TH.relayRetryRun})`, message: null, count: tries,
    occ: runs.flatMap((r) => [r.first, r.last].map((ts) => ({ chatId: null, ts, version: r.version ?? null }))),
    code: 'host/src/native-messaging.js createRelayChannel',
  })];
}

// ---- live checks (the panel right now)

function liveFindings(A) {
  const L = A.input.live;
  if (!L || typeof L !== 'object') return [];
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const out = [];
  const add = (rule, category, owner, severity, why, ctx = {}) => out.push(makeFinding(A, {
    fingerprint: `live|${rule}`, kind: 'live', category, rule, owner, severity, confidence: 'high', why, message: null, occ: [], count: 1,
    first: isoOf(A.now), last: isoOf(A.now), ctx,
  }));
  if (L.replaying === true) add('live.replay-stuck', 'TABHELM_BUG', 'tabhelm', 1, 'rule live.replay-stuck · the panel is still replaying the chat, so nothing new is saved');
  // The panel saves a chat only once it holds a user message: before that,
  // unsaved entries (a host error, a diagnosis) are by design. liveState()
  // may say so; per chat, the chat itself tells.
  const saveable = typeof L.saveable === 'boolean' ? L.saveable : A.kind !== 'chat' || !A.chats[0] || A.chats[0].journal.some((e) => e?.type === 'user');
  if (L.lastSaveError || (saveable && num(L.journalLen) > num(L.lastSavedLen) && num(L.lastEntryAgeMs) > TH.live.notSavingMs)) {
    add('live.not-saving', 'TABHELM_BUG', 'tabhelm', 1, `rule live.not-saving · ${L.lastSaveError ? 'the last save failed' : `${num(L.journalLen) - num(L.lastSavedLen)} entries not saved after ${TH.live.notSavingMs / 1000} s`}`);
  }
  const cards = Array.isArray(L.openCards) ? L.openCards.filter((c) => c && typeof c === 'object') : [];
  const lastAgent = [...A.turns].sort((a, b) => (toMs(a.end) ?? 0) - (toMs(b.end) ?? 0)).at(-1)?.agent;
  if (L.busy && cards.length) {
    add('live.waiting', 'USER_DECISION', 'expected', 3, 'rule live.waiting · a question in the chat is waiting for your answer', {
      cardKind: textOf(cards[0].kind) || 'question', cardTitle: norm(textOf(cards[0].title), { secrets: A.secrets, max: 60 }) || undefined,
    });
  } else if (L.busy && num(L.turnAgeMs) > TH.live.turnHungMs && num(L.lastEntryAgeMs) > TH.live.idleMs) {
    add('live.hung', 'TIMEOUT', 'agent', 2, `rule live.hung · busy for ${Math.round(num(L.turnAgeMs) / 60_000)} min, nothing new for ${Math.round(num(L.lastEntryAgeMs) / 60_000)} min`, {
      minutes: Math.round(num(L.lastEntryAgeMs) / 60_000), agent: lastAgent, ...otherAgents(A, lastAgent),
    });
  }
  const newest = [...A.chats].sort((a, b) => (A.chatSpan.get(a.id)[1] ?? 0) - (A.chatSpan.get(b.id)[1] ?? 0)).at(-1);
  const lastType = newest?.journal.at(-1)?.type;
  if (L.connected === false && (L.hostOffline || lastType === 'host_disconnected')) add('live.host-offline', 'HOST_LINK', 'setup', 2, 'rule live.host-offline · the panel lost the TabHelm host');
  if (L.versionMismatch) {
    const v = typeof L.versionMismatch === 'object' ? L.versionMismatch : {};
    add('live.version', 'SETUP', 'setup', 2, 'rule live.version · the host and the extension report different versions', {
      hostVersion: v.host ?? A.env.host ?? undefined, extVersion: v.ext ?? A.env.ext ?? undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------- status, score, ranking

// How often the finding's tools (or, without tools, chats) were used after it
// last happened: sorted times per tool, counted by binary search. `own` counts
// only clean uses on the finding's sites (site, knowledge) or by its agents
// (agent): a dropdown working on another site says nothing about this one.
function laterUses(A, f, own = false) {
  const after = toMs(f.last);
  const hosts = own && (f.owner === 'site' || f.owner === 'knowledge') && f.hosts.length ? new Set(f.hosts) : null;
  const agents = own && f.owner === 'agent' && f.agents.length ? new Set(f.agents) : null;
  if (hosts || agents) {
    const fits = (host, agent) => (!hosts || hosts.has(host)) && (!agents || agents.has(agent));
    if (f.tools.length) return A.actions.filter((a) => a.ok && a.ms !== null && a.ms > after && f.tools.includes(a.tool) && fits(a.host, a.agent || a.turnAgent)).length;
    return A.chats.filter((c) => (A.chatSpan.get(c.id)?.[0] ?? -Infinity) > after && fits(hostOf(typeof c.url === 'string' ? c.url : ''), c.agent)).length;
  }
  if (!A.toolTimes) {
    A.toolTimes = new Map();
    for (const a of A.actions) if (a.ms !== null) (A.toolTimes.get(a.tool) || A.toolTimes.set(a.tool, []).get(a.tool)).push(a.ms);
    for (const list of A.toolTimes.values()) list.sort((x, y) => x - y);
  }
  if (f.tools.length) return f.tools.reduce((n, tool) => n + countAfter(A.toolTimes.get(tool) || [], after), 0);
  return A.chats.filter((c) => (A.chatSpan.get(c.id)?.[0] ?? -Infinity) > after).length;
}

function countAfter(sorted, ms) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= ms) lo = mid + 1;
    else hi = mid;
  }
  return sorted.length - lo;
}

// open | recovered | probably_fixed | regressed | hidden (spec 6.12, first match).
function statusOf(A, f) {
  const st = A.state;
  const hidden = st.hidden && typeof st.hidden === 'object' ? st.hidden[f.id] : null;
  if (hidden && cmpVersion(f.versions.last, hidden.version) <= 0 && f.count < (Number(hidden.count) || 0) + TH.hideRegrowth) return 'hidden';
  const prev = st.last?.status?.[f.id];
  if (prev === 'probably_fixed' || prev === 'hidden') {
    const recorded = prev === 'hidden' && hidden?.version ? hidden.version : sortVersions(st.seen?.[f.id]?.versions || []).at(-1);
    if (cmpVersion(f.versions.last, recorded) > 0) return 'regressed';
  }
  if (f.last && f.kind !== 'live' && !STATEFUL_RULES.has(f.rule)) {
    // A TabHelm update fixes only what TabHelm or its setup owns. A site, the
    // missing knowledge or an agent changes on its own: those need 7 quiet days
    // and clean uses on the same site or by the same agent.
    const release = f.owner === 'tabhelm' || f.owner === 'setup';
    const later = laterUses(A, f, !release);
    if (release && f.versions.last && A.env.ext) {
      if (cmpVersion(f.versions.last, A.env.ext) < 0 && later >= TH.fixedLaterUses) return 'probably_fixed';
    } else if (f.owner !== 'setup' && later >= TH.fixedLaterUses && toMs(f.last) < A.now - 7 * DAY) {
      f.confidence = 'low';
      return 'probably_fixed';
    }
  }
  // Only for plain errors: a knowledge or tool-health finding is about the
  // steps the agent wastes before it recovers, so recovering does not settle it.
  if (f.kind === 'error' && f.count > 0 && f.recovered.yes / f.count >= 0.8 && f.owner !== 'tabhelm') return 'recovered';
  return 'open';
}

export function scoreFinding(f, now) {
  const lastMs = toMs(f.last);
  const nowMs = toMs(now);
  const age = lastMs === null || nowMs === null ? 0 : nowMs - lastMs;
  const recency = age <= 7 * DAY ? 1 : age <= 30 * DAY ? 0.5 : 0.25;
  const score = (W[f.severity] ?? 1)
    * (1 + Math.log2(Math.max(1, f.count || 1)))
    * (1 + Math.min(f.chats || 0, 10) / 5)
    * recency
    * (STATUS_F[f.status] ?? 1)
    * (f.recovered?.no ? 1.5 : 1)
    * (f.problemMatch ? 3 : 1);
  return round(score);
}

// Words that say nothing about which part failed ("the page does not work").
const STOP = new Set([
  'the', 'and', 'not', 'for', 'this', 'that', 'with', 'does', 'doesn', 'didn', 'work', 'working', 'works', 'again', 'try', 'bug', 'broken', 'wrong',
  'page', 'agent', 'error', 'tool', 'element', 'state', 'misuse', 'missing', 'knowledge', 'health', 'derived', 'www', 'com', 'org', 'net', 'tabhelm',
]);

function findingTerms(f) {
  const parts = [];
  for (const tool of f.tools) {
    const t = tool.replace(/^browser_/, '');
    parts.push(t, ...t.split('_'));
  }
  for (const h of f.hosts) parts.push(...h.split('.').slice(0, -1));
  parts.push(...String(f.category || '').toLowerCase().split('_'), ...String(f.rule || '').toLowerCase().split(/[._-]/), ...String(f.kind || '').split('_'));
  return parts.map((p) => p.toLowerCase()).filter((p) => p.length >= 3 && !STOP.has(p));
}

// Does the user's text ("не працює вибір розміру", "the dropdown is broken")
// point at this finding? Its words against the finding's tools, sites, rule
// and category, plus the component stems for other languages.
function problemMatcher(problem) {
  const text = String(problem || '').trim();
  if (!text) return null;
  const tokens = uniq((text.toLowerCase().match(/\p{L}[\p{L}\p{N}_-]*/gu) || []).filter((w) => (w.match(/\p{L}/gu) || []).length >= 3 && !STOP.has(w)));
  const hit = (tok, term) => tok === term || (tok.length >= 4 && term.length >= 4 && (tok.startsWith(term) || term.startsWith(tok)));
  return (f) => componentMatch(text, f) || (tokens.length > 0 && findingTerms(f).some((term) => tokens.some((tok) => hit(tok, term))));
}

const byScore = (a, b) => b.score - a.score || cmp(a.id, b.id);

// ---------------------------------------------------------------- analyze

function context(input) {
  const inp = input && typeof input === 'object' ? input : {};
  const options = { scope: 'all', chatId: null, includeTests: false, problem: '', hideSites: true, ...(inp.options || {}) };
  const kind = SCOPES.has(options.scope) ? options.scope : 'all';
  const env = inp.env && typeof inp.env === 'object' ? inp.env : {};
  const digest = inp.logDigest && typeof inp.logDigest === 'object' && !inp.logDigest.error ? inp.logDigest : null;
  return {
    input: inp, options, kind, history: kind !== 'chat',
    now: toMs(inp.now) ?? 0,
    secrets: Array.isArray(inp.secretValues) ? inp.secretValues.filter((s) => typeof s === 'string') : [],
    env,
    envAgents: (Array.isArray(env.agents) ? env.agents : [])
      .filter((a) => a && (present(a.id) || present(a.name)))
      .map((a) => ({ id: String(a.id ?? a.name), name: String(a.name ?? a.id), installHint: typeof a.installHint === 'string' ? a.installHint : null }))
      .sort((a, b) => cmp(a.id, b.id)),
    state: inp.state && typeof inp.state === 'object' ? inp.state : {},
    skills: (Array.isArray(inp.skills) ? inp.skills : [])
      .filter((s) => s && present(s.name))
      .map((s) => ({ name: String(s.name), desc: String(s.desc ?? s.description ?? '') }))
      .sort((a, b) => cmp(a.name, b.name)),
    versionHistory: cleanHistory(inp.versionHistory),
    digest,
    // Filled by ingest().
    chats: [], turns: [], events: [], soft: [], actions: [], sequences: [],
    chatById: new Map(), allChatsById: new Map(), connectedByChat: new Map(), chatSpan: new Map(), chatVersion: new Map(), eventAt: new Map(), eventsByTurn: new Map(),
    agentRate: new Map(), toolTimes: null, scopeTabs: new Set(), absorbed: new Set(), unclassified: [], sitesOnly: 0, excludedTests: 0, swWindow: [null, null], logWindow: [null, null],
  };
}

function chatSpanOf(chat) {
  const times = (Array.isArray(chat.journal) ? chat.journal : []).map((e) => toMs(e?.ts)).filter((ms) => ms !== null);
  const [lo, hi] = minMax(times);
  return [lo ?? toMs(chat.created), hi ?? toMs(chat.updated) ?? toMs(chat.created)];
}

function selectChats(A) {
  const all = (Array.isArray(A.input.chats) ? A.input.chats : []).filter((c) => c && typeof c === 'object' && present(c.id) && Array.isArray(c.journal));
  const sorted = [...all].sort((a, b) => cmp(String(a.id), String(b.id)) || cmp(JSON.stringify(a.created ?? null), JSON.stringify(b.created ?? null)));
  for (const c of sorted) if (!A.allChatsById.has(String(c.id))) A.allChatsById.set(String(c.id), c);
  let chats = A.kind === 'chat' && present(A.options.chatId) ? sorted.filter((c) => c.id === A.options.chatId) : sorted;
  const days = SCOPE_DAYS[A.kind];
  if (days) chats = chats.filter((c) => (toMs(c.updated) ?? chatSpanOf(c)[1] ?? A.now) >= A.now - days * DAY);
  // The chat being diagnosed is never left out, whatever made it.
  if (!A.options.includeTests && A.kind !== 'chat') {
    A.excludedTests = chats.filter(isTestChat).length;
    chats = chats.filter((c) => !isTestChat(c));
  }
  A.chats = chats;
}

// Turns, events and actions of every chat in scope, plus the indexes the
// detectors share.
function ingest(A) {
  selectChats(A);
  const uncaught = (A.digest?.events || []).filter((ev) => ev && (ev.kind === 'uncaught' || ev.kind === 'unhandled')).map((ev) => toMs(ev.ts)).filter((ms) => ms !== null);
  for (const chat of A.chats) {
    A.chatById.set(chat.id, chat);
    A.chatSpan.set(chat.id, chatSpanOf(chat));
    if (present(chat.tabId) && Number.isFinite(Number(chat.tabId))) A.scopeTabs.add(Number(chat.tabId));
    const turns = segmentTurns(chat, A.digest, { versionHistory: A.input.versionHistory });
    const events = extractEvents(chat, turns, { secrets: A.secrets });
    markRecovery(turns, events);
    const facts = chatFacts(chat, entriesOf(chat));
    A.connectedByChat.set(chat.id, facts.connected);
    const turnByKey = new Map(turns.map((t) => [t.key, t]));
    const crashTurns = new Set(events.filter((ev) => ev.source === 'X').map((ev) => ev.turnKey).filter(Boolean));
    for (const ev of events) {
      ev.version ??= versionAt(A.versionHistory, toMs(ev.ts));
      escalate(A, ev, turnByKey.get(ev.turnKey), facts.scheduled, uncaught);
      // History: an agent_exit entry already stands for the crash (health.crash).
      if (A.history && ev.category === 'AGENT_CRASH' && SOURCE_RANK[ev.source] && crashTurns.has(ev.turnKey)) ev.covered = true;
      if (ev.soft) A.soft.push(ev);
      else {
        A.events.push(ev);
        A.eventAt.set(`${ev.chatId}:${ev.idx}`, ev);
        if (ev.turnKey) (A.eventsByTurn.get(ev.turnKey) || A.eventsByTurn.set(ev.turnKey, []).get(ev.turnKey)).push(ev);
      }
    }
    for (const t of turns) {
      for (const a of t.actions) {
        const ev = A.eventAt.get(`${chat.id}:${a.idx}`);
        A.actions.push(Object.assign(a, { chatId: chat.id, turn: t.id, turnAgent: t.agent, model: t.model, version: t.version, ms: toMs(a.ts), norm: a.ok ? null : ev?.norm ?? normMessage(textOf(chat.journal[a.idx]?.error), A.secrets) }));
      }
    }
    A.chatVersion.set(chat.id, turns.map((t) => t.version).filter(Boolean).at(-1) ?? versionAt(A.versionHistory, A.chatSpan.get(chat.id)[1]));
    A.turns.push(...turns);
  }
  // The task running right now has no outcome yet; that is not a lost one.
  // live.chatId names the panel's chat; other chats' turns are not running here.
  if (A.input.live?.busy) {
    const liveChat = present(A.input.live.chatId) ? String(A.input.live.chatId) : null;
    const running = A.turns.filter((t) => liveChat === null || String(t.chatId) === liveChat).sort((a, b) => (toMs(a.end) ?? 0) - (toMs(b.end) ?? 0)).at(-1);
    if (running) running.inProgress = true;
    // Nor a failed start: an error notice while it works (a page script, a
    // recording) before its first step does not end it.
    if (running?.outcome === 'start_failed') {
      running.outcome = 'unknown';
      markRecovery([running], A.eventsByTurn.get(running.key) || []);
    }
  }
  A.sequences = detectSequences(A.turns);
  for (const r of agentTable(A)) {
    const cur = A.agentRate.get(r.agent) || { turns: 0, ok: 0 };
    cur.turns += r.turns.length;
    cur.ok += r.turns.filter((t) => t.outcome === 'ok').length;
    cur.rate = cur.ok / cur.turns;
    A.agentRate.set(r.agent, cur);
  }
  if (A.history) A.swWindow = [SCOPE_DAYS[A.kind] ? A.now - SCOPE_DAYS[A.kind] * DAY : null, null];
  else {
    const spans = A.chats.map((c) => A.chatSpan.get(c.id));
    const [lo] = minMax(spans.map((s) => s[0]));
    const [, hi] = minMax(spans.map((s) => s[1]));
    A.swWindow = lo === null ? [A.now, A.now] : [lo - 60_000, hi + TH.logJoinMs];
    // The panel's own chat (live state given) also owns what the host logged since its last entry.
    A.logWindow = [A.swWindow[0], A.input.live && typeof A.input.live === 'object' ? Math.max(A.swWindow[1], A.now) : A.swWindow[1]];
  }
}

// Owner overrides (spec 6.8): a timeout nobody was waiting for is a hang, and
// a lost host connection right after a host crash is that crash.
function escalate(A, ev, turn, scheduled, uncaught) {
  if (ev.soft) return;
  if (ev.category === 'TIMEOUT' && turn && !turn.waitedOnUser && !HUMAN_TOOLS.has(ev.tool) && !scheduled) {
    Object.assign(ev, { category: 'TABHELM_BUG', owner: 'tabhelm', confidence: 'medium', severity: 2, escalated: 'hang' });
  }
  const ms = toMs(ev.ts);
  if (ev.category === 'HOST_LINK' && ms !== null && uncaught.some((u) => Math.abs(u - ms) <= 10_000)) {
    Object.assign(ev, { category: 'TABHELM_BUG', owner: 'tabhelm', escalated: 'host-crash' });
  }
}

function collectFindings(A) {
  const out = [...mkDropdown(A)];
  if (A.history) out.push(...mkRepeat(A), ...mkNoSkill(A));
  out.push(...clusterFindings(A), ...loopFindings(A));
  if (A.history) {
    out.push(
      ...healthTool(A), ...healthAgent(A), ...healthCrash(A), ...ignoredSnapshot(A), ...preambleGaps(A),
      ...mkHandoff(A), ...mkCorrection(A), ...mkRestrictedStart(A), ...skillFindings(A), ...gapDomClick(A), ...criticFp(A),
    );
  }
  out.push(...probeFindings(A), ...invariantFindings(A), ...runtimeFindings(A), ...logFindings(A));
  const seen = new Set();
  return out.filter((f) => !seen.has(f.id) && seen.add(f.id));
}

// Other chats with this finding in the last full report: its chat count, less
// the chat being diagnosed when that report listed it among the evidence.
function seenElsewhere(A, seen) {
  const chats = Number(seen?.chats) || 0;
  const ids = Array.isArray(seen?.chatIds) ? new Set(seen.chatIds.map(String)) : null;
  const self = ids !== null && A.chats.some((c) => ids.has(String(c.id)));
  return Math.max(0, chats - (self ? 1 : 0));
}

function rankFindings(A, findings, { live = false } = {}) {
  const match = problemMatcher(A.options.problem);
  const lastIds = Array.isArray(A.state.last?.ids) ? new Set(A.state.last.ids) : null;
  for (const f of findings) {
    if (!live) f.status = statusOf(A, f);
    f.problemMatch = match ? Boolean(match(f)) : false;
    f.isNew = !live && lastIds !== null && !lastIds.has(f.id);
    if (!A.history) f.seenElsewhere = seenElsewhere(A, A.state.seen?.[f.id]);
    f.score = scoreFinding(f, A.now);
  }
  return findings.sort(byScore);
}

function countBy(xs, keyOf) {
  const counts = {};
  for (const k of xs.map(keyOf).filter(present).sort(cmp)) counts[k] = (counts[k] || 0) + 1;
  return counts;
}

function toolsTable(A, flagged) {
  return toolStats(A)
    .map((s) => ({ tool: s.tool, calls: s.calls, failed: s.failed, rate: s.calls ? round(s.failed / s.calls) : 0, flag: flagged.has(s.tool) ? 'flagged' : s.failed >= TH.tool.watchFails ? 'watch' : null }))
    .sort((a, b) => b.failed - a.failed || b.calls - a.calls || cmp(a.tool, b.tool));
}

function agentsTable(A) {
  return agentTable(A).map((r) => {
    const ok = r.turns.filter((t) => t.outcome === 'ok').length;
    const ms = r.turns.map((t) => t.ms).filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
    const mid = ms.length ? (ms.length % 2 ? ms[(ms.length - 1) / 2] : (ms[ms.length / 2 - 1] + ms[ms.length / 2]) / 2) : null;
    return { agent: r.agent, model: r.model, turns: r.turns.length, ok, rate: round(ok / r.turns.length), medianMs: mid === null ? null : Math.round(mid) };
  });
}

function logSection(A) {
  const d = A.input.logDigest;
  if (!d || typeof d !== 'object') return null;
  if (d.error) return { window: null, linesScanned: 0, groups: 0, truncated: false, relayMode: null, error: normMessage(String(d.error), A.secrets) };
  const m = d.meta || {};
  const related = (Array.isArray(d.groups) ? d.groups : []).filter((g) => {
    const tabs = Array.isArray(g?.tabs) ? g.tabs.map(Number) : [];
    return (!tabs.length || tabs.some((t) => A.scopeTabs.has(t))) && chatRelated(A, g);
  });
  return {
    window: m.window && typeof m.window === 'object' ? { since: m.window.since ?? null, until: m.window.until ?? null } : null,
    linesScanned: Number(m.linesScanned) || 0,
    groups: related.length,
    truncated: Boolean(m.truncated),
    relayMode: typeof m.relayMode === 'boolean' ? m.relayMode : null,
    error: null,
  };
}

function userReports(A, ranked) {
  const out = [];
  for (const chat of A.chats) {
    for (const [, e] of entriesOf(chat)) {
      if (e.type !== 'user_report') continue;
      const match = problemMatcher(e.text);
      out.push({ chatId: chat.id, ts: e.ts ?? null, matched: match ? ranked.filter((f) => match(f)).slice(0, 3).map((f) => f.id) : [] });
    }
  }
  return out.sort((a, b) => (toMs(a.ts) ?? 0) - (toMs(b.ts) ?? 0) || cmp(String(a.chatId), String(b.chatId)));
}

// The whole analysis (spec 6). Returns the Report of spec 5.4.
export function analyze(input) {
  const A = context(input);
  ingest(A);
  const ranked = rankFindings(A, collectFindings(A));
  const live = rankFindings(A, liveFindings(A), { live: true });
  const findings = ranked.slice(0, TH.maxFindings);
  const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, A.turns.filter((t) => t.outcome === o).length]));
  const unknown = outcomes.unknown + outcomes.legacy_unknown;
  const counted = A.events.filter((ev) => !ev.covered);
  const flagged = new Set(ranked.filter((f) => f.rule === 'health.tool').flatMap((f) => f.tools));
  const [firstMs] = minMax(A.chats.map((c) => A.chatSpan.get(c.id)[0]));
  const env = A.env;
  return {
    schema: 1,
    rulesetVersion: RULESET_VERSION,
    rulesetHash: RULESET_HASH,
    analyzerVersion: ANALYZER_VERSION,
    generated: isoOf(A.now),
    env: {
      ext: present(env.ext) ? String(env.ext) : null,
      host: present(env.host) ? String(env.host) : null,
      chrome: present(env.chrome) ? String(env.chrome) : null,
      platform: present(env.platform) ? String(env.platform) : null,
      features: uniq(Array.isArray(env.features) ? env.features : []),
    },
    scope: {
      kind: A.kind,
      chatId: A.kind === 'chat' ? A.options.chatId ?? A.chats[0]?.id ?? null : null,
      from: SCOPE_DAYS[A.kind] ? isoOf(A.now - SCOPE_DAYS[A.kind] * DAY) : isoOf(firstMs),
      to: isoOf(A.now),
      chats: A.chats.length,
      turns: A.turns.length,
      excludedTests: A.excludedTests,
    },
    coverage: {
      outcomes: A.turns.length ? round(1 - unknown / A.turns.length) : 1,
      instrumentedChats: A.chats.filter((c) => A.turns.some((t) => t.chatId === c.id && t.instrumented)).length,
      legacyChats: A.chats.filter((c) => !A.turns.some((t) => t.chatId === c.id && t.instrumented)).length,
      logJoined: A.turns.filter((t) => t.approximate).length,
    },
    summary: {
      outcomes,
      actions: A.actions.length,
      actionsFailed: A.actions.filter((a) => !a.ok).length,
      byOwner: countBy(ranked, (f) => f.owner),
      byCategory: countBy(counted, (ev) => ev.category),
      findings: ranked.length,
      more: ranked.length - findings.length,
      sites: A.sitesOnly,
    },
    live,
    findings,
    fixFirst: findings.filter((f) => (f.status === 'open' || f.status === 'regressed') && f.severity <= 3).slice(0, 3).map((f) => f.id),
    expected: {
      USER_DECISION: counted.filter((ev) => ev.category === 'USER_DECISION').length,
      POLICY: counted.filter((ev) => ev.category === 'POLICY').length,
      UI_INPUT: counted.filter((ev) => ev.category === 'UI_INPUT').length,
      cancelledTurns: outcomes.cancelled,
      singleTabRecovered: counted.filter((ev) => ev.rule === 'misuse.single-tab' && ev.recovered === true).length,
    },
    unclassified: A.unclassified.sort((a, b) => b.count - a.count || cmp(a.message, b.message)).slice(0, 20),
    tables: { tools: toolsTable(A, flagged), agents: agentsTable(A) },
    userReports: userReports(A, findings),
    log: logSection(A),
  };
}

// ---------------------------------------------------------------- state

function capBy(map, timeOf) {
  const ids = Object.keys(map);
  if (ids.length <= STATE_CAP) return map;
  const keep = ids.sort((a, b) => (toMs(timeOf(map[b])) ?? 0) - (toMs(timeOf(map[a])) ?? 0) || cmp(a, b)).slice(0, STATE_CAP);
  return Object.fromEntries(keep.sort(cmp).map((id) => [id, map[id]]));
}

// The selfAnalysisState after a report (spec 5.5): what was reported, and the
// history each finding id has had. A per-chat report changes nothing; only
// whole-history reports set "new" and "regressed" for the next one.
export function nextState(report, prevState) {
  const prev = prevState && typeof prevState === 'object' ? prevState : {};
  const hidden = capBy({ ...(prev.hidden && typeof prev.hidden === 'object' ? prev.hidden : {}) }, (h) => h?.at);
  const seen = { ...(prev.seen && typeof prev.seen === 'object' ? prev.seen : {}) };
  if (!report || report.scope?.kind === 'chat') return { hidden, last: prev.last ?? null, seen };
  const findings = Array.isArray(report.findings) ? report.findings : [];
  for (const f of findings) {
    const s = seen[f.id] && typeof seen[f.id] === 'object' ? seen[f.id] : {};
    const [first] = minMax([toMs(s.first), toMs(f.first)]);
    const [, last] = minMax([toMs(s.last), toMs(f.last)]);
    seen[f.id] = {
      chats: Number(f.chats) || 0,
      // The evidence chats (at most 5), so a per-chat card can leave its own chat out.
      chatIds: uniq((Array.isArray(f.evidence) ? f.evidence : []).map((e) => e?.chatId)).slice(0, TH.maxEvidence),
      first: isoOf(first),
      last: isoOf(last),
      versions: sortVersions([...(Array.isArray(s.versions) ? s.versions : []), f.versions?.first, f.versions?.last]).slice(-10),
    };
  }
  return {
    hidden,
    last: { generated: report.generated ?? null, ids: findings.map((f) => f.id), status: Object.fromEntries(findings.map((f) => [f.id, f.status])) },
    seen: capBy(seen, (s) => s?.last),
  };
}

// ---------------------------------------------------------------- skill drafts

const TOPICS = {
  'page.not-select': { slug: 'dropdowns', title: 'dropdowns', when: 'choosing options in its dropdowns' },
  'page.stale-ref': { slug: 'navigation', title: 'acting after the page changes', when: 'clicking or typing after the page changed' },
  'page.navigating': { slug: 'loading', title: 'page loading', when: 'pages are still loading' },
  'page.dialog-or-closed': { slug: 'dialogs', title: 'dialogs', when: 'a dialog blocks the page' },
};
const PITFALLS = { slug: 'pitfalls', title: 'pitfalls', when: 'steps keep failing there' };

const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);

// The successful steps after a failure in the same task: what the agent did instead.
function workedAfter(chat, idx, failed) {
  const j = Array.isArray(chat?.journal) ? chat.journal : [];
  const out = [];
  for (let i = idx + 1; i < j.length && out.length < 5; i++) {
    const e = j[i];
    if (!e || typeof e !== 'object') continue;
    if (typeof failed.turn === 'number' ? typeof e.turn === 'number' && e.turn !== failed.turn : e.type === 'user' && !e.queued) break;
    if (e.type !== 'action' || e.ok === false || isSelfTool(e.tool)) continue;
    const desc = safeDesc(e.tool, e.args, e.label, { labels: true });
    if (out.at(-1) !== desc) out.push(desc);
  }
  return out;
}

// A local skill draft for a knowledge finding (spec 6.13). Built from rule
// texts, normalized errors and value-free step descriptions — never typed
// text, option values or URLs; element labels appear because the user edits
// the draft before saving it.
export function skillDraft(finding, chats = [], { secrets = [] } = {}) {
  const f = finding && typeof finding === 'object' ? finding : {};
  const host = f.hosts?.[0] || 'this site';
  const byId = new Map((Array.isArray(chats) ? chats : []).filter((c) => c && present(c.id)).map((c) => [c.id, c]));
  const fails = [];
  for (const ev of Array.isArray(f.evidence) ? f.evidence : []) {
    const chat = byId.get(ev.chatId);
    const e = chat?.journal?.[ev.idx];
    if (!e || e.type !== 'action' || e.ok !== false) continue;
    const c = classify(textOf(e.error), { source: 'A', tool: e.tool });
    fails.push({ chat, idx: ev.idx, e, rule: c.rule, line: `${e.tool || 'a step'}: ${norm(c.inner, { secrets })}` });
  }
  const rule = f.rule === 'mk.dropdown' ? 'page.not-select' : TOPICS[f.rule] ? f.rule : mostCommon(fails.map((x) => x.rule)) || f.rule;
  const topic = TOPICS[rule] || PITFALLS;
  let name = `${siteLabel(host) || slugify(host.split('.')[0]) || 'site'}-${topic.slug}`;
  if (RESERVED_SKILLS.has(name)) name += '-skill';
  const failing = new Map();
  for (const x of fails) failing.set(x.line, (failing.get(x.line) || 0) + 1);
  if (!failing.size) failing.set(`${f.tools?.[0] || 'a step'}: ${f.message || 'fails'}`, f.count || 1);
  let worked = [];
  for (const x of fails) if (!worked.length) worked = workedAfter(x.chat, x.idx, x.e);
  const tips = uniq([TIPS[rule], ...fails.map((x) => TIPS[x.rule])]);
  const n = f.chats || distinct(fails.map((x) => x.chat.id)) || 1;
  const body = [
    `# ${host}: ${topic.title}`,
    '',
    `Learned from ${plural(n, 'chat')}.`,
    '',
    '## What fails',
    ...[...failing].map(([line, count]) => {
      // Evidence holds at most 5 steps; a single kind of failure shows the full count.
      const n = failing.size === 1 ? Math.max(count, f.count || 1) : count;
      return `- ${line}${n > 1 ? ` (×${n})` : ''}`;
    }),
    '',
    '## What worked instead',
    ...(worked.length ? worked.map((d) => `- ${d}`) : ['- (nothing recorded yet; describe the steps that work)']),
    '',
    '## Checklist',
    ...(tips.length ? tips.map((t) => `- ${t}`) : ['- Take a browser_snapshot before acting, and again after the page changes.']),
    '',
  ].join('\n');
  return { name, description: `Use on ${host} when ${topic.when}.`, body };
}
