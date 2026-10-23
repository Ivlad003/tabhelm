// End to end, the way the panel chains the self-analysis core: host.log →
// readLogWindow/digestLog (host) → analyze() with the journals → every
// renderer. The unit suites test each module against its own picture of the
// others; here real outputs feed real inputs, so a renamed field, a changed
// shape or a leak between modules fails. Run: node --test host/scripts/selfanalysis/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, nextState, skillDraft } from '../../../extension/analyzer.js';
import {
  toExport, toMarkdown, toDigest, toBugReport, toAgentTask, DIGEST_HEADER, DIGEST_FOOTER, REPORT_FOOTER,
} from '../../../extension/report-format.js';
import { classify, fnv1a32 as taxonomyFnv } from '../../../extension/taxonomy.js';
import { fnv1a32 } from '../../../extension/redact.js';
import { digestLog, readLogWindow } from '../../src/log-digest.js';
import { buildGolden, NOW } from './fixtures/gen-golden.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const LOG_FILE = join(here, 'fixtures/host.log');
const LINES = readLogWindow(LOG_FILE);
const LOG = digestLog(LINES);
const GOLDEN = buildGolden();
const SECRET = 's3cr3tValue';
const URL_WITH_PATH = /https?:\/\/\S+\/\S/;

const rules = (r) => r.findings.map((f) => f.rule);
const find = (r, rule) => r.findings.find((f) => f.rule === rule);
const run = (dataset, options = {}, extra = {}) => analyze({ ...structuredClone(dataset), now: NOW, logDigest: LOG, ...extra, options: { scope: 'all', ...options } });

// Every output a user can copy, export or send, with site names hidden and
// shown. `notes` adds the opt-in variants that carry the user's own description
// ("Include my description"), which are checked separately.
function renderAll(report, chats, { logDigest = LOG, keepHost = null, secrets = [], notes = false } = {}) {
  const out = {};
  for (const hideSites of [true, false]) {
    const opts = { hideSites, secrets };
    out[`export ${hideSites}`] = JSON.stringify(toExport(report, opts));
    out[`markdown ${hideSites}`] = toMarkdown(report, opts);
    out[`digest ${hideSites}`] = toDigest(report, opts);
    if (keepHost) out[`digest keepHost ${hideSites}`] = toDigest(report, { ...opts, keepHost });
    out[`task ${hideSites}`] = toAgentTask(report, opts);
    out[`bug ${hideSites}`] = toBugReport(null, report, chats, { ...opts, logDigest });
    out[`bug all ${hideSites}`] = toBugReport([...report.findings, ...report.live], report, chats, { ...opts, logDigest });
    if (notes) {
      out[`notes export ${hideSites}`] = JSON.stringify(toExport(report, { ...opts, includeNotes: true }));
      out[`notes markdown ${hideSites}`] = toMarkdown(report, { ...opts, includeNotes: true });
      out[`notes bug ${hideSites}`] = toBugReport(null, report, chats, { ...opts, includeNotes: true, logDigest });
    }
  }
  return out;
}

// LABEL_<n> are element labels: allowed in a local skill draft, never in an
// output. NOTE_<n> are the user's own problem descriptions: only in the
// "Include my description" variants.
function assertClean(outputs, { canary = /(?:CANARY|LABEL)_\w+/ } = {}) {
  for (const [name, text] of Object.entries(outputs)) {
    const hit = text.match(canary) || (name.startsWith('notes ') ? null : text.match(/NOTE_\w+/));
    assert.equal(hit, null, `${name} leaked ${hit?.[0]}: …${hit ? text.slice(Math.max(0, hit.index - 100), hit.index + 20) : ''}`);
    assert.ok(!text.includes(SECRET), `${name} leaked the secret value`);
    assert.ok(!text.includes('{{SECRET:'), `${name} leaked a secret name`);
    assert.doesNotMatch(text, URL_WITH_PATH, `${name} has a URL with a path`);
    assert.ok(!/\/home\/|\/Users\/|[A-Z]:\\Users/.test(text), `${name} has a home path`);
    assert.ok(!/\bundefined\b|\bNaN\b|\[object Object\]/.test(text), `${name} printed a missing value`);
  }
}

// ---------------------------------------------------------------- contracts

describe('module contracts', () => {
  test('the digest has exactly the fields the analyzer and the bug report read', () => {
    assert.deepEqual(Object.keys(LOG).sort(), ['events', 'groups', 'meta', 'runs', 'v']);
    for (const e of LOG.events) assert.deepEqual(Object.keys(e).sort(), ['agent', 'code', 'gid', 'kind', 'tabId', 'ts']);
    for (const g of LOG.groups) {
      assert.deepEqual(Object.keys(g).sort(), ['agent', 'code', 'count', 'first', 'frame', 'gid', 'kind', 'last', 'tabs', 'text', 'versions']);
      assert.deepEqual(Object.keys(g.versions).sort(), ['first', 'last']);
      assert.ok(g.frame === null || /^[\w.-]+\.[cm]?js:\d+$/.test(g.frame), `frame ${g.frame} is basename:line`);
    }
    for (const r of LOG.runs) assert.deepEqual(Object.keys(r).sort(), ['first', 'kind', 'last', 'length', 'version']);
    for (const k of ['hostVersion', 'relayMode', 'window', 'linesScanned', 'truncated', 'pairingCodesSeen']) assert.ok(k in LOG.meta, `meta.${k}`);
    assert.deepEqual(Object.keys(LOG.meta.window).sort(), ['since', 'until']);
  });

  test('every finding has the Finding fields (spec 5.3) the renderers read', () => {
    const r = run(GOLDEN.real, { includeTests: true });
    const fields = ['id', 'fingerprint', 'kind', 'category', 'rule', 'owner', 'severity', 'confidence', 'title', 'explain', 'why', 'message', 'count', 'chats',
      'turns', 'days', 'agents', 'models', 'tools', 'hosts', 'skills', 'first', 'last', 'versions', 'approximate', 'status', 'recovered', 'seenElsewhere',
      'evidence', 'frame', 'code', 'remedy', 'isNew', 'problemMatch', 'score'];
    const KINDS = new Set(['error', 'tool_health', 'agent_health', 'loop', 'ignored_snapshot', 'missing_knowledge', 'skill_unused', 'skill_stale', 'preamble_gap', 'probe',
      'invariant', 'live', 'host_log', 'runtime', 'user_report']);
    const ACTIONS = new Set(['open_settings', 'copy_command', 'skill_draft', 'skill_with_agent', 'memory_note', 'use_agent', 'open_extensions', 'copy_bug_report', 'ask_agent',
      'open_chat', 'hide', 'stop']);
    assert.ok(r.findings.length >= 10);
    for (const f of r.findings) {
      for (const k of fields) assert.ok(k in f, `${f.rule} lacks ${k}`);
      assert.ok(KINDS.has(f.kind), f.kind);
      assert.ok(['tabhelm', 'knowledge', 'agent', 'setup', 'site', 'expected'].includes(f.owner), f.owner);
      assert.ok(['open', 'recovered', 'probably_fixed', 'regressed', 'hidden'].includes(f.status), f.status);
      assert.ok(Number.isInteger(f.severity) && f.severity >= 1 && f.severity <= 5);
      assert.ok(typeof f.title === 'string' && f.title && !/undefined|null|NaN/.test(f.title), `${f.rule}: ${f.title}`);
      assert.ok(f.evidence.length <= 5 && f.evidence.every((e) => ['chatId', 'idx', 'ts', 'turn'].every((k) => k in e)));
      for (const a of f.remedy.actions) assert.ok(ACTIONS.has(a.kind), `${f.rule}: action ${a.kind}`);
    }
    assert.ok(r.fixFirst.every((id) => r.findings.some((f) => f.id === id)));
  });

  test('a joined code hint (preamble_gap) survives the export, the task and the bug report', () => {
    // Two agents making one mistake point at TabHelm's instructions (spec 6.8).
    const misuse = (id, agent, ts) => ({
      id, created: Date.parse(ts), updated: Date.parse(ts) + 60_000, tabId: 7, url: 'https://shop.example.com/a', agent,
      journal: [
        { ts, type: 'user', text: 'Go', attachments: [] },
        { ts, type: 'action', agent, tool: 'browser_click', args: { ref: 'button 3' }, ok: false, error: 'Invalid ref "button 3". Use a ref from the latest snapshot.' },
        { ts, type: 'agent', agent, model: 'm', text: '', failure: null },
      ],
    });
    const r = analyze({ chats: [misuse('p1', 'Claude Code', '2026-10-20T10:00:00.000Z'), misuse('p2', 'Codex', '2026-10-21T10:00:00.000Z')], now: NOW, options: { scope: 'all' } });
    const gap = find(r, 'preamble_gap');
    assert.equal(gap.code, 'host/src/session.js BROWSER_PREAMBLE; host/src/mcp-bridge.js tools');
    const x = toExport(r).findings.find((f) => f.rule === 'preamble_gap');
    assert.equal(x.code, gap.code);
    assert.match(toAgentTask(r), /^Code: host\/src\/session\.js BROWSER_PREAMBLE; host\/src\/mcp-bridge\.js tools$/m);
    assert.match(toBugReport(null, r, []), /code host\/src\/session\.js BROWSER_PREAMBLE; host\/src\/mcp-bridge\.js tools/);
  });

  test('the taxonomy and redact copies of fnv1a32 agree, so ids match whichever computes them', () => {
    for (const s of ['', 'a', 'foobar', 'error|page.not-select|browser_select_option|site:shop.example.com|<ref> is not a <select>', 'не працює вибір 🙂']) {
      assert.equal(taxonomyFnv(s), fnv1a32(s));
    }
  });
});

// ---------------------------------------------------------------- golden data

describe('golden datasets through every renderer', () => {
  test('default (tests excluded): host-log findings reach all outputs with their code areas', () => {
    const r = run(GOLDEN.legacy);
    assert.deepEqual(rules(r).sort(), ['inv.test-chats', 'log.agent-auth', 'log.enospc', 'log.pairing-codes', 'log.relay-orphan', 'log.uncaught', 'log.unknown-type']);
    const out = renderAll(r, GOLDEN.legacy.chats);
    assertClean(out);
    const x = toExport(r);
    assert.deepEqual(x.findings.map((f) => f.rule), rules(r));
    assert.deepEqual(x.findings.map((f) => f.id), r.findings.map((_, i) => `F${i + 1}`));
    assert.deepEqual(x.fixFirst, r.fixFirst.map((id) => `F${r.findings.findIndex((f) => f.id === id) + 1}`));
    assert.ok(out['markdown true'].startsWith('# TabHelm self-analysis report\n'));
    assert.ok(out['markdown true'].trimEnd().endsWith(REPORT_FOOTER));
    const digest = out['digest true'];
    assert.ok(digest.startsWith(`${DIGEST_HEADER}\n`) && digest.endsWith(DIGEST_FOOTER));
    assert.ok(Buffer.byteLength(digest) <= 6000);
    assert.match(digest, /\[S1 tabhelm · log\.uncaught · high\] .*"Error: write EPIPE"/);
    assert.match(out['task true'], /^Code: host\/src\/native-host\.js uncaughtException$/m);
    assert.match(out['task true'], /^Code: host\/src\/native-messaging\.js createRelayChannel$/m);
    assert.match(out['bug true'], /^- Rule: log\.uncaught \(TABHELM_BUG, S1, high confidence\)$/m);
    // The advice keeps its file name; a redacted "<path>.log" would be useless.
    assert.match(out['markdown true'], /Delete host\.log in ~\/\.tabhelm if you share this machine\./);
    assert.ok(!out['markdown true'].includes('<path>'));
  });

  test('includeTests: grouped crashes, a flag opened in Settings, fixed host errors by version', () => {
    const r = run(GOLDEN.legacy, { includeTests: true });
    const x = toExport(r);
    const off = x.findings.find((f) => f.rule === 'flag.off');
    assert.deepEqual(off.remedy.actions.map((a) => [a.kind, a.target]), [['open_settings', 'experimental:devTools']]);
    assert.equal(off.title, 'The agent tried browser_fill_form, but “Developer tools” is off');
    assert.equal(x.findings.find((f) => f.rule === 'crash.agent').count, 3);
    // host.log groups carry the version of the host that wrote them (0.31.0);
    // the extension is 0.31.1 and the chats went on, so the error is fixed.
    const epipe = find(r, 'log.uncaught');
    assert.deepEqual([epipe.versions, epipe.status], [{ first: '0.31.0', last: '0.31.0' }, 'probably_fixed']);
    const md = toMarkdown(r);
    assert.match(md.slice(md.indexOf('## Probably fixed')), /The TabHelm host crashed: Error: write EPIPE/);
    assert.doesNotMatch(toBugReport(null, r, GOLDEN.legacy.chats), /log\.uncaught/, 'a fixed bug is not reported again');
    assertClean(renderAll(r, GOLDEN.legacy.chats));
  });

  test('real use: the user\'s words move the dropdown finding up, and every output follows the ranking', () => {
    const plain = run(GOLDEN.real);
    const r = run(GOLDEN.real, { problem: 'не працює вибір розміру' });
    // ×3 for the match (spec 6.12) beats everything but the S2 crash with
    // unrecovered occurrences; in the chat where the dropdown failed it is first.
    assert.deepEqual(rules(plain).slice(0, 5), ['health.crash', 'log.uncaught', 'log.relay-orphan', 'health.tool', 'mk.dropdown']);
    assert.deepEqual(rules(r).slice(0, 2), ['health.crash', 'mk.dropdown']);
    assert.deepEqual(r.findings.filter((f) => f.problemMatch).map((f) => f.rule), ['mk.dropdown']);
    const where = GOLDEN.real.chats.find((c) => c.journal.filter((e) => e.tool === 'browser_select_option' && e.ok === false).length >= 2);
    // The panel asks the host for that chat's window of the log only.
    const window = digestLog(LINES, { since: where.created - 60_000, until: Date.parse(where.journal.at(-1).ts) + 120_000, tabIds: [where.tabId] });
    const card = run(GOLDEN.real, { scope: 'chat', chatId: where.id, problem: 'не працює вибір розміру' }, { logDigest: window });
    assert.equal(card.findings[0].rule, 'mk.dropdown');
    const x = toExport(r);
    const dd = x.findings[1];
    assert.deepEqual([dd.id, dd.rule, dd.hosts, dd.problemMatch], ['F2', 'mk.dropdown', ['site-2'], true]);
    assert.match(toDigest(r).split('\n')[4], /^F2 \[S3 knowledge · mk\.dropdown · high\] site-2: dropdowns are custom widgets/);
    assert.match(toDigest(r, { keepHost: 'shop.example.com' }), /^F2 .* shop\.example\.com: dropdowns/m);
    const memory = dd.remedy.actions.find((a) => a.kind === 'memory_note');
    assert.deepEqual([memory.host, memory.text], ['site-2', 'On site-2, dropdowns are not <select>: click the field, then click the option text.']);
    assertClean(renderAll(r, GOLDEN.real.chats, { keepHost: 'shop.example.com' }));
  });

  test('a skill draft from the real report names the site and holds no typed value', () => {
    const r = run(GOLDEN.real);
    const draft = skillDraft(find(r, 'mk.dropdown'), GOLDEN.real.chats);
    assert.equal(draft.name, 'example-dropdowns', 'the registrable label of shop.example.com');
    assert.match(draft.body, /^# shop\.example\.com: dropdowns$/m);
    assert.match(draft.body, /browser_select_option: <ref> is not a <select>/);
    const typed = GOLDEN.real.chats.flatMap((c) => c.journal).filter((e) => e.type === 'action' && e.args)
      .flatMap((e) => Object.entries(e.args).filter(([k]) => !/ref/i.test(k)).flatMap(([, v]) => [v].flat()))
      .filter((v) => typeof v === 'string' && v.length >= 3 && !/^(?:new|switch|list|close)$/.test(v));
    assert.ok(typed.length > 0, 'the dataset has typed values to look for');
    for (const v of typed) assert.ok(!draft.body.includes(v) && !draft.description.includes(v), `draft contains ${v}`);
  });
});

// ---------------------------------------------------------------- host.log joins

// Chats on the fixture log's tabs, timed against its lines: tab 41's prompt
// failed at 10:22:00, tab 42's agent was killed at 10:26:00 without a stop,
// and the host crashed (EPIPE) at 10:30:00.
function joinChats() {
  const entry = (ts, type, data = {}) => ({ ts: `2026-10-20T${ts}.000Z`, type, turn: 1, ...data });
  const connect = (ts) => entry(ts, 'agent_connected', { agent: 'Claude Code', agentId: 'claude', ext: '0.31.0', host: '0.31.0', features: ['selfAnalysis'], singleTab: false, autoApprove: false, skills: [] });
  const meta = (id, tabId, url) => ({ id, created: Date.parse('2026-10-20T10:00:00Z'), updated: Date.parse('2026-10-20T10:40:00Z'), tabId, url, agent: 'Claude Code' });
  return [
    { ...meta('join-41', 41, 'https://shop.example.com/cart'), journal: [
      entry('10:20:00', 'user', { text: 'Buy it', attachments: [] }), connect('10:20:02'),
      entry('10:20:30', 'action', { agent: 'Claude Code', tool: 'browser_select_option', args: { ref: 'e12', values: ['L'] }, ok: false, error: 'No option matching "L" in e12', host: 'shop.example.com' }),
      entry('10:20:50', 'action', { agent: 'Claude Code', tool: 'browser_click', args: { ref: 'e12' }, ok: true, host: 'shop.example.com' }),
    ] },
    { ...meta('join-42', 42, 'https://mail.example.org/inbox'), journal: [
      entry('10:25:00', 'user', { text: 'Archive', attachments: [] }), connect('10:25:02'),
      entry('10:25:30', 'action', { agent: 'Claude Code', tool: 'browser_snapshot', args: {}, ok: true, host: 'mail.example.org' }),
      entry('10:25:40', 'agent', { agent: 'Claude Code', model: 'sonnet', text: 'Done', thought: '', failure: null, stopReason: 'end_turn' }),
    ] },
    { ...meta('join-45', 45, 'https://docs.example.net/form'), journal: [
      entry('10:29:50', 'user', { text: 'Send it', attachments: [] }), connect('10:29:52'),
      entry('10:30:04', 'notice', { text: 'host disconnected', error: true }),
      entry('10:30:04', 'agent', { agent: 'Claude Code', model: 'sonnet', text: '', thought: '', failure: 'host disconnected', stopReason: null }),
    ] },
  ];
}

describe('host.log joins with the journals (digest built for the tabs in scope)', () => {
  const chats = joinChats();
  const digest = digestLog(LINES, { since: '2026-10-20T09:59:00Z', until: '2026-10-20T10:42:00Z', tabIds: chats.map((c) => c.tabId) });
  const r = analyze({ chats, now: NOW, logDigest: digest, env: GOLDEN.real.env, options: { scope: '7d' } });

  test('a turn with no recorded end is explained by the prompt failure on its tab', () => {
    assert.deepEqual([r.summary.outcomes.crashed, r.coverage.logJoined, r.summary.outcomes.unknown], [1, 1, 0]);
    assert.ok(!rules(r).includes('inv.lost-outcome'));
  });

  test('an agent killed without a stop is an agent crash, named as the journals name it', () => {
    const crash = find(r, 'log.agent-crash');
    assert.deepEqual([crash.agents, crash.count, crash.evidence[0].chatId, crash.title], [['Claude Code'], 1, 'join-42', 'Claude Code crashed 1×']);
    assert.deepEqual(crash.remedy.actions.map((a) => a.kind), ['use_agent', 'copy_command']);
  });

  test('a lost host right after a host crash is a TabHelm bug, and the bug report shows the crash line', () => {
    const lost = find(r, 'link.host');
    assert.deepEqual([lost.category, lost.owner, lost.title], ['TABHELM_BUG', 'tabhelm', 'The TabHelm host crashed and the panel lost it']);
    assert.equal(lost.count, 1, 'the notice and the failure are one error');
    const bug = toBugReport(lost, r, chats, { logDigest: digest });
    assert.match(bug, /^-4s uncaught EPIPE ×1: uncaught: Error: write EPIPE$/m);
    // The notice and the failure are both steps; the failure is the evidence.
    assert.match(bug, /^\+0s user\n\+2s agent_connected\n\+14s notice ✗ link\.host\n\+14s agent ✗ link\.host {2}←$/m);
  });

  test('a tool error of an in-scope tab becomes a finding; its site is aliased in exports', () => {
    const tool = find(r, 'log.tool-error');
    assert.deepEqual([tool.tools, tool.category], [['browser_navigate'], 'NETWORK']);
    assert.match(tool.message, /^Cannot reach shop\.example\.com for <email>: net::ERR_NAME_NOT_RESOLVED$/);
    const x = toExport(r);
    assert.match(x.findings.find((f) => f.rule === 'log.tool-error').message, /^Cannot reach site-\d+ for <email>/);
    assertClean(renderAll(r, chats, { logDigest: digest }));
  });

  test('a host frame in TabHelm code survives the digest and reaches the bug report', () => {
    const lines = [...LINES,
      '2026-10-20T10:35:00.000Z [4242] uncaught: Error: ENOENT: no such file or directory, open \'/home/ada/CANARY_F1/notes.txt\'',
      '    at Object.openSync (node:fs:573:18)',
      '    at readState (file:///home/ada/.tabhelm/app/host/src/state.js:176:9)',
    ];
    const d = digestLog(lines, { tabIds: [41] });
    const rr = analyze({ chats: chats.slice(0, 1), now: NOW, logDigest: d, env: GOLDEN.real.env, options: { scope: '7d' } });
    const f = rr.findings.find((x) => x.rule === 'log.uncaught' && /ENOENT/.test(x.message));
    assert.deepEqual([f.frame, f.message], ['state.js:176', 'Error: ENOENT: no such file or directory, open \'<path>.txt\'']);
    const bug = toBugReport(f, rr, chats, { logDigest: d });
    assert.match(bug, /^- Where: frame state\.js:176 · code host\/src\/native-host\.js uncaughtException$/m);
    assertClean({ bug, task: toAgentTask(rr), md: toMarkdown(rr) });
  });
});

// ---------------------------------------------------------------- chat scope

describe('per-chat diagnosis with live state', () => {
  const dataset = structuredClone(GOLDEN.real);
  const chat = dataset.chats.find((c) => c.journal.filter((e) => e.tool === 'browser_select_option' && e.ok === false).length >= 2);
  const digest = digestLog(LINES, { since: chat.created - 60_000, until: Date.parse(chat.journal.at(-1).ts) + 120_000, tabIds: [chat.tabId] });
  const live = { busy: true, connected: true, replaying: false, turnAgeMs: 5000, lastEntryAgeMs: 1000, journalLen: chat.journal.length, lastSavedLen: chat.journal.length,
    openCards: [{ kind: 'confirm', title: 'Allow paying CANARY_LIVE now' }] };
  const r = analyze({ ...dataset, now: NOW, logDigest: digest, live, options: { scope: 'chat', chatId: chat.id } });

  test('the chat\'s own findings, a live item, nothing about the whole history', () => {
    assert.deepEqual([r.scope.kind, r.scope.chats], ['chat', 1]);
    assert.ok(rules(r).includes('mk.dropdown'), 'two dropdown failures on one site count in one chat');
    assert.ok(!rules(r).some((x) => x === 'log.pairing-codes' || x === 'inv.test-chats' || x === 'inv.index-desync'), rules(r).join());
    assert.deepEqual(r.live.map((f) => f.rule), ['live.waiting']);
    assert.match(r.live[0].title, /^Right now: the agent is waiting for your answer: confirm “Allow paying CANARY_LIVE now”$/);
  });

  test('the waiting card is local only: no output carries its title', () => {
    const host = new URL(chat.url).hostname;
    const out = renderAll(r, [chat], { logDigest: digest, keepHost: host });
    assertClean(out);
    assert.deepEqual(toExport(r).live, []);
    assert.match(out[`digest keepHost true`], new RegExp(`^F1 .*${host.replace(/\./g, '\\.')}`, 'm'), 'the agent knows its own site');
  });

  test('a chat report leaves the history state alone; a history report updates it', () => {
    const history = analyze({ ...dataset, now: NOW, logDigest: LOG, options: { scope: 'all' } });
    const state = nextState(history, {});
    assert.deepEqual(nextState(r, state), state);
    const again = analyze({ ...dataset, now: NOW, logDigest: LOG, state, options: { scope: 'all' } });
    assert.ok(again.findings.every((f) => f.isNew === false));
    assert.deepEqual(again.findings.map((f) => f.id), history.findings.map((f) => f.id));
  });
});

// ---------------------------------------------------------------- privacy

// Every free-text field of the dataset holds CANARY_<n> (spec 12.1 item 5).
// Error texts keep their wording, which is what gets classified, and gain
// canaries only where redaction has to remove them: quoted, in a URL path and
// query, in an email, in a home path and as a key=value secret.
const KEEP = new Set(['ts', 'type', 'turn', 'tool', 'ok', 'agent', 'agentId', 'model', 'ext', 'host', 'kind', 'stopReason', 'answer', 'ref', 'fromRef', 'toRef',
  'where', 'frame', 'entryType', 'note', 'browser', 'code', 'signal', 'queued', 'source', 'features', 'action', 'size', 'id']);
const ERROR_FIELDS = { action: 'error', agent: 'failure', page_script: 'error', agent_tool: 'error', panel_error: 'message' };

function canarize(dataset) {
  let n = 0;
  const c = () => `CANARY_${++n}`;
  const tail = () => ` ("${c()}" at https://shop.example.com/${c()}?q=${c()} by ${c()}@mail.example.com in /home/ada/${c()}/notes.txt token=${c()} {{SECRET:pin}} ${SECRET})`;
  const err = (text) => {
    if (typeof text !== 'string' || !text || text === 'panel closed') return text;
    const more = text + tail();
    return classify(more).rule === classify(text).rule ? more : text;
  };
  const url = (u) => {
    try {
      const x = new URL(u);
      return `${x.protocol}//${x.host}/${c()}/x?q=${c()}&s=${c()}`;
    } catch {
      return u;
    }
  };
  const path = (p) => (typeof p === 'string' && p.startsWith('/tmp/tabhelm-') ? `${p}/${c()}` : `/home/ada/${c()}`);
  const fill = (v, key) => {
    if (KEEP.has(key)) return v;
    if (typeof v === 'string') return c();
    if (Array.isArray(v)) return v.map((x) => fill(x, key === 'features' ? key : ''));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'name' && key === 'skills' ? x : fill(x, k)]));
    return v;
  };
  const out = structuredClone(dataset);
  for (const chat of out.chats) {
    chat.url = url(chat.url);
    chat.folder = chat.folder ? path(chat.folder) : chat.folder;
    Object.assign(chat, { pageTitle: c(), title: c() });
    chat.journal = chat.journal.map((e) => {
      const errorField = ERROR_FIELDS[e.type] || (e.type === 'notice' && e.error ? 'text' : null);
      const next = Object.fromEntries(Object.entries(e).map(([k, v]) => {
        if (k === errorField) return [k, err(v)];
        if (k === 'path') return [k, path(v)];
        if (k === 'label' && typeof v === 'string') return [k, `LABEL_${++n}`];
        if (k === 'skills') return [k, fill(v, 'skills')];
        return [k, fill(v, k)];
      }));
      // The notice "Stopped" and an agent failure decide outcomes by exact text.
      if (e.type === 'notice' && !e.error && /^Stopped\.?$/.test(e.text || '')) next.text = e.text;
      return next;
    });
    const t = chat.journal.at(-1).ts;
    chat.journal.push(
      { ts: t, type: 'user_report', text: `NOTE_${++n} the dropdown is broken ${SECRET} {{SECRET:pin}}` },
      { ts: t, type: 'panel_error', where: 'window', message: err('TypeError: Cannot read properties of null (reading \'x\')'), frame: 'sidepanel.js:12' },
    );
  }
  out.index = out.index.map((m) => ({ ...m, title: c(), pageTitle: c(), url: url(m.url), folder: m.folder ? path(m.folder) : m.folder }));
  return { dataset: out, count: n };
}

const CANARY_LOG = [
  '2026-10-20T11:30:00.000Z [5151] tool error [tab 41] browser_type: No option matching "CANARY_L1" at https://shop.example.com/CANARY_L2?q=CANARY_L3',
  '2026-10-20T11:30:01.000Z [5151] uncaught: Error: ENOENT: no such file or directory, open \'/home/ada/CANARY_L4/notes.txt\'',
  '    at readState (file:///home/ada/CANARY_L5/host/src/state.js:176:9)',
  '2026-10-20T11:30:02.000Z [5151] [claude:41] Error: request for CANARY_L6@mail.example.com failed, token=CANARY_L7 Bearer CANARY_L8',
  '2026-10-20T11:30:04.000Z [5151] prompt failed for tab 41: Error: fetch https://api.example.com/CANARY_L9 failed',
];

describe('privacy: canaries in every free-text field never reach an output', () => {
  for (const [name, base] of Object.entries(GOLDEN)) {
    test(`${name} dataset, history and chat scope`, () => {
      const { dataset, count } = canarize(base);
      assert.ok(count > 500, `${count} canaries`);
      const digest = digestLog([...LINES, ...CANARY_LOG]);
      assert.doesNotMatch(JSON.stringify(digest), /CANARY_/, 'the host digest');
      const input = { ...dataset, now: NOW, logDigest: digest, secretValues: [SECRET] };
      const r = analyze({ ...input, options: { scope: 'all', includeTests: true } });
      // Canaries change no classification: the same findings as the clean data.
      const clean = analyze({ ...structuredClone(base), now: NOW, logDigest: digest, options: { scope: 'all', includeTests: true } });
      assert.deepEqual(rules(r).filter((x) => x !== 'rt.panel-error').sort(), rules(clean).sort());
      assert.ok(rules(r).includes('rt.panel-error') && rules(r).includes('log.uncaught'));
      assert.doesNotMatch(JSON.stringify(r), /CANARY_|s3cr3tValue|\{\{SECRET:/, 'the report itself');
      // Notes are redacted with the secret values the panel passes (selfanalysis-data loadSecretValues).
      const out = renderAll(r, dataset.chats, { logDigest: digest, keepHost: 'shop.example.com', secrets: [SECRET], notes: true });
      assertClean(out);
      assert.match(out['notes bug true'], /^- NOTE_\d+ the dropdown is broken \{\{SECRET\}\} \{\{SECRET\}\}$/m, 'the opt-in note, redacted');
      const one = dataset.chats.find((c) => c.journal.some((e) => e.type === 'action' && e.ok === false)) || dataset.chats[0];
      const rc = analyze({ ...input, options: { scope: 'chat', chatId: one.id, includeTests: true } });
      assertClean(renderAll(rc, [one], { logDigest: digest }));
      for (const f of r.findings) {
        const draft = skillDraft(f, dataset.chats, { secrets: [SECRET] });
        assert.doesNotMatch(`${draft.name}\n${draft.description}\n${draft.body}`, /CANARY_|s3cr3tValue/, `skill draft for ${f.rule}`);
      }
    });
  }
});

describe('privacy: a page script\'s own exception text', () => {
  test('only the error type and fixed engine wording reach any output', () => {
    const t = (s) => new Date(Date.parse(NOW) - 3_600_000 + s * 1000).toISOString();
    const chats = ['a', 'b', 'c'].map((id, i) => ({
      id: `page-err-${id}`, created: Date.parse(t(i * 100)), updated: Date.parse(t(i * 100 + 30)), url: 'https://crm.example.com/clients', agent: 'Claude Code',
      journal: [
        { ts: t(i * 100), type: 'user', text: 'Count the rows', turn: 1 },
        { ts: t(i * 100 + 1), type: 'agent_connected', agent: 'Claude Code', turn: 1 },
        { ts: t(i * 100 + 2), type: 'action', tool: 'browser_evaluate', ok: false, host: 'crm.example.com', turn: 1, error: 'Error: Client CANARY_PAGE_1 Ivan Petrenko has no card\n    at <anonymous>:1:7' },
        { ts: t(i * 100 + 3), type: 'action', tool: 'browser_evaluate', ok: false, host: 'crm.example.com', turn: 1, error: "TypeError: Cannot read properties of null (reading 'rows')" },
        { ts: t(i * 100 + 4), type: 'action', tool: 'browser_script_run', ok: false, host: 'crm.example.com', turn: 1, error: 'Uncaught (in promise) Error: CANARY_PAGE_2 token=abc' },
        { ts: t(i * 100 + 5), type: 'agent', agent: 'Claude Code', text: 'Done', turn: 1, stopReason: 'end_turn' },
      ],
    }));
    const report = analyze({ chats, now: NOW, options: { scope: 'all', includeTests: true } });
    assert.ok(report.findings.length, 'the failures are reported');
    const outputs = renderAll(report, chats);
    for (const [name, text] of Object.entries(outputs)) assert.doesNotMatch(text, /CANARY_PAGE|Ivan|Petrenko|token=/, name);
    assert.ok(Object.values(outputs).some((text) => /Cannot read properties of null/.test(text)), 'engine wording stays useful');
  });
});
