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
// E2E_CONTEXT=1 sends a page selection and an image to the chat (context menu path) and checks the agent sees them;
// E2E_SKILLS=1 adds a skill in Settings and checks the agent reads and follows it;
// E2E_ATTACH=1 attaches an image and a CSV and checks the agent reads both;
// E2E_FOLDER=1 binds a project folder (AGENTS.md + skill) and checks the agent works in it;
// E2E_HISTORY=1 checks the steps block, saved history, replay, continuing and reopening;
// E2E_TABS=1 shares a second tab through the chat's tab group and asks the agent to move data between tabs)
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

// A recording must be a regular, seekable MP4: index (moov) before the media
// data (fast start, so Slack & co. can preview it), a duration, keyframes
// throughout, and a frame decodable from the middle.
function checkVideo(path) {
  const buf = readFileSync(path);
  const moov = buf.indexOf('moov');
  const mdat = buf.indexOf('mdat');
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=format_name,duration:stream=codec_name', '-of', 'json', path]).toString());
  const duration = Number(probe.format?.duration) || 0;
  const keys = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', path]).toString().trim().split('\n').filter(Boolean).length;
  let seek = false;
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-ss', String(duration / 2), '-i', path, '-frames:v', '1', '-f', 'null', '-']);
    seek = true;
  } catch {}
  const info = { container: probe.format?.format_name, codec: probe.streams?.[0]?.codec_name, duration: Number(duration.toFixed(1)), keyframes: keys, fastStart: moov >= 0 && moov < mdat, seek };
  info.ok = /mp4/.test(info.container || '') && info.fastStart && duration > 1 && keys >= Math.max(2, Math.floor(duration / 4)) && seek;
  return info;
}

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
    if (q.url === '/contacts') return r.writeHead(200, { 'content-type': 'text/html' }).end('<title>Contacts</title><h1>Contacts</h1><p>Name: Grace Hopper</p><p>Email: grace@navy.example</p>');
    if (q.url === '/pic.png') return r.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
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
  // E2E_REAL_THROTTLING=1: keep Chrome's normal throttling of hidden pages (puppeteer
  // turns it off by default), so hidden side-panel behaviour matches real Chrome.
  ...(process.env.E2E_REAL_THROTTLING ? { ignoreDefaultArgs: ['--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'] } : {}),
  // Inherited by the native host: keep test videos out of ~/Videos.
  // The host keeps its backup of the panel's storage in the test profile: tests
  // must never read or overwrite the user's ~/.tabhelm/state.json.
  env: { ...process.env, TABHELM_RECORDINGS_DIR: join(profile, 'videos'), TABHELM_STATE_FILE: join(profile, 'state.json'), TABHELM_LOG_FILE: join(profile, 'host.log'), TABHELM_TEST: '1' },
  protocolTimeout: 300_000,
});
const page = (await browser.pages())[0] || (await browser.newPage());
await page.goto(url);

const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
const extId = new URL(swTarget.url()).host;
const sw = await swTarget.worker();
const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u + '*' }))[0].id, url);
console.log('ext', extId, 'tab', tabId);

if (process.env.E2E_NEWS) await sw.evaluate((u) => chrome.storage.local.set({ newsUrl: `${u}news.json` }), url);
// Other runs do not fetch the real site's news: a banner appearing mid-test shifts
// the layout under a click, and tests should not depend on the network.
else await sw.evaluate((u) => chrome.storage.local.set({ newsUrl: `${u}no-news.json` }), url);

// Open the panel in its own window so the test page stays the visible tab in
// its window (like the real side panel); background tabs render no frames.
const panelUrl = `chrome-extension://${extId}/sidepanel.html?tabId=${tabId}`;
// For the tab-group test the panel is a background tab of the same window: in
// headless Chrome a popup window disables tab grouping in the other windows.
if (process.env.E2E_TABS || process.env.E2E_RECORD_TABS) await sw.evaluate((url) => chrome.tabs.create({ url, active: true }), panelUrl);
else await sw.evaluate((url) => chrome.windows.create({ url, type: 'popup', width: 420, height: 800 }), panelUrl);
const panel = await (await browser.waitForTarget((t) => t.url() === panelUrl)).page();
panel.on('console', (m) => console.log('[panel]', m.text()));
if (process.env.E2E_DARK) await panel.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
await panel.waitForSelector('#agent');

// E2E_RELAY=1: a relay + a second host in relay mode; the panel pairs with the
// code the host prints and the whole task runs through the relay.
let relayProcs = [];
if (process.env.E2E_RELAY) {
  const { spawn } = await import('node:child_process');
  const relayPort = 18000 + Math.floor(Math.random() * 1000);
  const relay = spawn(process.execPath, [fileURLToPath(new URL('../../relay/server.js', import.meta.url))], { env: { ...process.env, PORT: String(relayPort), RELAY_KEY: 'test-relay-key-12345' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => relay.stdout.on('data', (d) => /listening/.test(String(d)) && r()));
  const hostProc = spawn(process.execPath, [fileURLToPath(new URL('../src/native-host.js', import.meta.url)), '--relay', `ws://127.0.0.1:${relayPort}`, '--key', 'test-relay-key-12345', '--name', 'testbox'], { env: { ...process.env, TABHELM_RECORDINGS_DIR: join(profile, 'videos'), TABHELM_STATE_FILE: join(profile, 'relay-state.json'), TABHELM_LOG_FILE: join(profile, 'relay-host.log'), TABHELM_TEST: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
  relayProcs = [relay, hostProc];
  const code = await new Promise((r) => hostProc.stderr.on('data', (d) => { const m = /pairing code:\s+([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(String(d)); if (m) r(m[1]); }));
  console.log('relay pairing code:', code);
  await panel.click('#settings-open');
  await panel.type('#remote-url', `ws://127.0.0.1:${relayPort}`);
  await panel.type('#remote-code', code);
  await panel.click('#remote-connect');
  await panel.waitForFunction(() => /connected \(testbox\)/.test(document.querySelector('#remote-status').textContent), { timeout: 20000 });
  console.log('remote status:', await panel.$eval('#remote-status', (e) => e.textContent));
  await panel.click('#settings-close');
}

if (process.env.E2E_TABS) {
  const contacts = await browser.newPage();
  await contacts.goto(`${url}contacts`);
  const contactsId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}contacts` }))[0].id, url);
  // Clicks in a background tab never complete in headless Chrome; keep the panel in front.
  await panel.bringToFront();
  await panel.click('#plus-menu summary');
  await panel.click('#group-tabs');
  try {
    await panel.waitForFunction(() => /1 tab shared/.test(document.querySelector('#group-tabs').textContent), { timeout: 10000 });
  } catch (err) {
    console.log('group failed; notices:', await panel.$$eval('.notice', (n) => n.map((x) => x.innerText).join(' / ')));
    throw err;
  }
  // The user drags the contacts tab into the group.
  await sw.evaluate(async (chat, id) => chrome.tabs.group({ groupId: (await chrome.tabs.get(chat)).groupId, tabIds: [id] }), tabId, contactsId);
  await panel.waitForFunction(() => /2 tabs shared/.test(document.querySelector('#group-tabs').textContent), { timeout: 10000 });
  console.log('group button:', await panel.$eval('#group-tabs', (e) => e.textContent), '| chip:', await panel.$eval('#tab-chip', (e) => e.textContent));

  await panel.waitForFunction((id) => [...document.querySelectorAll('#agent option')].some((o) => o.value === id && !o.disabled), { timeout: 20000 }, agent);
  await panel.select('#agent', agent);
  await panel.click('#auto');
  await panel.evaluate(() => window.tabhelmTest.connect());
  await panel.waitForFunction(() => document.querySelector('#status').dataset.state === 'ready', { timeout: 90000 });
  await panel.type('#input', "Another tab in this chat's tab group shows a contact. Find that person's email address there, type it into the Name field of the form on this tab, click Save, and tell me the email.");
  await panel.click('#send');
  await panel.waitForFunction(() => document.querySelector('#send').textContent === 'Send' && document.querySelector('#status').dataset.state !== 'working', { timeout: 300000, polling: 1000 });
  const out = await page.$eval('#out', (e) => e.textContent);
  const answer = (await panel.$$eval('.msg.agent', (m) => m.map((x) => x.innerText).join(' '))).replace(/\s+/g, ' ');
  const actions = await panel.$$eval('.action', (a) => a.map((x) => x.innerText.replace(/\s+/g, ' ')));
  const groupState = await sw.evaluate(async (id) => { const t = await chrome.tabs.get(id); return t.groupId === -1 ? null : await chrome.tabGroups.get(t.groupId); }, tabId);
  console.log('tab group after the task:', JSON.stringify(groupState));
  const confirms = await panel.$$eval('.card', (c) => c.length);
  console.log('actions:', actions.join(' | '));
  console.log('answer:', answer.slice(0, 160));
  console.log('page result:', out, '| confirmation cards:', confirms);
  const ok = /grace@navy\.example/.test(out) && confirms === 0;
  console.log(ok ? 'E2E PASS' : 'E2E FAIL');
  await browser.close();
  server.close();
  process.exit(ok ? 0 : 1);
}

if (process.env.E2E_FOLDER) {
  const project = join(profile, 'demo-project');
  mkdirSync(join(project, '.claude/skills/project-secret'), { recursive: true });
  writeFileSync(join(project, 'AGENTS.md'), '# Demo project\n\nRule: start every reply with the exact text PROJECT-RULES-OK.\n');
  writeFileSync(
    join(project, '.claude/skills/project-secret/SKILL.md'),
    '---\nname: project-secret\ndescription: Use when asked for the secret word of the demo project.\n---\n\nThe secret word of the demo project is HELIOTROPE.\n',
  );

  await panel.waitForFunction((id) => [...document.querySelectorAll('#agent option')].some((o) => o.value === id && !o.disabled), { timeout: 20000 }, agent);
  await panel.click('#plus-menu summary');
  await panel.click('#folder-type');
  await panel.type('#folder-path', project);
  await panel.click('#folder-form button');
  await panel.waitForFunction(() => /demo-project/.test(document.querySelector('#folder-chip').textContent), { timeout: 15000 });
  const label = await panel.$eval('#folder-chip', (e) => e.textContent);
  await panel.select('#agent', agent);
  await panel.click('#auto');
  const warning = await panel.$eval('#folder-warning', (e) => !e.hidden);
  await panel.evaluate(() => window.tabhelmTest.connect());
  await panel.waitForFunction(() => document.querySelector('#status').dataset.state === 'ready', { timeout: 90000 });
  await panel.type('#input', 'In the working folder, create a file named hello.txt containing only the secret word of this project (see the project skills). Do not use browser tools. Then tell me what you wrote.');
  await panel.click('#send');
  await panel.waitForFunction(() => document.querySelector('#send').textContent === 'Send' && document.querySelector('#status').dataset.state !== 'working', { timeout: 300000, polling: 1000 });
  const answer = (await panel.$$eval('.msg.agent', (m) => m.map((x) => x.innerText).join(' '))).replace(/\s+/g, ' ');
  const stats = await panel.$$eval('.stats', (s) => s.map((x) => x.textContent));
  const file = join(project, 'hello.txt');
  const content = existsSync(file) ? readFileSync(file, 'utf8').trim() : '(missing)';
  console.log('folder label:', label);
  console.log('auto-approve warning shown:', warning);
  console.log('answer:', answer.slice(0, 200));
  console.log('hello.txt:', content);
  console.log('stats:', stats.join(' | '));
  await panel.screenshot({ path: join(profile, 'panel.png') });
  console.log('panel screenshot:', join(profile, 'panel.png'));
  const ok = /AGENTS\.md/.test(label) && /1 skill/.test(label) && warning && /HELIOTROPE/i.test(content) && /PROJECT-RULES-OK/.test(answer) && stats.length > 0;
  console.log(ok ? 'E2E PASS' : 'E2E FAIL');
  await browser.close();
  server.close();
  process.exit(ok ? 0 : 1);
}

if (process.env.E2E_ATTACH) {
  // An image with a word only readable from the picture, and a CSV to sum.
  const art = await browser.newPage();
  await art.setViewport({ width: 420, height: 160 });
  await art.setContent('<body style="margin:0;background:#fff"><div style="font:bold 72px sans-serif;padding:36px 30px;color:#c2185b">ZEBRA</div></body>');
  const imagePath = join(profile, 'word.png');
  await art.screenshot({ path: imagePath });
  await art.close();
  const csvPath = join(profile, 'data.csv');
  writeFileSync(csvPath, 'item,amount\napples,120\npears,345\nplums,678\n');

  await panel.waitForFunction((id) => [...document.querySelectorAll('#agent option')].some((o) => o.value === id && !o.disabled), { timeout: 20000 }, agent);
  await panel.select('#agent', agent);
  await panel.click('#auto');
  await panel.evaluate(() => window.tabhelmTest.connect());
  try {
    await panel.waitForFunction(() => document.querySelector('#status').dataset.state === 'ready', { timeout: 90000 });
  } catch (err) {
    console.log('not ready; panel says:', await panel.$eval('body', (b) => b.innerText.replace(/\s+/g, ' ').slice(0, 800)));
    throw err;
  }
  if (process.env.E2E_MODEL) {
    await panel.waitForSelector('#config select.model', { timeout: 30000 });
    await panel.select('#config select.model', process.env.E2E_MODEL);
    await panel.waitForFunction((m) => document.querySelector('#config select.model')?.value === m && !document.querySelector('#config select.model').disabled, { timeout: 30000 }, process.env.E2E_MODEL);
  }
  const input = await panel.$('#file-input');
  await input.uploadFile(imagePath, csvPath);
  await panel.waitForFunction(() => document.querySelectorAll('#attachments .attachment').length === 2, { timeout: 10000 });
  await panel.type('#input', 'Do not use any browser tools. Using only the attached files: what is the sum of the amount column in data.csv, and what word is written in the image? Reply exactly as: SUM=<number>; WORD=<word>');
  await panel.click('#send');
  await panel.waitForFunction(() => document.querySelector('#send').textContent === 'Send' && document.querySelector('#status').dataset.state !== 'working', { timeout: 240000, polling: 1000 });
  const sentChips = await panel.$$eval('.msg.user .attachment', (a) => a.length);
  const answer = (await panel.$$eval('.msg.agent', (m) => m.map((x) => x.innerText).join(' '))).replace(/\s+/g, ' ');
  console.log('chips in sent message:', sentChips);
  console.log('answer:', answer.slice(0, 300));
  const sumOk = /SUM\s*=\s*1,?143/i.test(answer);
  const wordOk = /WORD\s*=\s*\**zebra/i.test(answer);
  console.log(`csv read: ${sumOk}, image read: ${wordOk}`);
  await panel.screenshot({ path: join(profile, 'panel.png') });
  console.log('panel screenshot:', join(profile, 'panel.png'));
  const ok = sentChips === 2 && sumOk && (wordOk || process.env.E2E_ATTACH === 'text-only');
  console.log(ok ? 'E2E PASS' : 'E2E FAIL');
  await browser.close();
  server.close();
  process.exit(ok ? 0 : 1);
}

if (process.env.E2E_CONTEXT) {
  // Simulate the context-menu actions on the chat tab.
  const tabInfo = await sw.evaluate((id) => chrome.tabs.get(id), tabId);
  await sw.evaluate((tab) => self.tabhelmDebug.sendPageContext(tab, { kind: 'selection', text: 'The quick emerald helm turns the tab' }), tabInfo);
  await sw.evaluate((tab, u) => self.tabhelmDebug.sendPageContext(tab, { kind: 'image', srcUrl: `${u}pic.png` }), tabInfo, url);
  await panel.waitForFunction(() => document.querySelectorAll('#attachments .attachment').length === 2, { timeout: 15000 });
  const chips = await panel.$$eval('#attachments .attachment', (a) => a.map((x) => `${x.className}: ${x.querySelector('.name').textContent}`));
  console.log('chips:', chips.join(' | '));
  await panel.waitForFunction((id) => [...document.querySelectorAll('#agent option')].some((o) => o.value === id && !o.disabled), { timeout: 20000 }, agent);
  await panel.select('#agent', agent);
  await panel.click('#auto');
  await panel.type('#input', 'Do not use any tools. Reply with exactly the quoted text I selected on the page, and the dominant color of the attached image in one word, as: QUOTE=<text>; COLOR=<color>');
  await panel.click('#send');
  await panel.waitForFunction(() => document.querySelector('#send').textContent === 'Send' && document.querySelector('#status').dataset.state !== 'working' && document.querySelector('.msg.agent'), { timeout: 240000, polling: 1000 });
  const sent = await panel.$eval('.msg.user', (e) => e.innerText.replace(/\s+/g, ' '));
  const answer = (await panel.$$eval('.msg.agent', (m) => m.map((x) => x.innerText).join(' '))).replace(/\s+/g, ' ');
  console.log('sent:', sent.slice(0, 200));
  console.log('answer:', answer.slice(0, 200));
  const ok = chips.some((c) => /quote/.test(c)) && chips.some((c) => /image/.test(c)) && /Selected on the page/.test(sent) && /QUOTE=.*quick emerald helm turns the tab/i.test(answer) && /COLOR=\s*\**(purple|violet|magenta)/i.test(answer);
  console.log(ok ? 'E2E PASS' : 'E2E FAIL');
  await browser.close();
  server.close();
  process.exit(ok ? 0 : 1);
}

// E2E_RECORD_TABS=1: record a task that moves between two tabs and check the
// video keeps running (no long freeze) while the agent works on the other tab.
// The panel is a tab of the same window, so — like the real side panel — it is
// hidden whenever the agent's tab is in front.
if (process.env.E2E_RECORD_TABS) {
  if (process.env.E2E_SINGLE_TAB) await sw.evaluate(() => chrome.storage.local.set({ singleTab: true }));
  if (process.env.E2E_TRIM) await sw.evaluate(async () => { const { features = {} } = await chrome.storage.local.get('features'); await chrome.storage.local.set({ features: { ...features, trimWaits: true }, featureSettings: { trimWaits: { maxPause: 1 } } }); });
  await panel.bringToFront();
  await panel.select('#agent', agent);
  await panel.click('#auto');
  await panel.click('#plus-menu summary');
  await panel.click('#record');
  await panel.click('#plus-menu summary');
  await panel.type('#input', `Open ${url}contacts in a new tab with browser_tabs, read the email address there, wait 3 seconds on that tab (browser_wait), then switch back to the signup tab, type the email into the Name field and click Save.`);
  const t0 = Date.now();
  await panel.click('#send');
  await panel.waitForFunction(() => document.querySelector('#send').textContent === 'Stop', { timeout: 30000 });
  const vis = new Set();
  while (await panel.evaluate(() => document.querySelector('#send').textContent === 'Stop')) {
    vis.add(await panel.evaluate(() => document.visibilityState));
    await new Promise((r) => setTimeout(r, 500));
    if (Date.now() - t0 > 300000) break;
  }
  const took = (Date.now() - t0) / 1000;
  console.log('panel visibility while the agent worked:', [...vis].join(', '));
  await panel.bringToFront();
  await panel.waitForFunction(() => /Saved to /.test(document.querySelector('.video')?.innerText || '') || /No video/.test(document.body.innerText), { timeout: 60000 }).catch(() => {});
  const info = await panel.$eval('.video', (e) => e.innerText.replace(/\s+/g, ' ')).catch(() => 'no video card');
  const path = /Saved to (\S+)/.exec(info)?.[1];
  const out = await page.$eval('#out', (e) => e.textContent).catch(() => `(not on the signup page: ${page.url()})`);
  console.log('answer:', (await panel.$$eval('.msg.agent', (m) => m.map((x) => x.innerText).join(' '))).replace(/\s+/g, ' ').slice(0, 300));
  let duration = 0;
  let freezes = [];
  if (path && existsSync(path)) {
    duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]).toString().trim()) || 0;
    const fd = execFileSync('ffmpeg', ['-v', 'info', '-i', path, '-vf', 'freezedetect=n=0.001:d=4', '-map', '0:v:0', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    freezes = [...(fd.match(/freeze_duration: [\d.]+/g) || [])];
  }
  const steps = await panel.$$eval('.action', (a) => a.map((x) => x.innerText.replace(/\s+/g, ' ')));
  console.log('steps:', steps.join(' | ').slice(0, 600));
  console.log(`task ${took.toFixed(1)} s | video ${duration.toFixed(1)} s | ${info.slice(0, 120)}`);
  console.log('freezes over 4 s:', freezes.join(', ') || 'none', '| page:', out);
  if (path) {
    // Frames for eyeballing: one every 3 s.
    execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-vf', 'fps=1/3,scale=480:-1', join(profile, 'frame-%02d.png')]);
    console.log('frames in', profile);
  }
  const tabCount = await sw.evaluate(async () => (await chrome.tabs.query({})).length);
  if (process.env.E2E_SINGLE_TAB) console.log('tabs open at the end:', tabCount, '(single-tab mode: page + panel = 2)');
  const v = path ? checkVideo(path) : { ok: false };
  console.log('video file:', JSON.stringify(v));
  // With "Skip waiting in recordings" the video is shorter than the task; otherwise about as long.
  const lengthOk = process.env.E2E_TRIM ? duration < took * 0.7 : duration >= took * 0.6;
  const ok = Boolean(path) && v.ok && lengthOk && (process.env.E2E_TRIM || freezes.length === 0) && /grace@navy\.example/.test(out) && (!process.env.E2E_SINGLE_TAB || tabCount === 2);
  console.log(ok ? 'E2E PASS' : 'E2E FAIL');
  await browser.close();
  server.close();
  process.exit(ok ? 0 : 1);
}

// E2E_GUIDE=1: the agent guides through the form and plays it automatically.
if (process.env.E2E_GUIDE) {
  // Auto-play is switched on in Settings → Page, like a user would.
  await panel.click('#settings-open');
  await panel.click('#guide-autoplay');
  await panel.click('#settings-close');
  await panel.select('#agent', agent);
  await panel.click('#auto'); // the agent's own tool permissions, not the guide
  await panel.type('#input', 'Guide me through filling this form as a guide tour (browser_guide) with the name "Ada Lovelace", color Blue, the agreement ticked and Save, so I can watch. Do not fill it yourself with other tools.');
  await panel.click('#send');
  const t0 = Date.now();
  let lastCard = '';
  while (Date.now() - t0 < 240000) {
    await new Promise((r) => setTimeout(r, 1000));
    const st = await panel.evaluate(() => ({ busy: document.querySelector('#send').textContent === 'Stop', card: document.querySelector('.card.guide')?.innerText.replace(/\s+/g, ' ') || '', confirm: [...document.querySelectorAll('.card:not(.resolved) .title')].map((t) => t.textContent).join(' | ') }));
    if (st.card !== lastCard) console.log('guide card:', st.card.slice(0, 160));
    lastCard = st.card;
    if (st.confirm) console.log('pending confirm:', st.confirm);
    if (!st.busy && Date.now() - t0 > 5000) break;
  }
  const out = await page.$eval('#out', (e) => e.textContent);
  const fields = await page.evaluate(() => ({ name: document.getElementById('name').value, color: document.getElementById('color').value, terms: document.getElementById('terms').checked }));
  const actions = await panel.$$eval('.action', (a) => a.map((x) => x.innerText.replace(/\s+/g, ' ')));
  const answer = await panel.$$eval('.msg.agent', (m) => m.map((x) => x.innerText).join(' ').replace(/\s+/g, ' '));
  console.log('steps:', actions.join(' | ').slice(0, 800));
  console.log('fields:', JSON.stringify(fields), '| out:', out);
  console.log('answer:', answer.slice(0, 400));
  const ok = out === 'Saved: Ada Lovelace / blue / agreed';
  console.log(ok ? 'E2E PASS' : 'E2E FAIL');
  await browser.close();
  server.close();
  process.exit(ok ? 0 : 1);
}

if (process.env.E2E_SKILLS) {
  await panel.click('#settings-open');
  await panel.type('#skill-url', `${url}skills/signup-secret`);
  await panel.click('#skill-form button');
  await panel.waitForFunction(() => /signup-secret/.test(document.querySelector('#skill-list')?.innerText || ''), { timeout: 30000 });
  // A repository full of skills offers a picker (real GitHub; needs network).
  await panel.type('#skill-url', 'https://github.com/mattpocock/skills/tree/main/skills/productivity');
  await panel.click('#skill-form button');
  await panel.waitForFunction(() => !document.getElementById('skill-picker').hidden || !document.getElementById('skill-error').hidden, { timeout: 60000 }).catch(async (e) => {
    console.log('DIAG', JSON.stringify(await panel.evaluate(() => ({ button: document.querySelector('#skill-form button').textContent, url: document.getElementById('skill-url').value, error: document.getElementById('skill-error').textContent, pickerHidden: document.getElementById('skill-picker').hidden, notices: [...document.querySelectorAll('#log .notice')].map((n) => n.textContent).slice(-4) }))));
    throw e;
  });
  const pickerRows = await panel.$$eval('#skill-picker .skill', (l) => l.map((x) => x.querySelector('b').textContent));
  await panel.type('#skill-picker input[type=search]', 'grill');
  await panel.evaluate(() => [...document.querySelectorAll('#skill-picker button')].find((b) => b.textContent === 'Select all').click());
  await panel.evaluate(() => [...document.querySelectorAll('#skill-picker button')].find((b) => /Add \d+ selected/.test(b.textContent)).click());
  await panel.waitForFunction(() => document.getElementById('skill-picker').hidden, { timeout: 5000 });
  console.log('collection picker rows:', pickerRows.join(', '));
  const listed = await panel.$eval('#skill-list', (e) => e.innerText.replace(/\s+/g, ' '));
  const pickerOk = pickerRows.length >= 5 && /grill-me/.test(listed) && /grilling/.test(listed) && !/handoff/.test(listed);
  console.log('picker added the filtered selection:', pickerOk);
  const button = await panel.$eval('#settings-open', (e) => e.textContent);
  await panel.screenshot({ path: join(profile, 'settings.png') });
  console.log('settings screenshot:', join(profile, 'settings.png'));
  await panel.click('#settings-close');
  await panel.waitForFunction(() => document.querySelector('#agent option:checked')?.value, { timeout: 15000 });
  await panel.select('#agent', agent);
  await panel.click('#auto');
  await panel.evaluate(() => window.tabhelmTest.connect());
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
  const ok = /signup-secret/.test(listed) && pickerOk && readSkill && /PURPLE-42/.test(answer);
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
// Before connecting, the model control shows the last choice and connects on click.
if (process.env.E2E_MODEL_PLACEHOLDER) {
  await panel.waitForSelector('.model-placeholder', { timeout: 10000 });
  console.log('placeholder:', await panel.$eval('.model-placeholder', (e) => e.textContent));
  await panel.screenshot({ path: join(profile, 'panel-before.png') });
  await panel.click('.model-placeholder');
  await panel.waitForSelector('#config select.model', { timeout: 60000 });
  const inSettings = await panel.$$eval('#config-extra select.model', (s) => s.length);
  console.log('model select after click:', await panel.$eval('#config select.model', (e) => e.selectedOptions[0].text), '| also in Settings:', inSettings === 1);
}
// E2E_LAZY=1: no explicit connect — the first Send starts the agent. A built
// release has no test hook (window.tabhelmTest is stripped), so it always goes
// this way, like a real user.
const hasHook = await panel.evaluate(() => Boolean(window.tabhelmTest));
if (process.env.E2E_LAZY || !hasHook) {
  await panel.type('#input', 'Fill this form: name "Ada Lovelace", color Blue, tick the agreement checkbox, then click Save and tell me the exact confirmation text shown.');
  await panel.click('#send');
} else await panel.evaluate(() => window.tabhelmTest.connect());
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
  await panel.evaluate(() => window.tabhelmTest.disconnect());
  await panel.waitForFunction(() => document.querySelector('#status').dataset.state === 'idle', { timeout: 30000 });
  await panel.evaluate(() => window.tabhelmTest.connect());
  await panel.waitForFunction((m) => {
    const s = document.querySelector('#config select.model');
    return document.querySelector('#status').dataset.state === 'ready' && s && s.value === m;
  }, { timeout: 60000 }, process.env.E2E_MODEL);
  console.log('model restored after reconnect');
}
if (process.env.E2E_RECORD) {
  await panel.click('#plus-menu summary');
  await panel.click('#record');
  await panel.click('#plus-menu summary');
}
if (!process.env.E2E_LAZY && hasHook) {
  await panel.type('#input', 'Fill this form: name "Ada Lovelace", color Blue, tick the agreement checkbox, then click Save and tell me the exact confirmation text shown.');
  await panel.click('#send');
}

if (process.env.E2E_INTERJECT) {
  // A message typed while the agent works rides along with its next tool result.
  await panel.waitForSelector('.action', { timeout: 120000 });
  await panel.type('#input', 'One more thing while you work: end your final answer with the word PINEAPPLE.');
  await panel.keyboard.press('Enter');
  const queuedTag = await panel.$eval('.msg.user.queued .queued-tag', (e) => e.textContent).catch(() => '(no queued bubble)');
  console.log('queued message tag:', queuedTag);
}

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
if (process.env.E2E_INTERJECT) {
  // The interrupt ends the first turn; the message then starts a second one.
  await panel.waitForFunction(() => /handed over/.test(document.querySelector('.queued-tag')?.textContent || ''), { timeout: 60000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  await panel.waitForFunction(() => document.querySelector('#send').textContent === 'Send' && document.querySelector('#status').dataset.state !== 'working', { timeout: 240000, polling: 1000 });
  const tag = await panel.$$eval('.queued-tag', (l) => l.map((e) => e.textContent).join(' | '));
  const reply = await panel.$$eval('.msg.agent', (m) => m.map((x) => x.innerText).join(' '));
  const outNow = await page.$eval('#out', (e) => e.textContent);
  const flagged = /posing as|prompt injection|claims? to be (from )?(you|the user)/i.test(reply);
  console.log('interject tag:', tag, '| PINEAPPLE:', /PINEAPPLE/.test(reply), '| treated as injection:', flagged, '| page:', outNow);
  extraOk &&= /handed over/.test(tag) && /PINEAPPLE/.test(reply) && !flagged && outNow === 'Saved: Ada Lovelace / blue / agreed';
}
if (process.env.E2E_HISTORY) {
  const count = await panel.$eval('.activity .activity-count', (e) => Number(e.textContent)).catch(() => 0);
  const blocks = await panel.$$eval('.activity', (b) => b.length);
  console.log(`steps block: ${blocks} block(s), ${count} steps in the first`);
  extraOk &&= blocks >= 1 && count >= 3;

  await new Promise((r) => setTimeout(r, 1000)); // debounced save
  await panel.click('#history-open');
  await panel.waitForSelector('.history-item', { timeout: 10000 });
  const items = await panel.$$eval('.history-item', (i) => i.map((x) => x.innerText.replace(/\s+/g, ' ')));
  console.log('history:', items);
  await panel.click('#history-close');

  await panel.click('#new-chat');
  await panel.waitForFunction(() => document.querySelector('#status').dataset.state === 'ready' && !document.querySelector('.msg'), { timeout: 90000 });

  // Move the tab elsewhere; opening the chat must bring it back.
  await page.goto(`${url}page-two`);
  await panel.click('#history-open');
  await panel.waitForSelector('.history-item .history-open', { timeout: 10000 });
  await panel.click('.history-item .history-open');
  await panel.waitForFunction(() => document.querySelectorAll('.msg.user').length === 1 && document.querySelector('.msg.agent'), { timeout: 20000 });
  await panel.waitForFunction(() => document.querySelector('#status').dataset.state === 'ready' && !document.querySelector('#send').disabled, { timeout: 90000 });
  const replayed = await panel.$eval('#log', (l) => ({ actions: l.querySelectorAll('.action').length, stats: l.querySelectorAll('.stats').length, text: l.innerText.slice(0, 120) }));
  console.log('replayed:', JSON.stringify(replayed));
  console.log('tab back on chat page:', page.url() === url, page.url());
  extraOk &&= replayed.actions >= 3 && replayed.stats >= 1 && page.url() === url;

  await panel.type('#input', 'Without using any tools: what exact confirmation text did the page show earlier in this chat?');
  await panel.click('#send');
  await panel.waitForFunction(() => document.querySelector('#send').textContent === 'Send' && document.querySelector('#status').dataset.state !== 'working', { timeout: 240000, polling: 1000 });
  const reply = await panel.$$eval('.msg.agent', (m) => m.at(-1)?.innerText || '');
  console.log('continued answer:', reply.replace(/\s+/g, ' ').slice(0, 160));
  extraOk &&= /Ada Lovelace/.test(reply);

  await new Promise((r) => setTimeout(r, 1000));
  await panel.reload();
  await panel.waitForFunction(() => document.querySelectorAll('.msg.user').length === 2, { timeout: 20000 });
  console.log('restored after reopening the panel: 2 messages');
}
if (process.env.E2E_FAILOVER) {
  const downloads = join(profile, 'downloads');
  const session = await browser.target().createCDPSession();
  await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  await panel.click('#history-open');
  await panel.waitForSelector('.history-item.current .history-export', { timeout: 10000 });
  await panel.click('.history-item.current .history-export');
  await panel.click('#history-close');
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
  const v = size ? checkVideo(path) : { ok: false };
  console.log('video file:', JSON.stringify(v));
  extraOk &&= size > 10_000 && v.ok;
  // Delete needs two clicks; the card and the file must both go.
  await panel.$$eval('.video .video-buttons button', (b) => b[0].click());
  await panel.$$eval('.video .video-buttons button', (b) => b[0].click());
  await panel.waitForFunction(() => !document.querySelector('.video'), { timeout: 10000 });
  const deleted = !existsSync(path);
  console.log('video deleted from chat and disk:', deleted);
  extraOk &&= deleted;
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
// Copy buttons under the reply: Markdown source and text with links written out.
await browser.defaultBrowserContext().overridePermissions(`chrome-extension://${extId}`, ['clipboard-read', 'clipboard-write']);
let copyOk = true;
{
  const bubbles = await panel.$$('.msg.agent');
  const lastBubble = bubbles[bubbles.length - 1];
  if (lastBubble) {
    await panel.bringToFront();
    await lastBubble.$eval('.msg-copy:nth-child(1)', (b) => b.click());
    await new Promise((r) => setTimeout(r, 300));
    const md = await panel.evaluate(() => navigator.clipboard.readText());
    const src = await lastBubble.evaluate((el) => el.markdown);
    await lastBubble.$eval('.msg-copy:nth-child(2)', (b) => b.click());
    await new Promise((r) => setTimeout(r, 300));
    const txt = await panel.evaluate(() => navigator.clipboard.readText());
    copyOk = md === src && txt.length > 0 && !/[*#`]/.test(txt.slice(0, 2));
    console.log('copy markdown matches source:', md === src, '| text copy:', txt.replace(/\s+/g, ' ').slice(0, 80));
  }
}

// Context & usage popup (shown once the agent reported usage).
const usageBtn = await panel.$eval('#usage-open', (b) => (b.hidden ? null : b.textContent.trim()));
let usagePopup = '';
if (usageBtn) {
  await panel.click('#usage-open');
  usagePopup = await panel.$eval('#usage-popup', (e) => (e.hidden ? '' : e.innerText.replace(/\s+/g, ' ')));
  await panel.screenshot({ path: join(profile, 'panel-usage.png') });
  await panel.click('#usage-close');
}
console.log('usage button:', usageBtn, '| popup:', usagePopup.slice(0, 200));
const usageOk = !usageBtn || (/Context window/.test(usagePopup) && /Tasks \d+/.test(usagePopup));
const log = await panel.$eval('#log', (e) => [...e.children].map((c) => c.className + ': ' + c.innerText.replace(/\n/g, ' ')).join('\n'));
console.log('---- panel log\n' + log + '\n----');
console.log('page result:', out);
await panel.screenshot({ path: join(profile, 'panel.png') });
console.log('panel screenshot:', join(profile, 'panel.png'));
if (process.env.E2E_SHOTS) {
  await panel.click('#plus-menu summary');
  await panel.screenshot({ path: join(profile, 'panel-menu.png') });
  await panel.click('#plus-menu summary');
  await panel.click('#settings-open');
  await panel.screenshot({ path: join(profile, 'panel-settings.png') });
  await panel.click('#settings-close');
  console.log('extra screenshots in', profile);
}
for (const p of relayProcs) p.kill();
const pass = (out === 'Saved: Ada Lovelace / blue / agreed' || process.env.E2E_INTERJECT) && extraOk && usageOk && copyOk;
console.log(pass ? 'E2E PASS' : 'E2E FAIL');
await browser.close();
server.close();
process.exit(pass ? 0 : 1);
