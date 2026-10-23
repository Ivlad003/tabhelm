// Report renderers: the sanitized export, Markdown, the agent digest, the bug
// report and the coding-agent task. The canary test (spec 12.1 item 5) fills
// every free-text field with CANARY_<n> and checks no output carries one.
// Reports are built by hand here, shaped like spec 5.3–5.4.
// Run: node --test 'host/scripts/selfanalysis/*.test.js'

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  toExport, toMarkdown, toDigest, toBugReport, toAgentTask,
  DIGEST_HEADER, DIGEST_FOOTER, REPORT_FOOTER, AGENT_TASK_PREFACE,
} from '../../../extension/report-format.js';
import { templateFor } from '../../../extension/taxonomy.js';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, '../../../extension/report-format.js'), 'utf8');

const BASE = Date.parse('2026-10-20T09:00:00.000Z');
const at = (s) => new Date(BASE + s * 1000).toISOString();
const SECRET = 's3cr3tValue';
const URL_WITH_PATH = /https?:\/\/\S+\/\S/;
const bytes = (s) => Buffer.byteLength(s, 'utf8');

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

// A finding as the analyzer builds it: template texts plus the 5.3 fields.
function finding(rule, fields = {}, ctx = {}) {
  const t = templateFor(rule, { ...ctx, ...fields });
  return {
    id: `f${rule.replace(/\W/g, '')}${fields.idSuffix || ''}`,
    fingerprint: `error|${rule}|${fields.tools?.[0] || '-'}|*|x`,
    kind: 'error', category: 'TABHELM_BUG', rule, owner: 'tabhelm', severity: 3, confidence: 'high',
    title: t.title, explain: t.explain, why: `rule ${rule}`, message: '',
    count: 1, chats: 1, turns: 1, days: 1, agents: [], models: [], tools: [], hosts: [], skills: [],
    first: at(0), last: at(60), versions: { first: '0.31.0', last: '0.31.0' }, approximate: false,
    status: 'open', recovered: { yes: 0, no: 1 }, seenElsewhere: 0, evidence: [], frame: null, code: null,
    remedy: t.remedy, isNew: false, problemMatch: false, score: 1,
    ...fields,
  };
}

function report(findings, extra = {}) {
  return {
    schema: 1, rulesetVersion: 1, analyzerVersion: 1, generated: at(3600),
    env: { ext: '0.31.0', host: '0.31.0', chrome: '141.0.7390.54', platform: 'Linux', features: ['selfAnalysis', 'devTools'], agents: [] },
    scope: { kind: '30d', chatId: null, from: at(-30 * 86400), to: at(3600), chats: 12, turns: 40, excludedTests: 3 },
    coverage: { outcomes: 0.6, instrumentedChats: 5, legacyChats: 7, logJoined: true },
    summary: { outcomes: { ok: 20, failed: 4, crashed: 1, cancelled: 2, legacy_unknown: 13 }, actions: 120, actionsFailed: 14, byOwner: { tabhelm: 2 }, byCategory: { TABHELM_BUG: 2 } },
    live: [], findings, fixFirst: findings.slice(0, 2).map((f) => f.id),
    expected: { USER_DECISION: 3, POLICY: 1, UI_INPUT: 0, cancelledTurns: 2, singleTabRecovered: 1 },
    unclassified: [],
    tables: {
      tools: [{ tool: 'browser_click', calls: 30, failed: 7, rate: 0.233, flag: 'flagged' }, { tool: 'browser_type', calls: 9, failed: 2, rate: 0.22, flag: 'watch' }],
      agents: [{ agent: 'Claude Code', model: 'claude-sonnet-4.5', turns: 30, ok: 26, rate: 0.867, medianMs: 41000 }, { agent: 'Codex', model: 'gpt-5', turns: 10, ok: 6, rate: 0.6, medianMs: 52000 }],
    },
    userReports: [],
    log: { window: { since: at(-30 * 86400), until: at(3600) }, linesScanned: 5000, groups: [], truncated: false, relayMode: false, error: null },
    ...extra,
  };
}

// One finding per owner (plus hidden and probably fixed ones), with hosts,
// skills, evidence and remedies.
function sampleReport() {
  const findings = [
    finding('bug.invalid-args', { kind: 'error', category: 'TABHELM_BUG', owner: 'tabhelm', severity: 2, confidence: 'medium',
      message: 'Invalid arguments for browser_find (Cannot read properties of null)', tools: ['browser_find'], hosts: ['shop.example.com'],
      frame: 'browser-tools.js:965', code: 'extension/browser-tools.js runTool', count: 2, chats: 2, agents: ['Claude Code'],
      evidence: [{ chatId: 'chat-a', idx: 11, ts: at(11), turn: 1 }], versions: { first: '0.30.0', last: '0.31.0' } }, { tool: 'browser_find' }),
    finding('mk.dropdown', { kind: 'missing_knowledge', category: 'MISSING_KNOWLEDGE', owner: 'knowledge', severity: 3,
      message: 'No option matching "…" in <ref>', tools: ['browser_select_option'], hosts: ['shop.example.com'], count: 3, chats: 2,
      recovered: { yes: 2, no: 1 }, why: 'rule page.not-select · 3 events on shop.example.com in 2 chats',
      evidence: [{ chatId: 'chat-b', idx: 4, ts: at(500) }, { chatId: 'chat-a', idx: 11, ts: at(11) }] }, { host: 'shop.example.com' }),
    finding('skill.unused', { kind: 'skill_unused', category: 'SKILL_UNUSED', owner: 'knowledge', severity: 3, confidence: 'low',
      hosts: ['docs.example.org'], skills: ['docs-helper'], why: 'rule skill.unused · skill “docs-helper” matched docs.example.org',
      evidence: [{ chatId: 'chat-c', idx: 2, ts: at(900) }] }, { host: 'docs.example.org', skill: 'docs-helper' }),
    finding('derived.loop', { kind: 'loop', category: 'LOOP', owner: 'agent', severity: 3, agents: ['Codex'], models: ['gpt-5'],
      hosts: ['shop.example.com'], tools: ['browser_click'], count: 4, chats: 3 }, { agent: 'Codex', model: 'gpt-5', host: 'shop.example.com' }),
    finding('auth.signin', { kind: 'error', category: 'AUTH', owner: 'setup', severity: 2, agents: ['Codex'], message: 'Authentication required' }, { agent: 'Codex' }),
    finding('flag.off', { kind: 'error', category: 'FEATURE_OFF', owner: 'setup', severity: 4, tools: ['browser_fill_form'],
      message: 'This tool needs the "…" feature, which is off.' }, { tool: 'browser_fill_form', inner: 'This tool needs the "Developer tools" feature, which is off.' }),
    finding('page.stale-ref', { kind: 'error', category: 'PAGE_ELEMENT', owner: 'site', severity: 4, hosts: ['news.example.net'],
      tools: ['browser_click'], message: 'Ref <ref> is stale or unknown' }, { host: 'news.example.net', tool: 'browser_click' }),
    finding('log.relay-orphan', { kind: 'host_log', category: 'TABHELM_BUG', owner: 'tabhelm', severity: 3, count: 25, status: 'probably_fixed' }, { count: 25 }),
    finding('inv.test-chats', { kind: 'invariant', category: 'DATA_QUALITY', owner: 'tabhelm', severity: 4, count: 3, status: 'hidden' }, { count: 3 }),
  ];
  return report(findings, {
    unclassified: [{ message: 'Weird failure N', count: 2 }],
    userReports: [{ chatId: 'chat-a', ts: at(20), matched: [findings[1].id, 'f-gone'], text: 'The size picker at https://shop.example.com/p/123?ref=mail does not open {{SECRET:pin}}' }],
  });
}

function sampleChats() {
  const journal = [
    { ts: at(0), type: 'user', text: 'buy the red one', turn: 1 },
    { ts: at(1), type: 'agent_connected', agent: 'Claude Code', agentId: 'claude', ext: '0.31.0', host: '0.31.0', features: ['selfAnalysis', 'devTools'], singleTab: false, autoApprove: true, skills: [{ name: 'shop-helper', desc: 'x' }], turn: 1 },
  ];
  for (let i = 2; i < 11; i++) journal.push({ ts: at(i), type: 'action', agent: 'Claude Code', tool: 'browser_click', args: { ref: `e${i}` }, desc: 'Click “Buy”', ok: true, turn: 1 });
  journal.push({ ts: at(11), type: 'action', tool: 'browser_find', args: { query: 'red one', limit: 3 }, desc: 'Find “red one”', ok: false, error: 'Invalid arguments for browser_find (Cannot read properties of null)', turn: 1 });
  journal.push({ ts: at(12), type: 'agent', agent: 'Claude Code', model: 'claude-sonnet-4.5', text: 'done', thought: '', failure: null, turn: 1 });
  return [{ id: 'chat-a', journal }];
}

// ---------- export ----------

const FINDING_KEYS = ['id', 'kind', 'category', 'rule', 'owner', 'severity', 'confidence', 'status', 'isNew', 'problemMatch', 'title', 'explain', 'why',
  'message', 'count', 'chats', 'turns', 'days', 'agents', 'models', 'tools', 'hosts', 'skills', 'first', 'last', 'versions', 'approximate', 'recovered',
  'seenElsewhere', 'frame', 'code', 'remedy', 'evidence', 'score'];
const REPORT_KEYS = ['schema', 'rulesetVersion', 'analyzerVersion', 'generated', 'hideSites', 'env', 'scope', 'coverage', 'summary', 'live', 'findings',
  'fixFirst', 'expected', 'unclassified', 'tables', 'userReports', 'log'];

test('toExport keeps only allow-listed fields and drops ids, fingerprints and chat ids', () => {
  const r = sampleReport();
  const x = toExport(r);
  assert.deepEqual(Object.keys(x), REPORT_KEYS);
  for (const f of x.findings) {
    assert.deepEqual(Object.keys(f), FINDING_KEYS);
    for (const e of f.evidence) assert.deepEqual(Object.keys(e), ['chat', 'ts']);
    for (const a of f.remedy.actions) {
      assert.ok(Object.keys(a).every((k) => ['kind', 'label', 'target', 'text', 'host', 'agentId', 'chat'].includes(k)), JSON.stringify(a));
    }
  }
  assert.deepEqual(Object.keys(x.scope), ['kind', 'from', 'to', 'chats', 'turns', 'excludedTests'], 'scope.chatId is dropped');
  assert.deepEqual(Object.keys(x.env), ['ext', 'host', 'chrome', 'platform', 'features'], 'env.agents (install hints) is dropped');
  const json = JSON.stringify(x);
  for (const gone of ['fingerprint', 'chatId', 'chat-a', 'chat-b', ...r.findings.map((f) => f.id)]) assert.ok(!json.includes(gone), gone);
});

test('findings are numbered F1..Fn in rank order; fixFirst and userReports follow the numbers', () => {
  const r = sampleReport();
  const x = toExport(r);
  assert.deepEqual(x.findings.map((f) => f.id), r.findings.map((_, i) => `F${i + 1}`));
  assert.deepEqual(x.findings.map((f) => f.rule), r.findings.map((f) => f.rule));
  assert.deepEqual(x.fixFirst, ['F1', 'F2']);
  assert.deepEqual(x.userReports[0].matched, ['F2'], 'unknown ids are dropped');
  assert.equal(x.userReports[0].chat, 'chat-1');
  assert.deepEqual(x.findings[1].evidence, [{ chat: 'chat-2', ts: at(500) }, { chat: 'chat-1', ts: at(11) }]);
});

test('user report text is exported only with includeNotes, and redacted', () => {
  const r = sampleReport();
  assert.equal(toExport(r).userReports[0].text, undefined);
  assert.ok(!toMarkdown(r).includes('size picker'));
  const text = toExport(r, { includeNotes: true }).userReports[0].text;
  assert.equal(text, 'The size picker at site-1 does not open {{SECRET}}');
  const md = toMarkdown(r, { includeNotes: true });
  assert.match(md, /## You reported\n\n- chat-1 · 2026-10-20: The size picker at site-1 does not open \{\{SECRET\}\} \(F2\)/);
});

test('remedy actions keep their targets, aliased hosts and safe commands only', () => {
  const r = report([
    finding('flag.off', { owner: 'setup', category: 'FEATURE_OFF', tools: ['browser_fill_form'] }, { tool: 'browser_fill_form', inner: 'This tool needs the "Developer tools" feature, which is off.' }),
    finding('setup.enospc', { owner: 'setup', category: 'SETUP' }),
    finding('bug.unknown-tool', { tools: ['browser_find'] }, { tool: 'browser_find' }),
    finding('mk.repeat', { owner: 'knowledge', category: 'MISSING_KNOWLEDGE', hosts: ['shop.example.com'], remedy: {
      type: 'skill', text: 'Teach it.', actions: [
        { kind: 'memory_note', host: 'shop.example.com', text: 'On shop.example.com, wait for the cart.', label: 'Remember for this site' },
        { kind: 'copy_command', text: 'cat /home/ada/notes/secret.txt', label: 'Copy “cat /home/ada/notes/secret.txt”' },
        { kind: 'open_chat', chatId: 'chat-z', label: 'Open chat' },
        { kind: 'run_shell', text: 'rm -rf /' },
      ] } }),
  ]);
  const [flag, enospc, unknown, mk] = toExport(r).findings;
  assert.deepEqual(flag.remedy.actions.map((a) => [a.kind, a.target]), [['open_settings', 'experimental:devTools']]);
  assert.ok(!flag.remedy.actions.some((a) => /enable|turn on/i.test(a.label)), 'never a one-click enable');
  assert.ok(enospc.remedy.actions[0].text.startsWith('echo fs.inotify.max_user_watches=524288'), 'taxonomy commands pass whole');
  assert.deepEqual(unknown.remedy.actions[0], { kind: 'copy_command', label: 'Copy “npm run install-host”', text: 'npm run install-host' });
  assert.deepEqual(mk.remedy.actions, [
    { kind: 'memory_note', label: 'Remember for this site', host: 'site-1', text: 'On site-1, wait for the cart.' },
    { kind: 'copy_command', label: 'Copy “…”', text: null },
    { kind: 'open_chat', label: 'Open chat', chat: 'chat-1' },
  ]);
});

// ---------- aliasing ----------

test('hosts and skills are aliased in order of first appearance, the same way in every output', () => {
  const r = report([
    finding('mk.repeat', { owner: 'knowledge', hosts: ['b.example.com'], message: 'No visible element contains "…"', tools: ['browser_click'] }, { host: 'b.example.com', tool: 'browser_click' }),
    finding('skill.stale', { owner: 'knowledge', hosts: ['a.example.com', 'b.example.com'], skills: ['b-shop', 'a-docs'] }, { host: 'a.example.com', skill: 'b-shop' }),
    finding('net', { owner: 'setup', category: 'NETWORK', message: 'getaddrinfo ENOTFOUND api.c.example.io' }),
    finding('page.navigating', { owner: 'site', hosts: ['local', 'about:blank', 'example.com'] }, { host: 'example.com' }),
  ]);
  const x = toExport(r);
  assert.deepEqual(x.findings.map((f) => f.hosts), [['site-1'], ['site-2', 'site-1'], [], ['local', 'about:blank', 'site-4']]);
  assert.deepEqual(x.findings[1].skills, ['skill-1', 'skill-2']);
  assert.equal(x.findings[0].title, 'site-1: browser_click keeps failing (No visible element contains "…")');
  assert.equal(x.findings[1].title, 'Skill “skill-1” does not cover what fails on site-2');
  assert.equal(x.findings[2].message, 'getaddrinfo ENOTFOUND site-3', 'a host only named in a message gets the next alias');
  assert.match(x.findings[3].title, /^site-4: /, 'example.com is not confused with a.example.com');
  const outputs = [JSON.stringify(x), toMarkdown(r), toDigest(r), toBugReport(r.findings, r, [], {}), toAgentTask(r)];
  for (const out of outputs) {
    for (const raw of ['a.example.com', 'b.example.com', 'api.c.example.io', 'b-shop', 'a-docs']) assert.ok(!out.includes(raw), `${raw} leaked`);
  }
  assert.match(toMarkdown(r), /### F2 · Skill “skill-1” does not cover what fails on site-2/);
  assert.match(toDigest(r), /^F1 .* on site-1: /m);
  assert.match(toBugReport([r.findings[1]], r, [], {}), /### F2 · Skill “skill-1” does not cover what fails on site-2/);
});

// Every output a finding can reach, with the default hideSites.
const allOutputs = (r, chats = []) => [JSON.stringify(toExport(r)), toMarkdown(r), toDigest(r), toBugReport(r.findings, r, chats, {}), toAgentTask(r)];

test('hosts named only in message text are aliased whatever their TLD; file names, calls and rule ids are not', () => {
  const msgs = [
    'Failed to fetch dynamically imported module: cdn.myclinic.co.nz',
    'llm.acme.internal → HTTP 401',
    'Cannot reach portal.myclinic.nz or hr.acmecorp.lan',
    'getaddrinfo ENOTFOUND xn----8sbc4aihl9q.xn--j1amh',
    'getaddrinfo ENOTFOUND мій-банк.укр',
    'ENOTFOUND bank.example.com.ua',
  ];
  const r = report([
    ...msgs.map((message, i) => finding('net', { idSuffix: String(i), owner: 'setup', category: 'NETWORK', message, hosts: ['portal.myclinic.co.nz'] })),
    finding('bug.js-error', { message: 'Cannot read properties of null in report.md, SKILL.md, browser-tools.js, host.log; tabs.update(…), document.body, Object.keys, rule mk.repeat' }),
    finding('bug.js-error', { idSuffix: 'fn', message: 'TypeError: msg.text.trim is not a function' }),
    // A raw URL whose host looks like a file name is learned from the URL itself.
    finding('net', { idSuffix: 'zip', owner: 'setup', category: 'NETWORK', title: 'Cannot load https://files.example.zip/a/b', message: 'Cannot load files.example.zip' }),
  ]);
  const x = toExport(r);
  assert.deepEqual(x.findings.slice(0, 6).map((f) => f.message), [
    'Failed to fetch dynamically imported module: site-2',
    'site-3 → HTTP N',
    'Cannot reach site-4 or site-5',
    'getaddrinfo ENOTFOUND site-6',
    'getaddrinfo ENOTFOUND site-6',
    'ENOTFOUND site-7',
  ]);
  assert.equal(x.findings[6].message, 'Cannot read properties of null in report.md, SKILL.md, browser-tools.js, host.log; tabs.update(…), document.body, Object.keys, rule mk.repeat');
  assert.equal(x.findings[7].message, 'TypeError: msg.text.trim is not a function');
  assert.deepEqual([x.findings[8].title, x.findings[8].message], ['Cannot load site-8', 'Cannot load site-8']);
  for (const out of allOutputs(r)) {
    assert.doesNotMatch(out, /myclinic|acme|xn--|мій-банк|укр|bank\.example|files\.example/, out);
  }
});

test('skill names listed by a missing-skill error are hidden with the site names', () => {
  const message = 'No skill named "…". Available: privatbank-salary-export, olena-koval-crm, nova-poshta-returns';
  const r = report([
    finding('mk.no-skill', { owner: 'knowledge', category: 'MISSING_KNOWLEDGE', message }),
    finding('misuse.no-skill', { owner: 'agent', category: 'AGENT_MISUSE', message }, { message }),
  ]);
  for (const out of allOutputs(r)) assert.doesNotMatch(out, /privatbank|olena|nova-poshta/, out);
  assert.equal(toExport(r).findings[0].message, 'No skill named "…". Available: …');
  // Shown as they are when the user turned name hiding off.
  assert.match(toExport(r, { hideSites: false }).findings[0].message, /Available: privatbank-salary-export/);
});

test('canary: quoted page or typed text never survives nested, other or unpaired quotes', () => {
  const messages = [
    // As an older analyzer stored them, before quotes inside quotes were one span.
    'A JavaScript confirm dialog is blocking the page: "…"Invoice N for CANARY Petrenko"…". Use browser_handle_dialog first.',
    'No option matching "…"CANARY" in <ref>',
    'No option matching "…" CANARY" in <ref>',
    "SyntaxError: Failed to execute 'querySelector' on 'Document': 'li:has-text(CANARY Petrenko)' is not a valid selector.",
    'Cannot find element «CANARY Петренко» on the page',
    'Typed „CANARY“ and ‘CANARY’',
    "Typed 'CANARY Petr",
  ];
  const r = report(messages.map((message, i) => finding('mk.repeat', { idSuffix: String(i), owner: 'knowledge', category: 'MISSING_KNOWLEDGE', hosts: ['shop.example.com'],
    tools: ['browser_click'], message, title: `shop.example.com: “CANARY “nested” CANARY” ${message}`, explain: `It said ${message}` }, { host: 'shop.example.com', tool: 'browser_click' })));
  for (const out of allOutputs(r)) assert.doesNotMatch(out, /CANARY|Petrenko|Петренко/, out);
  const x = toExport(r);
  assert.equal(x.findings[0].message, 'A JavaScript confirm dialog is blocking the page: "…". Use browser_handle_dialog first.');
  assert.equal(x.findings[3].message, "SyntaxError: Failed to execute '…' is not a valid selector.");
  // Values redaction already replaced, safe names and apostrophes stay readable.
  const ok = toExport(report([finding('log.uncaught', { message: "ENOENT: open '/home/ada/x/notes.txt' — it's Ada's \"Developer tools\" setting" })])).findings[0];
  assert.equal(ok.message, "ENOENT: open '<path>.txt' — it's Ada's \"…\" setting");
  const title = toExport(report([finding('flag.off', { title: 'This tool needs the "Developer tools" feature; it\'s off for “skill-1”' })])).findings[0].title;
  assert.equal(title, 'This tool needs the "Developer tools" feature; it\'s off for “skill-1”');
  // A template's own fallback word is not typed text.
  assert.match(toExport(report([finding('flag.off')])).findings[0].title, /“a feature” is off/);
});

test('hideSites false keeps names; keepHost leaves the chat host readable in the digest', () => {
  const r = sampleReport();
  const plain = toExport(r, { hideSites: false });
  assert.equal(plain.hideSites, false);
  assert.deepEqual(plain.findings[0].hosts, ['shop.example.com']);
  assert.deepEqual(plain.findings[2].skills, ['docs-helper']);
  assert.equal(plain.findings[2].title, 'Skill “docs-helper” was not used on docs.example.org');
  assert.ok(!JSON.stringify(plain).includes('site-1'));
  const digest = toDigest(r, { keepHost: 'Shop.Example.com' });
  assert.match(digest, /browser_select_option on shop\.example\.com:/);
  assert.ok(!digest.includes('docs.example.org') && digest.includes('site-1'), 'other hosts stay aliased');
  assert.match(toDigest(r, { keepHost: 'https://shop.example.com/cart' }), /on shop\.example\.com:/, 'a URL works as keepHost');
});

// ---------- digest ----------

test('the digest is framed as data, follows the 9.1 format and skips hidden findings', () => {
  const r = sampleReport();
  const d = toDigest(r);
  const lines = d.split('\n');
  assert.equal(lines[0], DIGEST_HEADER);
  assert.equal(lines.at(-1), DIGEST_FOOTER);
  assert.equal(lines[1], 'Scope: last 30 days (2026-09-20 → 2026-10-20) · 12 chats · 40 tasks (5 failed) · outcome known for 60% · ext 0.31.0 / host 0.31.0 · agents Claude Code, Codex');
  assert.equal(lines[2], 'Findings, most important first:');
  assert.equal(lines.at(-2), 'Not counted: 3 user decisions, 1 site-rule block, 2 cancelled tasks, 1 recovered single-tab refusal.');
  assert.equal(lines[3], 'F1 [S2 tabhelm · bug.invalid-args · medium] browser_find on site-1: "Invalid arguments for browser_find (Cannot read properties of null)" ×2 in 2 chats, frame browser-tools.js:965. Not your fault; offer the user to copy a bug report (History → Report).');
  assert.match(d, /^F4 \[S3 agent · derived\.loop · high\] .* ×4 in 3 chats, agent Codex\. .*Offer: draft a skill for this site\.$/m);
  assert.match(d, /^F2 \[S3 knowledge · mk\.dropdown · high\] .*browser_select_option on site-1: "No option matching "…" in <ref>" ×3 in 2 chats, recovered 2\/3\. Fix: .* Offer: remember a note for this site, draft a skill for this site\.$/m);
  assert.match(d, /^F8 .*probably fixed/m);
  assert.ok(!/^F9 /m.test(d), 'hidden findings are left out');
  assert.ok(bytes(d) <= 6000);
});

test('the digest stays under maxBytes and counts what did not fit', () => {
  const many = Array.from({ length: 80 }, (_, i) => finding('mk.repeat', { idSuffix: String(i), owner: 'knowledge', hosts: [`shop${i}.example.com`], tools: ['browser_click'],
    message: `No visible element contains "…" (attempt ${i}) ${'é'.repeat(40)}`, count: 3, chats: 2 }, { host: `shop${i}.example.com`, tool: 'browser_click' }));
  const r = report(many);
  for (const maxBytes of [6000, 2500, 900, 300]) {
    const d = maxBytes === 6000 ? toDigest(r) : toDigest(r, { maxBytes });
    assert.ok(bytes(d) <= maxBytes, `${bytes(d)} > ${maxBytes}`);
    assert.ok(d.startsWith(`${DIGEST_HEADER}\n`));
    assert.ok(d.endsWith(`\n${DIGEST_FOOTER}`));
    const shown = d.split('\n').filter((l) => /^F\d+ /.test(l)).length;
    if (maxBytes >= 900) {
      assert.ok(shown > 0 && shown < 80);
      assert.match(d, new RegExp(`^…and ${80 - shown} more \\(see History → Report\\)\\.$`, 'm'));
    }
  }
  const all = toDigest(r, { maxBytes: 1_000_000 });
  assert.equal(all.split('\n').filter((l) => /^F\d+ /.test(l)).length, 80);
  assert.ok(!all.includes('more (see History'));
});

test('an empty or missing report still renders every format', () => {
  for (const r of [null, undefined, {}, { findings: 'nope', live: [null, 3], userReports: [null] }]) {
    const d = toDigest(r);
    assert.ok(d.startsWith(DIGEST_HEADER) && d.endsWith(DIGEST_FOOTER));
    assert.match(d, /No problems found\./);
    assert.ok(toMarkdown(r).includes(REPORT_FOOTER));
    assert.ok(toAgentTask(r).startsWith(AGENT_TASK_PREFACE));
    assert.match(toBugReport(null, r, null), /No TabHelm bugs were found/);
    assert.deepEqual(toExport(r).findings, []);
  }
});

// ---------- Markdown ----------

test('Markdown groups findings by owner, then probably fixed and hidden, and ends with the footer', () => {
  const r = sampleReport();
  const md = toMarkdown(r);
  const headings = md.split('\n').filter((l) => l.startsWith('## '));
  assert.deepEqual(headings, ['## Fix these first', '## TabHelm bugs (1)', '## Skills & knowledge (2)', '## Agent (1)', '## Setup & environment (2)', '## Sites (1)',
    '## Probably fixed (1)', '## Hidden (1)', '## Not counted as problems', '## Unrecognised errors', '## Tools', '## Agents']);
  const sectionOf = (id) => {
    const at = md.indexOf(`### ${id} · `);
    return md.slice(0, at).split('\n').filter((l) => l.startsWith('## ')).at(-1);
  };
  const x = toExport(r);
  const names = { tabhelm: '## TabHelm bugs', knowledge: '## Skills & knowledge', agent: '## Agent', setup: '## Setup & environment', site: '## Sites' };
  for (const f of x.findings) {
    const expected = f.status === 'hidden' ? '## Hidden' : f.status === 'probably_fixed' ? '## Probably fixed' : names[f.owner];
    assert.ok(sectionOf(f.id).startsWith(expected), `${f.id} ${f.rule} under ${sectionOf(f.id)}`);
  }
  assert.equal(md.trim().split('\n').at(-1), REPORT_FOOTER);
  assert.match(md, /^- Environment: extension 0\.31\.0 · host 0\.31\.0 · Chrome 141\.0\.7390\.54 · Linux · ruleset 1$/m);
  assert.match(md, /^- Scope: last 30 days \(2026-09-20 → 2026-10-20\) · 12 chats · 40 tasks · 3 test chats left out$/m);
  assert.match(md, /^- Coverage: outcome known for 60% of tasks · 5 instrumented chats · 7 older chats · host log joined$/m);
  assert.match(md, /^- ×2 · 2 chats · last 2026-10-20 · versions 0\.30\.0 → 0\.31\.0$/m);
  assert.match(md, /^- `Invalid arguments for browser_find \(Cannot read properties of null\)`$/m, 'message in backticks');
  assert.match(md, /^- Why: rule page\.not-select · 3 events on site-1 in 2 chats$/m);
  assert.match(md, /### F2 · site-1: dropdowns are custom widgets, not \\<select\\>/, 'HTML-like text is escaped');
  assert.match(md, /^\| browser_click \| 30 \| 7 \| 23% \| flagged \|$/m);
  assert.match(md, /^1\. F1 · browser_find failed inside TabHelm$/m);
});

test('Markdown keeps backticks and table pipes from breaking the layout', () => {
  const r = report([finding('unclassified', { message: 'odd `x` | y' })], { tables: { tools: [], agents: [{ agent: 'A|B', model: 'm', turns: 1, ok: 1, rate: 1 }] } });
  const md = toMarkdown(r);
  assert.match(md, /^- `odd 'x' \| y`$/m);
  assert.match(md, /^\| A\\\|B \| m \| 1 \| 1 \| 100% \|  \|$/m);
});

// ---------- bug report ----------

const STEP_RE = /^\+\d+s [a-z_]+(?: [\w-]+ \{[\w.?, ]*\})?(?: (?:guide|human|login))?(?: (?:ok|✗(?: [\w.-]+)?))?(?: {2}←)?$/;

function codeBlocks(text) {
  return [...text.matchAll(/^```text\n([\s\S]*?)\n```$/gm)].map((m) => m[1].split('\n'));
}

test('the bug report shows up to 10 steps before the failure as type, tool, arg keys and rule', () => {
  const r = sampleReport();
  const out = toBugReport(null, r, sampleChats(), {});
  const [steps] = codeBlocks(out);
  assert.equal(steps.length, 11, '10 preceding entries plus the failing one');
  for (const line of steps) assert.match(line, STEP_RE);
  assert.equal(steps[0], '+0s agent_connected');
  assert.equal(steps[1], '+1s action browser_click {ref} ok');
  assert.equal(steps.at(-1), '+10s action browser_find {limit, query} ✗ bug.invalid-args  ←');
  assert.ok(!out.includes('red one') && !out.includes('Buy') && !out.includes('e10'), 'no argument values, desc or user text');
  assert.match(out, /^### F1 · browser_find failed inside TabHelm$/m, 'the same number as in the export');
  assert.ok(!/^### F[2-9]/m.test(out), 'null selects open TabHelm-owned findings only (F8 is probably fixed, F9 hidden)');
});

test('the bug report has the env, context and host-log lines within ±60 s', () => {
  const r = sampleReport();
  r.log.groups = [
    { gid: 'g1', kind: 'agent_stderr', agent: 'claude', code: '-32000', text: 'Error handling request session/new → -32000 Authentication required', count: 2, first: at(-30), last: at(5), tabs: [7] },
    { gid: 'g2', kind: 'uncaught', agent: null, code: 'EPIPE', text: 'uncaught: Error: write EPIPE at /home/ada/tabhelm/host/src/x.js', count: 1, first: at(40), last: at(40), tabs: [] },
    { gid: 'g3', kind: 'tool_error', agent: null, code: 'browser_find', text: 'far away', count: 1, first: at(400), last: at(400), tabs: [] },
  ];
  const out = toBugReport([r.findings[0]], r, sampleChats(), { includeNotes: false });
  assert.match(out, /^- Environment: extension 0\.31\.0 · host 0\.31\.0 · Chrome 141\.0\.7390\.54 · Linux · ruleset 1$/m);
  assert.match(out, /^- Flags on: selfAnalysis, devTools$/m);
  assert.match(out, /^- Context: agent Claude Code · model claude-sonnet-4\.5 · singleTab off · auto-approve on · flags selfAnalysis, devTools · ext 0\.31\.0 \/ host 0\.31\.0$/m);
  assert.match(out, /^- Where: frame browser-tools\.js:965 · code extension\/browser-tools\.js runTool$/m);
  assert.match(out, /^- Seen: ×2 · 2 chats · last 2026-10-20 · versions 0\.30\.0 → 0\.31\.0 · agents Claude Code · recovered 0\/2$/m);
  const [, log] = codeBlocks(out);
  assert.deepEqual(log, [
    '-41s agent_stderr claude -32000 ×2: Error handling request session/new → -N Authentication required',
    '+29s uncaught EPIPE ×1: uncaught: Error: write EPIPE at <path>.js',
  ]);
  assert.equal(codeBlocks(toBugReport([r.findings[0]], r, sampleChats(), { includeLog: false })).length, 1, 'no log block without includeLog');
  assert.ok(out.trim().endsWith('Generated by TabHelm self-analysis on this computer.'));
  assert.match(out, /Left out on purpose: messages, typed text, argument values/);
});

test('bug report log lines need a line near the step: a group that only spans it is left out', () => {
  const r = sampleReport();
  const groups = [
    // First seen an hour before, last an hour after: nothing near the step.
    { gid: 'g1', kind: 'agent_stderr', agent: 'claude', code: 'ENOSPC', text: 'ENOSPC: System limit for number of file watchers reached', count: 40, first: at(-3600), last: at(3600), tabs: [] },
    // The same span, but one of its lines (an event) is 20 s after the step.
    { gid: 'g2', kind: 'prompt_failed', agent: null, code: null, text: 'ACP connection closed', count: 9, first: at(-3600), last: at(3600), tabs: [7] },
  ];
  const events = [{ ts: at(31), kind: 'prompt_failed', tabId: 7, agent: null, code: null, gid: 'g2' }, { ts: at(-3000), kind: 'prompt_failed', tabId: 7, agent: null, code: null, gid: 'g2' }];
  const out = toBugReport([r.findings[0]], r, sampleChats(), { logDigest: { groups, events } });
  const [, log] = codeBlocks(out);
  assert.deepEqual(log, ['+20s prompt_failed ×9: ACP connection closed']);
});

test('bug report log lines from other tabs (other chats) are left out', () => {
  const r = sampleReport();
  const groups = [
    { gid: 'g1', kind: 'prompt_failed', agent: null, code: null, text: 'ACP connection closed', count: 1, first: at(15), last: at(15), tabs: [7] },
    { gid: 'g2', kind: 'agent_stderr', agent: 'claude', code: null, text: 'OTHERCHAT failure', count: 1, first: at(16), last: at(16), tabs: [999] },
    { gid: 'g3', kind: 'uncaught', agent: null, code: null, text: 'Error: write EPIPE', count: 1, first: at(17), last: at(17), tabs: [] },
  ];
  const chats = sampleChats().map((c) => ({ ...c, tabId: 7 }));
  const [, log] = codeBlocks(toBugReport([r.findings[0]], r, chats, { logDigest: { groups, events: [] } }));
  assert.deepEqual(log, ['+4s prompt_failed ×1: ACP connection closed', '+6s uncaught ×1: Error: write EPIPE']);
});

test('the bug report renders a selected finding, a live one and the user note on request', () => {
  const r = sampleReport();
  r.live = [finding('live.not-saving', { kind: 'live', owner: 'tabhelm', severity: 1 }), finding('live.waiting', { title: 'Right now: confirm “Pay 300 USD”' })];
  const one = toBugReport(r.findings[1], r, sampleChats(), {});
  assert.match(one, /^### F2 · site-1: dropdowns are custom widgets/m);
  assert.match(one, /Steps: not available for this finding\./, 'chat-b is not loaded');
  const live = toBugReport(r.live, r, [], {});
  assert.match(live, /^### L1 · This chat is not being saved$/m);
  assert.ok(!live.includes('Pay 300'), 'the waiting card title is local only');
  assert.ok(!one.includes('size picker'));
  const noted = toBugReport(null, r, sampleChats(), { includeNotes: true });
  assert.match(noted, /^- The size picker at site-1 does not open \{\{SECRET\}\}$/m);
  // The note can also come from the journal when the report has no text.
  delete r.userReports[0].text;
  r.userReports[0].ts = at(30);
  const chats = sampleChats();
  chats[0].journal.push({ ts: at(30), type: 'user_report', text: 'checkout at https://shop.example.com/c?id=9 hangs' });
  assert.match(toBugReport(null, r, chats, { includeNotes: true }), /^- checkout at site-1 hangs$/m);
});

// ---------- coding-agent task ----------

test('the coding-agent task lists only open TabHelm bugs with code, frame and a fenced message', () => {
  const r = sampleReport();
  r.findings.push(finding('bug.js-error', { idSuffix: 'tick', message: 'x is not a function in ```weird``` code', code: 'extension/sidepanel.js replayChat' }));
  const out = toAgentTask(r);
  assert.ok(out.startsWith(`${AGENT_TASK_PREFACE}\n`));
  const ids = [...out.matchAll(/^## (\S+) · /gm)].map((m) => m[1]);
  assert.deepEqual(ids, ['F1', 'F8', 'F10'], 'tabhelm-owned, hidden left out');
  assert.match(out, /^## F1 · browser_find failed inside TabHelm\nRule: bug\.invalid-args \(TABHELM_BUG, S2, medium confidence\)\nCode: extension\/browser-tools\.js runTool\nFrame: browser-tools\.js:965\n/m);
  assert.match(out, /^```text\nInvalid arguments for browser_find \(Cannot read properties of null\)\n```$/m);
  assert.match(out, /^````text\nx is not a function in ```weird``` code\n````$/m, 'the fence outgrows backticks in the message');
  assert.equal(out.split('\n').at(-1), DIGEST_FOOTER);
});

// ---------- canary privacy (spec 12.1 item 5) ----------

function canaryCorpus(n = 30) {
  let k = 0;
  const canaries = [];
  const c = () => {
    const v = `CANARY_${++k}`;
    canaries.push(v);
    return v;
  };
  const chats = [];
  for (let i = 0; i < n; i++) {
    const host = `shop${i % 4}.example.com`;
    const t = (s) => at(i * 3600 + s);
    chats.push({
      id: c(), created: t(0), updated: t(30), tabId: 100 + i, agent: 'Claude Code', folder: `/home/ada/${c()}`, pageTitle: c(), title: c(),
      url: `https://${host}/${c()}/item?q=${c()}&session=${c()}`,
      journal: [
        { ts: t(0), type: 'user', text: `${c()} pay with {{SECRET:pin}} ${SECRET}`, attachments: [{ name: `${c()}.pdf`, kind: 'file', size: 1 }], turn: 1 },
        { ts: t(1), type: 'agent_connected', agent: 'Claude Code', agentId: 'claude', ext: '0.31.0', host: '0.31.0', features: ['selfAnalysis'], singleTab: true, autoApprove: false, skills: [{ name: 'shop-helper', desc: c() }], turn: 1 },
        { ts: t(2), type: 'folder', path: `/home/ada/${c()}` },
        { ts: t(3), type: 'action', tool: 'browser_navigate', args: { url: `https://${host}/${c()}?q=${c()}` }, desc: `Open ${c()}`, label: c(), ok: true, turn: 1 },
        { ts: t(4), type: 'action', tool: 'browser_type', args: { ref: 'e12', text: `${c()} {{SECRET:pin}} ${SECRET}`, submit: true }, desc: `Type “${c()}”`, label: c(), ok: true, turn: 1 },
        { ts: t(5), type: 'confirm', title: c(), detail: `Critic: ${c()}`, answer: 'Allow once', turn: 1 },
        { ts: t(6), type: 'ask', kind: 'human', message: c(), turn: 1 },
        { ts: t(7), type: 'page_script', name: c(), ok: false, error: `ReferenceError: ${c()} is not defined`, turn: 1 },
        { ts: t(8), type: 'agent_tool', title: c(), ok: false, error: c(), turn: 1 },
        { ts: t(9), type: 'notice', text: `Recording failed: ${c()}`, error: true, turn: 1 },
        { ts: t(10), type: 'permission', title: c(), answer: c(), turn: 1 },
        { ts: t(11), type: 'video', path: `/tmp/${c()}.webm` },
        { ts: t(12), type: 'action', tool: 'browser_select_option', args: { ref: 'e14', values: [c()] }, desc: `Select ${c()}`, label: c(), ok: false, error: `No option matching "${c()}" at https://${host}/${c()}?x=${c()}`, turn: 1 },
        { ts: t(13), type: 'user_report', text: `${c()} the dropdown is broken`, turn: 1 },
        { ts: t(14), type: 'agent', agent: 'Claude Code', model: 'claude-sonnet-4.5', text: c(), thought: c(), failure: `stopped early (refusal) ${c()}`, turn: 1 },
      ],
    });
  }
  // Findings the way a careless analyzer might fill them: raw quoted values,
  // URLs with paths, paths, secrets, ids and fields that are not in 5.3.
  const ev = (i) => ({ chatId: chats[i].id, idx: 12, ts: chats[i].journal[12].ts, turn: 1 });
  const rules = [
    ['bug.invalid-args', 'tabhelm', 'TABHELM_BUG'], ['mk.dropdown', 'knowledge', 'MISSING_KNOWLEDGE'], ['skill.unused', 'knowledge', 'SKILL_UNUSED'],
    ['derived.loop', 'agent', 'LOOP'], ['auth.signin', 'setup', 'AUTH'], ['page.stale-ref', 'site', 'PAGE_ELEMENT'], ['probe.replay', 'tabhelm', 'TABHELM_BUG'],
    ['unclassified', 'tabhelm', 'UNCLASSIFIED'], ['log.uncaught', 'tabhelm', 'TABHELM_BUG'], ['flag.off', 'setup', 'FEATURE_OFF'],
  ];
  const findings = Array.from({ length: n }, (_, i) => {
    const [rule, owner, category] = rules[i % rules.length];
    const host = `shop${i % 4}.example.com`;
    const ctx = { host, tool: 'browser_select_option', skill: 'shop-helper', agent: 'Claude Code', model: 'claude-sonnet-4.5', message: `"${c()}"`, entryType: 'ask' };
    const t = templateFor(rule, ctx);
    return {
      id: c(), fingerprint: c(), kind: 'error', category, rule, owner, severity: 1 + (i % 5), confidence: 'high',
      title: `${t.title} — “${c()}” https://${host}/${c()}?q=${c()}`,
      explain: `${t.explain} See https://${host}/${c()} and /home/ada/${c()}/x.txt or ${c()}@mail.example.com`,
      why: `rule ${rule} · last “${c()}” · {{SECRET:pin}} ${SECRET}`,
      message: `No option matching "${c()}" at https://${host}/${c()}?q=${c()} {{SECRET:pin}} ${SECRET}`,
      count: 3, chats: 2, turns: 2, days: 1, agents: ['Claude Code'], models: ['claude-sonnet-4.5'], tools: ['browser_select_option'],
      hosts: [host], skills: i % 3 === 0 ? ['shop-helper'] : [], first: chats[i].created, last: chats[i].updated,
      versions: { first: '0.30.0', last: '0.31.0' }, approximate: false, status: ['open', 'open', 'recovered', 'regressed', 'hidden', 'probably_fixed'][i % 6],
      recovered: { yes: 1, no: 2 }, seenElsewhere: 2, evidence: [ev(i), ev((i + 1) % n)], frame: 'browser-tools.js:965', code: 'extension/browser-tools.js runTool',
      remedy: {
        type: t.remedy.type, text: `${t.remedy.text} “${c()}” https://${host}/${c()}`,
        actions: [...t.remedy.actions,
          { kind: 'memory_note', host, text: `On ${host}, pick “${c()}” at https://${host}/${c()}`, label: 'Remember for this site' },
          { kind: 'copy_command', text: `cat /home/ada/${c()}/notes.txt`, label: `Copy “cat /home/ada/${c()}/notes.txt”` },
          { kind: 'open_chat', chatId: chats[i].id, label: 'Open chat' }],
      },
      isNew: true, problemMatch: false, score: 30 - i,
      raw: c(), desc: c(), label: c(), pageTitle: c(), args: { text: c() }, entryType: c(), inner: c(),
    };
  });
  const r = report(findings, {
    scope: { kind: '7d', chatId: c(), from: at(0), to: at(n * 3600), chats: n, turns: n, excludedTests: 0 },
    env: { ext: '0.31.0', host: '0.31.0', chrome: '141', platform: 'Linux', features: ['selfAnalysis'], agents: [{ id: 'claude', name: 'Claude Code', installHint: c() }] },
    live: [
      { ...findings[0], id: c(), rule: 'live.waiting', kind: 'live', title: `Right now: the agent is waiting for your answer: confirm “${c()}”` },
      { ...findings[6], id: c(), rule: 'live.not-saving', kind: 'live' },
    ],
    unclassified: [{ message: `Weird "${c()}" at https://x.example.com/${c()} /home/ada/${c()}/y.log`, count: 2 }],
    userReports: chats.slice(0, 5).map((ch) => ({ chatId: ch.id, ts: ch.journal[13].ts, matched: [findings[1].id], text: ch.journal[13].text })),
    log: { window: { since: at(0), until: at(n * 3600) }, linesScanned: 10, groups: [
      { gid: 'g1', kind: 'tool_error', agent: null, code: 'browser_click', text: `tool error: "${c()}" at https://y.example.com/${c()}`, count: 1, first: at(10), last: at(12), tabs: [] },
    ], truncated: false, relayMode: false, error: `cannot read https://z.example.com/${c()}` },
  });
  return { chats, report: r, canaries };
}

test('canary privacy: no free-text value, secret or URL path reaches any output', () => {
  const { chats, report: r, canaries } = canaryCorpus(30);
  deepFreeze(r);
  deepFreeze(chats);
  assert.ok(canaries.length > 600, `${canaries.length} canaries`);
  const outputs = {};
  for (const hideSites of [true, false]) {
    const opts = { hideSites, secrets: [SECRET] };
    outputs[`export ${hideSites}`] = JSON.stringify(toExport(r, opts));
    outputs[`markdown ${hideSites}`] = toMarkdown(r, opts);
    outputs[`digest ${hideSites}`] = toDigest(r, opts);
    outputs[`digest keepHost ${hideSites}`] = toDigest(r, { ...opts, keepHost: 'shop1.example.com' });
    outputs[`task ${hideSites}`] = toAgentTask(r, opts);
    outputs[`bug ${hideSites}`] = toBugReport(null, r, chats, opts);
    outputs[`bug all ${hideSites}`] = toBugReport(r.findings, r, chats, { ...opts, includeLog: true });
    outputs[`bug live ${hideSites}`] = toBugReport(r.live, r, chats, opts);
  }
  const canaryRe = /CANARY_\d+/;
  for (const [name, out] of Object.entries(outputs)) {
    const hit = out.match(canaryRe);
    assert.equal(hit, null, `${name} leaked ${hit?.[0]}: …${hit ? out.slice(Math.max(0, hit.index - 80), hit.index + 20) : ''}`);
    assert.ok(!out.includes(SECRET), `${name} leaked the secret value`);
    assert.ok(!out.includes('{{SECRET:pin}}'), `${name} leaked the secret name`);
    assert.doesNotMatch(out, URL_WITH_PATH, name);
    assert.ok(!out.includes('/home/ada'), `${name} leaked a home path`);
    assert.ok(!out.includes('mail.example.com') || !out.includes('@'), `${name} leaked an email`);
  }
  // The renderers really used the data (not an empty shell).
  assert.ok(outputs['export true'].includes('"F30"'));
  assert.ok(outputs['bug all true'].includes('{ref, values} ✗ page.not-select'));
  assert.ok(outputs['bug true'].includes('+1s action browser_navigate {url} ok'));
  assert.ok(outputs['markdown false'].includes('shop0.example.com'));
  for (const name of ['export true', 'markdown true', 'digest true', 'task true', 'bug all true']) {
    assert.ok(!/shop\d\.example\.com|shop-helper/.test(outputs[name]), `${name} shows a site or skill name with hideSites`);
  }
  assert.ok(outputs['digest keepHost true'].includes('shop1.example.com') && !outputs['digest keepHost true'].includes('shop2.example.com'));
});

// ---------- determinism and purity ----------

function shuffleKeys(v, seed = { n: 7 }) {
  if (Array.isArray(v)) return v.map((x) => shuffleKeys(x, seed));
  if (!v || typeof v !== 'object') return v;
  const keys = Object.keys(v);
  for (let i = keys.length - 1; i > 0; i--) {
    seed.n = (seed.n * 1103515245 + 12345) % 2147483648;
    const j = seed.n % (i + 1);
    [keys[i], keys[j]] = [keys[j], keys[i]];
  }
  return Object.fromEntries(keys.map((k) => [k, shuffleKeys(v[k], seed)]));
}

test('renderers are deterministic, ignore key order and never mutate their input', () => {
  const r = deepFreeze(sampleReport());
  const chats = deepFreeze(sampleChats());
  const render = (rep, ch) => [JSON.stringify(toExport(rep)), toMarkdown(rep), toDigest(rep), toBugReport(null, rep, ch), toAgentTask(rep)];
  const a = render(r, chats);
  assert.deepEqual(render(r, chats), a);
  const s = shuffleKeys(sampleReport());
  // Shuffling must keep the finding objects identical by value; refs differ, ids map them.
  assert.deepEqual(render(s, shuffleKeys(sampleChats())), a);
});

test('the module is pure: no chrome.*, no DOM, no clock', () => {
  assert.doesNotMatch(SOURCE, /(?<!['\w.-])chrome\.\w+|\bdocument\.|\bwindow\.|Date\.now|new Date\(\)/);
});
