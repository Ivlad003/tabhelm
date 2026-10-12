// End-to-end test in headless Chrome: loads the extension, opens a form page,
// drives the side panel and checks that the agent filled and saved the form.
// Usage: node scripts/e2e.js [agentId]   (CHROME_PATH overrides the browser;
// TABHELM_RELEASE=<dist/tabhelm-x.y.z> tests a built release instead of the sources;
// E2E_MODEL=<model value> switches the model in the panel before the task;
// E2E_EXPECT_AUTH=1 only checks that the panel shows the agent's sign-in card;
// E2E_RECORD=1 records the task and checks the saved video;
// E2E_SWITCH=<agentId> afterwards switches agents and checks the conversation was handed over,
// then presses New chat;
// E2E_FAILOVER=<agentId> kills the first agent mid-task, continues with <agentId>
// via the panel's "Continue with" card, then checks the Markdown export;
// E2E_NEWS=1 only checks the update/news banner against a local feed;
// E2E_SKILLS=1 adds a skill in Settings and checks the agent reads and follows it)
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const agent = process.argv[2] || 'claude';
const release = process.env.TABHELM_RELEASE;
const EXT = release ? join(release, 'extension') : fileURLToPath(new URL('../../extension', import.meta.url));
const INSTALL = release ? join(release, 'host/scripts/install.js') : fileURLToPath(new URL('./install.js', import.meta.url));
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const profile = mkdtempSync(join(tmpdir(), 'tabhelm-e2e-'));
execFileSync(process.execPath, [INSTALL, '--user-data-dir', profile], { stdio: 'inherit' });

const PAGE = `<!doctype html><title>Signup test</title>
<h1>Newsletter signup</h1>
<label>Name <input id=name placeholder="Your name"></label>
<label>Color <select id=color><option value="">--</option><option value=red>Red</option><option value=blue>Blue</option></select></label>
<label><input type=checkbox id=terms> I agree</label>
<button id=save onclick="document.getElementById('out').textContent='Saved: '+document.getElementById('name').value+' / '+document.getElementById('color').value+' / '+(document.getElementById('terms').checked?'agreed':'no')">Save</button>
<p id=out></p>`;
const NEWS = {
  latest: { version: '9.9.9', url: 'https://example.com/release', install: 'curl -fsSL https://example.com/install.sh | bash' },
  news: [{ id: 'test-news', title: { en: 'Test news title', uk: 'Тестова новина' }, text: { en: 'Body', uk: 'Текст' } }],
};
const SKILL = `---
name: signup-secret
description: Use when the user asks for the secret code of the newsletter signup page.
---
# Signup secret

The secret code of the newsletter signup page is PURPLE-42. Reply with exactly that code.
`;
const server = http
  .createServer((q, r) => {
    if (q.url === '/news.json') return r.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(NEWS));
    if (q.url === '/skills/signup-secret/SKILL.md') return r.writeHead(200, { 'content-type': 'text/markdown' }).end(SKILL);
    if (q.url.startsWith('/skills/')) return r.writeHead(404).end('not found');
    r.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
  })
  .listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: profile,
  pipe: true,
  enableExtensions: [EXT],
  args: ['--no-first-run'],
  // Inherited by the native host: keep test videos out of ~/Videos.
  env: { ...process.env, TABHELM_RECORDINGS_DIR: join(profile, 'videos') },
  protocolTimeout: 300_000,
});
const page = await browser.newPage();
await page.goto(url);

const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
const extId = new URL(swTarget.url()).host;
const sw = await swTarget.worker();
const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u + '*' }))[0].id, url);
console.log('ext', extId, 'tab', tabId);

if (process.env.E2E_NEWS) await sw.evaluate((u) => chrome.storage.local.set({ newsUrl: `${u}news.json` }), url);

// Open the panel in its own window so the test page stays the visible tab in
// its window (like the real side panel); background tabs render no frames.
const panelUrl = `chrome-extension://${extId}/sidepanel.html?tabId=${tabId}`;
await sw.evaluate((url) => chrome.windows.create({ url, type: 'popup', width: 420, height: 800 }), panelUrl);
const panel = await (await browser.waitForTarget((t) => t.url() === panelUrl)).page();
panel.on('console', (m) => console.log('[panel]', m.text()));
await panel.waitForSelector('#agent');

if (process.env.E2E_SKILLS) {
  await panel.click('#settings-open');
  await panel.type('#skill-url', `${url}skills/signup-secret`);
  await panel.click('#skill-form button');
  await panel.waitForFunction(() => /signup-secret/.test(document.querySelector('#skill-list')?.innerText || ''), { timeout: 30000 });
  const listed = await panel.$eval('#skill-list', (e) => e.innerText.replace(/\s+/g, ' '));
  const button = await panel.$eval('#settings-open', (e) => e.textContent);
  await panel.screenshot({ path: join(profile, 'settings.png') });
  console.log('settings screenshot:', join(profile, 'settings.png'));
  await panel.click('#settings-close');
  await panel.waitForFunction(() => document.querySelector('#agent option:checked')?.value, { timeout: 15000 });
  await panel.select('#agent', agent);
  await panel.click('#auto');
  await panel.click('#connect');
  await panel.waitForFunction(() => document.querySelector('#status').dataset.state === 'ready', { timeout: 60000 });
  await panel.type('#input', 'What is the secret code of this signup page? Answer with the code only.');
  await panel.click('#send');
  await panel.waitForFunction(() => document.querySelector('#send').textContent === 'Send' && document.querySelector('#status').dataset.state !== 'working', { timeout: 240000, polling: 1000 });
  const answer = await panel.$$eval('.msg.agent', (m) => m.map((x) => x.innerText).join(' '));
  const readSkill = await panel.$$eval('.action', (a) => a.some((x) => /Read skill/.test(x.innerText)));
  console.log('skill listed:', listed);
  console.log('settings button:', button);
  console.log('agent read the skill:', readSkill);
  console.log('answer:', answer.replace(/\s+/g, ' ').slice(0, 200));
  const ok = /signup-secret/.test(listed) && readSkill && /PURPLE-42/.test(answer);
  console.log(ok ? 'E2E PASS' : 'E2E FAIL');
  await browser.close();
  server.close();
  process.exit(ok ? 0 : 1);
}

if (process.env.E2E_NEWS) {
  const bannerText = () => panel.$eval('#news', (e) => (e.hidden ? '' : e.innerText.replace(/\s+/g, ' ')));
  await panel.waitForSelector('.banner.update', { timeout: 15000 });
  const update = await bannerText();
  await panel.click('.banner .btn.primary');
  const stepsVisible = await panel.$eval('.banner-steps', (e) => !e.hidden && e.innerText.includes('install.sh'));
  await panel.screenshot({ path: join(profile, 'panel.png') });
  await panel.click('.banner-close');
  await panel.reload();
  await panel.waitForSelector('.banner.news', { timeout: 15000 });
  const news = await bannerText();
  await panel.click('.banner-close');
  await panel.reload();
  await new Promise((r) => setTimeout(r, 1500));
  const after = await bannerText();
  console.log('update banner:', update);
  console.log('update steps visible:', stepsVisible);
  console.log('news banner:', news);
  console.log('after dismissing both:', JSON.stringify(after));
  console.log('panel screenshot:', join(profile, 'panel.png'));
  const ok = /9\.9\.9/.test(update) && stepsVisible && /Test news title|Тестова новина/.test(news) && after === '';
  console.log(ok ? 'E2E PASS' : 'E2E FAIL');
  await browser.close();
  server.close();
  process.exit(ok ? 0 : 1);
}
await panel.waitForFunction(() => document.querySelectorAll('#agent option[value]').length > 0 && document.querySelector('#agent').value, { timeout: 15000 });
console.log('agents:', await panel.$$eval('#agent option', (o) => o.map((x) => x.value).join(',')));
await panel.select('#agent', agent);
await panel.click('#auto');
await panel.click('#connect');
if (process.env.E2E_EXPECT_AUTH) {
  await panel.waitForFunction(() => [...document.querySelectorAll('.card .title')].some((t) => /sign in/.test(t.textContent)), { timeout: 60000 });
  const buttons = await panel.$$eval('.card .options button', (b) => b.map((x) => x.textContent));
  console.log('sign-in options:', buttons.join(' | '));
  console.log(buttons.length ? 'E2E PASS' : 'E2E FAIL');
  await browser.close();
  server.close();
  process.exit(buttons.length ? 0 : 1);
}
try {
  await panel.waitForFunction(() => document.querySelector('#status').dataset.state === 'ready', { timeout: 60000 });
} catch (err) {
  console.log('agent did not become ready; panel says:', await panel.$eval('body', (b) => b.innerText.replace(/\s+/g, ' ').slice(0, 1500)));
  throw err;
}
await panel.waitForSelector('#config select.model', { timeout: 30000 });
const models = await panel.$$eval('#config select.model option', (o) => o.map((x) => x.value));
console.log(`models (${models.length}):`, models.slice(0, 8).join(', '), models.length > 8 ? '…' : '');
if (process.env.E2E_MODEL) {
  if (!models.includes(process.env.E2E_MODEL)) throw new Error(`Model ${process.env.E2E_MODEL} not offered`);
  await panel.select('#config select.model', process.env.E2E_MODEL);
  await panel.waitForFunction((m) => {
    const s = document.querySelector('#config select.model');
    return s && !s.disabled && s.value === m;
  }, { timeout: 30000 }, process.env.E2E_MODEL);
  console.log('model switched to', process.env.E2E_MODEL);

  // Reconnect: the panel should restore the saved model for this agent.
  await panel.click('#connect');
  await panel.waitForFunction(() => document.querySelector('#status').dataset.state === 'idle', { timeout: 30000 });
  await panel.click('#connect');
  await panel.waitForFunction((m) => {
    const s = document.querySelector('#config select.model');
    return document.querySelector('#status').dataset.state === 'ready' && s && s.value === m;
  }, { timeout: 60000 }, process.env.E2E_MODEL);
  console.log('model restored after reconnect');
}
if (process.env.E2E_RECORD) await panel.click('#record');
await panel.type('#input', 'Fill this form: name "Ada Lovelace", color Blue, tick the agreement checkbox, then click Save and tell me the exact confirmation text shown.');
await panel.click('#send');

if (process.env.E2E_FAILOVER) {
  // Kill the agent process (child of this test's native host) after its first browser action.
  await panel.waitForSelector('.action', { timeout: 120000 });
  const tree = execFileSync('ps', ['-eo', 'pid=,ppid=,args=']).toString().trim().split('\n').map((l) => {
    const [pid, ppid, ...args] = l.trim().split(/\s+/);
    return { pid: +pid, ppid: +ppid, args: args.join(' ') };
  });
  const descendants = (pid) => tree.filter((p) => p.ppid === pid).flatMap((c) => [c, ...descendants(c.pid)]);
  const host = descendants(browser.process().pid).find((p) => p.args.includes('native-host.js'));
  const agentProc = tree.find((p) => p.ppid === host.pid);
  console.log('killing agent process:', agentProc.args.slice(0, 80));
  process.kill(agentProc.pid, 'SIGKILL');
  await panel.waitForFunction(() => /did not finish/.test(document.body.innerText), { timeout: 60000 });
  const target = await panel.$$eval('.card .options button', (bs, id) => bs.findIndex((b) => b.textContent.toLowerCase().includes(id)), process.env.E2E_FAILOVER);
  if (target < 0) throw new Error('No continue button for ' + process.env.E2E_FAILOVER);
  await panel.evaluate((i) => document.querySelectorAll('.card .options button')[i].click(), target);
  console.log('continuing with', process.env.E2E_FAILOVER);
  await panel.waitForFunction(() => document.querySelectorAll('.msg.user').length === 2, { timeout: 90000 });
}
await panel.waitForFunction(() => document.querySelector('#send').textContent === 'Send' && document.querySelector('#status').dataset.state !== 'working', { timeout: 240000, polling: 1000 });

const out = await page.$eval('#out', (e) => e.textContent);

let extraOk = true;
if (process.env.E2E_FAILOVER) {
  const downloads = join(profile, 'downloads');
  const session = await browser.target().createCDPSession();
  await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  await panel.click('#export-menu summary');
  await panel.click('[data-export="md"]');
  await new Promise((r) => setTimeout(r, 1500));
  const file = readdirSync(downloads).find((f) => f.endsWith('.md'));
  const md = file ? readFileSync(join(downloads, file), 'utf8') : '';
  console.log('--- export', file, `(${md.length} chars) ---\n${md.slice(0, 1800)}\n---`);
  extraOk &&= /· You/.test(md) && /— actions/.test(md) && /Switched to/.test(md) && /Stopped before finishing/.test(md);
}
if (process.env.E2E_RECORD) {
  await panel.waitForFunction(() => /Saved to /.test(document.querySelector('.video')?.innerText || ''), { timeout: 60000 });
  const info = await panel.$eval('.video', (e) => e.innerText.replace(/\s+/g, ' '));
  const path = /Saved to (\S+)/.exec(info)[1];
  const size = existsSync(path) ? statSync(path).size : 0;
  console.log('video:', info, '| file bytes:', size);
  extraOk &&= size > 10_000;
}
if (process.env.E2E_SWITCH) {
  await panel.select('#agent', process.env.E2E_SWITCH);
  await panel.waitForFunction(() => document.querySelector('#status').dataset.state === 'ready', { timeout: 90000 });
  await panel.type('#input', 'Without using any tools: what exact confirmation text did the page show earlier in this chat?');
  await panel.click('#send');
  await panel.waitForFunction(() => document.querySelector('#send').textContent === 'Send', { timeout: 180000, polling: 1000 });
  const reply = await panel.$$eval('.msg.agent', (m) => m.at(-1)?.innerText || '');
  console.log(`after switch to ${process.env.E2E_SWITCH}:`, reply.replace(/\s+/g, ' ').slice(0, 200));
  extraOk &&= /Ada Lovelace/.test(reply);

  await panel.click('#new-chat');
  await panel.waitForFunction(() => document.querySelector('#status').dataset.state === 'ready' && document.querySelectorAll('.msg').length === 0, { timeout: 90000 });
  console.log('new chat: log cleared, agent reconnected');
}
const log = await panel.$eval('#log', (e) => [...e.children].map((c) => c.className + ': ' + c.innerText.replace(/\n/g, ' ')).join('\n'));
console.log('---- panel log\n' + log + '\n----');
console.log('page result:', out);
await panel.screenshot({ path: join(profile, 'panel.png') });
console.log('panel screenshot:', join(profile, 'panel.png'));
const pass = out === 'Saved: Ada Lovelace / blue / agreed' && extraOk;
console.log(pass ? 'E2E PASS' : 'E2E FAIL');
await browser.close();
server.close();
process.exit(pass ? 0 : 1);
