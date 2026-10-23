// extension/selfanalysis-ui.js against a minimal fake DOM and an in-memory
// chrome: opening chats from the report, the report's run order and its
// remembered state, Show again, and the Diagnose card. Nothing here touches
// the real ~/.tabhelm files. Run: node --test host/scripts/selfanalysis/

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// Just enough of the DOM for the module: elements by id, children, text.
class El {
  constructor(tag) {
    Object.assign(this, { tagName: tag.toUpperCase(), children: [], attrs: {}, hidden: false, _text: '', className: '', dataset: {}, parentElement: null });
    this.classList = { toggle: (c, on) => (this.className = on ? `${this.className} ${c}`.trim() : this.className.replace(c, '').trim()) };
  }
  append(...c) {
    for (const x of c) {
      const n = x instanceof El ? x : Object.assign(new El('#text'), { _text: String(x) });
      n.parentElement = this;
      this.children.push(n);
    }
  }
  replaceChildren(...c) {
    this._text = '';
    this.children = [];
    this.append(...c);
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  remove() {}
  click() {
    return this.onclick?.();
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  all() {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
}
const byId = new Map();
const $ = (id) => {
  if (!byId.has(id)) new El('label').append(byId.set(id, Object.assign(new El('div'), { id })).get(id));
  return byId.get(id);
};
const buttons = (root, text) => root.all().filter((e) => e.tagName === 'BUTTON' && (text instanceof RegExp ? text.test(e.textContent) : e.textContent === text));

function area(data) {
  const pick = (keys) => (keys == null ? Object.keys(data) : [].concat(keys));
  return {
    data,
    get: async (keys) => structuredClone(Object.fromEntries(pick(keys).filter((k) => k in data).map((k) => [k, data[k]]))),
    set: async (obj) => void Object.assign(data, structuredClone(obj)),
    remove: async (keys) => [].concat(keys).forEach((k) => delete data[k]),
    getKeys: async () => Object.keys(data),
  };
}

// Three chats with the same failing dropdown: this panel's (tab 100), one
// still open in tab 200 and one whose tab shows another page now.
function chat(id, tabId, url, ageMin) {
  const t0 = NOW - ageMin * 60_000;
  const a = (sec, type, data) => ({ ts: iso(t0 + sec * 1000), type, ...data });
  const act = (sec) => a(sec, 'action', { turn: 1, agent: 'Claude Code', tool: 'browser_select', args: {}, desc: 'select', ok: false, error: 'Element is not a <select>', host: new URL(url).host });
  const journal = [a(0, 'user', { turn: 1, text: 'Pick a colour', attachments: [] }), a(2, 'agent_connected', { turn: 1, agent: 'Claude Code' }), act(5), act(6), act(7)];
  journal.push(a(9, 'agent', { turn: 1, agent: 'Claude Code', model: 'sonnet', text: 'Done.', failure: null, stopReason: 'end_turn' }), a(30, 'user_report', { text: 'the list does not open' }));
  return { id, created: t0, updated: t0 + 30_000, url, tabId, agent: 'Claude Code', journal };
}
const HERE = chat('cHere', 100, 'https://shop.example.com/item', 10);
const OTHER_TAB = chat('cOther', 200, 'https://other.example.org/a', 20);
const GONE = chat('cGone', 300, 'https://third.example.net/x', 30);

describe('self-analysis panel UI', () => {
  const calls = { openSaved: [], panelOpened: [] };
  const saved = {};
  let ui;
  let local;
  let hold = null; // pending host log requests, while a test holds them
  const navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const body = () => $('report-body');
  const rendered = async () => {
    for (let i = 0; i < 500 && /Analysing/.test(body().textContent); i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 20));
  };

  before(async () => {
    local = area({
      features: { selfAnalysis: true },
      featureSettings: { selfAnalysis: { days: 0 } }, // "All chats"
      selfAnalysisState: { last: { generated: null, ids: [], status: {} } }, // an earlier, empty report
      chatIndex: [HERE, OTHER_TAB, GONE].map((c) => ({ id: c.id, created: c.created, updated: c.updated, url: c.url, tabId: c.tabId })),
      ...Object.fromEntries([HERE, OTHER_TAB, GONE].map((c) => [`chat:${c.id}`, c])),
    });
    globalThis.document = { getElementById: $, createElement: (t) => new El(t), createTextNode: (t) => Object.assign(new El('#text'), { _text: t }), querySelector: () => null, querySelectorAll: () => [] };
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} }, userAgent: '' }, configurable: true });
    globalThis.chrome = {
      storage: { local, session: area({}), onChanged: { addListener() {} } },
      runtime: { getManifest: () => ({ version: '0.31.0' }), id: 'ext' },
      tabs: {
        query: async () => [{ id: 100, url: HERE.url }, { id: 200, url: `${OTHER_TAB.url}?step=2` }, { id: 300, url: 'https://elsewhere.example/' }],
        get: async (id) => ({ id, windowId: 1 }),
        update: async () => {},
        create: () => {},
      },
      sidePanel: { setOptions: async () => {}, open: async ({ tabId }) => void calls.panelOpened.push(tabId) },
      windows: { update: async () => {} },
    };
    for (const id of ['report', 'history', 'settings']) $(id).hidden = true;
    ui = await import('../../../extension/selfanalysis-ui.js');
    ui.initSelfAnalysis({
      tabId: 100,
      add: (tag, cls) => {
        const e = Object.assign(new El(tag), { className: cls });
        $('log').append(e);
        return e;
      },
      scrollDown() {},
      record: (type) => (saved[type] = (saved[type] || 0) + 1),
      hostRequest: () => (hold ? new Promise((r) => hold.push(() => r({ digest: null }))) : Promise.resolve({ digest: null })),
      hostVersion: () => '0.31.0',
      agents: () => [],
      openSavedChat: (id) => calls.openSaved.push(id),
      liveChat: () => ({ id: HERE.id, created: HERE.created, updated: NOW, tabId: 100, agent: 'Claude Code', journal: HERE.journal }),
      liveState: () => ({ busy: true, openCards: [{ kind: 'confirm', title: 'Delete the item?' }] }),
    });
  });
  after(() => {
    delete globalThis.chrome;
    delete globalThis.document;
    if (navigatorBefore) Object.defineProperty(globalThis, 'navigator', navigatorBefore);
  });

  test('opens on the report window from Settings ("All chats" is 0) and un-highlights History', async () => {
    $('history').hidden = false;
    $('history-open').setAttribute('aria-pressed', 'true');
    await ui.openReport();
    assert.equal($('report-scope').value, 'all');
    assert.equal($('history-open').getAttribute('aria-pressed'), 'false');
    assert.equal($('history').hidden, true);
    await rendered();
    assert.match(body().textContent, /3 chats/);
  });

  test('what was reported is remembered once per opening: New stays after refresh and Hide', async () => {
    const generated = local.data.selfAnalysisState.last.generated;
    assert.ok(generated, 'the opening run is remembered');
    const news = () => body().all().filter((e) => e.className === 'badge' && e.textContent === 'New').length;
    const before = news();
    assert.ok(before > 0);
    $('report-refresh').click();
    await rendered();
    assert.equal(news(), before);
    await buttons(body(), 'Hide')[0].onclick();
    await rendered();
    assert.equal(local.data.selfAnalysisState.last.generated, generated, 're-renders do not overwrite the baseline');
    assert.equal(Object.keys(local.data.selfAnalysisState.hidden).length, 1);
    assert.ok(news() > 0, 'New badges survive Hide');
  });

  test('a hidden finding offers Show again, which brings it back', async () => {
    const show = buttons(body(), 'Show again');
    assert.equal(show.length, 1);
    await show[0].onclick();
    await rendered();
    assert.deepEqual(local.data.selfAnalysisState.hidden, {});
    assert.equal(buttons(body(), 'Show again').length, 0);
  });

  test('a slower earlier run does not replace a newer one', async () => {
    hold = [];
    $('report-log').checked = true;
    $('report-scope').value = '90d';
    ui.renderReport(); // waits for the host log
    await new Promise((r) => setTimeout(r, 50));
    $('report-log').checked = false;
    $('report-scope').value = '7d';
    await ui.renderReport();
    const shown = body().textContent;
    for (const release of hold.splice(0)) release();
    hold = null;
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(body().textContent, shown);
    assert.doesNotMatch(shown, /Host log unavailable/);
  });

  test('evidence: the chat open here only shows its log; an open tab is switched to; others are replayed', async () => {
    $('report-scope').value = 'all';
    await ui.renderReport();
    const evidence = (host) => body().all().find((e) => e.className === 'linkish' && e.textContent.includes(host));
    evidence('shop.example.com').click();
    assert.deepEqual(calls.openSaved, [], 'the running task is not stopped');
    assert.equal($('report').hidden, true);
    assert.equal($('log').hidden, false);
    await ui.openReport();
    await rendered();
    evidence('other.example.org').click();
    assert.deepEqual(calls.panelOpened, [200]);
    assert.deepEqual(calls.openSaved, []);
    await ui.openReport();
    await rendered();
    evidence('third.example.net').click();
    assert.deepEqual(calls.openSaved, ['cGone']);
  });

  test('the fix-task preview has no "Include my description"; the bug report has it', async () => {
    await ui.openReport();
    await rendered();
    $('report-task').click();
    assert.equal($('sa-notes').parentElement.hidden, true);
    assert.equal($('sa-notes').checked, false);
    $('report-bug').click();
    assert.equal($('sa-notes').parentElement.hidden, false);
    assert.equal($('sa-notes').checked, true);
    $('sa-preview').close();
  });

  test('Diagnose closes History so its card is seen, and says "Right now" once', async () => {
    $('report').hidden = true;
    $('history').hidden = false;
    $('log').hidden = true;
    await ui.runDiagnose({ source: 'menu' });
    assert.equal($('history').hidden, true);
    assert.equal($('log').hidden, false);
    const card = $('log').children.at(-1).textContent;
    assert.match(card, /Right now: the agent is waiting for your answer/);
    assert.doesNotMatch(card, /Right now:\s*Right now/i);
    assert.equal(saved.notice, undefined, 'nothing the self-analysis says goes into the journal');
  });
});
