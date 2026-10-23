// extension/selfanalysis-data.js against an in-memory chrome.storage: the
// agent's tabhelm_diagnose tool and the report's remembered state. Nothing here
// touches the real ~/.tabhelm files. Run: node --test host/scripts/selfanalysis/

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as data from '../../../extension/selfanalysis-data.js';

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const TAB = 100;
const iso = (ms) => new Date(ms).toISOString();

// Two turns: the first ended (or, with `lostFirst`, recorded no end), the
// second is the task running right now — the one that calls the tool.
function chat(id, { lostFirst = false } = {}) {
  const t0 = NOW - 10 * 60_000;
  const a = (sec, type, data) => ({ ts: iso(t0 + sec * 1000), type, ...data });
  const act = (sec, turn, tool, error = null) => a(sec, 'action', { turn, agent: 'Claude Code', tool, args: {}, desc: tool, ok: !error, error, host: 'shop.example.com' });
  const journal = [
    a(0, 'user', { turn: 1, text: 'Pick a colour', attachments: [] }),
    a(2, 'agent_connected', { turn: 1, agent: 'Claude Code' }),
    act(5, 1, 'browser_snapshot'),
    ...(lostFirst ? [] : [a(9, 'agent', { turn: 1, agent: 'Claude Code', model: 'sonnet', text: 'Done.', thought: '', failure: null, stopReason: 'end_turn' })]),
    a(60, 'user', { turn: 2, text: 'It does not work', attachments: [] }),
    act(65, 2, 'browser_select', 'Element is not a <select>'),
  ];
  return { id, created: t0, updated: t0 + 65_000, url: 'https://shop.example.com/item', tabId: TAB, agent: 'Claude Code', journal };
}

function area(data) {
  const pick = (keys) => (keys == null ? Object.keys(data) : typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys));
  return {
    data,
    async get(keys) {
      return structuredClone(Object.fromEntries(pick(keys).filter((k) => k in data).map((k) => [k, data[k]])));
    },
    async set(obj) {
      Object.assign(data, structuredClone(obj));
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    },
    async getKeys() {
      return Object.keys(data);
    },
  };
}

function install(c) {
  globalThis.chrome = {
    storage: {
      local: area({ features: { selfAnalysis: true }, chatIndex: [{ id: c.id, created: c.created, updated: c.updated, url: c.url, tabId: TAB }], [`chat:${c.id}`]: c }),
      session: area({ [`activeChat:${TAB}`]: c.id }),
    },
    runtime: { getManifest: () => ({ version: '0.31.0' }) },
    tabs: { get: async () => ({ id: TAB, url: c.url }) },
  };
  return globalThis.chrome.storage.local.data;
}

describe('tabhelm_diagnose (the agent calls it mid-task)', () => {
  after(() => delete globalThis.chrome);
  const ui = (c) => ({ liveChat: async () => ({ chat: c, hostVersion: '0.31.0', agents: [] }), confirm: async () => true });

  test('the running task is not reported as a lost outcome, with or without the panel', async () => {
    const c = chat('dg1');
    install(c);
    const withPanel = (await data.diagnoseTool(TAB, { scope: 'chat' }, ui(c))).content[0].text;
    const fromStorage = (await data.diagnoseTool(TAB, { scope: 'chat' }, { confirm: async () => true })).content[0].text;
    const recent = (await data.diagnoseTool(TAB, { scope: 'recent' }, ui(c))).content[0].text;
    for (const text of [withPanel, fromStorage, recent]) {
      assert.match(text, /^\[TabHelm self-analysis/);
      assert.doesNotMatch(text, /inv\.lost-outcome|not being saved/);
    }
  });

  test('an earlier task that recorded no end is still reported', async () => {
    const c = chat('dg2', { lostFirst: true });
    install(c);
    assert.match((await data.diagnoseTool(TAB, { scope: 'chat' }, ui(c))).content[0].text, /inv\.lost-outcome/);
  });
});

describe('report state: remembered once per opening', () => {
  after(() => delete globalThis.chrome);
  test('persist: false leaves selfAnalysisState alone; the default remembers what was reported', async () => {
    const store = install(chat('rs1', { lostFirst: true }));
    const first = await data.runSelfAnalysis({ scope: '30d', persist: false }, { now: NOW });
    const ids = first.report.findings.map((f) => f.id);
    assert.ok(ids.length);
    assert.equal(store.selfAnalysisState, undefined);
    await data.runSelfAnalysis({ scope: '30d' }, { now: NOW });
    assert.deepEqual(store.selfAnalysisState.last.ids, ids);
  });

  test('a passed state replaces the stored one (New stays against the opening baseline)', async () => {
    const store = install(chat('rs2', { lostFirst: true }));
    const { report } = await data.runSelfAnalysis({ scope: '30d', persist: false }, { now: NOW });
    store.selfAnalysisState = { last: { ids: report.findings.map((f) => f.id), status: {} } };
    const opened = { hidden: {}, last: { ids: [], status: {} } };
    const again = await data.runSelfAnalysis({ scope: '30d', persist: false }, { now: NOW, state: opened });
    assert.deepEqual(again.input.state, opened);
    assert.ok(again.report.findings.length && again.report.findings.every((f) => f.isNew), 'measured against the passed state, not the stored one');
    const stored = await data.runSelfAnalysis({ scope: '30d', persist: false }, { now: NOW });
    assert.ok(stored.report.findings.every((f) => !f.isNew));
  });
});
