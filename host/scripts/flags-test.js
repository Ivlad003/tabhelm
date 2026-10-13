#!/usr/bin/env node
// Tests the experimental features end to end with the built-in agent talking
// to a scripted OpenAI-compatible mock (so the agent's tool calls are
// deterministic): secrets, fill_form/highlight/storage (dev tools), memory,
// sensitive-action gate, site rules, action critic, take-over help, password
// manager hand-off (Chrome path), plan preview, slash commands, scheduled
// runs, notifications badge, action database.
// Usage: node scripts/flags-test.js   (CHROME_PATH overrides the browser)

import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('../../extension', import.meta.url));
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const profile = mkdtempSync(join(tmpdir(), 'tabhelm-flags-'));
const fakeHome = mkdtempSync(join(tmpdir(), 'tabhelm-home-'));
execFileSync(process.execPath, [fileURLToPath(new URL('./install.js', import.meta.url)), '--user-data-dir', profile], { stdio: 'inherit' });

// ---- mock model -----------------------------------------------------------
const seen = { critic: [], tools: [] };
function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, ...c }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520, cost: 0.0002 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}
const call = (i, id, name, args) => [{ delta: { tool_calls: [{ index: i, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }];
const ref = (snap, pattern) => new RegExp(`\\[(e\\d+)\\] ${pattern}`).exec(snap)?.[1];
const finishTools = { delta: {}, finish_reason: 'tool_calls' };
const say = (t) => [{ delta: { content: t } }, { delta: {}, finish_reason: 'stop' }];

const mock = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  if (req.url === '/v1/models') {
    return res.end(JSON.stringify({ data: [{ id: 'mock/agent:free', name: 'Mock agent', supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' }, context_length: 100000, architecture: { input_modalities: ['text'] } }] }));
  }
  // Transcription API for the Voice feature: every chunk becomes a numbered phrase.
  if (req.url === '/v1/audio/transcriptions') {
    seen.audioChunks = (seen.audioChunks || 0) + 1;
    return res.end(JSON.stringify({ text: `phrase ${seen.audioChunks}` }));
  }
  if (req.url !== '/v1/chat/completions') return res.writeHead(404).end();
  const { messages, stream } = JSON.parse(body);
  const system = messages[0]?.content || '';

  // The critic (non-streaming): block anything aimed at a "Delete" control.
  if (!stream && /safety reviewer/.test(system)) {
    const text = messages[1].content;
    seen.critic.push(text);
    const block = /Proposed action:[^\n]*Delete/i.test(text);
    return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decision: block ? 'block' : 'allow', reason: block ? 'deleting is not part of the task' : 'fine' }) } }] }));
  }

  const users = messages.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => p.text || '').join(' ')));
  const lastUser = users.at(-1) || '';
  // The newest scenario mention wins: earlier chats are handed over as context.
  const scenario = [...users.join('\n').matchAll(/SCENARIO (\w+)/g)].at(-1)?.[1];
  const toolResults = messages.filter((m) => m.role === 'tool').map((m) => m.content);
  const assistantTurns = messages.filter((m) => m.role === 'assistant').length;
  const step = toolResults.length;
  const lastTool = toolResults.at(-1) || '';
  const snap = toolResults.find((t) => /\[e\d+\]/.test(t)) || '';
  const log = (n, a) => seen.tools.push(`${scenario}:${n}`);

  switch (scenario) {
    case 'fill':
      if (step === 0) return sse(res, [...call(0, 'c1', 'browser_snapshot', {}), finishTools]);
      if (step === 1) {
        log('browser_fill_form');
        return sse(res, [...call(0, 'c2', 'browser_fill_form', { fields: [{ ref: ref(snap, 'textbox "Name"'), value: '{{SECRET:token}}' }, { ref: ref(snap, 'combobox'), value: 'Blue' }, { ref: ref(snap, 'checkbox "I agree"'), value: 'true' }] }), finishTools]);
      }
      if (step === 2) return sse(res, [...call(0, 'c3', 'browser_highlight', { refs: [ref(snap, 'button "Save"')], label: 'next' }), finishTools]);
      if (step === 3) return sse(res, [...call(0, 'c4', 'memory_save', { text: 'The signup form wants a token in the Name field', scope: 'site' }), finishTools]);
      if (step === 4) return sse(res, [...call(0, 'c5', 'browser_storage', { action: 'get', kind: 'localStorage' }), finishTools]);
      return sse(res, say(`FILL DONE. storage=${lastTool.slice(0, 40)}`));
    case 'sensitive':
      if (step === 0) return sse(res, [...call(0, 'c1', 'browser_snapshot', {}), finishTools]);
      if (step === 1) return sse(res, [...call(0, 'c2', 'browser_click', { ref: ref(snap, 'button "Save"') }), finishTools]);
      return sse(res, say(`SENSITIVE RESULT: ${lastTool.slice(0, 80)}`));
    case 'blocked':
      if (step === 0) return sse(res, [...call(0, 'c1', 'browser_navigate', { url: 'https://www.paypal.com/signin' }), finishTools]);
      return sse(res, say(`BLOCKED RESULT: ${lastTool.slice(0, 120)}`));
    case 'critic':
      if (step === 0) return sse(res, [...call(0, 'c1', 'browser_snapshot', {}), finishTools]);
      if (step === 1) return sse(res, [...call(0, 'c2', 'browser_click', { ref: ref(snap, 'button "Delete account"') }), finishTools]);
      if (step === 2) return sse(res, [...call(0, 'c3', 'browser_click', { ref: ref(snap, 'button "Save"') }), finishTools]);
      return sse(res, say(`CRITIC RESULT: ${toolResults[1].slice(0, 80)} | ${lastTool.slice(0, 40)}`));
    case 'human':
      if (step === 0) return sse(res, [...call(0, 'c1', 'browser_request_human', { message: 'Enter the 2FA code from your phone' }), finishTools]);
      return sse(res, say(`HUMAN RESULT: ${lastTool.slice(0, 120)}`));
    case 'login':
      if (step === 0) return sse(res, [...call(0, 'c1', 'browser_snapshot', {}), finishTools]);
      if (step === 1) return sse(res, [...call(0, 'c2', 'browser_request_login', { usernameRef: ref(snap, 'textbox "Name"'), note: 'account required' }), finishTools]);
      return sse(res, say(`LOGIN RESULT: ${lastTool.slice(0, 120)}`));
    case 'plan':
      // The plan-preview preamble mentions "[plan approved]"; only a message starting with it approves.
      if (!users.some((u) => u.trim().startsWith('[plan approved]'))) return sse(res, say('PLAN:\n1. Read the page\n2. Click Save\n3. Report'));
      if (step === 0) return sse(res, [...call(0, 'c1', 'browser_snapshot', {}), finishTools]);
      if (step === 1) return sse(res, [...call(0, 'c2', 'browser_click', { ref: ref(snap, 'button "Save"') }), finishTools]);
      return sse(res, say('PLAN EXECUTED'));
    case 'skill':
      if (step === 0) return sse(res, [...call(0, 'c1', 'skill_read', { name: 'greet' }), finishTools]);
      return sse(res, say(`SKILL SAYS: ${/MAGIC-[\w-]+/.exec(lastTool)?.[0] || 'nothing'}`));
    case 'scheduled':
      if (step === 0) return sse(res, [...call(0, 'c1', 'browser_get_text', {}), finishTools]);
      return sse(res, say(`SCHEDULED DONE: ${/Newsletter signup/.test(lastTool) ? 'page read' : 'no page'}`));
    default:
      if (lastUser.includes('/greet')) return sse(res, say('unexpected: slash not expanded'));
      return sse(res, say(`no scenario in: ${lastUser.slice(0, 60)}`));
  }
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${mock.address().port}/v1`;

// ---- fixture page ---------------------------------------------------------
const PAGE = `<!doctype html><title>Signup test</title>
<h1>Newsletter signup</h1>
<label>Name <input id=name placeholder="Your name"></label>
<label>Color <select id=color><option value="">--</option><option value=red>Red</option><option value=blue>Blue</option></select></label>
<label><input type=checkbox id=terms> I agree</label>
<button id=save onclick="document.getElementById('out').textContent='Saved: '+document.getElementById('name').value+' / '+document.getElementById('color').value+' / '+(document.getElementById('terms').checked?'agreed':'no')">Save</button>
<button id=del onclick="document.getElementById('out').textContent='DELETED'">Delete account</button>
<p id=out></p><script>localStorage.setItem('theme','dark')</script>`;
const site = http.createServer((q, r) => r.writeHead(200, { 'content-type': 'text/html' }).end(PAGE)).listen(0, '127.0.0.1');
await new Promise((r) => site.once('listening', r));
const url = `http://127.0.0.1:${site.address().port}/`;

// ---- browser --------------------------------------------------------------
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: profile,
  pipe: true,
  enableExtensions: [EXT],
  // Fake microphone so the Voice feature can be exercised headlessly.
  args: ['--no-first-run', '--use-fake-device-for-media-capture', '--use-fake-ui-for-media-capture'],
  env: { ...process.env, HOME: fakeHome, TABHELM_OPENROUTER_BASE_URL: base, OPENROUTER_API_KEY: 'test-key', TABHELM_RECORDINGS_DIR: join(profile, 'videos'), TABHELM_TRANSCRIBE_BASE_URL: base, TABHELM_TRANSCRIBE_API_KEY: 'test-key', TABHELM_TRANSCRIBE_MODEL: 'mock-whisper' },
  protocolTimeout: 300_000,
});
const page = (await browser.pages())[0] || (await browser.newPage());
await page.goto(url);
const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
const extId = new URL(swTarget.url()).host;
const sw = await swTarget.worker();
const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}*` }))[0].id, url);
const panelUrl = `chrome-extension://${extId}/sidepanel.html?tabId=${tabId}`;
await sw.evaluate((u) => chrome.windows.create({ url: u, type: 'popup', width: 420, height: 800 }), panelUrl);
const panel = await (await browser.waitForTarget((t) => t.url() === panelUrl)).page();
const panelErrors = [];
panel.on('console', (m) => m.type() === 'error' && panelErrors.push(m.text()));
panel.on('pageerror', (e) => panelErrors.push(String(e)));

let failures = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `  —  ${String(info).slice(0, 500)}`}`);
  if (!ok) failures++;
};
const setStorage = (obj) => sw.evaluate((o) => chrome.storage.local.set(o), obj);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  await panel.reload();
  await panel.waitForFunction(() => [...document.querySelectorAll('#agent option')].some((o) => o.value === 'openrouter' && !o.disabled), { timeout: 20000 });
  await panel.select('#agent', 'openrouter');
  if (!(await panel.$eval('#auto', (e) => e.checked))) await panel.click('#auto');
  await panel.click('#connect');
  await panel.waitForFunction(() => document.querySelector('#status').dataset.state === 'ready', { timeout: 60000 });
}
async function ask(text) {
  await panel.type('#input', text);
  await panel.click('#send');
}
const idle = () => panel.waitForFunction(() => document.querySelector('#send').textContent === 'Send' && document.querySelector('#status').dataset.state !== 'working', { timeout: 120000, polling: 500 });
// Only what appeared after the last user message (earlier chats are replayed above it).
const sinceLastUser = (sel) =>
  panel.evaluate((sel) => {
    const log = document.getElementById('log');
    const kids = [...log.children];
    const last = kids.map((k) => k.classList.contains('user')).lastIndexOf(true);
    return kids.slice(last + 1).flatMap((k) => (k.matches(sel) ? [k] : [...k.querySelectorAll(sel)])).map((x) => x.innerText.replace(/\s+/g, ' '));
  }, sel);
const answer = async () => (await sinceLastUser('.msg.agent')).join(' ');
const actions = () => sinceLastUser('.action');
const cardTitles = () => panel.$$eval('.card .title', (t) => t.map((x) => x.textContent));
async function clickCard(buttonText) {
  await panel.waitForFunction((t) => [...document.querySelectorAll('.card:not(.resolved) .options button')].some((b) => b.textContent.includes(t)), { timeout: 30000 }, buttonText);
  await panel.evaluate((t) => [...document.querySelectorAll('.card:not(.resolved) .options button')].find((b) => b.textContent.includes(t)).click(), buttonText);
}
async function pageOut() {
  return page.$eval('#out', (e) => e.textContent);
}

// 1. Secrets + developer tools + memory
await setStorage({ features: { secrets: true, devTools: true, memory: true, actionDb: true }, featureSettings: { secrets: { names: ['token'] } }, 'secret:token': 'S3CR3T-VALUE' });
await connect();
await ask('SCENARIO fill');
await idle();
const nameValue = await page.$eval('#name', (e) => e.value);
const acts = await actions();
const ans = await answer();
check('secret substituted on the page', nameValue === 'S3CR3T-VALUE', nameValue);
check('fill_form filled select and checkbox', (await page.$eval('#color', (e) => e.value)) === 'blue' && (await page.$eval('#terms', (e) => e.checked)), '');
check('placeholder (not the secret) in the action log', acts.some((a) => a.includes('{{SECRET:token}}')) && !acts.some((a) => a.includes('S3CR3T')), acts.join(' | '));
check('highlight, memory_save and storage ran', acts.some((a) => /highlight/i.test(a)) && acts.some((a) => /memory|Remember|wants a token/i.test(a)) && /FILL DONE\. storage=theme = dark/.test(ans), `${acts.join(' | ')} || ${ans}`);
const memFile = join(fakeHome, '.tabhelm', 'memory.json');
check('memory note written to disk', existsSync(memFile) && readFileSync(memFile, 'utf8').includes('wants a token'), existsSync(memFile) ? readFileSync(memFile, 'utf8') : 'missing');
await sleep(1500); // let the debounced history save finish before the panel reloads

// 2. Sensitive gate (keyword "save") — Allow in the card
await setStorage({ features: { sensitiveGate: true }, featureSettings: { sensitiveGate: { keywords: ['save', 'pay'] } } });
await connect();
await page.reload();
await ask('SCENARIO sensitive');
await clickCard('Allow');
await idle();
check('sensitive action asked first and then ran', (await cardTitles()).some((t) => /Sensitive action/.test(t)) && /^Saved:/.test(await pageOut()), `${(await cardTitles()).join(' | ')} / ${await pageOut()}`);

// 3. Site rules: banking blocked
await setStorage({ features: { siteRules: true } });
await connect();
await ask('SCENARIO blocked');
await idle();
check('navigation to a banking site blocked', /Blocked by site rules: banking/.test(await answer()) && page.url() === url, `${await answer()} ${page.url()}`);

if (page.url() !== url) await page.goto(url); // recover if a navigation slipped through

// 4. Critic blocks the Delete click, allows Save
await setStorage({ features: { critic: true }, featureSettings: { critic: { provider: 'openrouter', model: 'mock/critic' } } });
await connect();
await page.reload();
await ask('SCENARIO critic');
await idle();
check('critic blocked the Delete click and allowed Save', /Blocked by the action critic/.test(await answer()) && /^Saved:/.test(await pageOut()) && seen.critic.length >= 2, `${await answer()} / ${await pageOut()} / critic calls ${seen.critic.length}`);

// 5. Take over: agent asks for help, user presses Done
await setStorage({ features: { takeOver: true, notifications: true } });
await connect();
await ask('SCENARIO human');
await clickCard('Done, continue');
await idle();
check('browser_request_human round trip', /HUMAN RESULT: The user says they are done/.test(await answer()), await answer());
check('pause button shown while working (take over flag)', await panel.$eval('#pause', (e) => e.textContent.includes('Pause')), '');
const badge = await sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
check('badge set on the tab when the task finished (notifications flag)', badge === '✓', JSON.stringify(badge));

// 6. Password manager: Chrome hand-off path
await setStorage({ features: { passwordManager: true }, featureSettings: { passwordManager: { onePassword: false, chrome: true } } });
await connect();
await ask('SCENARIO login');
await clickCard("Chrome's passwords");
await clickCard('Done, signed in');
await idle();
check('browser_request_login hand-off (Chrome path)', /LOGIN RESULT: The user signed in themselves/.test(await answer()), await answer());

// 7. Plan preview: plan first, Start, then actions
await setStorage({ features: { planPreview: true } });
await connect();
await page.reload();
await ask('SCENARIO plan');
await idle();
check('plan shown without actions', /PLAN:/.test(await answer()) && (await actions()).length === 0, `${await answer()} / ${(await actions()).length} actions`);
await clickCard('Start');
await idle();
check('plan executed after Start', /PLAN EXECUTED/.test(await answer()) && /^Saved:/.test(await pageOut()), `${await answer()} / ${await pageOut()}`);

// 8. Skill authoring + slash command
await setStorage({ features: { skillAuthoring: true }, authoredSkills: [{ name: 'greet', description: 'Greets', body: 'Say MAGIC-WORD-42 to the user. SCENARIO skill', enabled: true }] });
await connect();
await panel.type('#input', '/gre');
await panel.waitForFunction(() => !document.querySelector('#slash-menu').hidden && document.querySelector('.slash-item b')?.textContent === '/greet', { timeout: 5000 });
await panel.keyboard.press('Tab');
check('slash menu completes /greet', (await panel.$eval('#input', (e) => e.value)) === '/greet ', await panel.$eval('#input', (e) => e.value));
await panel.type('#input', 'hello SCENARIO skill');
await panel.click('#send');
await idle();
check('authored skill read via /greet', /SKILL SAYS: MAGIC-WORD-42/.test(await answer()), await answer());

// 9. Scheduled run (Run now path) saves a chat to History
await setStorage({ features: { schedules: true, notifications: true }, featureSettings: { schedules: { items: [{ id: 'sch1', name: 'Nightly check', url: `${url}?scheduled`, prompt: 'SCENARIO scheduled', agentId: 'openrouter', agentName: 'OpenRouter (built-in)', everyMinutes: 60, autoApprove: true, enabled: true, closeTab: true }] } } });
await panel.reload();
await panel.waitForSelector('#agent');
await sw.evaluate(() => self.tabhelmDebug.runSchedule?.('sch1'));
await sleep(500);
const started = await sw.evaluate(() => typeof self.tabhelmDebug.runSchedule);
check('scheduled run hook available', started === 'function', started);
let scheduledChat = null;
for (let i = 0; i < 60 && !scheduledChat; i++) {
  await sleep(1000);
  const { chatIndex = [] } = await sw.evaluate(() => chrome.storage.local.get('chatIndex'));
  scheduledChat = chatIndex.find((c) => c.title === 'SCENARIO scheduled');
}
const sched = await sw.evaluate(() => chrome.storage.local.get('featureSettings'));
check('scheduled run saved to History with the result', Boolean(scheduledChat) && /page read/.test(sched.featureSettings?.schedules?.items?.[0]?.lastResult || ''), JSON.stringify({ scheduledChat, last: sched.featureSettings?.schedules?.items?.[0]?.lastResult }));

// 10. Voice: fake microphone → host engine (mock transcription API) → one message in the box
await setStorage({ features: { voice: true }, featureSettings: { voice: { engine: 'host', language: 'en-US', chunkSeconds: 3 } } });
// Extension pages need an explicit microphone grant in headless Chrome.
await browser.defaultBrowserContext().overridePermissions(`chrome-extension://${extId}`, ['microphone']);
await connect();
await panel.waitForFunction(() => !document.querySelector('#voice-menu').hidden, { timeout: 5000 });
await panel.click('#voice-button');
await panel.click('[data-voice="mic"]');
await panel.waitForFunction(() => !document.querySelector('#voice-live').hidden, { timeout: 5000 });
try {
  await panel.waitForFunction(() => /phrase 2/.test(document.querySelector('#voice-text').textContent), { timeout: 20000 });
} catch (err) {
  console.log('voice diag:', JSON.stringify(await panel.evaluate(() => ({ live: document.querySelector('#voice-live').hidden, status: document.querySelector('#voice-status').textContent, text: document.querySelector('#voice-text').textContent, notices: [...document.querySelectorAll('.notice.error')].map((n) => n.textContent) }))), 'audio chunks at mock:', seen.audioChunks || 0, 'panel errors:', panelErrors.join(' | '));
  throw err;
}
const live = await panel.$eval('#voice-text', (e) => e.textContent);
await panel.click('#voice-stop');
await panel.waitForFunction(() => /phrase 1/.test(document.querySelector('#input').value), { timeout: 20000 });
const boxed = await panel.$eval('#input', (e) => e.value);
console.log('voice live:', live, '| message box:', boxed);
check('voice: live transcript while recording', /phrase 1 phrase 2/.test(live), live);
check('voice: whole transcript becomes one message on Stop', /^phrase 1 phrase 2( phrase \d+)*$/.test(boxed.trim()), boxed);
await panel.$eval('#input', (e) => (e.value = ''));

// 11. Action database: History search finds steps
await setStorage({ features: { actionDb: true } });
await panel.click('#history-open');
await panel.type('#history-search', 'highlight');
await panel.waitForFunction(() => [...document.querySelectorAll('.history-item')].some((i) => /step\(s\) match/.test(i.innerText)), { timeout: 10000 }).catch(() => {});
const hist = await panel.$$eval('.history-item', (i) => i.map((x) => x.innerText.replace(/\s+/g, ' ')));
check('History search matches steps (action database)', hist.some((h) => /step\(s\) match/.test(h)), `${hist.join(' | ')} / panel errors: ${panelErrors.join(' | ')}`);

console.log(failures ? `\n${failures} check(s) failed` : '\nFLAG CHECKS PASSED');
await browser.close();
mock.close();
site.close();
process.exit(failures ? 1 : 0);
