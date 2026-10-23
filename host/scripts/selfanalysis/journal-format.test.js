// extension/journal-format.js, and the journal shapes the panel writes when a
// task ends without its agent reporting back (New chat, another chat, closing
// the panel, a browser tool call rejected before the extension ran it).
// Run: node --test host/scripts/selfanalysis/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { contextText, replayOp, exportMarkdown, browserToolOf } from '../../../extension/journal-format.js';
import { segmentTurns, extractEvents } from '../../../extension/analyzer.js';

const T0 = Date.parse('2026-10-20T10:00:00.000Z');
const ts = (s) => new Date(T0 + s * 1000).toISOString();
const chatOf = (journal) => ({ id: 'c1', tabId: 7, url: 'https://shop.example/cart', journal });

describe('contextText', () => {
  const history = [
    { ts: ts(0), type: 'user', text: 'find a flight', turn: 1 },
    { ts: ts(1), type: 'action', tool: 'browser_navigate', desc: 'Open the site', ok: true, turn: 1 },
    { ts: ts(2), type: 'agent', agent: 'Claude Code', text: 'Found three.', turn: 1 },
  ];

  test('leaves out the message that goes to the agent as the prompt itself', () => {
    const journal = [...history, { ts: ts(3), type: 'user', text: 'book a table for two', turn: 2 }];
    const out = contextText(journal, 'Codex', { pendingTurn: 2 });
    assert.match(out, /User: find a flight/);
    assert.match(out, /Claude Code: Found three\./);
    assert.doesNotMatch(out, /book a table/);
  });

  test('a first message alone gives no hand-over at all', () => {
    const journal = [{ ts: ts(0), type: 'user', text: 'book a table for two', turn: 1 }];
    assert.equal(contextText(journal, null, { pendingTurn: 1 }), null);
    assert.equal(contextText(journal), 'User: book a table for two\n\n');
  });

  test('keeps the rest of the pending turn and every earlier message', () => {
    const journal = [
      ...history,
      { ts: ts(3), type: 'user', text: 'second try', turn: 2 },
      { ts: ts(4), type: 'agent', agent: null, text: '', stopReason: 'cancelled', turn: 2 },
      { ts: ts(5), type: 'user', text: 'third try', turn: 3 },
    ];
    const out = contextText(journal, null, { pendingTurn: 3 });
    assert.match(out, /User: second try/);
    assert.doesNotMatch(out, /third try/);
    assert.equal(contextText(journal), contextText(journal, null, { pendingTurn: null }));
  });
});

describe('tasks closed by the panel', () => {
  const busyTurn = [
    { ts: ts(0), type: 'user', text: 'fill the form', turn: 1 },
    { ts: ts(1), type: 'agent_connected', agent: 'Claude Code', agentId: 'claude', turn: 1 },
    { ts: ts(2), type: 'action', agent: 'Claude Code', tool: 'browser_click', desc: 'Click “Next”', ok: true, turn: 1 },
  ];
  const outcomes = (journal) => segmentTurns(chatOf(journal)).map((t) => t.outcome);

  test('without a closing entry the task has no outcome (what New chat used to save)', () => {
    assert.deepEqual(outcomes(busyTurn), ['unknown']);
  });

  test('New chat or opening another chat mid-task: cancelled', () => {
    const journal = [...busyTurn, { ts: ts(3), type: 'agent', agent: 'Claude Code', text: '', thought: '', failure: null, stopReason: 'cancelled', stats: { ms: 3000 }, turn: 1 }];
    assert.deepEqual(outcomes(journal), ['cancelled']);
  });

  test('a message whose agent was still starting: cancelled, or panel closed', () => {
    const pending = [{ ts: ts(0), type: 'user', text: 'hi', turn: 1 }];
    assert.deepEqual(outcomes([...pending, { ts: ts(1), type: 'agent', agent: null, text: '', failure: null, stopReason: 'cancelled', turn: 1 }]), ['cancelled']);
    assert.deepEqual(outcomes([...pending, { ts: ts(1), type: 'agent', agent: null, text: '', failure: 'panel closed', stopReason: null, turn: 1 }]), ['panel_closed']);
  });

  test('the closing entry replays and exports without an agent name', () => {
    const e = { ts: ts(1), type: 'agent', agent: null, text: '', failure: 'panel closed', stopReason: null, turn: 1 };
    assert.deepEqual(replayOp(e), { kind: 'agent', agent: 'Agent', text: '', thought: '', failure: 'panel closed', stats: null });
    assert.match(exportMarkdown(null, [{ ts: ts(0), type: 'user', text: 'hi', turn: 1 }, e], { time: () => '10:00' }), /Stopped before finishing: panel closed/);
  });
});

describe('browser tool calls that never reached the extension', () => {
  const entry = {
    ts: ts(2), type: 'agent_tool', agent: 'Claude Code', title: 'browser_tabs', ok: false, browser: true,
    error: "Invalid enum value. Expected 'list' | 'new' | 'switch' | 'close', received 'open'", turn: 1,
  };
  const journal = [
    { ts: ts(0), type: 'user', text: 'list my tabs', turn: 1 },
    { ts: ts(1), type: 'agent_connected', agent: 'Claude Code', turn: 1 },
    entry,
    { ts: ts(3), type: 'agent', agent: 'Claude Code', text: 'Sorry.', failure: null, stopReason: 'end_turn', turn: 1 },
  ];

  test('are an error of source T for that tool', () => {
    const chat = chatOf(journal);
    const events = extractEvents(chat, segmentTurns(chat));
    const t = events.find((e) => e.source === 'T');
    assert.ok(t, 'no T event');
    assert.equal(t.tool, 'browser_tabs');
  });

  test('replay as a failed tool row', () => {
    assert.deepEqual(replayOp(entry), { kind: 'tool', title: 'browser_tabs', ok: false });
  });
});

describe('browserToolOf', () => {
  test('names the TabHelm tool however the agent prefixes it', () => {
    assert.equal(browserToolOf('browser_tabs'), 'browser_tabs');
    // Claude Code: a plain /(browser_[a-z_]+)/ read "browser__browser_click" here.
    assert.equal(browserToolOf('mcp__tabhelm-browser__browser_click'), 'browser_click');
    assert.equal(browserToolOf('mcp__tabhelm-browser__browser_click_xy'), 'browser_click_xy');
    assert.equal(browserToolOf('mcp__tabhelm_browser__browser_get_text'), 'browser_get_text');
    assert.equal(browserToolOf('mcp.tabhelm-browser.browser_handle_dialog'), 'browser_handle_dialog');
  });

  test("another MCP server's browser_* tool is not TabHelm's", () => {
    assert.equal(browserToolOf('mcp__playwright__browser_click'), null);
    assert.equal(browserToolOf('mcp.playwright.browser_type'), null);
  });

  test('no browser tool at all', () => {
    for (const t of [undefined, null, '', 'Read file', 'browser_', 'mcp__tabhelm-browser__skill_save']) assert.equal(browserToolOf(t), null);
  });
});
