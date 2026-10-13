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
const page = (await browser.pages())[0] || (await browser.newPage());
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
// For the tab-group test the panel is a background tab of the same window: in
// headless Chrome a popup window disables tab grouping in the other windows.
if (process.env.E2E_TABS) await sw.evaluate((url) => chrome.tabs.create({ url, active: true }), panelUrl);
else await sw.evaluate((url) => chrome.windows.create({ url, type: 'popup', width: 420, height: 800 }), panelUrl);
const panel = await (await browser.waitForTarget((t) => t.url() === panelUrl)).page();
panel.on('console', (m) => console.log('[panel]', m.text()));
if (process.env.E2E_DARK) await panel.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
await panel.waitForSelector('#agent');

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
// E2E_LAZY=1: no explicit connect — the first Send starts the agent.
if (process.env.E2E_LAZY) {
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
if (!process.env.E2E_LAZY) {
  await panel.type('#input', 'Fill this form: name "Ada Lovelace", color Blue, tick the agreement checkbox, then click Save and tell me the exact confirmation text shown.');
  await panel.click('#send');
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
  extraOk &&= size > 10_000;
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
const pass = out === 'Saved: Ada Lovelace / blue / agreed' && extraOk;
console.log(pass ? 'E2E PASS' : 'E2E FAIL');
await browser.close();
server.close();
process.exit(pass ? 0 : 1);
