#!/usr/bin/env node
// Smoke test without Chrome: plays the extension's role over native messaging,
// starts an agent, asks it to read the "page" and answers tool calls with a fake snapshot.
// Usage: node scripts/smoke.js [agentId]
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNativeChannel } from '../src/native-messaging.js';

const agentId = process.argv[2] || 'claude';
const tabId = 7;
const host = spawn(process.execPath, [fileURLToPath(new URL('../src/native-host.js', import.meta.url))], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, TABHELM_TEST: '1', TABHELM_LOG_FILE: join(tmpdir(), `tabhelm-smoke-${process.pid}.log`), TABHELM_STATE_FILE: join(tmpdir(), `tabhelm-smoke-${process.pid}.json`) } });

const FAKE_PAGE = 'URL: https://shop.example/cart\nTitle: Cart — Example Shop\n\n# Your cart\n[e1] button "Checkout"\n[e2] link "Continue shopping" → /\nTotal: 42.00 USD';
const toolsSeen = [];
let answer = '';

const ch = createNativeChannel({
  input: host.stdout,
  output: host.stdin,
  onClose: () => console.log('host closed'),
  onMessage(msg) {
    if (msg.type === 'agents') {
      console.log('agents:', msg.agents.filter((a) => a.installed).map((a) => a.id).join(', '));
      ch.send({ type: 'start', tabId, agentId, autoApprove: true });
    } else if (msg.type === 'status') {
      console.log('status:', msg.state, msg.detail || '');
      if (msg.state === 'ready') ch.send({ type: 'prompt', tabId, text: 'What is the cart total on this page? Use the browser tools, do not click anything.' });
    } else if (msg.type === 'tool_call') {
      toolsSeen.push(msg.tool);
      console.log('tool_call:', msg.tool, JSON.stringify(msg.args), 'tab', msg.tabId);
      ch.send({ type: 'tool_result', id: msg.id, ok: true, content: [{ type: 'text', text: FAKE_PAGE }] });
    } else if (msg.type === 'update' && msg.update.kind === 'agent_message_chunk') {
      answer += msg.update.text;
    } else if (msg.type === 'permission') {
      console.log('permission asked:', msg.title);
      ch.send({ type: 'permission_response', tabId, id: msg.id, optionId: msg.options[0].optionId });
    } else if (msg.type === 'done' || msg.type === 'error') {
      console.log(msg.type, msg.stopReason || msg.message);
      console.log('answer:', answer.trim());
      const pass = toolsSeen.includes('browser_snapshot') && /42/.test(answer);
      console.log(pass ? 'SMOKE PASS' : 'SMOKE FAIL');
      host.stdin.end();
      setTimeout(() => process.exit(pass ? 0 : 1), 1000);
    }
  },
});
setTimeout(() => { console.log('SMOKE TIMEOUT'); process.exit(2); }, 240_000);
