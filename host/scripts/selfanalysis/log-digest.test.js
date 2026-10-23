// host/src/log-digest.js: the host.log digest the self-analysis joins with
// chat journals. Fixture: fixtures/host.log (+ host.log.1, the rotated day
// before), shaped like the real log of 2026-10-12..21 with no real content.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestLog, readLogWindow, redactLine } from '../../src/log-digest.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const REDACT_JS = new URL('../../../extension/redact.js', import.meta.url);

let tmp;
let onlyLog; // host.log alone
let bothLog; // host.log next to host.log.1

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'tabhelm-logdigest-'));
  mkdirSync(join(tmp, 'only'));
  mkdirSync(join(tmp, 'both'));
  onlyLog = join(tmp, 'only', 'host.log');
  bothLog = join(tmp, 'both', 'host.log');
  copyFileSync(join(FIXTURES, 'host.log'), onlyLog);
  copyFileSync(join(FIXTURES, 'host.log'), bothLog);
  copyFileSync(join(FIXTURES, 'host.log.1'), `${bothLog}.1`);
});

after(() => rmSync(tmp, { recursive: true, force: true }));

const fixtureDigest = (opts = {}) => digestLog(readLogWindow(onlyLog), opts);
const groupsOf = (d, kind) => d.groups.filter((g) => g.kind === kind);
const ts = (base, i) => new Date(Date.parse(base) + i * 1000).toISOString();
// Distinct words that survive redaction (numbers would all become "N").
const word = (i) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(97 + ((n - 1) % 26)) + s;
  return s;
};

describe('digestLog on the fixture', () => {
  test('groups errors by kind, agent, code and redacted text', () => {
    const d = fixtureDigest();
    assert.equal(d.v, 1);
    const [uncaught] = groupsOf(d, 'uncaught');
    assert.equal(uncaught.text, 'uncaught: Error: write EPIPE');
    assert.equal(uncaught.code, 'EPIPE');
    assert.equal(uncaught.frame, null, 'node internals are not TabHelm code');
    assert.deepEqual(uncaught.tabs, []);

    const [handling] = groupsOf(d, 'error_handling');
    assert.equal(handling.text, 'error handling start: Error: ACP connection closed');
    assert.equal(handling.code, 'start');

    const [prompt] = groupsOf(d, 'prompt_failed');
    assert.equal(prompt.text, 'ACP connection closed');
    assert.equal(prompt.count, 2);
    assert.deepEqual(prompt.tabs, [41, 99]);

    const tools = groupsOf(d, 'tool_error');
    assert.deepEqual(tools.map((g) => g.code), ['browser_select_option', 'browser_navigate', null]);
    assert.equal(tools[0].text, 'No option matching "…" in <ref>');
    assert.equal(tools[1].text, 'Cannot reach shop.example.com for <email>: net::ERR_NAME_NOT_RESOLVED');

    assert.deepEqual(groupsOf(d, 'unknown_type').map((g) => g.text), ['unknown message type frobnicate']);
    assert.equal(groupsOf(d, 'config').length, 2);
    assert.deepEqual(groupsOf(d, 'skill_lookup').map((g) => g.text), ['skill collection lookup failed for github.com: HTTP N']);
  });

  test('agent stderr: ENOSPC and the multi-line -32000 sign-in error are groups', () => {
    const d = fixtureDigest();
    const stderr = groupsOf(d, 'agent_stderr');
    assert.equal(stderr.length, 2);
    const enospc = stderr.find((g) => g.code === 'ENOSPC');
    assert.equal(enospc.agent, 'claude');
    assert.match(enospc.text, /^Failed to set up watcher for <path>\.json: Error: ENOSPC: System limit for number of file watchers/);
    assert.deepEqual(enospc.tabs, [41]);
    const auth = stderr.find((g) => g.agent === 'qoder');
    assert.equal(auth.code, '-32000');
    assert.equal(auth.text, 'Error handling request session/new → -N Authentication required: Authentication is required.');
    assert.deepEqual(auth.tabs, [12]);
  });

  test('noise is never grouped: session titles, Unexpected case, session/create, recordings, relay chatter', () => {
    const d = fixtureDigest();
    const all = JSON.stringify(d.groups);
    assert.doesNotMatch(all, /session title|Query closed|Unexpected case|session\/create|recording|relay|Reading prompt/);
    // Non-error stderr (including the 112 session-title lines) is only counted.
    assert.deepEqual(d.meta.stderrOther, { codex: 4, claude: 114 });
  });

  test('exits: 0/130/SIGTERM, SIGKILL after "stopping agent" and after "extension disconnected" are not crashes', () => {
    const d = fixtureDigest();
    const exits = groupsOf(d, 'agent_exit');
    assert.equal(exits.length, 1);
    assert.deepEqual({ ...exits[0], gid: undefined }, {
      gid: undefined, kind: 'agent_exit', agent: 'claude', code: 'SIGKILL', text: 'agent claude for tab N exited (SIGKILL)',
      frame: null, count: 1, first: '2026-10-20T10:26:00.000Z', last: '2026-10-20T10:26:00.000Z', tabs: [42],
      // Written by pid 4242 (v0.31.0), not by the newest host (v0.31.1).
      versions: { first: '0.31.0', last: '0.31.0' },
    });
    // Every exit is still an event, so the analyzer can apply its own 5 s rule.
    const exitEvents = d.events.filter((e) => e.kind === 'agent_exit');
    assert.deepEqual(exitEvents.map((e) => [e.tabId, e.code, e.gid !== null]), [
      [41, '0', false], [43, '130', false], [43, 'SIGTERM', false], [41, 'SIGKILL', false], [42, 'SIGKILL', true], [44, 'SIGKILL', false],
    ]);
    assert.equal(exitEvents[4].gid, exits[0].gid);
  });

  test('events: tab events plus the tab-less lifecycle and crash lines', () => {
    const d = fixtureDigest();
    assert.deepEqual(d.events.map((e) => e.kind), [
      'host_started', 'host_started', 'tool_error', 'tool_error', 'tool_error', 'prompt_failed', 'error_handling', 'prompt_failed',
      'agent_exit', 'agent_exit', 'agent_exit', 'stopping_agent', 'agent_exit', 'agent_exit', 'uncaught', 'ext_disconnected', 'agent_exit', 'host_started',
    ]);
    const stop = d.events.find((e) => e.kind === 'stopping_agent');
    assert.deepEqual(stop, { ts: '2026-10-20T10:25:00.000Z', kind: 'stopping_agent', tabId: 41, agent: 'claude', code: null, gid: null });
    const gids = new Set(d.groups.map((g) => g.gid));
    for (const e of d.events) if (e.gid) assert.ok(gids.has(e.gid), `event gid ${e.gid} has a group`);
  });

  test('runs: the 25-line relay retry loop is one run; a 3-line blip is not', () => {
    const d = fixtureDigest();
    // Old-format lines carry no pid, so the host version is unknown.
    assert.deepEqual(d.runs, [{ kind: 'relay_retry', length: 25, first: '2026-10-20T09:01:00.000Z', last: '2026-10-20T09:13:00.000Z', version: null }]);
  });

  test('meta: host facts from the newest "host started" line, counters, pairing codes', () => {
    const d = fixtureDigest();
    const size = statSync(onlyLog).size;
    assert.deepEqual(d.meta, {
      hostVersion: '0.31.1', pid: 5151, platform: 'linux', node: 'v22.11.0', relayMode: true,
      files: [{ name: 'host.log', bytes: size }],
      window: { since: null, until: null },
      bytesRead: size,
      linesScanned: 202,
      linesInWindow: 202,
      firstTs: '2026-10-20T09:00:00.000Z',
      truncated: false,
      pairingCodesSeen: 1,
      stderrOther: { codex: 4, claude: 114 },
    });
    const own = fixtureDigest({ meta: { hostVersion: '0.32.0', relayMode: false, pid: 7 } }).meta;
    assert.deepEqual([own.hostVersion, own.relayMode, own.pid, own.node], ['0.32.0', false, 7, 'v22.11.0']);
  });

  test('privacy: no pairing code, path, email, URL path, typed text or canary leaves the host', () => {
    const json = JSON.stringify(fixtureDigest());
    assert.doesNotMatch(json, /K7PM-3QWX|CANARY|ivanko|\/home\/|@example|jane|https?:\/\/\S+\/\S|Large/);
  });

  test('is deterministic', () => {
    assert.equal(JSON.stringify(fixtureDigest({ tabIds: [41] })), JSON.stringify(fixtureDigest({ tabIds: [41] })));
  });
});

describe('digestLog filters', () => {
  test('window: only lines within [since - 60 s, until + 60 s]', () => {
    // From 10:20:40, just after the last session-title line.
    const d = fixtureDigest({ since: '2026-10-20T10:21:40Z', until: '2026-10-20T10:22:00Z' });
    assert.deepEqual(d.events.map((e) => `${e.ts.slice(11, 19)} ${e.kind}`), [
      '10:21:00 tool_error', '10:21:05 tool_error', '10:21:10 tool_error', '10:22:00 prompt_failed', '10:22:01 error_handling', '10:23:00 prompt_failed',
    ]);
    assert.deepEqual(d.groups.map((g) => g.kind).sort(), ['error_handling', 'prompt_failed', 'tool_error', 'tool_error', 'tool_error']);
    assert.deepEqual(d.runs, []);
    assert.deepEqual(d.meta.window, { since: '2026-10-20T10:21:40.000Z', until: '2026-10-20T10:22:00.000Z' });
    assert.equal(d.meta.linesInWindow, 8); // 6 records + 2 stack frames
    assert.equal(d.meta.firstTs, '2026-10-20T09:00:00.000Z'); // of everything read
    assert.equal(d.meta.pairingCodesSeen, 1); // about the file, not the window
    // Epoch milliseconds work the same as ISO strings.
    const ms = fixtureDigest({ since: Date.parse('2026-10-20T10:21:40Z'), until: Date.parse('2026-10-20T10:22:00Z') });
    assert.deepEqual(ms, d);
  });

  test('tabIds: tab events only for those tabs; tab-less events and groups stay', () => {
    const d = fixtureDigest({ tabIds: [41] });
    const tabEvents = d.events.filter((e) => ['prompt_failed', 'agent_exit', 'stopping_agent', 'tool_error'].includes(e.kind));
    assert.ok(tabEvents.length > 0);
    assert.ok(tabEvents.every((e) => e.tabId === 41));
    assert.deepEqual(new Set(d.events.filter((e) => e.tabId === null).map((e) => e.kind)), new Set(['host_started', 'error_handling', 'uncaught', 'ext_disconnected']));
    // Groups are not filtered: their tabs tell the analyzer which chats they touch.
    assert.deepEqual(groupsOf(d, 'prompt_failed')[0].tabs, [41, 99]);
    assert.equal(groupsOf(d, 'agent_exit').length, 1);

    const none = fixtureDigest({ tabIds: [] });
    assert.ok(none.events.every((e) => e.tabId === null));
  });

  test('continuation lines attach to the previous record; one before any record is dropped', () => {
    const d = digestLog([
      '    at orphanFrame (x.js:1:1)',
      '2026-10-20T10:00:00.000Z [9] uncaught: TypeError: x is not a function',
      'continued message line',
      '    at run (node:internal/a:1:1)',
      '    at later (node:internal/b:2:2)',
      '2026-10-20T10:00:01.000Z [9] host started v1.0.0 pid=9 node=v22.0.0 darwin, tool server http://127.0.0.1:1/call',
    ]);
    assert.equal(d.groups.length, 1);
    assert.equal(d.groups[0].text, 'uncaught: TypeError: x is not a function');
    assert.equal(d.groups[0].frame, null);
    assert.equal(d.meta.linesScanned, 6);
    assert.equal(d.meta.linesInWindow, 5);
    assert.equal(d.meta.platform, 'darwin');
  });

  test('frame: basename:line of the first frame in TabHelm code, below any internals; never a path', () => {
    const d = digestLog([
      '2026-10-20T10:00:00.000Z [9] uncaught: Error: write EPIPE',
      '    at afterWriteDispatched (node:internal/stream_base_commons:159:15)',
      '    at Socket._write (node:net:1270:8)',
      '    at Object.write (file:///home/ivanko/tabhelm/host/node_modules/ws/lib/sender.js:10:1)',
      '    at log (file:///home/ivanko/.tabhelm/app/host/src/native-messaging.js:125:20)',
      '    at main (file:///home/ivanko/.tabhelm/app/host/src/native-host.js:40:3)',
      '2026-10-20T10:00:01.000Z [9] error handling prompt: TypeError: x is not a function',
      '    at handle (C:\\Users\\ivanko\\tabhelm\\host\\src\\native-host.js:212:11)',
      '2026-10-20T10:00:02.000Z [9] [claude:41] Error: boom',
      '    at run (/home/ivanko/.npm/claude-agent-acp/dist/index.js:5:5)',
    ]);
    const frames = Object.fromEntries(d.groups.map((g) => [g.kind, g.frame]));
    assert.deepEqual(frames, { uncaught: 'native-messaging.js:125', error_handling: 'native-host.js:212', agent_stderr: null });
    assert.ok(!JSON.stringify(d).includes('ivanko'), 'no user name or path from the stack');
  });

  test('versions: each group is tagged with the version of the host (pid) that wrote it', () => {
    const d = digestLog([
      // The spec's "pid=" format and the one native-host.js writes (pid only in the prefix).
      '2026-10-20T10:00:00.000Z [7] host started v0.30.0 pid=7 node=v22.0.0 linux, tool server http://127.0.0.1:1/call',
      '2026-10-20T10:00:01.000Z [8] host started v0.31.0 node=v22.0.0 linux, tool server http://127.0.0.1:2/call',
      '2026-10-20T10:00:02.000Z [7] uncaught: Error: write EPIPE',
      '2026-10-20T10:00:03.000Z [8] uncaught: Error: write EPIPE',
      '2026-10-20T10:00:04.000Z [9] unknown message type x',
      '2026-10-20T10:00:05.000Z unknown message type y',
    ]);
    const by = Object.fromEntries(d.groups.map((g) => [g.text, g.versions]));
    assert.deepEqual(by['uncaught: Error: write EPIPE'], { first: '0.30.0', last: '0.31.0' });
    assert.deepEqual(by['unknown message type x'], { first: null, last: null }, 'pid 9 never logged its start');
    assert.deepEqual(by['unknown message type y'], { first: null, last: null }, 'old lines have no pid');
    assert.equal(d.meta.hostVersion, '0.31.0', 'meta still names the newest host');
  });

  test('the start line exactly as native-host.js writes it gives the host facts and group versions', () => {
    // host/src/native-host.js: log() prefixes "[pid] ", then logs this line.
    const started = (pid, hostVersion, relayMode) => {
      const toolServer = { url: `http://127.0.0.1:${40000 + pid}/call` };
      const process = { version: 'v22.11.0', platform: 'linux' };
      return `[${pid}] host started v${hostVersion} node=${process.version} ${process.platform}${relayMode ? ' relay' : ''}, tool server ${toolServer.url}`;
    };
    const d = digestLog([
      `2026-10-20T10:00:00.000Z ${started(31, '0.31.0', false)}`,
      '2026-10-20T10:00:01.000Z [31] uncaught: Error: write EPIPE',
      `2026-10-20T10:05:00.000Z ${started(32, '0.32.0', true)}`,
      '2026-10-20T10:05:01.000Z [32] uncaught: Error: write EPIPE',
      '2026-10-20T10:05:02.000Z [32] relay: connect ECONNREFUSED 127.0.0.1:1',
    ]);
    assert.deepEqual(d.groups.map((g) => g.versions), [{ first: '0.31.0', last: '0.32.0' }]);
    assert.deepEqual([d.meta.hostVersion, d.meta.pid, d.meta.node, d.meta.platform, d.meta.relayMode], ['0.32.0', 32, 'v22.11.0', 'linux', true]);
    // A line with no pid at all (before the prefix existed) names no pid.
    assert.equal(digestLog(['2026-10-20T10:00:00.000Z host started v0.30.0 node=v22.0.0 linux, tool server http://127.0.0.1:1/call']).meta.pid, null);
  });

  test('relay runs are per host pid and end at "connected"/"paired"', () => {
    const lines = [];
    for (let i = 0; i < 30; i++) {
      lines.push(`${ts('2026-10-20T10:00:00Z', i * 2)} [100] relay: disconnected (1006 ); retrying in 30s`);
      // Another host connecting does not end host 100's loop.
      if (i === 10) lines.push(`${ts('2026-10-20T10:00:00Z', i * 2 + 1)} [200] relay: connected to wss://relay.example.com`);
    }
    lines.push(`${ts('2026-10-20T10:01:00Z', 0)} [100] relay: connected to wss://relay.example.com`);
    for (let i = 0; i < 21; i++) lines.push(`${ts('2026-10-20T10:02:00Z', i)} [100] relay: ECONNRESET socket`);
    const d = digestLog(lines);
    assert.deepEqual(d.runs.map((r) => r.length), [30, 21]);
  });

  test('the 300-group cap keeps the most frequent groups and sets truncated', () => {
    const lines = [];
    for (let i = 0; i < 400; i++) lines.push(`${ts('2026-10-20T10:00:00Z', i)} unknown message type t${word(i)}`);
    for (let i = 0; i < 5; i++) lines.push(`${ts('2026-10-20T11:00:00Z', i)} unknown message type tzzz`);
    const d = digestLog(lines);
    assert.equal(d.groups.length, 300);
    assert.equal(d.meta.truncated, true);
    assert.deepEqual([d.groups[0].text, d.groups[0].count], ['unknown message type tzzz', 5]);
    assert.ok(JSON.stringify(d).length <= 200_000);
  });

  test('the 200 KB cap keeps 200 events, then drops groups seen once', () => {
    const lines = [];
    const tabIds = Array.from({ length: 200 }, (_, i) => 100000 + i);
    // 100 groups, each in all 200 requested tabs: big, and worth keeping.
    for (let g = 0; g < 100; g++) {
      for (const tab of tabIds) lines.push(`${ts('2026-10-20T10:00:00Z', g)} prompt failed for tab ${tab}: Boom ${word(g)}`);
    }
    // 190 long one-off groups.
    const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam';
    for (let g = 0; g < 190; g++) lines.push(`${ts('2026-10-20T11:00:00Z', g)} unknown message type t${word(g)} ${filler}`);
    const d = digestLog(lines, { tabIds });
    assert.ok(JSON.stringify(d).length <= 200_000);
    assert.equal(d.meta.truncated, true);
    assert.equal(d.events.length, 200);
    assert.equal(d.groups.length, 100);
    assert.ok(d.groups.every((g) => g.count === 200 && g.tabs.length === 200));
    const gids = new Set(d.groups.map((g) => g.gid));
    assert.ok(d.events.every((e) => e.gid === null || gids.has(e.gid)));
  });

  test('events are capped at 500, keeping failures over lifecycle lines', () => {
    const lines = [];
    for (let i = 0; i < 600; i++) lines.push(`${ts('2026-10-20T10:00:00Z', i)} host started, tool server http://127.0.0.1:1/call`);
    for (let i = 0; i < 450; i++) lines.push(`${ts('2026-10-20T11:00:00Z', i)} prompt failed for tab 7: ACP connection closed`);
    const d = digestLog(lines);
    assert.equal(d.events.length, 500);
    assert.equal(d.events.filter((e) => e.kind === 'prompt_failed').length, 450);
    assert.equal(d.events[0].ts, ts('2026-10-20T10:00:00Z', 550)); // the newest 50 starts
    assert.equal(d.meta.truncated, true);
  });
});

describe('readLogWindow', () => {
  test('merges host.log.1 when the window starts before host.log', () => {
    const lines = readLogWindow(bothLog, { since: '2026-10-19T00:00:00Z' });
    assert.deepEqual(lines.files.map((f) => f.name), ['host.log.1', 'host.log']);
    assert.equal(lines.bytesRead, statSync(bothLog).size + statSync(`${bothLog}.1`).size);
    const d = digestLog(lines, { since: '2026-10-19T00:00:00Z' });
    const [uncaught] = groupsOf(d, 'uncaught');
    assert.deepEqual([uncaught.count, uncaught.first, uncaught.last], [2, '2026-10-19T08:05:00.000Z', '2026-10-20T10:30:00.000Z']);
    assert.equal(groupsOf(d, 'prompt_failed')[0].count, 3);
    assert.equal(d.meta.firstTs, '2026-10-19T08:00:00.000Z');
    assert.deepEqual(d.meta.files.map((f) => f.name), ['host.log.1', 'host.log']);
  });

  test('skips host.log.1 when host.log already covers since, or was not read whole', () => {
    assert.deepEqual(readLogWindow(bothLog, { since: '2026-10-20T09:30:00Z' }).files.map((f) => f.name), ['host.log']);
    // Budget smaller than host.log: only its tail, first (cut) line dropped, no .1.
    const tail = readLogWindow(bothLog, { since: '2026-10-19T00:00:00Z', maxBytes: 2000 });
    assert.deepEqual(tail.files.map((f) => f.name), ['host.log']);
    assert.ok(tail.bytesRead <= 2000);
    assert.ok(readFileSync(bothLog, 'utf8').includes(`\n${tail[0]}\n`), 'the first kept line is a whole line');
    assert.equal(tail.at(-1), '2026-10-20T11:00:01.000Z [5151] relay: pairing code issued (valid 10 minutes)');
  });

  test('missing files read as an empty log', () => {
    const lines = readLogWindow(join(tmp, 'nope', 'host.log'), {});
    assert.deepEqual([...lines], []);
    assert.deepEqual(lines.files, []);
    const d = digestLog(lines);
    assert.deepEqual([d.events, d.groups, d.runs, d.meta.linesScanned, d.meta.firstTs], [[], [], [], 0, null]);
    // Right after rotation only host.log.1 may exist.
    const dir = join(tmp, 'rotated');
    mkdirSync(dir);
    copyFileSync(join(FIXTURES, 'host.log.1'), join(dir, 'host.log.1'));
    assert.deepEqual(readLogWindow(join(dir, 'host.log')).files.map((f) => f.name), ['host.log.1']);
  });

  test('a 50 MB log is read only from its tail and digests under 200 KB', () => {
    const file = join(tmp, 'big', 'host.log');
    mkdirSync(dirname(file));
    const fd = openSync(file, 'w');
    const base = Date.parse('2026-10-01T00:00:00Z');
    let written = 0;
    let i = 0;
    try {
      writeSync(fd, `${new Date(base).toISOString()} [1] uncaught: Error: HEADMARK\n`);
      while (written < 50 * 1024 * 1024) {
        const chunk = [];
        for (let k = 0; k < 5000; k++, i++) {
          const at = new Date(base + 1000 + i * 100).toISOString();
          chunk.push(i % 3
            ? `${at} [1] relay: connect ECONNREFUSED 127.0.0.1:18958 (filler line to make the file big quickly)`
            : `${at} [1] prompt failed for tab ${i % 50}: ACP connection closed while sending the prompt number ${i}`);
        }
        const text = `${chunk.join('\n')}\n`;
        writeSync(fd, text);
        written += Buffer.byteLength(text);
      }
      writeSync(fd, `${new Date(base + 1000 + i * 100).toISOString()} [1] uncaught: Error: TAILMARK\n`);
    } finally {
      closeSync(fd);
    }
    try {
      assert.ok(statSync(file).size > 50 * 1024 * 1024);
      const lines = readLogWindow(file, {});
      assert.ok(lines.bytesRead <= 8 << 20, `read ${lines.bytesRead} bytes`);
      assert.ok(lines.length < 200_000);
      const d = digestLog(lines, { tabIds: [1, 2, 3] });
      const json = JSON.stringify(d);
      assert.ok(json.length < 200_000, `digest is ${json.length} bytes`);
      assert.match(json, /TAILMARK/);
      assert.doesNotMatch(json, /HEADMARK/);
      assert.ok(d.meta.firstTs > '2026-10-01T00:00:01.000Z');
      assert.equal(d.meta.files[0].bytes, statSync(file).size);
      // Relay lines are one loop: prompt_failed lines between them do not end it.
      assert.equal(d.runs.length, 1);
      assert.ok(d.runs[0].length > 20_000);
    } finally {
      rmSync(file, { force: true });
    }
  });

  test('scans at most 200,000 lines, keeping the newest', () => {
    const file = join(tmp, 'many.log');
    const lines = [];
    for (let i = 0; i < 250_000; i++) lines.push(`2026-10-20T10:00:00.000Z x${i}`);
    writeFileSync(file, `${lines.join('\n')}\n`);
    try {
      const read = readLogWindow(file, {});
      assert.equal(read.length, 200_000);
      assert.equal(read[0], '2026-10-20T10:00:00.000Z x50000');
      assert.equal(read.at(-1), '2026-10-20T10:00:00.000Z x249999');
      assert.equal(digestLog(read).meta.linesScanned, 200_000);
    } finally {
      rmSync(file, { force: true });
    }
  });
});

describe('redactLine', () => {
  const cases = [
    ['Signed in as ada.lovelace+test@example.co.uk', 'Signed in as <email>'],
    ['Typed {{SECRET:card_pin}} into e14', 'Typed {{SECRET}} into <ref>'],
    ['/home/ivanko/x/y.pdf', '<path>.pdf'],
    ['relay: pairing code K7PM-3QWX', 'relay: pairing code <code>'],
    ['See AUTHORS and HTTPS docs', 'See AUTHORS and HTTPS docs'],
    // Fake keys are split in two so secret scanners do not report them as leaks.
    ['Invalid API key sk-' + 'test-0000example0000example', 'Invalid API key <key>'],
    ['Bad credentials ghp' + '_exampleExampleExample0123456789ab', 'Bad credentials <key>'],
    ['jwt eyJhbGciOiJIUzI1NiJ9' + '.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlMTIz expired', 'jwt <key> expired'],
    ['GET https://shop.example.com/cart/checkout?session=abc123&user=42#top failed', 'GET shop.example.com failed'],
    ['relay: connect ECONNREFUSED 127.0.0.1:18958', 'relay: connect ECONNREFUSED N.0.0.1:N'],
    ['No option matching "Ada Lovelace" in f1:e12', 'No option matching "…" in <ref>'],
    ['browser_select_option and browser_handle_dialog failed in extension/browser-tools', 'browser_select_option and browser_handle_dialog failed in extension/browser-tools'],
    ['session 9f86d081884c7d659a2feaa0c55ad015 expired', 'session <token> expired'],
    ['  spaced\n\tout   text ', 'spaced out text'],
  ];
  for (const [input, expected] of cases) {
    test(JSON.stringify(input), () => assert.equal(redactLine(input), expected));
  }

  test('canary: no user, folder or file name from a path, and no quoted page text', () => {
    const lines = [
      '2026-10-20T10:00:00.000Z [9] error handling start: Error: Not a folder: /Users/CANARY/Google Drive/Clients/Acme CANARY',
      '2026-10-20T10:00:01.000Z [9] error handling start: Error: Not a folder: /home/kos/Документи/Клієнти/ТОВ Ромашка',
      '2026-10-20T10:00:02.000Z [9] error handling start: Error: Not a folder: C:\\Users\\Olena Petrenko\\Desktop\\work',
      "2026-10-20T10:00:03.000Z [9] [claude:41] Error: EACCES: permission denied, open '/home/u/My CANARY/Acme Bank/notes.txt'",
      '2026-10-20T10:00:04.000Z [9] prompt failed for tab 41: ENOENT \\\\fileserver\\CANARY\\HR\\salaries.xlsx',
      '2026-10-20T10:00:05.000Z [9] tool error [tab 41] browser_click: A JavaScript confirm dialog is blocking the page: "Delete "Invoice 42 for CANARY Petrenko"?".',
      "2026-10-20T10:00:06.000Z [9] tool error [tab 41] browser_evaluate: SyntaxError: Failed to execute 'querySelector' on 'Document': 'li:has-text(CANARY)' is not a valid selector.",
      '2026-10-20T10:00:07.000Z [9] tool error [tab 41] browser_find: Cannot find «CANARY Петренко»',
      '2026-10-20T10:00:08.000Z [9] prompt failed for tab 41: Error: bad cwd:/home/u/CANARY Clinic/x and ERROR:C:\\Users\\CANARY Petrenko',
      '2026-10-20T10:00:09.000Z [9] prompt failed for tab 41: EPERM \\\\?\\C:\\Users\\CANARY Petrenko\\x.txt or smb://fs/HR/CANARY.xlsx',
    ];
    const d = digestLog(lines, { tabIds: [41] });
    const json = JSON.stringify(d);
    assert.doesNotMatch(json, /CANARY|Petrenko|Петренко|Olena|Документи|Клієнти|Ромашка|Acme|salaries|Desktop|Google Drive/);
    const texts = d.groups.map((g) => g.text);
    assert.ok(texts.includes('error handling start: Error: Not a folder: <path>'), texts.join('\n'));
    assert.ok(texts.includes("Error: EACCES: permission denied, open '<path>.txt'"), texts.join('\n'));
  });

  test('truncates to 160 characters with an ellipsis', () => {
    const out = redactLine('word '.repeat(100));
    assert.equal(out.length, 160);
    assert.ok(out.endsWith('…'));
  });

  test('parity with extension/redact.js steps 2-13', async (t) => {
    if (!existsSync(REDACT_JS)) {
      t.skip('extension/redact.js is not there yet; parity not checked');
      return;
    }
    const { REDACTION_TABLE, redactText, normalize, norm } = await import(REDACT_JS.href);
    // redactText is steps 1-11; with normalize, whitespace and truncation it is
    // norm(), which is what redactLine mirrors.
    const extra = [
      ...cases.map(([input]) => input),
      'Failed to set up watcher for /home/ivanko/.claude/settings.json: Error: ENOSPC: System limit for number of file watchers reached',
      'Cannot reach https://shop.example.com/cart/CANARY_3?id=CANARY_4 for jane.doe@example.com: net::ERR_NAME_NOT_RESOLVED',
      'at Connection.close (file:///home/ivanko/tabhelm/host/node_modules/@agentclientprotocol/sdk/dist/jsonrpc.js:589:37)',
      'about:blank, chrome://settings/passwords, devtools://devtools/bundled/x.html, ws://[::1]:9229/x and wss://relay.example.com/host?key=abc',
      `${'x'.repeat(149)} 😀😀😀😀😀😀`, // a surrogate pair straddles the cut
      'word '.repeat(100),
      // Unpaired, glued and multi-line quotes; apostrophes; paths that end at a quote or a line.
      "a '<path>' Ivan' b, it's", 'cut “Ivan Petr', 'x "…"Ivan" y', "don't stop, it's Ada's", 'line "a\nb" c',
      'Not a folder: /home/u/My Docs\n    at f (/home/u/x.js:1:2)', "open '/Users/a/Ivan’s Files/x.pdf' and «Іван»",
    ];
    for (const input of [...REDACTION_TABLE.map(([input]) => input), ...extra]) {
      const expected = norm(input);
      assert.equal(redactLine(input), expected, JSON.stringify(input));
      const viaSteps = normalize(redactText(input)).replace(/\s+/g, ' ').trim();
      if (viaSteps.length <= 160) assert.equal(redactLine(input), viaSteps, JSON.stringify(input));
    }
    for (const [input, expected] of REDACTION_TABLE) assert.equal(redactLine(input), expected, JSON.stringify(input));
  });
});

test('redactLine truncation never leaves part of a host name', () => {
  const out = redactLine(`${'y'.repeat(150)} connect to portal.privatbank.ua failed`);
  assert.doesNotMatch(out, /portal|privat/);
  assert.match(out, /connect…$/);
});
