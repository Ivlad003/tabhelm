// Taxonomy: the ordered ruleset, unwrap, context overrides, the committed
// ruleset hash, code hints, the complaint regex and the finding templates.
// Run: node --test host/scripts/selfanalysis/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  RULES, WRAPPERS, OVERRIDES, UNCLASSIFIED, DERIVED_RULES, RULESET_VERSION, RULESET_HASH, BASE_SEVERITY, OWNER_OF,
  TEMPLATES, TIPS, PREAMBLE_HINTS, COMPLAINT_RE, COMPONENT_STEMS, LOG_NOISE,
  classify, unwrap, fnv1a32, rulesetHash, ownerFor, templateFor, featureOf, componentMatch, pageErrorShape,
} from '../../../extension/taxonomy.js';
import { FEATURES } from '../../../extension/features.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '../../..');
const MESSAGES = JSON.parse(readFileSync(join(here, 'fixtures/messages.json'), 'utf8'));

const ALL_RULES = [...RULES, ...OVERRIDES, UNCLASSIFIED];
const FINDING_RULES = [...new Set([...ALL_RULES.map((r) => r.id), ...DERIVED_RULES])];
const OWNERS = new Set(['tabhelm', 'knowledge', 'agent', 'setup', 'site', 'expected']);
const REMEDY_TYPES = new Set(['tabhelm_fix', 'skill', 'memory', 'preamble', 'setting', 'command', 'agent_choice', 'user_action', 'none']);
const ACTION_KINDS = new Set(['open_settings', 'copy_command', 'skill_draft', 'skill_with_agent', 'memory_note', 'use_agent', 'open_extensions',
  'copy_bug_report', 'ask_agent', 'open_chat', 'hide', 'stop']);

test('every fixture message keeps its category (and rule where given)', () => {
  assert.ok(MESSAGES.length >= 191 + 30, 'the 191 harness messages plus the new cases');
  const bad = [];
  for (const m of MESSAGES) {
    const r = classify(m.text, m.ctx);
    if (r.category !== m.expected || (m.rule && r.rule !== m.rule)) {
      bad.push(`${m.expected}/${m.rule || '*'} got ${r.category}/${r.rule} :: ${m.text.slice(0, 100)}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('classify returns the full result shape', () => {
  const keys = ['category', 'rule', 'inner', 'confidence', 'code', 'severity', 'owner'];
  for (const m of MESSAGES) assert.deepEqual(Object.keys(classify(m.text, m.ctx)).sort(), [...keys].sort());

  const uncaught = classify('uncaught: Error: write EPIPE');
  assert.equal(uncaught.severity, 1, 'rule sev overrides the base');
  assert.equal(uncaught.code, 'host/src/native-host.js handleMessageNow');
  assert.equal(uncaught.owner, 'tabhelm');

  const invalid = classify("Invalid arguments for browser_find (Cannot read properties of null (reading 'x')).");
  assert.equal(invalid.confidence, 'medium');
  assert.equal(invalid.severity, 2);

  const select = classify('e4 is not a <select>; click it and pick the option instead.');
  assert.deepEqual([select.confidence, select.severity, select.owner, select.code], ['high', 4, 'site', null]);

  assert.equal(classify('Tool "browser_guide" timed out after 1800s').owner, 'setup');
  assert.equal(classify('needs approval (scheduled runs cannot ask)').owner, 'tabhelm');
  assert.equal(classify('Blocked by site rules: banking site.').owner, 'expected');
  assert.equal(classify('Speech recognition: audio-capture').severity, 3);
});

test('unclassified text is UNCLASSIFIED, S3, tabhelm, low', () => {
  for (const text of ['the flux capacitor broke', '', null, undefined]) {
    const r = classify(text);
    assert.deepEqual([r.category, r.rule, r.severity, r.owner, r.confidence], ['UNCLASSIFIED', 'unclassified', 3, 'tabhelm', 'low']);
  }
  assert.equal(classify('x', null).rule, 'unclassified', 'a null ctx is fine');
});

test('unwrap strips up to 3 nested wrappers', () => {
  assert.equal(unwrap('Recording failed: Cannot pick on this page: Cannot access a chrome:// URL'), 'Cannot access a chrome:// URL');
  const three = 'Scheduled run of "a" failed: Recording failed: Cannot pick on this page: Cannot access a chrome:// URL';
  assert.equal(unwrap(three), 'Cannot access a chrome:// URL');
  const r = classify(three);
  assert.deepEqual([r.category, r.rule, r.inner], ['CHROME_LIMIT', 'chrome.script', 'Cannot access a chrome:// URL']);
  const four = `Transcription failed: ${three}`;
  assert.equal(unwrap(four), 'Cannot pick on this page: Cannot access a chrome:// URL', 'the fourth level stays wrapped');
  assert.equal(unwrap('  plain  '), 'plain');
  assert.equal(unwrap(undefined), '');
  assert.equal(unwrap('Claude Code stopped before finishing: ACP connection closed'), 'ACP connection closed');
});

test('classify is stateless across calls', () => {
  for (const m of MESSAGES.slice(0, 40)) assert.deepEqual(classify(m.text, m.ctx), classify(m.text, m.ctx));
  for (const r of [...RULES.map((x) => x.re), ...WRAPPERS, COMPLAINT_RE, LOG_NOISE]) {
    assert.ok(!r.global && !r.sticky, `${r} must not be global or sticky (.test would keep lastIndex)`);
  }
});

test('RULESET_HASH matches the rules', () => {
  const recomputed = fnv1a32(RULES.map((r) => r.id + r.cat + r.re).join('\n'));
  assert.equal(rulesetHash(), recomputed);
  assert.equal(RULESET_HASH, recomputed, `rules changed: set RULESET_HASH = '${recomputed}' and bump RULESET_VERSION`);
  assert.ok(Number.isInteger(RULESET_VERSION) && RULESET_VERSION >= 1);
});

test('fnv1a32 matches the reference vectors', () => {
  assert.equal(fnv1a32(''), '811c9dc5');
  assert.equal(fnv1a32('a'), 'e40c292c');
  assert.equal(fnv1a32('foobar'), 'bf9cf968');
  assert.match(fnv1a32('ї “x”'), /^[0-9a-f]{8}$/);
});

test('rule ids are unique and well formed', () => {
  const ids = ALL_RULES.map((r) => r.id);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
  for (const r of ALL_RULES) {
    assert.match(r.id, /^[a-z]+(?:\.[a-z0-9-]+)?$/, r.id);
    assert.ok(r.cat in BASE_SEVERITY, `${r.id}: ${r.cat} has a base severity`);
    assert.ok(r.cat in OWNER_OF, `${r.id}: ${r.cat} has an owner`);
    if (r.conf) assert.ok(['high', 'medium', 'low'].includes(r.conf), r.id);
    if (r.sev) assert.ok(r.sev >= 1 && r.sev <= 5, r.id);
  }
  for (const id of DERIVED_RULES) assert.match(id, /^[a-z_]+(?:\.[a-z0-9-]+)?$/, id);
  assert.ok(Object.values(OWNER_OF).every((o) => OWNERS.has(o)));
  assert.ok(Object.values(BASE_SEVERITY).every((s) => s >= 1 && s <= 5));
});

// "file symbol" → the file exists and still contains the symbol as a word.
function checkCode(hint, where) {
  const [file, symbol] = hint.split(' ');
  const path = join(ROOT, file);
  assert.ok(existsSync(path), `${where}: ${file} exists`);
  if (!symbol) return;
  const src = readFileSync(path, 'utf8');
  assert.ok(new RegExp(`\\b${symbol.replace(/[$.]/g, '\\$&')}\\b`).test(src), `${where}: ${file} contains ${symbol}`);
}

test('every code hint names an existing file that contains its symbol', () => {
  const withCode = ALL_RULES.filter((r) => r.code);
  assert.ok(withCode.length >= 6);
  for (const r of withCode) checkCode(r.code, r.id);
  for (const [rule, hint] of Object.entries(PREAMBLE_HINTS)) {
    assert.ok(hint.code.length && hint.what, rule);
    for (const c of hint.code) checkCode(c, `PREAMBLE_HINTS ${rule}`);
  }
});

test('TIPS and PREAMBLE_HINTS are keyed by known rules', () => {
  for (const id of [...Object.keys(TIPS), ...Object.keys(PREAMBLE_HINTS)]) assert.ok(FINDING_RULES.includes(id), id);
  for (const id of ['misuse.ref', 'misuse.args', 'misuse.mcp', 'misuse.tabs', 'mk.restricted-start']) assert.ok(PREAMBLE_HINTS[id], id);
  for (const id of ['page.stale-ref', 'page.not-select', 'page.navigating', 'page.dialog-or-closed', 'page.element-soft', 'chrome.restricted', 'misuse.single-tab']) {
    assert.equal(typeof TIPS[id], 'string', id);
  }
});

test('COMPLAINT_RE: Ukrainian and English, Unicode-aware boundaries', () => {
  for (const s of ['не працює', 'Не працює вибір розміру', 'ще раз', 'знову', 'знову-таки не те', 'doesn\'t work', 'it doesnt work', 'try again', 'Wrong button', 'зламалось', 'помилка!', 'не спрацювало']) {
    assert.match(s, COMPLAINT_RE, s);
  }
  for (const s of ['закрити так', 'тест', 'a bugle', 'neпрацює', 'незнову', 'дуже добре', 'thanks, works', 'debugger']) {
    assert.doesNotMatch(s, COMPLAINT_RE, s);
  }
});

test('LOG_NOISE drops routine host.log lines only', () => {
  for (const s of ['relay: connected', 'relay: paired with K7PM-3QWX', 'recording saved /tmp/x.webm', '[claude:12] [session/update] x',
    '[claude:3] Error: Query closed before response received — failed to generate a session title', '[codex:1] Unexpected case foo']) {
    assert.match(s, LOG_NOISE, s);
  }
  for (const s of ['relay: disconnected (1006)', 'uncaught: Error: write EPIPE', '[claude:1] Error: ENOSPC: System limit for number of file watchers reached']) {
    assert.doesNotMatch(s, LOG_NOISE, s);
  }
});

test('COMPONENT_STEMS point the user\'s words at findings', () => {
  for (const s of COMPONENT_STEMS) for (const k of ['kinds', 'categories', 'rules', 'tools']) assert.ok(Array.isArray(s[k]));
  const dropdown = { kind: 'missing_knowledge', category: 'MISSING_KNOWLEDGE', rule: 'mk.dropdown', tools: ['browser_select_option'] };
  assert.ok(componentMatch('не працює вибір розміру', dropdown));
  assert.ok(componentMatch('the dropdown is broken', { kind: 'error', category: 'PAGE_ELEMENT', rule: 'page.not-select', tools: [] }));
  assert.ok(componentMatch('історія не зберігається', { kind: 'probe', category: 'TABHELM_BUG', rule: 'probe.replay' }));
  assert.ok(componentMatch('upload fails', { kind: 'error', category: 'PAGE_ELEMENT', rule: 'page.element', tools: ['browser_upload_file'] }));
  assert.ok(componentMatch('розклад', { kind: 'error', category: 'SCHEDULE_NO_APPROVAL', rule: 'sched.no-approval' }));
  assert.ok(!componentMatch('не працює вибір розміру', { kind: 'error', category: 'AUTH', rule: 'auth.key', tools: [] }));
  assert.ok(!componentMatch('', dropdown));
});

test('ownerFor applies the rule-level owners of spec 6.11', () => {
  assert.equal(ownerFor('TABHELM_BUG', 'probe.replay'), 'tabhelm');
  assert.equal(ownerFor('MISSING_KNOWLEDGE', 'mk.restricted-start'), 'tabhelm');
  assert.equal(ownerFor('MISSING_KNOWLEDGE', 'mk.dropdown'), 'knowledge');
  assert.equal(ownerFor('SKILL_UNUSED', 'skill.unused'), 'knowledge');
  assert.equal(ownerFor('SETUP', 'inv.version-mismatch'), 'setup');
  assert.equal(ownerFor('POLICY', 'critic.fp'), 'setup');
  assert.equal(ownerFor('AGENT_MISUSE', 'preamble_gap'), 'tabhelm');
  assert.equal(ownerFor('AGENT_MISUSE', 'misuse.ref'), 'agent');
  assert.equal(ownerFor('AGENT_CRASH', 'log.agent-crash'), 'agent');
  assert.equal(ownerFor('PAGE_STATE', 'page.navigating'), 'site');
  assert.equal(ownerFor(undefined, undefined), 'tabhelm');
});

const FULL_CTX = {
  tool: 'browser_select_option', host: 'shop.example.com', message: '<ref> is not a <select>; click it and pick the option instead.',
  agent: 'Claude Code', model: 'sonnet', count: 4, chats: 3, agents: 2, category: 'PAGE_ELEMENT', scope: '30d', feature: 'devTools',
  skill: 'shop-dropdowns', entryType: 'ask', hostVersion: '0.29.0', extVersion: '0.30.0', other: { id: 'codex', name: 'Codex' },
  best: { id: 'codex', name: 'Codex' }, installHint: 'npm i -g @openai/codex', rate: 0.42, calls: 10, provider: 'openrouter', code: 1,
  cardKind: 'confirm', cardTitle: 'Allow JavaScript', minutes: 12, bytes: 950_000, chatId: 'c1',
};

function checkTemplate(id, out) {
  assert.equal(typeof out.title, 'string', id);
  assert.ok(out.title.length > 0, `${id}: title`);
  assert.equal(typeof out.explain, 'string', id);
  assert.ok(REMEDY_TYPES.has(out.remedy.type), `${id}: remedy type ${out.remedy.type}`);
  assert.equal(typeof out.remedy.text, 'string', id);
  assert.ok(Array.isArray(out.actions) && out.remedy.actions === out.actions, id);
  const json = JSON.stringify(out);
  assert.doesNotMatch(json, /undefined|null|NaN|\[object /, `${id}: ${json}`);
  for (const a of out.actions) {
    assert.ok(ACTION_KINDS.has(a.kind), `${id}: action ${a.kind}`);
    assert.ok(a.label, `${id}: ${a.kind} has a label`);
    if (a.kind === 'open_settings') {
      const [, flag] = /^experimental:(\w+)$/.exec(a.target) || [];
      assert.ok(a.target === 'skills' || FEATURES.some((f) => f.id === flag), `${id}: settings target ${a.target}`);
    }
    if (a.kind === 'copy_command') assert.ok(a.text, id);
    if (a.kind === 'memory_note') assert.ok(a.host && a.text, id);
  }
}

test('TEMPLATES cover every rule that can produce a finding', () => {
  for (const id of FINDING_RULES) {
    assert.equal(typeof TEMPLATES[id], 'function', `template for ${id}`);
    checkTemplate(id, TEMPLATES[id]({}));
    checkTemplate(id, TEMPLATES[id](FULL_CTX));
    checkTemplate(id, templateFor(id, null));
  }
});

test('templates never show the raw inner text', () => {
  for (const id of FINDING_RULES) {
    const out = JSON.stringify(TEMPLATES[id]({ inner: 'CANARY_INNER This tool needs the "Developer tools" feature, which is off' }));
    assert.ok(!out.includes('CANARY_INNER'), id);
  }
});

test('templateFor falls back by family, then generically', () => {
  assert.match(templateFor('probe.mdx', { entryType: 'video' }).title, /“video” entries/);
  assert.equal(templateFor('sched.other').title, TEMPLATES['sched.no-approval']().title);
  checkTemplate('unknown', templateFor('totally.new', { category: 'PAGE_STATE', tool: 'browser_click', message: 'x' }));
  assert.equal(templateFor('totally.new', { category: 'TABHELM_BUG' }).title, 'Unrecognised error');
  checkTemplate('empty', templateFor(undefined));
});

test('flag.off opens Settings at the flag and never enables it', () => {
  const dev = templateFor('flag.off', { tool: 'browser_fill_form', inner: 'This tool needs the "Developer tools" feature, which is off. The user can enable it.' });
  assert.match(dev.title, /browser_fill_form.*“Developer tools” is off/);
  assert.deepEqual(dev.actions.map((a) => [a.kind, a.target]), [['open_settings', 'experimental:devTools']]);
  const mem = templateFor('flag.off', { message: 'Memory is off. The user can enable it in Settings.' });
  assert.equal(mem.actions[0].target, 'experimental:memory');
  assert.equal(templateFor('flag.off', { feature: 'Developer tools' }).actions[0].target, 'experimental:devTools');
  assert.deepEqual(templateFor('flag.off', {}).actions, []);
  assert.equal(featureOf('This tool needs the "Page scripts & styles" feature, which is off')?.id, 'pageScripts');
  assert.equal(featureOf('nothing here'), null);
});

test('templates follow the spec texts where it fixes them', () => {
  assert.equal(TEMPLATES['mk.dropdown']({ host: 'shop.example.com' }).title, 'shop.example.com: dropdowns are custom widgets, not <select>');
  const mk = TEMPLATES['mk.dropdown']({ host: 'shop.example.com' });
  assert.deepEqual(mk.actions.map((a) => a.kind), ['memory_note', 'skill_draft']);
  assert.equal(mk.actions[0].text, 'On shop.example.com, dropdowns are not <select>: click the field, then click the option text.');
  assert.deepEqual(TEMPLATES['mk.dropdown']({}).actions.map((a) => a.kind), ['skill_draft'], 'no memory note without a host');
  assert.equal(TEMPLATES['bug.invalid-args']({ tool: 'browser_find' }).title, 'browser_find failed inside TabHelm');
  assert.equal(TEMPLATES['sched.no-approval']().actions[0].target, 'experimental:schedules');
  assert.ok(!/auto-approve/i.test(JSON.stringify(TEMPLATES['sched.user-decision']())), 'never suggests auto-approve');
  assert.equal(TEMPLATES['setup.version']({ hostVersion: '0.29.0', extVersion: '0.30.0' }).title, 'Host 0.29.0 and extension 0.30.0 differ');
  assert.equal(TEMPLATES['health.crash']({ agent: 'Codex', count: 3 }).title, 'Codex crashed 3×');
  assert.equal(TEMPLATES['budget']({ agent: 'Built-in' }).remedy.text, 'Split the task (the built-in agent stops at 40 steps).');
  assert.equal(TEMPLATES['inv.too-big']({ count: 2 }).title, '2 chats are too big for the host backup');
  assert.match(TEMPLATES['inv.too-big']({ count: 1, bytes: 2_500_000 }).explain, /slow down/);
  assert.equal(TEMPLATES['timeout']({ tool: 'browser_wait', category: 'TABHELM_BUG' }).remedy.type, 'tabhelm_fix');
  assert.deepEqual(TEMPLATES['health.agent']({ agent: 'X', rate: 0.79, best: { id: 'codex', name: 'Codex' } }).actions.map((a) => a.agentId), ['codex']);
  // By rule, not by count: an unavailable critic is never "blocked actions you then allowed (1×)".
  assert.equal(templateFor('setup.critic', { count: 1 }).title, 'The action critic was unavailable');
  assert.equal(templateFor('critic.fp', { count: 4 }).title, 'The action critic blocked actions you then allowed (4×)');
  for (const rule of ['setup.critic', 'critic.fp']) assert.deepEqual(templateFor(rule, { count: 2 }).actions.map((a) => a.target), ['experimental:critic']);
});

test('taxonomy.js stays pure', () => {
  const src = readFileSync(join(ROOT, 'extension/taxonomy.js'), 'utf8');
  assert.doesNotMatch(src, /(?<!['\w.-])chrome\.\w+|\bdocument\.|Date\.now|new Date\(/);
});

test('pageErrorShape keeps the error type and fixed engine wording only', () => {
  assert.equal(pageErrorShape('Error: User Ivan Petrenko not found\n    at <anonymous>:1:7'), 'Error: …');
  assert.equal(pageErrorShape("TypeError: Cannot read properties of null (reading 'value')"), "TypeError: Cannot read properties of null (reading 'value')");
  assert.equal(pageErrorShape('Uncaught ReferenceError: foo is not defined'), 'ReferenceError: foo is not defined');
  assert.equal(pageErrorShape('Uncaught (in promise) Error: secret 123'), 'Error: …');
  assert.equal(pageErrorShape("DOMException: Failed to execute 'querySelector' on 'Document': '#a b' is not a valid selector."), "DOMException: Failed to execute 'querySelector' on 'Document'");
  // Engine wording only counts for the error type the engine uses for it.
  assert.equal(pageErrorShape('Error: Ivan is not a function'), 'Error: …');
  assert.equal(pageErrorShape('Error: Ivan.Petrenko is not defined'), 'Error: …');
  assert.equal(classify('Error: Client Ivan Petrenko', { tool: 'browser_evaluate' }).inner, 'Error: …');
});
