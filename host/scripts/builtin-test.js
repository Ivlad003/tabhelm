#!/usr/bin/env node
// Tests the built-in agent without a real model: a mock OpenAI-compatible API
// streams reasoning, text and tool calls (snapshot → fill the form → read the
// result → answer) and rate-limits the first request. Then runs e2e.js with the
// "openrouter" agent pointed at the mock, and checks the missing-key sign-in card.
// Usage: node scripts/builtin-test.js

import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const stats = { modelsCalls: 0, completions: 0, rateLimited: 0, badAuth: 0, toolsOffered: 0 };

function stream(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, ...c }] })}\n\n`);
  res.end('data: [DONE]\n\n');
}

const toolCall = (index, id, name, args) => [
  { delta: { tool_calls: [{ index, id, type: 'function', function: { name, arguments: '' } }] } },
  // Arguments arrive in pieces, like real providers send them.
  { delta: { tool_calls: [{ index, function: { arguments: JSON.stringify(args).slice(0, 5) } }] } },
  { delta: { tool_calls: [{ index, function: { arguments: JSON.stringify(args).slice(5) } }] } },
];

const ref = (snapshot, pattern) => new RegExp(`\\[(e\\d+)\\] ${pattern}`).exec(snapshot)?.[1];

const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== 'Bearer test-key') {
    stats.badAuth++;
    return res.writeHead(401).end('{"error":"bad key"}');
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    stats.modelsCalls++;
    return res.end(
      JSON.stringify({
        data: [
          { id: 'mock/helper:free', name: 'Mock Helper (free)', supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'] } },
          { id: 'mock/pro', name: 'Mock Pro', supported_parameters: ['tools'], pricing: { prompt: '0.000001', completion: '0.000002' }, architecture: { input_modalities: ['text', 'image'] } },
          { id: 'mock/no-tools:free', name: 'No tools', supported_parameters: [], pricing: { prompt: '0', completion: '0' } },
        ],
      }),
    );
  }
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return res.writeHead(404).end();

  let body = '';
  for await (const c of req) body += c;
  const { messages, tools, model } = JSON.parse(body);
  stats.completions++;
  if (tools?.some((t) => t.function.name === 'browser_snapshot')) stats.toolsOffered++;
  if (stats.completions === 1) {
    stats.rateLimited++;
    return res.writeHead(429).end('{"error":{"message":"slow down"}}');
  }

  const lastUser = messages.map((m) => m.role).lastIndexOf('user');
  const step = messages.slice(lastUser).filter((m) => m.role === 'assistant').length;
  const toolResults = messages.slice(lastUser).filter((m) => m.role === 'tool').map((m) => m.content);

  if (step === 0) {
    return stream(res, [
      { delta: { reasoning: 'I should look at the page first. ' } },
      { delta: { content: `Using ${model}. Let me look at the page.` } },
      ...toolCall(0, 'call_snap', 'browser_snapshot', {}),
      { delta: {}, finish_reason: 'tool_calls' },
    ]);
  }
  if (step === 1) {
    const snap = toolResults.at(-1);
    return stream(res, [
      ...toolCall(0, 'c1', 'browser_type', { ref: ref(snap, 'textbox "Name"'), text: 'Ada Lovelace' }),
      ...toolCall(1, 'c2', 'browser_select_option', { ref: ref(snap, 'combobox'), value: 'Blue' }),
      ...toolCall(2, 'c3', 'browser_click', { ref: ref(snap, 'checkbox "I agree"') }),
      ...toolCall(3, 'c4', 'browser_click', { ref: ref(snap, 'button "Save"') }),
      { delta: {}, finish_reason: 'tool_calls' },
    ]);
  }
  if (step === 2) return stream(res, [...toolCall(0, 'c5', 'browser_get_text', {}), { delta: {}, finish_reason: 'tool_calls' }]);
  const saved = /Saved:[^\n]*/.exec(toolResults.at(-1) || '')?.[0] || 'nothing saved';
  return stream(res, [{ delta: { content: 'Done. The page shows: ' } }, { delta: { content: saved } }, { delta: {}, finish_reason: 'stop' }]);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1`;
const e2e = fileURLToPath(new URL('./e2e.js', import.meta.url));
// Async on purpose: the mock server lives in this process and must keep serving.
const run = async (env) => {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [e2e, 'openrouter'], { env: { ...process.env, ...env }, timeout: 240_000, maxBuffer: 20e6 });
    return stdout;
  } catch (err) {
    return `${err.stdout || ''}${err.stderr || ''}`;
  }
};

let failures = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `  —  ${String(info).slice(-1500)}`}`);
  if (!ok) failures++;
};

// 1. Full task through the built-in agent.
const out = await run({ TABHELM_OPENROUTER_BASE_URL: base, OPENROUTER_API_KEY: 'test-key' });
check('built-in agent fills and saves the form', /E2E PASS/.test(out), out);
check('agent answer streamed to the panel', /The page shows: Saved: Ada Lovelace/.test(out), out);
check('free tool-calling models listed first, no-tools model hidden', /models \(2\): mock\/helper:free, mock\/pro/.test(out), out.match(/models.*/)?.[0]);
check('browser tools offered to the model', stats.toolsOffered >= 4, JSON.stringify(stats));
check('429 retried', stats.rateLimited === 1 && stats.completions >= 5, JSON.stringify(stats));
check('API key sent', stats.badAuth === 0, JSON.stringify(stats));

// 2. No key: the panel shows the sign-in card with instructions. HOME points to an
//    empty folder so a real ~/.tabhelm/env cannot supply a key.
const emptyHome = mkdtempSync(join(tmpdir(), 'tabhelm-home-'));
const authOut = await run({ TABHELM_OPENROUTER_BASE_URL: base, OPENROUTER_API_KEY: '', HOME: emptyHome, E2E_EXPECT_AUTH: '1' });
check('missing key shows the sign-in card', /sign-in options: Use OPENROUTER_API_KEY/.test(authOut) && /E2E PASS/.test(authOut), authOut);

server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nBUILT-IN AGENT CHECKS PASSED');
process.exit(failures ? 1 : 0);
