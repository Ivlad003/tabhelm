// End-to-end test in headless Chrome: loads the extension, opens a form page,
// drives the side panel and checks that the agent filled and saved the form.
// Usage: node scripts/e2e.js [agentId]   (CHROME_PATH overrides the browser;
// TABHELM_RELEASE=<dist/tabhelm-x.y.z> tests a built release instead of the sources;
// E2E_MODEL=<model value> switches the model in the panel before the task;
// E2E_EXPECT_AUTH=1 only checks that the panel shows the agent's sign-in card)
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
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
const server = http.createServer((q, r) => r.writeHead(200, { 'content-type': 'text/html' }).end(PAGE)).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: profile,
  pipe: true,
  enableExtensions: [EXT],
  args: ['--no-first-run'],
});
const page = await browser.newPage();
await page.goto(url);

const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
const extId = new URL(swTarget.url()).host;
const sw = await swTarget.worker();
const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u + '*' }))[0].id, url);
console.log('ext', extId, 'tab', tabId);

const panel = await browser.newPage();
panel.on('console', (m) => console.log('[panel]', m.text()));
await panel.goto(`chrome-extension://${extId}/sidepanel.html?tabId=${tabId}`);
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
await panel.waitForFunction(() => document.querySelector('#status').dataset.state === 'ready', { timeout: 60000 });
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
await panel.type('#input', 'Fill this form: name "Ada Lovelace", color Blue, tick the agreement checkbox, then click Save and tell me the exact confirmation text shown.');
await panel.click('#send');
await panel.waitForFunction(() => document.querySelector('#send').textContent === 'Send' && document.querySelector('#status').dataset.state !== 'working', { timeout: 240000, polling: 1000 });

const out = await page.$eval('#out', (e) => e.textContent);
const log = await panel.$eval('#log', (e) => [...e.children].map((c) => c.className + ': ' + c.innerText.replace(/\n/g, ' ')).join('\n'));
console.log('---- panel log\n' + log + '\n----');
console.log('page result:', out);
await panel.screenshot({ path: join(profile, 'panel.png') });
console.log('panel screenshot:', join(profile, 'panel.png'));
const pass = out === 'Saved: Ada Lovelace / blue / agreed';
console.log(pass ? 'E2E PASS' : 'E2E FAIL');
await browser.close();
server.close();
process.exit(pass ? 0 : 1);
