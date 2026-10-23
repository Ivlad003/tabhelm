// extension/analyzer.js: turns, events, detectors at their thresholds, probes,
// invariants, status and ranking, determinism, and the golden real-shape
// datasets (fixtures/golden*.json, built by fixtures/gen-golden.mjs).
// Run: node --test 'host/scripts/selfanalysis/*.test.js'

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  THRESHOLDS, analyze, isTestChat, segmentTurns, extractEvents, markRecovery, detectSequences,
  matchesHost, scoreFinding, nextState, skillDraft,
} from '../../../extension/analyzer.js';
import { buildGolden, FILES, serialize } from './fixtures/gen-golden.mjs';
import { digestLog, readLogWindow } from '../../src/log-digest.js';
import { norm } from '../../../extension/redact.js';

const here = dirname(fileURLToPath(import.meta.url));
const ANALYZER_SRC = readFileSync(join(here, '../../../extension/analyzer.js'), 'utf8');
const LOG = digestLog(readLogWindow(join(here, 'fixtures/host.log')));
const GOLDEN = JSON.parse(readFileSync(FILES.legacy, 'utf8'));
const REAL = JSON.parse(readFileSync(FILES.real, 'utf8'));

const NOW = '2026-10-23T12:00:00.000Z';
const T0 = '2026-10-20T10:00:00.000Z';
const ENV = {
  ext: '0.31.0', host: '0.31.0', chrome: '141', platform: 'linux', features: ['selfAnalysis'],
  agents: [{ id: 'claude', name: 'Claude Code', installHint: 'npm i -g claude' }, { id: 'codex', name: 'Codex', installHint: 'npm i -g codex' }],
};
const iso = (ms) => new Date(ms).toISOString();

// A chat journal written the way the panel writes it. Instrumented chats carry
// turn ids, stopReason and action hosts; legacy chats do not.
function chat(id, opts = {}) {
  const { url = 'https://shop.example.com/item', start = T0, tabId = 100, agent = 'Claude Code', model = 'sonnet', instrumented = true, ...meta } = opts;
  let ms = Date.parse(start);
  let turn = 0;
  const journal = [];
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  })();
  const b = {
    push(type, data = {}, gap = 2) {
      ms += gap * 1000;
      const e = { ts: iso(ms), type, ...data };
      if (instrumented && turn && !('turn' in data)) e.turn = turn;
      journal.push(e);
      return b;
    },
    user(text = 'Do the task.', data = {}) {
      if (instrumented && !data.queued) turn++;
      return b.push('user', { text, attachments: [], ...data }, 10);
    },
    connect(data = {}) {
      return b.push('agent_connected', { agent, ...data });
    },
    act(tool, args = {}, error = null, data = {}) {
      return b.push('action', { agent, tool, args, desc: tool, ok: !error, error, ...(instrumented ? { host } : {}), ...data });
    },
    ok(text = 'Done.', data = {}) {
      return b.push('agent', { agent, model, text, thought: '', failure: null, ...(instrumented ? { stopReason: 'end_turn' } : {}), ...data }, 3);
    },
    fail(failure, data = {}) {
      return b.push('agent', { agent, model, text: '', thought: '', failure, ...(instrumented ? { stopReason: null } : {}), ...data }, 0);
    },
    notice(text, error = true, gap = 0) {
      return b.push('notice', { text, error }, gap);
    },
    wait(sec) {
      ms += sec * 1000;
      return b;
    },
    chat() {
      return { id, created: Date.parse(start), updated: ms, url, tabId, agent, folder: null, journal, ...meta };
    },
  };
  return b;
}

const run = (chats, options = {}, extra = {}) => analyze({ chats, now: NOW, env: ENV, options: { scope: 'all', ...options }, ...extra });
const rules = (r) => r.findings.map((f) => f.rule);
const find = (r, rule) => r.findings.find((f) => f.rule === rule);
const findAll = (r, rule) => r.findings.filter((f) => f.rule === rule);
const day = (n) => iso(Date.parse(T0) + n * 3_600_000);

// The real taxonomy texts the detectors see.
const NOT_SELECT = 'e21 is not a <select>; click it and pick the option instead.';
const ZERO_SIZE = 'Element e5 is not visible (zero size).';
const BAD_REF = 'Invalid ref "button". Use a ref from browser_snapshot or browser_find (e.g. e12).';
const ABOUT_BLANK = 'Chrome does not allow extensions to control about:blank. Navigate to a normal web page first.';

describe('turns and outcomes', () => {
  test('legacy chats: turns start at user messages, queued notes merge, no outcome is legacy_unknown', () => {
    const c = chat('L1', { instrumented: false })
      .connect().user('first').act('browser_snapshot').act('browser_click', { ref: 'e1' }, 'Ref e1 is stale or unknown. Take a new browser_snapshot.')
      .user('again').user('note', { queued: true }).act('browser_snapshot')
      .chat();
    const turns = segmentTurns(c);
    assert.equal(turns.length, 2);
    assert.deepEqual(turns.map((t) => [t.instrumented, t.outcome]), [[false, 'legacy_unknown'], [false, 'legacy_unknown']]);
    assert.equal(turns[1].entries.filter(([, e]) => e.type === 'user').length, 2, 'the queued note joins the open turn');
    const r = run([c]);
    assert.equal(r.summary.outcomes.failed, 0);
    assert.equal(r.summary.outcomes.legacy_unknown, 2);
    assert.equal(r.coverage.outcomes, 0);
    assert.ok(!rules(r).includes('inv.lost-outcome'), 'legacy turns never count as lost');
  });

  test('instrumented chat with a missing agent entry is inv.lost-outcome', () => {
    const c = chat('I1').user().connect().act('browser_snapshot').user().act('browser_snapshot').ok().chat();
    const turns = segmentTurns(c);
    assert.deepEqual(turns.map((t) => t.outcome), ['unknown', 'ok']);
    const f = find(run([c]), 'inv.lost-outcome');
    assert.equal(f.count, 1);
    assert.equal(f.severity, 2);
    assert.equal(f.owner, 'tabhelm');
    // The task running right now is not lost.
    assert.ok(!rules(run([chat('I2').user().connect().act('browser_snapshot').chat()], {}, { live: { busy: true, connected: true } })).includes('inv.lost-outcome'));
    // Only the panel's own chat is running, even when another chat has newer entries.
    const mine = chat('I3', { tabId: 1 }).user().connect().act('browser_snapshot').chat();
    const other = chat('I4', { tabId: 2, start: '2026-10-20T11:00:00.000Z' }).user().connect().act('browser_snapshot').user().ok().chat();
    const both = run([mine, other], {}, { live: { busy: true, chatId: 'I3' } });
    assert.equal(find(both, 'inv.lost-outcome').count, 1, 'only I4\'s unfinished first task');
    assert.deepEqual(find(both, 'inv.lost-outcome').evidence.map((e) => e.chatId), ['I4']);
  });

  test('outcomes: ok, failed, declined, cancelled, panel closed, start failed', () => {
    const outcome = (c) => segmentTurns(c)[0].outcome;
    assert.equal(outcome(chat('o1').user().connect().ok().chat()), 'ok');
    assert.equal(outcome(chat('o2').user().connect().fail('ACP connection closed').chat()), 'failed');
    assert.equal(outcome(chat('o3').user().connect().act('browser_click', { ref: 'e1' }, 'The user did not allow acting on this site.').fail('cancelled').chat()), 'declined');
    assert.equal(outcome(chat('o4').user().connect().ok('', { stopReason: 'cancelled' }).chat()), 'cancelled');
    assert.equal(outcome(chat('o5').user().connect().ok('').notice('Stopped', false).chat()), 'cancelled');
    assert.equal(outcome(chat('o6', { instrumented: false }).user().connect().user('stop, do X', { queued: true }).ok('').chat()), 'cancelled');
    assert.equal(outcome(chat('o7').user().connect().fail('panel closed').chat()), 'panel_closed');
    // start_failed: a user entry, a startup failure notice and no agent_connected.
    const start = chat('o8').user().notice('Claude Code exited during startup. Check that it is installed and logged in.').chat();
    assert.equal(outcome(start), 'start_failed');
    assert.equal(run([start]).summary.outcomes.start_failed, 1);
  });

  // R23: any real error that stopped the start, not just crash/setup/auth/host.
  test('start_failed from a network or quota error before the agent connected; never a lost outcome', () => {
    const outcome = (c) => segmentTurns(c)[0].outcome;
    const net = chat('s1').user('book a table').notice('Cannot list OpenRouter models: fetch failed').chat();
    assert.equal(outcome(net), 'start_failed');
    assert.equal(outcome(chat('s2').user().notice('429 Too Many Requests: rate limit exceeded').chat()), 'start_failed');
    const r = run([net]);
    assert.ok(!rules(r).includes('inv.lost-outcome'));
    assert.ok(rules(r).includes('net'));
    // A declined attachment is not a failed start; a task that already worked is not one either.
    assert.equal(outcome(chat('s3').user().notice('Up to 10 files per message.').chat()), 'unknown');
    const later = chat('s4').user().connect().ok().user().act('browser_click', { ref: 'e1' }, ZERO_SIZE).chat();
    assert.equal(segmentTurns(later)[1].outcome, 'unknown');
    // The task running right now did start: an error notice before its first step does not end it.
    const busy = chat('s5').user().connect().act('browser_snapshot').ok().user('second').notice('Recording failed: Could not start the tab capture').chat();
    const now = run([busy], { scope: 'chat', chatId: 's5' }, { live: { busy: true, connected: true } });
    assert.deepEqual([now.summary.outcomes.start_failed, now.summary.outcomes.unknown], [0, 1]);
    assert.ok(!rules(now).includes('inv.lost-outcome'));
    assert.deepEqual(find(now, 'unclassified').recovered, { yes: 0, no: 0 }, 'not marked unrecovered by a failed start');
  });

  // R25: the turn's own failure decides; an earlier decline does not hide a crash.
  test('a crash or a lost host after a declined step is failed, not declined', () => {
    const outcome = (c) => segmentTurns(c)[0].outcome;
    const upload = (end) => end(chat('dc').user().connect()
      .act('browser_upload_file', { ref: 'e3', paths: ['/x'] }, 'The user did not allow this upload.')
      .act('browser_click', { ref: 'e4' }).act('browser_click', { ref: 'e5' })).chat();
    assert.equal(outcome(upload((b) => b.fail('Agent exited (SIGKILL)'))), 'failed');
    assert.equal(outcome(upload((b) => b.fail('host disconnected').notice('Cannot reach the TabHelm host: gone.'))), 'failed');
    assert.equal(run([upload((b) => b.fail('Agent exited (SIGKILL)'))]).summary.outcomes.failed, 1);
    // A failure that says nothing classifiable keeps the decline before it.
    assert.equal(outcome(upload((b) => b.fail('something odd'))), 'declined');
  });

  test('turns with no outcome are explained by the host.log join (approximate)', () => {
    const digest = (events) => ({ v: 1, events, groups: [], runs: [], meta: {} });
    const c = chat('J1', { tabId: 41, start: '2026-10-20T10:20:00.000Z' }).user().connect().act('browser_snapshot').chat();
    const crashed = segmentTurns(c, digest([{ ts: '2026-10-20T10:21:00.000Z', kind: 'prompt_failed', tabId: 41, agent: null, code: null, gid: 'g1' }]))[0];
    assert.deepEqual([crashed.outcome, crashed.approximate], ['crashed', true]);
    const killed = segmentTurns(c, digest([{ ts: '2026-10-20T10:21:00.000Z', kind: 'agent_exit', tabId: 41, agent: 'claude', code: 'SIGKILL', gid: 'g2' }]))[0];
    assert.equal(killed.outcome, 'crashed');
    const stopped = segmentTurns(c, digest([
      { ts: '2026-10-20T10:21:00.000Z', kind: 'stopping_agent', tabId: 41, agent: 'claude', code: null, gid: null },
      { ts: '2026-10-20T10:21:03.000Z', kind: 'agent_exit', tabId: 41, agent: 'claude', code: 'SIGKILL', gid: null },
    ]))[0];
    assert.equal(stopped.outcome, 'unknown', 'a SIGKILL 3 s after stopping is dispose(), not a crash');
    const closed = segmentTurns(c, digest([{ ts: '2026-10-20T10:21:30.000Z', kind: 'ext_disconnected', tabId: null, agent: null, code: null, gid: null }]))[0];
    assert.deepEqual([closed.outcome, closed.approximate], ['panel_closed', true]);
    const far = segmentTurns(c, digest([{ ts: '2026-10-20T11:30:00.000Z', kind: 'prompt_failed', tabId: 41, agent: null, code: null, gid: 'g1' }]))[0];
    assert.equal(far.outcome, 'unknown', 'outside [start − 5 s, last + 120 s]');
    assert.equal(run([c], {}, { logDigest: digest([{ ts: '2026-10-20T10:21:00.000Z', kind: 'prompt_failed', tabId: 41, agent: null, code: null, gid: 'g1' }]) }).coverage.logJoined, 1);
  });

  test('turn version: agent_connected.ext, else versionHistory', () => {
    const a = chat('V1').user().connect({ ext: '0.31.2', host: '0.31.2' }).ok().chat();
    assert.equal(segmentTurns(a)[0].version, '0.31.2');
    const b = chat('V2', { instrumented: false }).user().connect().ok().chat();
    const history = [{ v: '0.30.0', at: '2026-10-01T00:00:00Z' }, { v: '0.31.0', at: '2026-10-20T09:00:00Z' }, { v: '0.32.0', at: '2026-10-22T00:00:00Z' }];
    assert.equal(segmentTurns(b, null, { versionHistory: history })[0].version, '0.31.0');
  });
});

describe('events, dedupe and recovery', () => {
  test('a host error written as notice and failure counts once; so does a page script result and its notice', () => {
    const c = chat('D1')
      .user().connect().notice('Agent is still working on the previous message').fail('Agent is still working on the previous message')
      .user().connect().push('page_script', { name: 'My script', ok: false, error: 'ReferenceError: foo is not defined' }).notice('Script “My script” failed: ReferenceError: foo is not defined').ok()
      .chat();
    const events = extractEvents(c, segmentTurns(c));
    assert.deepEqual(events.map((e) => [e.source, e.rule]), [['F', 'bug.desync'], ['P', 'misuse.page-script']]);
  });

  test('two failed actions with the same text are two failures', () => {
    const c = chat('D2').user().connect().act('browser_click', { ref: 'e5' }, ZERO_SIZE).act('browser_click', { ref: 'e6' }, ZERO_SIZE.replace('e5', 'e6')).ok().chat();
    const events = extractEvents(c, segmentTurns(c));
    assert.equal(events.length, 2);
    assert.equal(events[0].norm, events[1].norm, 'refs do not change the normalized text');
  });

  // R26: the panel writes "host disconnected" as the failure and a longer notice.
  test('a lost host written as failure and notice is one link.host finding', () => {
    const c = chat('hd').user().connect().act('browser_snapshot')
      .fail('host disconnected').notice('Cannot reach the TabHelm host: Native host has exited.. Run "npm run install-host" and reopen the panel.').chat();
    assert.deepEqual(extractEvents(c, segmentTurns(c)).map((e) => [e.source, e.rule]), [['F', 'link.host']]);
    for (const scope of ['all', 'chat']) assert.equal(findAll(run([c], { scope, chatId: 'hd' }), 'link.host').length, 1, scope);
    // Two different failed steps of one rule stay two.
    const two = chat('hd2').user().connect().act('browser_click', { ref: 'e5' }, ZERO_SIZE).act('browser_click', { ref: 'e6' }, 'Element e6 is not a file input.').ok().chat();
    assert.equal(extractEvents(two, segmentTurns(two)).length, 2);
  });

  // R14: the cut must not split a host, or hideSites cannot alias it.
  test('a long message is cut before a host name, never inside it', () => {
    const tail = 'https://portal.privatbank.ua/clients/history';
    const head = 'The payment form did not accept the card because the confirmation response never came in from ';
    for (const pad of [40, 52, 60, 66, 70]) {
      const error = `${head}${'x'.repeat(pad)} ${tail}`;
      const c = chat(`pb${pad}`).user().connect().act('browser_click', { ref: 'e5' }, error).ok().chat();
      const [ev] = extractEvents(c, segmentTurns(c));
      assert.ok(ev.norm.length <= THRESHOLDS.maxMessage, ev.norm);
      // Either the whole host survives (and is aliased later) or none of it.
      const host = /portal|privatbank/.test(ev.norm);
      assert.ok(!host || ev.norm.includes('portal.privatbank.ua'), ev.norm);
      // 52 and 60 put a plain 160-character cut inside the host.
      if (pad === 52 || pad === 60) assert.match(ev.norm, / x+…$/);
      // Elsewhere the cut is norm()'s own.
      else assert.equal(ev.norm, norm(error));
    }
    // Short messages are untouched; a host the host.log cut split is dropped.
    const short = chat('pb').user().connect().act('browser_click', { ref: 'e5' }, `Response from ${tail} failed`).ok().chat();
    assert.equal(extractEvents(short, segmentTurns(short))[0].norm, 'Response from portal.privatbank.ua failed');
    const digest = { v: 1, events: [], runs: [], meta: {}, groups: [{ kind: 'unknown_type', agent: null, code: null, text: 'unknown message type x from portal.privatb…', frame: null, count: 1, first: day(0), last: day(0), tabs: [] }] };
    const logMessage = (text) => find(run([chat('lg').user().connect().ok().chat()], {}, { logDigest: { ...digest, groups: [{ ...digest.groups[0], text }] } }), 'log.unknown-type').message;
    assert.equal(logMessage(digest.groups[0].text), 'unknown message type x from…');
    // A line the host cut at 160 may end in a host that lost its dot: its last word goes.
    const cutLine = (frag) => `${'unknown message type x '.padEnd(159 - frag.length, 'w')} ${frag}`;
    // ("e1" grows into "<ref>" in norm(), which pushes that word back across 160.)
    for (const frag of ['privatbank…', 'privatbank.…', 'portal.privatbank.u…', 'e1 privatbank…']) {
      assert.equal(cutLine(frag).length, 160);
      assert.doesNotMatch(logMessage(cutLine(frag)), /privat/, frag);
    }
    assert.equal(logMessage('unknown message type Loading…'), 'unknown message type Loading…', 'a short line was not cut');
    // Panel and service-worker errors are stored cut to 200 characters; numbers
    // shrink in norm(), so the cut end can land inside 160.
    const at200 = `${'Error 1234567 '.repeat(13)}from privatbank-online.example.ua`.slice(0, 200);
    const sw = find(run([chat('sw').user().connect().ok().chat()], {}, { swErrors: [{ ts: day(0), message: at200, frame: 'background.js:9' }] }), 'rt.sw-error');
    assert.match(sw.message, /from…$/);
    const panel = chat('pe').user().connect().push('panel_error', { where: 'window', message: at200, frame: 'sidepanel.js:9' }).ok().chat();
    assert.match(extractEvents(panel, segmentTurns(panel)).find((e) => e.source === 'E').norm, /from…$/);
  });

  test('one crash per turn, however many ways it is announced', () => {
    const c = chat('D3').user().connect().notice('ACP connection closed').fail('ACP connection closed').notice('Agent exited (SIGKILL)', true, 1).chat();
    const events = extractEvents(c, segmentTurns(c));
    assert.deepEqual(events.map((e) => [e.source, e.norm]), [['F', 'ACP connection closed']]);
  });

  test('recovery marking', () => {
    const recovered = (c) => markRecovery(segmentTurns(c), extractEvents(c, segmentTurns(c))).map((e) => e.recovered);
    const turnsOf = (c) => segmentTurns(c);
    const mark = (c) => {
      const turns = turnsOf(c);
      return markRecovery(turns, extractEvents(c, turns)).map((e) => e.recovered);
    };
    assert.deepEqual(mark(chat('R1').user().connect().act('browser_click', { ref: 'e5' }, ZERO_SIZE).act('browser_click', { ref: 'e7' }).ok().chat()), [true]);
    assert.deepEqual(mark(chat('R2').user().connect().act('browser_click', { ref: 'e5' }, ZERO_SIZE).act('browser_click', { ref: 'e7' }).fail('stopped early (max_tokens)').chat()), [false, false]);
    assert.deepEqual(mark(chat('R3', { instrumented: false }).user().act('browser_click', { ref: 'e5' }, ZERO_SIZE).chat()), [null]);
    assert.deepEqual(mark(chat('R4', { instrumented: false }).user().act('browser_click', { ref: 'e5' }, ZERO_SIZE).act('browser_click', { ref: 'e6' }, ZERO_SIZE).act('browser_click', { ref: 'e7' }, ZERO_SIZE).chat()), [false, false, false]);
    assert.deepEqual(recovered(chat('R5').user().connect().act('browser_click', { ref: 'e5' }, ZERO_SIZE).ok().chat()), [null], 'no later success');
  });

  test('a timeout nobody waited for is a TabHelm hang; with a confirmation open it is not', () => {
    const hang = chat('E1').user().connect().act('browser_click', { ref: 'e5' }, 'Tool "browser_click" timed out after 1800s').fail('x').chat();
    const f = run([hang]).findings.find((x) => x.message?.startsWith('Tool'));
    assert.deepEqual([f.rule, f.category, f.owner, f.confidence], ['timeout', 'TABHELM_BUG', 'tabhelm', 'medium']);
    assert.match(f.title, /hung inside TabHelm/);
    const waited = chat('E2').user().connect().push('confirm', { title: 'Allow?', detail: 'x', answer: 'Allow once' }).act('browser_click', { ref: 'e5' }, 'Tool "browser_click" timed out after 1800s').fail('x').chat();
    const g = run([waited]).findings.find((x) => x.message?.startsWith('Tool'));
    assert.deepEqual([g.category, g.owner], ['TIMEOUT', 'setup']);
  });

  test('losing the host right after a host crash is that crash', () => {
    const c = chat('E3', { start: '2026-10-20T10:04:40.000Z' }).user().connect().notice('Native host has exited.').fail('host disconnected').chat();
    const digest = { v: 1, events: [{ ts: '2026-10-20T10:05:00.000Z', kind: 'uncaught', tabId: null, agent: null, code: 'EPIPE', gid: 'g1' }], groups: [], runs: [], meta: {} };
    const link = run([c], {}, { logDigest: digest }).findings.filter((f) => f.rule === 'link.host');
    assert.ok(link.length && link.every((f) => f.category === 'TABHELM_BUG' && f.owner === 'tabhelm'));
    assert.ok(run([c]).findings.filter((f) => f.rule === 'link.host').every((f) => f.category === 'HOST_LINK'));
  });
});

describe('test chats', () => {
  test('isTestChat: ephemeral localhost port, chat.test, temp folder, e2e video', () => {
    assert.equal(isTestChat({ url: 'http://127.0.0.1:40000/form', journal: [] }), true);
    assert.equal(isTestChat({ url: 'http://localhost:8080/form', journal: [] }), false);
    assert.equal(isTestChat({ url: 'http://[::1]:39001/', journal: [] }), true);
    assert.equal(isTestChat({ url: 'https://example.com:40000/', journal: [] }), false);
    assert.equal(isTestChat({ test: true, journal: [] }), true);
    assert.equal(isTestChat({ folder: '/tmp/tabhelm-e2e-1/demo', journal: [] }), true);
    assert.equal(isTestChat({ journal: [{ type: 'video', path: '/tmp/tabhelm-e2e-7/videos/a.webm' }] }), true);
    assert.equal(isTestChat({ url: 'https://shop.example.com/', journal: [{ type: 'video', path: '/home/u/Videos/a.webm' }] }), false);
  });

  test('test chats are left out unless asked for, and counted', () => {
    const t = chat('T1', { url: 'http://127.0.0.1:40000/x' }).user().connect().act('browser_click', {}, ZERO_SIZE).fail('Internal error').chat();
    const real = chat('T2').user().connect().ok().chat();
    const r = run([t, real]);
    assert.equal(r.scope.chats, 1);
    assert.equal(r.scope.excludedTests, 1);
    assert.deepEqual(rules(r), ['inv.test-chats']);
    assert.ok(run([t, real], { includeTests: true }).findings.some((f) => f.rule === 'crash.agent'));
  });

  test('the chat being diagnosed is analysed even when it is a test chat', () => {
    const t = chat('T1', { url: 'http://127.0.0.1:40000/x' }).user().connect().act('browser_click', {}, ZERO_SIZE).fail('Internal error').chat();
    const r = run([t], { scope: 'chat', chatId: 'T1' });
    assert.equal(r.scope.chats, 1);
    assert.equal(r.scope.excludedTests, 0);
    assert.ok(r.findings.some((f) => f.rule === 'crash.agent'));
  });
});

// Each detector at its threshold and one below (spec 12.1 item 7).
describe('detector thresholds', () => {
  const loopOf = (c) => detectSequences(segmentTurns(c)).filter((h) => h.type === 'LOOP').flatMap((h) => h.reasons);

  // Repeats count only when they fail: the same call working again (paging,
  // "Load more") is progress, not a loop.
  test('LOOP: same failing call 2 vs 3; the same call working 3× is not a loop', () => {
    const calls = (n, error = ZERO_SIZE) => {
      const b = chat('L').user().connect();
      for (let i = 0; i < n; i++) b.act('browser_click', { ref: 'e5' }, error).act('browser_snapshot');
      return b.ok().chat();
    };
    assert.deepEqual(loopOf(calls(2)), []);
    assert.deepEqual(loopOf(calls(3)), ['same_call']);
    assert.deepEqual(loopOf(calls(3, null)), []);
  });

  test('LOOP: same tool failing 4 vs 5 in a row (typing field after field is exempt); working runs are not loops', () => {
    const runOf = (n, tool = 'browser_scroll', error = (i) => `Element e${i} is not visible (zero size).`) => {
      const b = chat('L').user().connect();
      for (let i = 0; i < n; i++) b.act(tool, { direction: 'down', amount: i, ref: `e${i}`, text: `t${i}` }, error(i));
      return b.ok().chat();
    };
    assert.deepEqual(loopOf(runOf(4)), []);
    assert.deepEqual(loopOf(runOf(5)), ['same_tool_run']);
    assert.deepEqual(loopOf(runOf(6, 'browser_type')), []);
    assert.deepEqual(loopOf(runOf(6, 'browser_scroll', () => null)), []);
    // One step that works in the middle breaks the run.
    assert.deepEqual(loopOf(runOf(6, 'browser_click', (i) => (i === 2 ? null : `Element e${i} is not visible (zero size).`))), []);
  });

  // R21: everyday successful tasks repeat a tool on purpose.
  test('LOOP: reading, list picking, ticking boxes and filling selects that all work are not loops', () => {
    const tasks = {
      read: (b) => b.act('browser_scroll', { direction: 'down' }).act('browser_get_text', {}).act('browser_scroll', { direction: 'down' }).act('browser_get_text', {})
        .act('browser_scroll', { direction: 'down' }).act('browser_get_text', {}),
      list: (b) => b.act('browser_press_key', { key: 'ArrowDown' }).act('browser_press_key', { key: 'ArrowDown' }).act('browser_press_key', { key: 'ArrowDown' }).act('browser_press_key', { key: 'Enter' }),
      boxes: (b) => [1, 2, 3, 4, 5].reduce((x, i) => x.act('browser_click', { ref: `e${i}` }), b),
      selects: (b) => [1, 2, 3, 4, 5].reduce((x, i) => x.act('browser_select_option', { ref: `e${i}`, values: ['A'] }), b),
      // A snapshot before every step and one to check the result: 6 of 11.
      looks: (b) => [1, 2, 3, 4, 5].reduce((x, i) => x.act('browser_snapshot').act('browser_click', { ref: `e${i}` }), b).act('browser_snapshot'),
    };
    for (const [name, steps] of Object.entries(tasks)) {
      const c = steps(chat(name).user().connect().act('browser_snapshot')).ok().chat();
      assert.deepEqual(loopOf(c), [], name);
      assert.ok(!rules(run([c, { ...c, id: `${name}2` }])).includes('derived.loop'), `${name} (history)`);
      assert.ok(!rules(run([c], { scope: 'chat', chatId: name })).includes('derived.loop'), `${name} (chat)`);
    }
  });

  test('LOOP: failed actions 7 vs 8', () => {
    const fails = (n) => {
      const b = chat('L').user().connect();
      for (let i = 0; i < n; i++) b.act(i % 2 ? 'browser_hover' : 'browser_click', { ref: `e${i}` }, `Element e${i} is not visible (zero size).`);
      return b.ok().chat();
    };
    assert.deepEqual(loopOf(fails(7)), []);
    assert.deepEqual(loopOf(fails(8)), ['many_failures']);
  });

  test('LOOP: snapshot share with 10 vs 11 actions in a task that did not succeed; max_turn_requests', () => {
    const share = (n, end = (b) => b.fail('stopped early (max_tokens)')) => {
      const b = chat('L').user().connect();
      for (let i = 0; i < n; i++) (i % 2 === 0 || i === n - 1) ? b.act('browser_snapshot') : b.act('browser_click', { ref: `e${i}` });
      return end(b).chat();
    };
    assert.deepEqual(loopOf(share(10)), [], '6 of 10 is not enough actions');
    assert.deepEqual(loopOf(share(11)), ['snapshot_share']);
    assert.deepEqual(loopOf(share(11, (b) => b.ok())), [], 'a task that worked with every step made progress');
    assert.deepEqual(loopOf(chat('L').user().connect().act('browser_snapshot').fail('stopped early (max_turn_requests)', { stopReason: 'max_turn_requests' }).chat()), ['max_turn_requests']);
    // One finding per (agent, host), also in the per-chat scope.
    const r = run([share(11)], { scope: 'chat', chatId: 'L' });
    assert.equal(find(r, 'derived.loop').count, 1);
    assert.equal(find(r, 'derived.loop').owner, 'agent');
  });

  test('IGNORED_SNAPSHOT: 3 events in 1 chat (none) vs 2 chats', () => {
    const nav = (id, n) => {
      const b = chat(id).user().connect();
      for (let i = 0; i < n; i++) b.act('browser_navigate', { url: `https://shop.example.com/${i}` }).act('browser_click', { ref: `e${i}` });
      return b.act('browser_navigate', { url: 'https://shop.example.com/x' }).act('browser_snapshot').act('browser_click', { ref: 'e9' }).ok().chat();
    };
    assert.equal(detectSequences(segmentTurns(nav('a', 3))).filter((h) => h.type === 'IGNORED_SNAPSHOT').length, 3);
    assert.ok(!rules(run([nav('a', 3)])).includes('derived.ignored-snapshot'));
    const f = find(run([nav('a', 2), nav('b', 1)]), 'derived.ignored-snapshot');
    assert.equal(f.count, 3);
    assert.equal(f.confidence, 'medium');
    const stale = chat('c').user().connect().act('browser_navigate', { url: 'https://shop.example.com/' }).act('browser_click', { ref: 'e1' }, 'Ref e1 is stale or unknown. Take a new browser_snapshot.').ok().chat();
    assert.equal(find(run([nav('a', 1), nav('b', 1), stale]), 'derived.ignored-snapshot').confidence, 'high');
  });

  test('MK-A: 3 events in 1 chat vs 2 chats', () => {
    const fails = (id, n) => {
      const b = chat(id).user().connect();
      for (let i = 0; i < n; i++) b.act('browser_click', { ref: `e${i}` }, `Element e${i} is not visible (zero size).`);
      return b.act('browser_click', { ref: 'e9' }).ok().chat();
    };
    assert.ok(!rules(run([fails('a', 3)])).includes('mk.repeat'));
    const f = find(run([fails('a', 2), fails('b', 1)]), 'mk.repeat');
    assert.deepEqual([f.count, f.chats, f.owner, f.confidence, f.hosts[0], f.tools[0]], [3, 2, 'knowledge', 'medium', 'shop.example.com', 'browser_click']);
    assert.ok(!rules(run([fails('a', 2), fails('b', 1)])).includes('page.element'), 'the cluster is absorbed');
    assert.equal(find(run([fails('a', 1), fails('b', 1), fails('c', 1)]), 'mk.repeat').confidence, 'high');
  });

  test('MK-B: page.not-select 1 vs 2 on one host (also per chat)', () => {
    const one = chat('a').user().connect().act('browser_select_option', { ref: 'e21', values: ['M'] }, NOT_SELECT).act('browser_click', { ref: 'e21' }).ok().chat();
    const two = chat('b').user().connect().act('browser_select_option', { ref: 'e21', values: ['M'] }, NOT_SELECT).act('browser_select_option', { ref: 'e21', values: ['L'] }, NOT_SELECT).act('browser_click', { ref: 'e21' }).ok().chat();
    assert.ok(!rules(run([one], { scope: 'chat', chatId: 'a' })).includes('mk.dropdown'));
    const f = find(run([two], { scope: 'chat', chatId: 'b' }), 'mk.dropdown');
    assert.deepEqual([f.severity, f.owner, f.confidence, f.count], [3, 'knowledge', 'high', 2]);
    assert.ok(f.remedy.actions.some((a) => a.kind === 'memory_note' && a.host === 'shop.example.com'));
    assert.ok(rules(run([one, chat('c').user().connect().act('browser_select_option', { ref: 'e2' }, NOT_SELECT).ok().chat()])).includes('mk.dropdown'));
  });

  test('MK-B: the same dropdown failures are not also reported as a loop', () => {
    const b = chat('d').user().connect().act('browser_snapshot');
    for (let i = 0; i < 3; i++) b.act('browser_select_option', { ref: 'e21', values: ['M'] }, NOT_SELECT);
    const r = run([b.act('browser_click', { ref: 'e21' }).ok().chat()], { scope: 'chat', chatId: 'd' });
    assert.ok(rules(r).includes('mk.dropdown'));
    assert.ok(!rules(r).includes('derived.loop'));
    // Without the dropdown explanation, the same repetition is a loop.
    const c = chat('e').user().connect().act('browser_snapshot');
    for (let i = 0; i < 3; i++) c.act('browser_click', { ref: 'e9' }, 'Element is covered by another element');
    assert.ok(rules(run([c.ok().chat()], { scope: 'chat', chatId: 'e' })).includes('derived.loop'));
  });

  test('MK-C: hand-offs in 1 vs 2 chats on one host', () => {
    const human = (id) => chat(id).user().connect().push('ask', { kind: 'human', message: 'Solve the captcha' }).ok().chat();
    assert.ok(!rules(run([human('a')])).includes('mk.handoff'));
    const f = find(run([human('a'), human('b')]), 'mk.handoff');
    assert.deepEqual([f.count, f.severity, f.confidence], [2, 4, 'medium']);
    assert.ok(f.remedy.actions.some((a) => a.kind === 'open_chat' && a.chatId));
    const skipped = (id, n) => chat(id).user().connect().push('ask', { kind: 'guide', answer: `Finished (${n} skipped)` }).ok().chat();
    assert.ok(!rules(run([skipped('a', 0), skipped('b', 0)])).includes('mk.handoff'), '"0 skipped" is not a hand-off');
    assert.ok(rules(run([skipped('a', 1), skipped('b', 2)])).includes('mk.handoff'));
  });

  test('MK-D: a Ukrainian complaint after a failed turn; not after an ok turn; not after 11 minutes', () => {
    const after = (id, { failed = true, wait = 60 } = {}) => {
      const b = chat(id).user().connect();
      if (failed) b.act('browser_click', { ref: 'e1' }, ZERO_SIZE).fail('stopped early (max_tokens)');
      else b.act('browser_click', { ref: 'e1' }).ok();
      return b.wait(wait).user('не працює, спробуй ще раз').connect().ok().chat();
    };
    const f = find(run([after('a'), after('b')]), 'mk.correction');
    assert.deepEqual([f.count, f.confidence, f.hosts[0]], [2, 'low', 'shop.example.com']);
    assert.ok(!rules(run([after('a', { failed: false }), after('b', { failed: false })])).includes('mk.correction'));
    assert.ok(!rules(run([after('a', { wait: 660 }), after('b', { wait: 660 })])).includes('mk.correction'));
    assert.ok(!rules(run([after('a')])).includes('mk.correction'), 'one turn is below the threshold');
    assert.equal(find(run(['a', 'b', 'c', 'd'].map((id) => after(id))), 'mk.correction').confidence, 'medium');
  });

  test('MK-E: a missing skill', () => {
    const r = run([chat('a').user().connect().act('skill_read', { name: 'checkout' }, 'No skill named "checkout". Available: shop-tips').ok().chat()]);
    assert.deepEqual([find(r, 'mk.no-skill').owner, find(r, 'mk.no-skill').count], ['knowledge', 1]);
    assert.ok(!rules(r).includes('misuse.no-skill'));
  });

  test('MK-F: tasks that start on about:blank in 1 vs 2 chats', () => {
    const blank = (id) => chat(id, { url: 'about:blank' }).user().connect().act('browser_click', { ref: 'e1' }, ABOUT_BLANK).act('browser_navigate', { url: 'https://shop.example.com/' }).ok().chat();
    assert.ok(!rules(run([blank('a')])).includes('mk.restricted-start'));
    const f = find(run([blank('a'), blank('b')]), 'mk.restricted-start');
    assert.deepEqual([f.owner, f.severity, f.code], ['tabhelm', 3, 'host/src/session.js BROWSER_PREAMBLE']);
  });

  // The registrable label of rozetka.com.ua is "rozetka".
  const SKILL = { name: 'rozetka-checkout', desc: 'How to check out' };
  const SHOP = 'https://rozetka.com.ua/item/1';

  test('skill.unused: read before vs after the first failure; needs 2 turns', () => {
    const turn = (id, { readFirst }) => {
      const b = chat(id, { url: SHOP }).user().connect({ skills: ['rozetka-checkout'] });
      if (readFirst) b.act('skill_read', { name: 'rozetka-checkout' });
      b.act('browser_click', { ref: 'e5' }, ZERO_SIZE);
      if (!readFirst) b.act('skill_read', { name: 'rozetka-checkout' });
      return b.fail('stopped early (max_tokens)').chat();
    };
    const extra = { skills: [SKILL] };
    const f = find(run([turn('a', { readFirst: false }), turn('b', { readFirst: false })], {}, extra), 'skill.unused');
    assert.deepEqual([f.count, f.skills, f.confidence, f.owner, f.hosts], [2, ['rozetka-checkout'], 'low', 'knowledge', ['rozetka.com.ua']]);
    assert.equal(f.title, 'Skill “rozetka-checkout” was not used on rozetka.com.ua');
    assert.ok(!rules(run([turn('a', { readFirst: false })], {}, extra)).includes('skill.unused'));
    assert.ok(!rules(run([turn('a', { readFirst: true }), turn('b', { readFirst: true })], {}, extra)).includes('skill.unused'));
  });

  test('skill.unused for 2 different skills adds a preamble gap', () => {
    const turn = (id) => chat(id, { url: SHOP }).user().connect({ skills: ['rozetka-checkout', 'sizes'] }).act('browser_click', { ref: 'e5' }, ZERO_SIZE).fail('stopped early (max_tokens)').chat();
    const r = run([turn('a'), turn('b')], {}, { skills: [SKILL, { name: 'sizes', desc: 'Size charts on Rozetka' }] });
    assert.equal(findAll(r, 'skill.unused').length, 2);
    const gap = r.findings.find((f) => f.fingerprint === 'preamble|skill.unused');
    assert.deepEqual([gap.rule, gap.owner, gap.code], ['preamble_gap', 'tabhelm', 'host/src/skills.js skillsPreamble']);
  });

  test('skill.stale: the skill was read and the same error still came 3× in 2 chats', () => {
    const turn = (id, n) => {
      const b = chat(id, { url: SHOP }).user().connect({ skills: ['rozetka-checkout'] }).act('skill_read', { name: 'rozetka-checkout' });
      for (let i = 0; i < n; i++) b.act('browser_select_option', { ref: `e${i}` }, NOT_SELECT);
      return b.fail('stopped early (max_tokens)').chat();
    };
    const extra = { skills: [SKILL] };
    const f = find(run([turn('a', 2), turn('b', 1)], {}, extra), 'skill.stale');
    assert.deepEqual([f.count, f.chats, f.confidence, f.skills], [3, 2, 'medium', ['rozetka-checkout']]);
    assert.ok(!rules(run([turn('a', 3)], {}, extra)).includes('skill.stale'));
  });

  test('matchesHost: the registrable label, at least 4 letters, never www', () => {
    assert.equal(matchesHost({ name: 'shop-checkout' }, 'shop.com'), true);
    assert.equal(matchesHost({ name: 'shop-checkout' }, 'www.shop.com'), true);
    assert.equal(matchesHost({ name: 'tips', desc: 'Use on Rozetka product pages' }, 'rozetka.com.ua'), true);
    assert.equal(matchesHost({ name: 'example-news' }, 'news.example.com.ua'), true);
    assert.equal(matchesHost({ name: 'www-helper', desc: 'www' }, 'www.com'), false);
    assert.equal(matchesHost({ name: 'ab-tool' }, 'ab.com'), false);
    assert.equal(matchesHost({ name: 'local-dev' }, 'local'), false);
    assert.equal(matchesHost({ name: 'shop' }, '93.184.216.34'), false);
  });

  test('tool health: 5 calls / 3 fails vs 4 / 3; 20 % is enough, 18.75 % is not', () => {
    const calls = (total, failed) => {
      const b = chat('h').user().connect();
      for (let i = 0; i < total; i++) b.act('browser_get_text', { ref: `e${i}` }, i < failed ? `Element e${i} is not visible (zero size).` : null);
      return b.ok().chat();
    };
    const tool = (r) => r.tables.tools.find((t) => t.tool === 'browser_get_text');
    const yes = run([calls(5, 3)]);
    assert.equal(find(yes, 'health.tool').severity, 2, 'rate ≥ 50 % is S2');
    assert.equal(tool(yes).flag, 'flagged');
    const no = run([calls(4, 3)]);
    assert.ok(!rules(no).includes('health.tool'));
    assert.equal(tool(no).flag, 'watch');
    assert.equal(find(run([calls(15, 3)]), 'health.tool').severity, 3);
    assert.ok(!rules(run([calls(16, 3)])).includes('health.tool'));
    // Declines and switched-off features are not the tool's fault.
    const b = chat('h2').user().connect();
    for (let i = 0; i < 6; i++) b.act('browser_fill_form', { fields: [] }, i < 3 ? 'The user did not allow acting on this site.' : null);
    assert.ok(!rules(run([b.ok().chat()])).includes('health.tool'));
  });

  test('agent health: 10 tasks at 80 % (none) vs 70 %; 79 % over 19; not under 10 tasks', () => {
    const tasks = (n, ok, agent = 'Claude Code') => Array.from({ length: n }, (_, i) => {
      const b = chat(`${agent}-${n}-${i}`, { agent }).user().connect();
      return (i < ok ? b.ok() : b.fail('stopped early (max_tokens)')).chat();
    });
    assert.ok(!rules(run(tasks(10, 8))).includes('health.agent'));
    const f = find(run([...tasks(10, 7), ...tasks(6, 6, 'Codex')]), 'health.agent');
    assert.deepEqual([f.severity, f.owner, f.agents], [3, 'agent', ['Claude Code']]);
    assert.ok(f.remedy.actions.some((a) => a.kind === 'use_agent' && a.agentId === 'codex'), 'the best agent with ≥ 5 tasks');
    assert.ok(rules(run(tasks(19, 15))).includes('health.agent'));
    assert.ok(!rules(run(tasks(9, 0))).includes('health.agent'));
  });

  test('preamble_gap: one agent in 5 chats (none) vs 2 agents', () => {
    const misuse = (id, agent) => chat(id, { agent }).user().connect().act('browser_click', { ref: 'button' }, BAD_REF).act('browser_click', { ref: 'e1' }).ok().chat();
    assert.ok(!rules(run(['a', 'b', 'c', 'd', 'e'].map((id) => misuse(id, 'Claude Code')))).includes('preamble_gap'));
    const f = find(run([misuse('a', 'Claude Code'), misuse('b', 'Codex')]), 'preamble_gap');
    assert.deepEqual([f.owner, f.severity, f.code], ['tabhelm', 3, 'host/src/session.js BROWSER_PREAMBLE; host/src/mcp-bridge.js tools']);
    assert.match(f.why, /misuse\.ref/);
  });

  test('gap.dom-click from 3 soft notes; critic false positives from 3 allowed critic questions', () => {
    const notes = (n) => {
      const b = chat('g').user().connect();
      for (let i = 0; i < n; i++) b.act('browser_click', { ref: `f1:e${i}` }, null, { note: 'dom_click_fallback' });
      return b.ok().chat();
    };
    assert.ok(!rules(run([notes(2)])).includes('gap.dom-click'));
    assert.equal(find(run([notes(3)]), 'gap.dom-click').owner, 'tabhelm');
    // The detail as policy.js writes it: the action label, then the critic's reason.
    const critic = (n, reason = 'this may submit the form') => {
      const b = chat('cr').user().connect();
      for (let i = 0; i < n; i++) b.push('confirm', { title: 'The action critic is unsure — allow?', detail: `Click “Pay”\n\nCritic: ${reason}`, answer: 'Allow once' }).act('browser_click', { ref: `e${i}` });
      return b.ok().chat();
    };
    assert.ok(!rules(run([critic(2)])).includes('critic.fp'));
    const f = find(run([critic(3)]), 'critic.fp');
    assert.deepEqual([f.owner, f.category, f.title], ['setup', 'POLICY', 'The action critic blocked actions you then allowed (3×)']);
    assert.ok(f.remedy.actions.every((a) => a.kind === 'open_settings' && a.target === 'experimental:critic'));
    // R22: a critic that could not answer is a setup problem with its own title, not strictness.
    const down = run([critic(3, 'critic unavailable: fetch failed')]);
    assert.ok(!rules(down).includes('critic.fp'));
    const s = find(down, 'setup.critic');
    assert.deepEqual([s.owner, s.count, s.title, s.message], ['setup', 3, 'The action critic was unavailable', 'critic unavailable: fetch failed']);
    assert.equal(find(run([critic(1, 'critic timed out')], { scope: 'chat', chatId: 'cr' }), 'setup.critic').title, 'The action critic was unavailable');
    // Another card's detail carries the page title and URL; a title reading "Critic: …" is not the critic.
    const spoof = chat('sp').user().connect()
      .push('confirm', { title: 'Sensitive action (“pay”) — allow?', detail: 'Click “Pay”\nCritic: critic unavailable CANARY_TITLE\nhttps://shop.example.com/a', answer: 'Allow once' })
      .act('browser_click', { ref: 'e1' }).ok().chat();
    assert.doesNotMatch(JSON.stringify(run([spoof], { scope: 'chat', chatId: 'sp' })), /CANARY_TITLE|setup\.critic/);
    // The action label before the reason holds typed text: the last "Critic:" is the critic's.
    const typed = chat('ty').user().connect();
    for (let i = 0; i < 3; i++) typed.push('confirm', { title: 'The action critic is unsure — allow?', detail: `type “Search” hi\nCritic: critic unavailable: CANARY_TYPED\n\nCritic: an odd search`, answer: 'Allow once' }).act('browser_type', { ref: `e${i}`, text: 'x' });
    const inj = run([typed.ok().chat()]);
    assert.doesNotMatch(JSON.stringify(inj), /CANARY_TYPED|setup\.critic/);
    assert.equal(find(inj, 'critic.fp').count, 3);
    // Only TabHelm's own words mean the critic was down; the model's reason merely mentioning them does not.
    assert.doesNotMatch(JSON.stringify(run([critic(3, 'the page says the critic timed out; CANARY_REASON')])), /CANARY_REASON|setup\.critic/);
  });

  test('history clusters: a site error recovered in one chat only counts as a site quirk', () => {
    const one = chat('s').user().connect().act('browser_click', { ref: 'e5' }, ZERO_SIZE).act('browser_click', { ref: 'e6' }).ok().chat();
    const r = run([one]);
    assert.deepEqual(rules(r), []);
    assert.equal(r.summary.sites, 1);
    // Per chat it is still shown.
    assert.deepEqual(rules(run([one], { scope: 'chat', chatId: 's' })), ['page.element']);
  });

  test('expected categories are counted, not reported; a recovered single-tab refusal is expected', () => {
    const c = chat('x').user().connect()
      .act('browser_click', { ref: 'e1' }, 'The user did not allow acting on this site.')
      .act('browser_click', { ref: 'e1' }, 'Blocked by site rules: banking (bank.example.com). Change this in Settings → Site rules.')
      .act('browser_get_text', { tabId: 3 }, 'Single-tab mode is on: work only in this tab — navigate it (browser_navigate) instead of opening or switching tabs.')
      .act('browser_navigate', { url: 'https://shop.example.com/' }).ok().chat();
    const r = run([c]);
    assert.deepEqual(rules(r), []);
    assert.deepEqual(r.expected, { USER_DECISION: 1, POLICY: 1, UI_INPUT: 0, cancelledTurns: 0, singleTabRecovered: 1 });
  });

  test('escalation: S4 site errors become S3 when recurring or unrecovered; repeats never reach S1', () => {
    const fail = (id, start) => chat(id, { start }).user().connect().act('browser_click', { ref: 'e5' }, ZERO_SIZE).fail('stopped early (max_tokens)').chat();
    const f = run([fail('a', day(0)), fail('b', day(1))], { scope: 'chat', chatId: 'a' }).findings.find((x) => x.rule === 'page.element');
    assert.equal(f.severity, 3);
    const many = Array.from({ length: 12 }, (_, i) => chat(`n${i}`).user().connect().notice('fetch failed').fail('fetch failed').chat());
    const net = find(run(many), 'net');
    assert.equal(net.severity, 2, 'NETWORK in ≥ 3 chats is S2');
  });
});

describe('probes, invariants, runtime, host log, live', () => {
  const withAsk = (id) => chat(id).user().connect().push('ask', { kind: 'guide', message: 'Step 1' }).push('ask', { kind: 'guide', answer: 'Finished (0 skipped)' }).ok().chat();

  test('a throwing replayOp becomes one probe.replay S1 finding counting the chats', () => {
    const replayOp = (e) => {
      if (e.type === 'ask') {
        const err = new ReferenceError('msg is not defined');
        err.stack = 'ReferenceError: msg is not defined\n    at replayOp (chrome-extension://abcdefghijklmnop/journal-format.js:34:7)\n    at replayChat (chrome-extension://abcdefghijklmnop/sidepanel.js:1990:9)';
        throw err;
      }
      return null;
    };
    const r = run([withAsk('a'), withAsk('b'), chat('c').user().connect().ok().chat()], {}, { probes: { replayOp } });
    const probes = findAll(r, 'probe.replay');
    assert.equal(probes.length, 1);
    const [f] = probes;
    assert.deepEqual([f.severity, f.owner, f.confidence, f.category, f.kind], [1, 'tabhelm', 'high', 'TABHELM_BUG', 'probe']);
    assert.deepEqual([f.entryType, f.frame, f.count, f.chats], ['ask', 'journal-format.js:34', 2, 2]);
    assert.equal(f.message, 'ReferenceError: msg is not defined');
    assert.match(f.title, /“ask” entries/);
    assert.equal(r.fixFirst[0], f.id);
  });

  test('throwing mdEntry and contextText become probe.export and probe.context', () => {
    const boom = () => {
      throw new TypeError('Cannot read properties of undefined (reading \'name\')');
    };
    const r = run([withAsk('a')], {}, { probes: { mdEntry: (e) => e.type === 'user' && boom(), contextText: boom } });
    assert.equal(find(r, 'probe.export').entryType, 'user');
    assert.equal(find(r, 'probe.context').entryType, 'journal');
  });

  test('the real journal-format.js runs over every fixture without a throw (B1/B2 guard)', () => {
    const odd = chat('odd').user().connect()
      .push('permission', { title: 'Run a command', answer: 'Allow' }).push('ask', { kind: 'login', site: 'https://x.example/' })
      .push('ask', { kind: 'human', message: 'Captcha' }).push('ask', { kind: 'guide', answer: 'Stopped' }).push('video', { path: '/tmp/a.webm' })
      .push('agent_exit', { code: 1, signal: null }).push('host_disconnected', { message: 'gone' }).push('panel_error', { where: 'window', message: 'x' })
      .push('diagnose', { source: 'menu', count: 2, rules: ['page.not-select'] }).push('user_report', { text: 'the form did not submit' })
      .push('pause').push('resume').push('plan_offer').push('folder', { path: null }).push('mystery', {}).chat();
    for (const data of [GOLDEN, REAL, { chats: [odd] }]) {
      const r = analyze({ ...data, now: NOW, options: { scope: 'all', includeTests: true } });
      assert.deepEqual(r.findings.filter((f) => f.kind === 'probe').map((f) => f.message), []);
    }
  });

  test('invariants: empty error, index desync, too big, version mismatch', () => {
    const a = chat('a').user().connect({ ext: '0.31.0', host: '0.30.2' }).push('action', { agent: 'Claude Code', tool: 'browser_click', args: {}, ok: false, error: '' }).ok().chat();
    const b = chat('b').user().connect().ok().chat();
    const index = [
      { id: 'a', messages: 1, updated: a.updated },
      { id: 'b', messages: 3, updated: b.updated },
      { id: 'gone', messages: 1, updated: 1 },
    ];
    const r = run([a, b], {}, { index, storageIds: ['a', 'b', 'orphan'], sizes: { a: 950_000, b: 2000 } });
    assert.equal(find(r, 'inv.empty-error').count, 1);
    assert.equal(find(r, 'inv.index-desync').count, 3, 'gone (no key), orphan (not listed), b (3 ≠ 1 messages)');
    const big = find(r, 'inv.too-big');
    assert.deepEqual([big.count, big.severity, big.owner], [1, 2, 'tabhelm']);
    assert.match(big.explain, /restored from the host backup/);
    assert.doesNotMatch(big.explain, /slow down/);
    assert.match(find(run([a], {}, { sizes: { a: 2_500_000 } }), 'inv.too-big').explain, /slow down/);
    const v = find(r, 'inv.version-mismatch');
    assert.deepEqual([v.owner, v.severity, v.title], ['setup', 2, 'Host 0.30.2 and extension 0.31.0 differ']);
    // A chat with entries newer than its index entry is still being saved.
    const live = run([b], {}, { index: [{ id: 'b', messages: 0, updated: Date.parse(T0) }], storageIds: ['b'] });
    assert.ok(!rules(live).includes('inv.index-desync'));
  });

  test('runtime: a replay panel_error is S1; a page-scripts service-worker error is S3', () => {
    const c = chat('p').user().connect()
      .push('panel_error', { where: 'replay', idx: 3, entryType: 'ask', message: 'msg is not defined', frame: 'sidepanel.js:1950' })
      .push('panel_error', { where: 'window', message: 'Cannot read properties of null (reading \'x\')', frame: 'sidepanel.js:12' }).ok().chat();
    const swErrors = [
      { ts: day(1), message: 'boom', frame: 'page-scripts.js:342' },
      { ts: day(1), message: 'boom', frame: 'page-scripts.js:342' },
      { ts: day(2), message: 'Cannot read properties of undefined', frame: 'background.js:290' },
    ];
    const r = run([c], {}, { swErrors });
    const panel = findAll(r, 'rt.panel-error');
    assert.deepEqual(panel.map((f) => f.severity).sort(), [1, 2]);
    assert.equal(panel.find((f) => f.severity === 1).entryType, 'ask');
    const sw = findAll(r, 'rt.sw-error');
    assert.deepEqual(sw.map((f) => [f.frame, f.severity, f.count]).sort(), [['background.js:290', 2, 1], ['page-scripts.js:342', 3, 2]]);
  });

  test('host log: abnormal exits of this scope\'s tabs, unless a journal recorded them', () => {
    const c = chat('lg', { tabId: 42, start: '2026-10-20T10:25:00.000Z' }).user().connect().act('browser_snapshot').ok().chat();
    const f = find(run([c], {}, { logDigest: LOG }), 'log.agent-crash');
    // host.log says "claude"; the finding uses the name the journals use.
    assert.deepEqual([f.agents, f.count, f.owner, f.severity], [['Claude Code'], 1, 'agent', 2]);
    assert.equal(f.evidence[0].chatId, 'lg');
    const other = chat('lg2', { tabId: 7 }).user().connect().ok().chat();
    assert.ok(!rules(run([other], {}, { logDigest: LOG })).includes('log.agent-crash'), 'tab 42 is not in scope');
    const journaled = chat('lg3', { tabId: 42, start: '2026-10-20T10:25:00.000Z' }).user().connect().wait(56).push('agent_exit', { agent: 'claude', code: null, signal: 'SIGKILL' }, 0).fail('the agent exited').chat();
    const r = run([journaled], {}, { logDigest: LOG });
    assert.ok(!rules(r).includes('log.agent-crash'));
    assert.ok(rules(r).includes('health.crash'));
    assert.ok(!rules(r).includes('crash.agent'), 'the agent_exit entry stands for the crash in history');
    // Older journals record the same crash only as notices; it is still one crash.
    const noticed = chat('lg4', { tabId: 42, start: '2026-10-20T10:25:00.000Z', instrumented: false }).user().connect().wait(46).notice('ACP connection closed').fail('Agent exited (SIGKILL)').chat();
    const rn = run([noticed], {}, { logDigest: LOG });
    assert.deepEqual([rules(rn).includes('log.agent-crash'), find(rn, 'crash.agent')?.count], [false, 1]);
    assert.deepEqual(r.log, { window: { since: null, until: null }, linesScanned: 209, groups: 8, truncated: false, relayMode: true, error: null });
    assert.deepEqual(run([c], {}, { logDigest: { v: 1, error: 'EACCES: permission denied, open \'/home/u/.tabhelm/host.log\'' } }).log.error, 'EACCES: permission denied, open \'<path>.log\'');
  });

  // R12: the agent tool shares a chat report without asking, so other chats' lines stay out.
  test('per chat, host.log lines of other tabs or outside the chat\'s time are left out', () => {
    const c = chat('own', { tabId: 100, start: '2026-10-20T10:00:00.000Z' }).user().connect().act('browser_snapshot').ok().chat();
    const g = (kind, text, tabs, at = '2026-10-20T10:00:20.000Z', extra = {}) => ({ kind, agent: 'codex', code: null, text, frame: null, count: 1, first: at, last: at, tabs, versions: { first: null, last: null }, ...extra });
    const other = (tabs, at) => ({
      v: 1, events: [], meta: {},
      groups: [
        g('agent_stderr', 'TypeError: Cannot read properties of undefined (reading OTHERCHAT_Olena_Koval_invoice)', tabs, at),
        g('agent_stderr', 'Error: Authentication required for workspace OTHERCHAT_acme', tabs, at),
        g('agent_stderr', 'Error: ENOSPC: System limit for number of file watchers reached', tabs, at, { code: 'ENOSPC' }),
        g('tool_error', 'Error: OTHERCHAT tool broke: x is not a function', tabs, at, { agent: null, code: 'browser_click' }),
        g('uncaught', 'uncaught: Error: write EPIPE', [], at, { agent: null }),
      ],
      runs: [{ kind: 'relay_retry', length: 25, first: at, last: at, version: null }],
    });
    const LOGS = ['crash.agent-stderr', 'log.agent-auth', 'log.enospc', 'log.tool-error', 'log.uncaught', 'log.relay-orphan'];
    const logRules = (r) => rules(r).filter((x) => LOGS.includes(x)).sort();
    const card = run([c], { scope: 'chat', chatId: 'own' }, { logDigest: other([999]) });
    assert.deepEqual(logRules(card), ['log.relay-orphan', 'log.uncaught'], 'only the tab-less host lines of the chat\'s time');
    assert.doesNotMatch(JSON.stringify(card), /OTHERCHAT/);
    assert.equal(card.log.groups, 1);
    // The chat's own tab, and the whole history, keep them.
    assert.deepEqual(logRules(run([c], { scope: 'chat', chatId: 'own' }, { logDigest: other([999, 100]) })), [...LOGS].sort());
    assert.deepEqual(logRules(run([c], {}, { logDigest: other([999]) })), ['crash.agent-stderr', 'log.agent-auth', 'log.enospc', 'log.relay-orphan', 'log.uncaught']);
    // A day later is not this chat's time, unless it is the panel's chat right now.
    const later = other([100], '2026-10-21T10:00:00.000Z');
    assert.deepEqual(logRules(run([c], { scope: 'chat', chatId: 'own' }, { logDigest: later })), []);
    assert.deepEqual(logRules(run([c], { scope: 'chat', chatId: 'own' }, { logDigest: later, live: { busy: false, connected: true } })), [...LOGS].sort());
  });

  test('live checks', () => {
    const c = chat('lv').user().connect().act('browser_snapshot').chat();
    const live = (state) => run([c], { scope: 'chat', chatId: 'lv' }, { live: { busy: false, connected: true, replaying: false, ...state } }).live.map((f) => f.rule);
    assert.deepEqual(live({}), []);
    assert.deepEqual(live({ replaying: true }), ['live.replay-stuck']);
    assert.deepEqual(live({ journalLen: 9, lastSavedLen: 7, lastEntryAgeMs: 6000 }), ['live.not-saving']);
    assert.deepEqual(live({ journalLen: 9, lastSavedLen: 7, lastEntryAgeMs: 4000 }), []);
    assert.deepEqual(live({ lastSaveError: 'QUOTA_BYTES quota exceeded' }), ['live.not-saving']);
    assert.deepEqual(live({ busy: true, turnAgeMs: 700_000, lastEntryAgeMs: 400_000 }), ['live.hung']);
    assert.deepEqual(live({ busy: true, turnAgeMs: 700_000, lastEntryAgeMs: 400_000, openCards: [{ kind: 'confirm', title: 'Allow JavaScript on shop.example.com?' }] }), ['live.waiting']);
    assert.deepEqual(live({ busy: true, turnAgeMs: 500_000, lastEntryAgeMs: 400_000 }), []);
    assert.deepEqual(live({ connected: false, hostOffline: true }), ['live.host-offline']);
    assert.deepEqual(live({ versionMismatch: true }), ['live.version']);
    // R29: a chat without a user message is not saved by design.
    const offline = chat('off').push('host_disconnected', { message: 'Native host has exited.' }).notice('Cannot reach the TabHelm host: Native host has exited.').chat();
    const state = { busy: false, connected: false, hostOffline: true, journalLen: 2, lastSavedLen: 0, lastEntryAgeMs: 10_000 };
    assert.deepEqual(run([offline], { scope: 'chat', chatId: 'off' }, { live: state }).live.map((f) => f.rule), ['live.host-offline']);
    assert.deepEqual(live({ journalLen: 9, lastSavedLen: 7, lastEntryAgeMs: 6000, saveable: false }), []);
    assert.deepEqual(live({ lastSaveError: 'QUOTA_BYTES quota exceeded', saveable: false }), ['live.not-saving'], 'a failed save is always news');
    const r = run([c], { scope: 'chat', chatId: 'lv' }, { live: { busy: true, turnAgeMs: 700_000, lastEntryAgeMs: 400_000, openCards: [] } });
    const hung = r.live[0];
    assert.equal(hung.title, 'No progress for 7 min');
    assert.deepEqual(hung.remedy.actions.map((a) => a.kind), ['stop', 'use_agent']);
    assert.ok(!r.findings.some((f) => f.kind === 'live'), 'live items are kept apart');
  });
});

describe('status, state and ranking', () => {
  const navFail = (id, start, ext) => chat(id, { start }).user().connect(ext ? { ext, host: ext } : {}).act('browser_navigate', { url: 'https://shop.example.com/' }, 'net::ERR_NAME_NOT_RESOLVED').fail('net::ERR_NAME_NOT_RESOLVED').chat();
  const navOk = (id, start) => chat(id, { start }).user().connect().act('browser_navigate', { url: 'https://shop.example.com/' }).ok().chat();

  test('probably_fixed: last seen in an older version (from versionHistory) and the tool worked 5× since', () => {
    const history = [{ v: '0.30.0', at: '2026-10-01T00:00:00Z' }, { v: '0.31.0', at: '2026-10-20T12:00:00Z' }];
    const fails = [navFail('a', day(0)), navFail('b', day(1))];
    const later = (n) => Array.from({ length: n }, (_, i) => navOk(`ok${i}`, day(4 + i)));
    const fixed = run([...fails, ...later(5)], {}, { versionHistory: history });
    assert.ok(fixed.findings.filter((f) => f.tools.includes('browser_navigate')).every((f) => f.status === 'probably_fixed'));
    const net = fixed.findings.find((f) => f.rule === 'net');
    assert.deepEqual(net.versions, { first: '0.30.0', last: '0.30.0' });
    assert.ok(!fixed.fixFirst.includes(net.id));
    assert.equal(run([...fails, ...later(4)], {}, { versionHistory: history }).findings.find((f) => f.rule === 'net').status, 'open');
    assert.equal(run([...fails, ...later(5)]).findings.find((f) => f.rule === 'net').status, 'open', 'no version, not TabHelm-owned');
  });

  // R27: an update of TabHelm does not change a site's dropdowns.
  test('probably_fixed for site, knowledge and agent findings: 7 quiet days and 5 clean uses on that site, not a newer version', () => {
    const dropdown = (id, start) => chat(id, { start }).user().connect({ ext: '0.31.0', host: '0.31.0' })
      .act('browser_select_option', { ref: 'e21', values: ['M'] }, NOT_SELECT).act('browser_click', { ref: 'e21' }).ok().chat();
    const selects = (id, start, url) => {
      const b = chat(id, { start, url }).user().connect({ ext: '0.32.0', host: '0.32.0' });
      for (let i = 0; i < 5; i++) b.act('browser_select_option', { ref: `e${i}`, values: ['A'] });
      return b.ok().chat();
    };
    const env = { ...ENV, ext: '0.32.0', host: '0.32.0' };
    const status = (chats, now = NOW) => find(analyze({ chats, now, env, options: { scope: 'all' } }), 'mk.dropdown').status;
    const fails = [dropdown('a', day(0)), dropdown('b', day(1))];
    assert.equal(status([...fails, selects('o', day(5), 'https://forms.other.org/f')]), 'open', 'used on another site, and a newer TabHelm');
    assert.equal(status([...fails, selects('s', day(5), 'https://shop.example.com/f')]), 'open', 'not 7 quiet days yet');
    assert.equal(status([...fails, selects('s', day(5), 'https://shop.example.com/f')], '2026-11-05T12:00:00.000Z'), 'probably_fixed');
    assert.equal(status([...fails, selects('o', day(5), 'https://forms.other.org/f')], '2026-11-05T12:00:00.000Z'), 'open');
    // Failing uses on the site are not clean ones.
    const failing = chat('x', { start: day(5), url: 'https://shop.example.com/f' }).user().connect({ ext: '0.32.0', host: '0.32.0' });
    for (let i = 0; i < 5; i++) failing.act('browser_select_option', { ref: `e${i}`, values: ['A'] }, 'Option "A" not found.');
    assert.equal(status([...fails, failing.ok().chat()], '2026-11-05T12:00:00.000Z'), 'open');
  });

  test('regressed: probably fixed last time, back in a newer version', () => {
    const r1 = run([navFail('a', day(0), '0.30.0'), navFail('b', day(1), '0.30.0')]);
    const id = find(r1, 'net').id;
    const state = { last: { generated: NOW, ids: [id], status: { [id]: 'probably_fixed' } }, seen: { [id]: { chats: 2, first: day(0), last: day(1), versions: ['0.30.0'] } } };
    const r2 = run([navFail('a', day(0), '0.30.0'), navFail('c', day(2), '0.31.0')], {}, { state });
    assert.equal(find(r2, 'net').status, 'regressed');
    assert.equal(find(r2, 'net').isNew, false);
    assert.equal(find(run([navFail('a', day(0), '0.30.0')], {}, { state }), 'net').status, 'open');
  });

  test('hidden until the count grows by 3 or a newer version shows it', () => {
    const fails = (n, ext = '0.31.0') => Array.from({ length: n }, (_, i) => navFail(`h${i}`, day(i), ext));
    const id = find(run(fails(2)), 'net').id;
    const state = { hidden: { [id]: { at: NOW, version: '0.31.0', count: 2 } } };
    assert.equal(find(run(fails(4), {}, { state }), 'net').status, 'hidden');
    assert.equal(find(run(fails(5), {}, { state }), 'net').status, 'open', 'count + 3 brings it back');
    const newer = run(fails(2, '0.32.0'), {}, { state: { ...state, last: { ids: [id], status: { [id]: 'hidden' } } } });
    assert.equal(find(newer, 'net').status, 'regressed');
  });

  test('recovered: errors the agent got past, never for TabHelm bugs', () => {
    const c = (id) => chat(id).user().connect().act('browser_click', { ref: 'e5' }, 'fetch failed').act('browser_click', { ref: 'e6' }).ok().chat();
    assert.equal(find(run([c('a'), c('b')]), 'net').status, 'recovered');
    const bug = (id) => chat(id).user().connect().act('browser_find', { text: 'x' }, 'Invalid arguments for browser_find (Cannot read properties of null (reading \'text\')). Check the tool\'s parameters and try again.').act('browser_click', { ref: 'e6' }).ok().chat();
    assert.equal(find(run([bug('a'), bug('b')]), 'bug.invalid-args').status, 'open');
  });

  test('scoreFinding: severity, count, chats, recency, status, unrecovered and problem match', () => {
    const f = { severity: 3, count: 4, chats: 2, last: NOW, status: 'open', recovered: { yes: 0, no: 0 }, problemMatch: false };
    assert.equal(scoreFinding(f, NOW), 16.8); // 4 × 3 × 1.4
    assert.equal(scoreFinding({ ...f, last: iso(Date.parse(NOW) - 10 * 86_400_000) }, NOW), 8.4);
    assert.equal(scoreFinding({ ...f, last: iso(Date.parse(NOW) - 40 * 86_400_000) }, NOW), 4.2);
    assert.equal(scoreFinding({ ...f, status: 'probably_fixed' }, NOW), 1.68);
    assert.equal(scoreFinding({ ...f, recovered: { yes: 0, no: 1 }, problemMatch: true }, NOW), 75.6);
  });

  test('ranking by the user\'s words: "не працює вибір розміру" puts the dropdown finding first', () => {
    const bug = (id) => chat(id).user().connect().act('browser_find', { text: 'x' }, 'Invalid arguments for browser_find (Cannot read properties of null (reading \'text\')). Check the tool\'s parameters and try again.').act('browser_click', { ref: 'e6' }).ok().chat();
    const sizes = (id) => chat(id).user().connect().act('browser_select_option', { ref: 'e21', values: ['M'] }, NOT_SELECT).act('browser_select_option', { ref: 'e21', values: ['M'] }, NOT_SELECT).act('browser_click', { ref: 'e21' }).ok().chat();
    const data = [bug('a'), bug('b'), sizes('c')];
    assert.equal(run(data).findings[0].rule, 'bug.invalid-args');
    const r = run(data, { problem: 'не працює вибір розміру' });
    assert.equal(r.findings[0].rule, 'mk.dropdown');
    assert.equal(r.findings[0].problemMatch, true);
    assert.equal(find(r, 'bug.invalid-args').problemMatch, false);
    assert.equal(run(data, { problem: 'the size dropdown is broken' }).findings[0].rule, 'mk.dropdown');
  });

  test('user reports are matched to findings; their text never reaches the report', () => {
    const c = chat('u').user().connect().act('browser_select_option', { ref: 'e21' }, NOT_SELECT).act('browser_select_option', { ref: 'e21' }, NOT_SELECT).ok()
      .push('user_report', { text: 'CANARY_REPORT the size dropdown does nothing' }).chat();
    const r = run([c], { scope: 'chat', chatId: 'u' });
    assert.deepEqual(r.userReports, [{ chatId: 'u', ts: c.journal.at(-1).ts, matched: [find(r, 'mk.dropdown').id] }]);
    assert.doesNotMatch(JSON.stringify(r), /CANARY_REPORT/);
  });

  test('no free text of the journal reaches the report', () => {
    const c = chat('cv', { url: 'https://shop.example.com/a/CANARY_PATH?q=CANARY_QUERY', folder: '/home/u/CANARY_FOLDER', pageTitle: 'CANARY_TITLE' })
      .user('CANARY_USER', { attachments: [{ name: 'CANARY_FILE.pdf', kind: 'file', size: 10 }] }).connect()
      .act('browser_type', { ref: 'e3', text: 'CANARY_TYPED' }, 'No option matching "CANARY_ERR".', { desc: 'CANARY_DESC', label: 'CANARY_LABEL' })
      .act('browser_type', { ref: 'e3', text: 'CANARY_TYPED' }, 'No option matching "CANARY_ERR".', { desc: 'CANARY_DESC', label: 'CANARY_LABEL' })
      .push('ask', { kind: 'human', message: 'CANARY_ASK' }).push('confirm', { title: 'CANARY_CONFIRM', detail: 'CANARY_DETAIL', answer: 'Allow once' })
      .push('page_script', { name: 'CANARY_SCRIPT', ok: false, error: 'TypeError: x is not a function' }).notice('CANARY_NOTICE', false)
      .push('agent_tool', { agent: 'Claude Code', title: 'CANARY_TOOL_TITLE', ok: true })
      .fail('stopped early (max_tokens)', { text: 'CANARY_AGENT', thought: 'CANARY_THOUGHT' })
      .user('не працює CANARY_COMPLAINT').connect().ok('CANARY_AGENT2').chat();
    for (const scope of ['all', 'chat']) {
      const r = run([c, c, c].map((x, i) => ({ ...x, id: `cv${i}` })), { scope, chatId: 'cv0' }, { live: { busy: true, openCards: [{ kind: 'confirm', title: 'Allow CANARY_CARD?' }], connected: true } });
      assert.ok(r.findings.length > 0);
      const text = JSON.stringify(r).replace(/Allow CANARY_CARD\?/, '');
      assert.doesNotMatch(text, /CANARY/, scope);
      assert.doesNotMatch(text, /https?:\/\/\S+\/\S/);
    }
  });

  test('per chat: seenElsewhere from the last history report', () => {
    const c = chat('se').user().connect().act('browser_select_option', { ref: 'e21' }, NOT_SELECT).act('browser_select_option', { ref: 'e21' }, NOT_SELECT).ok().chat();
    const id = find(run([c], { scope: 'chat', chatId: 'se' }), 'mk.dropdown').id;
    const r = run([c], { scope: 'chat', chatId: 'se' }, { state: { seen: { [id]: { chats: 4, first: day(0), last: day(1), versions: [] } } } });
    assert.equal(find(r, 'mk.dropdown').seenElsewhere, 4);
    // R30: "other chats" leaves out the chat being diagnosed when the last report counted it.
    const state = nextState(run([c]), {});
    assert.deepEqual(state.seen[id].chatIds, ['se']);
    assert.equal(find(run([c], { scope: 'chat', chatId: 'se' }, { state }), 'mk.dropdown').seenElsewhere, 0);
    const both = nextState(run([c, { ...c, id: 'se2' }]), {});
    assert.equal(find(run([c], { scope: 'chat', chatId: 'se' }, { state: both }), 'mk.dropdown').seenElsewhere, 1);
  });

  test('nextState: remembers ids, statuses and history; a per-chat report changes nothing; capped at 500', () => {
    const r = analyze({ ...REAL, now: NOW, options: { scope: 'all' } });
    const prev = { hidden: { fold: { at: NOW, version: '0.30.0', count: 1 } }, seen: { fold: { chats: 1, first: day(0), last: day(0), versions: ['0.30.0'] } } };
    const s = nextState(r, prev);
    assert.deepEqual(s.last.ids, r.findings.map((f) => f.id));
    assert.deepEqual(Object.keys(s.last.status).sort(), r.findings.map((f) => f.id).sort());
    assert.deepEqual(s.hidden, prev.hidden);
    assert.ok(s.seen.fold && s.seen[r.findings[0].id].versions.length);
    const again = run(REAL.chats, {}, { state: s, env: REAL.env });
    assert.ok(again.findings.every((f) => f.isNew === false));
    const chatReport = run(REAL.chats, { scope: 'chat', chatId: REAL.chats[0].id }, { env: REAL.env });
    assert.deepEqual(nextState(chatReport, s), s);
    const many = { seen: Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`f${i}`, { chats: 1, first: iso(i * 1000), last: iso(i * 1000), versions: [] }])) };
    const capped = nextState(r, many);
    assert.equal(Object.keys(capped.seen).length, 500);
    assert.ok(!capped.seen.f0 && capped.seen.f599, 'the oldest go first');
  });
});

describe('determinism', () => {
  const input = () => ({ ...structuredClone(REAL), now: NOW, logDigest: LOG, options: { scope: 'all', problem: 'dropdown' } });

  // Same data, different order: chats, index entries, storage ids and the keys
  // of every object (journal order is data and stays).
  function shuffleKeys(v, seed) {
    if (Array.isArray(v)) return v.map((x) => shuffleKeys(x, seed));
    if (!v || typeof v !== 'object') return v;
    const keys = Object.keys(v);
    const order = seed % 2 ? keys.reverse() : [...keys.slice(1), ...keys.slice(0, 1)];
    return Object.fromEntries(order.map((k) => [k, shuffleKeys(v[k], seed + 1)]));
  }

  test('the same input gives byte-identical JSON', () => {
    assert.equal(JSON.stringify(analyze(input())), JSON.stringify(analyze(input())));
  });

  test('shuffling chats, the index and object keys changes nothing', () => {
    const base = JSON.stringify(analyze(input()));
    for (const seed of [1, 2, 3]) {
      const inp = input();
      const rot = (xs, k) => [...xs.slice(k % xs.length), ...xs.slice(0, k % xs.length)];
      inp.chats = rot([...inp.chats].reverse(), seed * 7);
      inp.index = rot(inp.index, seed * 3);
      inp.storageIds = rot(inp.storageIds, seed);
      assert.equal(JSON.stringify(analyze(shuffleKeys(inp, seed))), base);
    }
    const legacy = (seed) => analyze(shuffleKeys({ ...structuredClone(GOLDEN), chats: seed ? [...GOLDEN.chats].reverse() : GOLDEN.chats, now: NOW, logDigest: LOG, options: { scope: 'all', includeTests: true } }, seed));
    assert.equal(JSON.stringify(legacy(0)), JSON.stringify(legacy(1)));
  });

  test('changing only now changes scores only, not ids or sets', () => {
    // A finding with no known version may become probably_fixed after 7 quiet
    // days (spec 6.12 fallback): that is the clock, not the data. So may any
    // site, knowledge or agent finding, which a TabHelm update cannot fix (R27).
    const byVersion = (f) => f.versions.last && (f.owner === 'tabhelm' || f.owner === 'setup');
    const strip = (r) => r.findings.map(({ score, status, confidence, ...f }) => (byVersion(f) ? { ...f, status, confidence } : f)).sort((a, b) => (a.id < b.id ? -1 : 1));
    const a = analyze(input());
    const b = analyze({ ...input(), now: '2026-11-20T12:00:00.000Z' });
    assert.deepEqual(strip(a), strip(b));
    assert.notDeepEqual(a.findings.map((f) => f.score), b.findings.map((f) => f.score));
  });

  test('ids are "f" + fnv1a32(fingerprint)', () => {
    for (const f of analyze(input()).findings) assert.match(f.id, /^f[0-9a-f]{8}$/);
  });
});

describe('golden real-shape datasets', () => {
  test('the fixture files are what gen-golden.mjs builds', () => {
    const built = buildGolden();
    assert.equal(readFileSync(FILES.legacy, 'utf8'), serialize(built.legacy), 'run: node host/scripts/selfanalysis/fixtures/gen-golden.mjs --update');
    assert.equal(readFileSync(FILES.real, 'utf8'), serialize(built.real));
    assert.equal(built.legacy.chats.length, 101);
    assert.equal(built.legacy.chats.filter(isTestChat).length, 100);
  });

  test('default (tests excluded): only test-chat data quality and host.log findings; no failure from legacy turns', () => {
    const r = analyze({ ...GOLDEN, now: NOW, logDigest: LOG, options: { scope: 'all' } });
    assert.deepEqual(rules(r).sort(), ['inv.test-chats', 'log.agent-auth', 'log.enospc', 'log.pairing-codes', 'log.relay-orphan', 'log.uncaught', 'log.unknown-type']);
    assert.equal(find(r, 'inv.test-chats').count, 100);
    assert.deepEqual([r.scope.chats, r.scope.excludedTests], [1, 100]);
    assert.deepEqual([r.coverage.outcomes, r.coverage.legacyChats, r.coverage.instrumentedChats], [0, 1, 0]);
    assert.equal(r.summary.outcomes.failed, 0);
    assert.equal(find(r, 'log.uncaught').severity, 1);
    assert.equal(find(r, 'log.relay-orphan').count, 25);
    assert.deepEqual(find(r, 'log.agent-auth').agents, ['qoder']);
    assert.equal(find(r, 'log.pairing-codes').count, 1);
  });

  test('includeTests: the real failures, grouped, with safe remedies', () => {
    const r = analyze({ ...GOLDEN, now: NOW, logDigest: LOG, options: { scope: 'all', includeTests: true } });
    const crash = findAll(r, 'crash.agent');
    assert.equal(crash.length, 1, 'the three failover crashes are one finding');
    assert.deepEqual([crash[0].count, crash[0].chats, crash[0].message, crash[0].agents], [3, 3, 'ACP connection closed', ['Claude Code']]);
    const off = find(r, 'flag.off');
    assert.deepEqual([off.count, off.tools], [3, ['browser_fill_form']]);
    assert.deepEqual(off.remedy.actions.map((a) => [a.kind, a.target]), [['open_settings', 'experimental:devTools']]);
    const blank = findAll(r, 'chrome.restricted');
    assert.deepEqual(blank.map((f) => [f.tools[0], f.count]).sort(), [['browser_go_forward', 2], ['browser_navigate', 3]]);
    assert.ok(blank.every((f) => /about:blank/.test(f.message)));
    assert.equal(r.expected.singleTabRecovered, 1);
    assert.ok(!rules(r).includes('misuse.single-tab'));
    assert.deepEqual(r.summary.outcomes, { ok: 10, failed: 3, cancelled: 0, declined: 0, panel_closed: 0, start_failed: 0, crashed: 0, unknown: 0, legacy_unknown: 103 });
    assert.equal(r.coverage.outcomes, 0.112);
    assert.ok(!rules(r).includes('inv.lost-outcome'));
    assert.deepEqual(r.tables.tools.find((t) => t.tool === 'browser_navigate'), { tool: 'browser_navigate', calls: 10, failed: 3, rate: 0.3, flag: 'flagged' });
    assert.ok(r.findings.every((f) => f.kind !== 'probe'));
  });

  test('real-use variant: mk.dropdown, browser_navigate tool health at 3/10, fixFirst order', () => {
    const r = analyze({ ...REAL, now: NOW, options: { scope: 'all' } });
    assert.deepEqual(rules(r).sort(), ['chrome.restricted', 'chrome.restricted', 'flag.off', 'health.crash', 'health.tool', 'mk.dropdown', 'mk.handoff']);
    const dd = find(r, 'mk.dropdown');
    assert.deepEqual([dd.hosts, dd.count, dd.chats, dd.status], [['shop.example.com'], 3, 2, 'open']);
    const nav = find(r, 'health.tool');
    assert.deepEqual([nav.tools, nav.count, nav.category, nav.owner, nav.severity], [['browser_navigate'], 3, 'CHROME_LIMIT', 'setup', 3]);
    assert.match(nav.why, /3 of 10 calls failed \(30%\)/);
    assert.deepEqual(r.fixFirst.map((id) => r.findings.find((f) => f.id === id).rule), ['health.crash', 'health.tool', 'mk.dropdown']);
    const crash = find(r, 'health.crash');
    assert.deepEqual([crash.count, crash.title, crash.message], [3, 'Claude Code crashed 3×', 'Agent exited (SIGKILL)']);
    assert.equal(r.coverage.outcomes, 1);
    assert.equal(r.expected.singleTabRecovered, 1);
  });

  test('every remedy action is a safe kind; settings are opened, never switched', () => {
    const kinds = new Set(['open_settings', 'copy_command', 'skill_draft', 'skill_with_agent', 'memory_note', 'use_agent', 'open_extensions', 'copy_bug_report', 'ask_agent', 'open_chat', 'hide', 'stop']);
    const reports = [
      analyze({ ...GOLDEN, now: NOW, logDigest: LOG, options: { scope: 'all', includeTests: true } }),
      analyze({ ...REAL, now: NOW, logDigest: LOG, options: { scope: 'all' } }),
    ];
    for (const r of reports) {
      for (const f of [...r.findings, ...r.live]) {
        assert.ok(['tabhelm_fix', 'skill', 'memory', 'preamble', 'setting', 'command', 'agent_choice', 'user_action', 'none'].includes(f.remedy.type), f.rule);
        for (const a of f.remedy.actions) {
          assert.ok(kinds.has(a.kind), `${f.rule}: ${a.kind}`);
          if (a.kind === 'open_settings') assert.match(a.target, /^(?:experimental:[A-Za-z]+|skills)$/);
        }
        assert.doesNotMatch(JSON.stringify(f), /undefined/);
      }
    }
  });
});

describe('skill drafts', () => {
  test('a dropdown draft: name, description, what failed, what worked (labels), checklist — no typed values', () => {
    const r = analyze({ ...REAL, now: NOW, options: { scope: 'all' } });
    const d = skillDraft(find(r, 'mk.dropdown'), REAL.chats);
    assert.equal(d.name, 'example-dropdowns');
    assert.equal(d.description, 'Use on shop.example.com when choosing options in its dropdowns.');
    assert.match(d.body, /^# shop\.example\.com: dropdowns\n\nLearned from 2 chats\./);
    assert.match(d.body, /## What fails\n- browser_select_option: <ref> is not a <select>; click it and pick the option instead\. \(×3\)/);
    assert.match(d.body, /## What worked instead\n- Click “Size”\n- Click “M”\n- Click “Add to cart”/);
    assert.match(d.body, /## Checklist\n- Dropdowns are custom widgets/);
  });

  test('typed text, option values and URLs never reach a draft', () => {
    const c = chat('cn', { url: 'https://shop.example.com/p?q=CANARY_URL' }).user('CANARY_USER').connect()
      .act('browser_select_option', { ref: 'e21', values: ['CANARY_VALUE'] }, 'No option matching "CANARY_OPTION".')
      .act('browser_select_option', { ref: 'e21', values: ['CANARY_VALUE'] }, 'No option matching "CANARY_OPTION".')
      .act('browser_type', { ref: 'e3', text: 'CANARY_TYPED' }, null, { label: 'Search' })
      .act('browser_navigate', { url: 'https://shop.example.com/cart?id=CANARY_URL2' })
      .act('browser_fill_form', { fields: [{ ref: 'e4', value: 'CANARY_FIELD' }] })
      .ok('CANARY_AGENT').chat();
    const r = run([c], { scope: 'chat', chatId: 'cn' });
    const d = skillDraft(find(r, 'mk.dropdown'), [c]);
    assert.doesNotMatch(JSON.stringify(d), /CANARY/);
    assert.match(d.body, /- Type <12 chars> into “Search”\n- Open shop\.example\.com\n- Fill 1 field/);
    assert.doesNotMatch(JSON.stringify(r), /CANARY/);
  });

  test('a reserved name gets "-skill"; a draft without evidence still reads', () => {
    const d = skillDraft({ rule: 'mk.repeat', hosts: ['report.example.org'], tools: ['browser_click'], message: 'Element <ref> is not visible (zero size).', count: 4, chats: 2, evidence: [] }, []);
    assert.equal(d.name, 'example-pitfalls');
    assert.match(d.body, /- browser_click: Element <ref> is not visible \(zero size\)\. \(×4\)/);
    assert.equal(skillDraft({ rule: 'mk.repeat', hosts: ['local'] }).name, 'local-pitfalls');
  });
});

test('every code hint a finding carries names a file that still has that symbol', () => {
  const ROOT = join(here, '../../..');
  const reports = [
    analyze({ ...GOLDEN, now: NOW, logDigest: LOG, options: { scope: 'all', includeTests: true } }),
    analyze({ ...REAL, now: NOW, logDigest: LOG, options: { scope: 'all' } }),
    run(['a', 'b'].map((id, i) => chat(id, { url: 'about:blank', agent: i ? 'Codex' : 'Claude Code' }).user().connect().act('browser_click', { ref: 'button' }, BAD_REF).act('browser_click', { ref: 'e1' }, ABOUT_BLANK).ok().chat())),
  ];
  const hints = new Set(reports.flatMap((r) => r.findings.map((f) => f.code)).filter(Boolean).flatMap((c) => c.split('; ')));
  assert.ok(hints.size >= 4);
  for (const hint of hints) {
    const [file, symbol] = hint.split(' ');
    const src = readFileSync(join(ROOT, file), 'utf8');
    if (symbol) assert.ok(src.includes(symbol), `${hint}: symbol not found`);
  }
});

test('analyzer.js is pure: no chrome.*, no DOM, no clock', () => {
  const code = ANALYZER_SRC.replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\bchrome\./);
  assert.doesNotMatch(code, /(?<![\w.])(?:document|window|localStorage)\./);
  assert.doesNotMatch(code, /Date\.now\(|new Date\(\s*\)|performance\.now/);
});

test('THRESHOLDS are the spec values and frozen', () => {
  assert.equal(THRESHOLDS.tool.minRate, 0.2);
  assert.equal(THRESHOLDS.mk.correctionWindowMs, 600_000);
  assert.ok(Object.isFrozen(THRESHOLDS) && Object.isFrozen(THRESHOLDS.loop));
});
