#!/usr/bin/env node
// Exercises every browser tool directly (no agent) in headless Chrome against a
// fixture page with iframes, hover menus, drag-and-drop, canvas, file inputs,
// dialogs, popups, console and network activity.
// Usage: node scripts/tools-test.js   (CHROME_PATH overrides the browser)

import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('../../extension', import.meta.url));
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const profile = mkdtempSync(join(tmpdir(), 'tabhelm-tools-'));
const uploadFile = join(profile, 'hello.txt');
writeFileSync(uploadFile, 'hello from tabhelm');

const INNER = `<!doctype html><title>Inner</title><body style="margin:0">
<input id=innerInput placeholder="Inner field">
<button id=innerBtn onclick="document.body.dataset.clicked = 'yes'">Inner button</button></body>`;

const MAIN = (port) => `<!doctype html><title>Tools fixture</title>
<style>
  body { margin: 0; font: 14px sans-serif; } section { margin: 8px; }
  #menu { display: none; } #dropZone, #dragSrc { display: inline-block; padding: 12px; border: 1px solid #888; }
  #scroller { height: 80px; overflow: auto; border: 1px solid #ccc; width: 200px; }
  iframe { width: 300px; height: 60px; border: 2px solid #333; padding: 3px; }
</style>
<h1>Fixture</h1>
<section><button id=hoverTarget>Hover me</button><div id=menu><a href="#secret">Secret item</a></div></section>
<section><span id=dbl tabindex=0>Double me</span> <span id=ctx tabindex=0>Context me</span></section>
<section><span id=dragSrc draggable=true>Drag source</span> <span id=dropZone>Drop zone</span></section>
<section><canvas id=cv width=200 height=100 style="border:1px solid #000"></canvas></section>
<section><input id=kb placeholder="Keyboard field"></section>
<section><label for=file1 id=uploadLabel>Upload photo</label><input type=file id=file1 hidden></section>
<section><button id=logBtn onclick="console.log('hello-console'); console.error('oops-error')">Log</button>
<button id=fetchBtn onclick="fetch('/api/ping'); fetch('/missing')">Fetch</button>
<button id=alertBtn onclick="results.alert = confirm('Proceed?')">Alert</button>
<a id=popup href="/popup" target="_blank">Open popup</a> <a href="/page2">Page two</a></section>
<section><div id=scroller><div style="height:600px">Scrollable box</div></div></section>
<section><iframe id=same src="/inner"></iframe> <iframe id=cross src="http://localhost:${port}/inner"></iframe></section>
<div style="height:1500px">Tall filler</div>
<script>
  window.results = {};
  hoverTarget.addEventListener('mouseover', () => (menu.style.display = 'block'));
  dbl.addEventListener('dblclick', () => (results.dbl = true));
  ctx.addEventListener('contextmenu', (e) => { e.preventDefault(); results.ctx = true; });
  dragSrc.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', 'payload'));
  dropZone.addEventListener('dragover', (e) => e.preventDefault());
  dropZone.addEventListener('drop', (e) => { e.preventDefault(); results.drop = e.dataTransfer.getData('text/plain'); });
  let drawing = false;
  cv.addEventListener('mousedown', (e) => { drawing = true; results.drawStart = [e.offsetX, e.offsetY]; });
  cv.addEventListener('mousemove', (e) => { if (drawing) results.drawMoves = (results.drawMoves || 0) + 1; });
  cv.addEventListener('mouseup', (e) => { drawing = false; results.drawEnd = [e.offsetX, e.offsetY]; });
  cv.addEventListener('click', (e) => (results.canvasClick = [e.offsetX, e.offsetY]));
  kb.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 'a') results.ctrlA = true; if (e.shiftKey && e.key === 'Tab') results.shiftTab = true; });
  file1.addEventListener('change', () => (results.files = [...file1.files].map((f) => f.name)));
</script>`;

let port;
const server = http.createServer((req, res) => {
  const html = (body) => res.writeHead(200, { 'content-type': 'text/html' }).end(body);
  if (req.url === '/') return html(MAIN(port));
  if (req.url === '/inner') return html(INNER);
  if (req.url === '/popup') return html('<title>Popup page</title><h1>Popup content</h1>');
  if (req.url === '/page2') return html('<title>Page two</title><h1>Second page</h1>');
  if (req.url === '/contacts') return html('<title>Contacts</title><h1>Contacts</h1><p>Name: Grace Hopper</p><p>Email: grace@navy.example</p>');
  if (req.url === '/private') return html('<title>Private</title><h1>Private page</h1>');
  if (req.url === '/api/ping') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  res.writeHead(404).end('not found');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
port = server.address().port;
const url = `http://127.0.0.1:${port}/`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: profile,
  pipe: true,
  enableExtensions: [EXT],
  args: ['--no-first-run', '--window-size=1280,900'],
  defaultViewport: null,
  protocolTimeout: 60_000,
});

const page = (await browser.pages())[0];
await page.goto(url, { waitUntil: 'load' });
const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
const sw = await swTarget.worker();
const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}*` }))[0].id, url);

async function tool(name, args = {}, { allow = true } = {}) {
  return sw.evaluate(
    async (tabId, name, args, allow) => {
      const ui = { confirm: async () => allow, onTarget() {} };
      try {
        const r = await self.tabhelmDebug.runTool(tabId, name, args, ui);
        return { ok: true, text: r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), images: r.content.filter((c) => c.type === 'image').length, label: r.label };
      } catch (err) {
        return { ok: false, text: err.message };
      }
    },
    tabId,
    name,
    args,
    allow,
  );
}

const results = () => page.evaluate(() => window.results);
let failures = 0;
function check(name, cond, info = '') {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  —  ${String(info).slice(0, 400)}`}`);
  if (!cond) failures++;
}
const refFor = (text, label) => new RegExp(`\\[((?:f\\d+:)?e\\d+)\\][^\\n]*${label}`).exec(text)?.[1];

// --- Reading
let snap = await tool('browser_snapshot');
check('snapshot reads page', snap.ok && snap.text.includes('Hover me'), snap.text);
check('snapshot includes both iframes', (snap.text.match(/── iframe f\d+/g) || []).length === 2, snap.text);
check('snapshot lists hidden file input', /hidden file inputs[\s\S]*file-input/.test(snap.text), snap.text);

let found = await tool('browser_find', { text: 'Hover me' });
check('find returns a ref', /\[e\d+\]/.test(found.text), found.text);

// --- Mouse
let r = await tool('browser_hover', { ref: refFor(found.text, 'Hover me') });
found = await tool('browser_find', { text: 'Secret item' });
check('hover reveals menu', r.ok && /\[e\d+\]/.test(found.text), `${r.text} | ${found.text}`);

found = await tool('browser_find', { text: 'Double me' });
r = await tool('browser_click', { ref: refFor(found.text, 'Double me'), double: true });
check('double click', r.ok && (await results()).dbl, r.text);

found = await tool('browser_find', { text: 'Context me' });
r = await tool('browser_click', { ref: refFor(found.text, 'Context me'), button: 'right' });
check('right click', r.ok && (await results()).ctx, r.text);

snap = await tool('browser_snapshot');
found = await tool('browser_find', { text: 'Drop zone' }); // plain <span>: no ref in the snapshot, find assigns one
r = await tool('browser_drag', { fromRef: refFor(snap.text, 'Drag source'), toRef: refFor(found.text, 'Drop zone') });
check('HTML5 drag and drop', r.ok && (await results()).drop === 'payload', `${r.text} | ${JSON.stringify(await results())}`);

r = await tool('browser_screenshot');
check('viewport screenshot', r.ok && r.images === 1 && /Viewport \d+×\d+/.test(r.text), r.text);

await page.evaluate(() => document.getElementById('cv').scrollIntoView({ block: 'center' }));
const cvBox = await page.evaluate(() => {
  const cv = document.getElementById('cv');
  const b = cv.getBoundingClientRect();
  return { x: b.left + cv.clientLeft, y: b.top + cv.clientTop };
});
r = await tool('browser_click_xy', { x: cvBox.x + 50, y: cvBox.y + 40 });
let res = await results();
check('click by coordinates on canvas', r.ok && res.canvasClick?.[0] === 50 && res.canvasClick?.[1] === 40, `${r.text} ${JSON.stringify(res.canvasClick)}`);

r = await tool('browser_drag', { from: { x: cvBox.x + 10, y: cvBox.y + 10 }, to: { x: cvBox.x + 150, y: cvBox.y + 80 } });
res = await results();
check('mouse drag on canvas', r.ok && res.drawMoves > 5 && res.drawEnd?.[0] === 150, `${r.text} ${JSON.stringify(res)}`);

// --- Keyboard
snap = await tool('browser_snapshot');
const kbRef = refFor(snap.text, 'Keyboard field');
await tool('browser_type', { ref: kbRef, text: 'select me' });
r = await tool('browser_press_key', { key: 'Control+A' });
const selection = await page.evaluate(() => [document.getElementById('kb').selectionStart, document.getElementById('kb').selectionEnd]);
check('Control+A combo selects text', r.ok && (await results()).ctrlA && selection[0] === 0 && selection[1] === 9, `${r.text} ${selection}`);
r = await tool('browser_press_key', { key: 'Shift+Tab' });
check('Shift+Tab combo', r.ok && (await results()).shiftTab, r.text);

// --- Upload
const fileRef = /\[(e\d+)\] file-input/.exec(snap.text)?.[1];
r = await tool('browser_upload_file', { ref: fileRef, paths: [uploadFile] });
check('upload via hidden file input ref', r.ok && (await results()).files?.[0] === 'hello.txt', r.text);
await page.evaluate(() => {
  document.getElementById('file1').value = '';
  window.results.files = null;
});
r = await tool('browser_click', { ref: refFor(snap.text, 'Upload photo') });
check('click on upload label reports file chooser', r.ok && /file chooser opened/.test(r.text), r.text);
r = await tool('browser_upload_file', { paths: [uploadFile] });
check('upload via intercepted file chooser', r.ok && (await results()).files?.[0] === 'hello.txt', r.text);

// --- Diagnostics
await tool('browser_click', { ref: refFor(snap.text, '"Log"') });
r = await tool('browser_console');
check('console messages', r.text.includes('hello-console') && r.text.includes('[error] oops-error'), r.text);
r = await tool('browser_console', { level: 'error' });
check('console error filter', r.text.includes('oops-error') && !r.text.includes('hello-console'), r.text);

await tool('browser_click', { ref: refFor(snap.text, '"Fetch"') });
await new Promise((x) => setTimeout(x, 500));
r = await tool('browser_network', { filter: '/api/ping' });
check('network log', /GET 200 Fetch .*\/api\/ping/.test(r.text), r.text);
r = await tool('browser_network', { failedOnly: true });
check('network failed filter', /404 .*\/missing/.test(r.text) && !r.text.includes('/api/ping'), r.text);

r = await tool('browser_evaluate', { expression: 'document.title + " " + (1 + 2)' });
check('evaluate JS', r.ok && r.text === '"Tools fixture 3"', r.text);
r = await tool('browser_evaluate', { expression: 'new Promise((ok) => setTimeout(() => ok({a: 1}), 50))' });
check('evaluate awaits promises', r.ok && r.text.includes('"a": 1'), r.text);

// --- Iframes
snap = await tool('browser_snapshot');
const innerBtns = [...snap.text.matchAll(/\[(f\d+:e\d+)\] button "Inner button"/g)].map((m) => m[1]);
const innerInputs = [...snap.text.matchAll(/\[(f\d+:e\d+)\] textbox "Inner field"/g)].map((m) => m[1]);
check('iframe refs are prefixed', innerBtns.length === 2 && innerInputs.length === 2, snap.text);
for (const [i, which] of [[0, 'same-origin'], [1, 'cross-origin']]) {
  r = await tool('browser_click', { ref: innerBtns[i] });
  const frame = page.frames().find((f) => f.url().includes('/inner') && (which === 'same-origin' ? f.url().startsWith('http://127.0.0.1') : f.url().startsWith('http://localhost')));
  const clicked = await frame.evaluate(() => document.body.dataset.clicked);
  check(`click inside ${which} iframe (trusted, positioned)`, r.ok && clicked === 'yes' && !/DOM click/.test(r.text), r.text);
  r = await tool('browser_type', { ref: innerInputs[i], text: `typed ${i}` });
  const value = await frame.evaluate(() => document.getElementById('innerInput').value);
  check(`type inside ${which} iframe`, r.ok && value === `typed ${i}`, `${r.text} value=${value}`);
}
found = await tool('browser_find', { text: 'Inner button' });
check('find searches iframes', (found.text.match(/\[f\d+:e\d+\]/g) || []).length === 2, found.text);
r = await tool('browser_screenshot', { ref: innerBtns[1] });
check('element screenshot inside iframe', r.ok && r.images === 1, r.text);

// --- Scroll & screenshots
r = await tool('browser_scroll', { direction: 'down', amount: 300 });
check('scroll page', r.ok && /Position \d+/.test(r.text), r.text);
r = await tool('browser_scroll', { direction: 'down', ref: refFor(snap.text, 'focusable "Scrollable box"') || /\[(e\d+)\][^\n]*Scrollable box/.exec(snap.text)?.[1] });
check('scroll element', r.ok || /stale|Invalid ref/.test(r.text), r.text);
r = await tool('browser_screenshot', { fullPage: true });
check('full-page screenshot', r.ok && r.images === 1 && /Full page/.test(r.text), r.text);

// --- Dialogs
snap = await tool('browser_snapshot');
r = await tool('browser_click', { ref: refFor(snap.text, '"Alert"') });
check('click reports dialog', /confirm dialog opened/.test(r.text), r.text);
r = await tool('browser_snapshot');
check('tools blocked while dialog open', !r.ok && /handle_dialog/.test(r.text), r.text);
r = await tool('browser_handle_dialog', { accept: true });
check('accept dialog', r.ok && (await results()).alert === true, r.text);

// --- Tabs
snap = await tool('browser_snapshot');
r = await tool('browser_click', { ref: refFor(snap.text, 'Open popup') });
await new Promise((x) => setTimeout(x, 800));
r = await tool('browser_tabs', { action: 'list' });
const popupId = /^(\d+): Popup page/m.exec(r.text)?.[1];
check('popup tab is tracked', Boolean(popupId), r.text);
r = await tool('browser_tabs', { action: 'switch', tabId: Number(popupId) });
snap = await tool('browser_snapshot');
check('switch to popup tab', r.ok && snap.text.includes('Popup content'), snap.text);
r = await tool('browser_tabs', { action: 'close', tabId: Number(popupId) });
snap = await tool('browser_snapshot');
check('closing popup returns to chat tab', r.ok && snap.text.includes('Fixture'), snap.text);

r = await tool('browser_tabs', { action: 'new', url: `${url}page2` });
snap = await tool('browser_snapshot');
check('new background tab', r.ok && snap.text.includes('Second page'), `${r.text} | ${snap.text}`);
r = await tool('browser_tabs', { action: 'switch', tabId });
check('switch back to chat tab', r.ok, r.text);
r = await tool('browser_tabs', { action: 'close', tabId });
check('chat tab cannot be closed', !r.ok, r.text);

// --- Several tabs: a shared tab group, tabId on any tool, search across tabs
// Tabs opened within ~3 s of an agent action count as its popups; these are the user's.
await new Promise((x) => setTimeout(x, 3500));
const contacts = await browser.newPage();
await contacts.goto(`${url}contacts`);
const contactsId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}contacts` }))[0].id, url);
const other = await browser.newPage();
await other.goto(`${url}private`);
const otherId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}private` }))[0].id, url);
await page.bringToFront();

const group = await sw.evaluate(async (chat) => self.tabhelmDebug.ensureGroup(chat), tabId);
check('chat tab put into a tab group', group.grouped && group.count === 1, JSON.stringify(group));
// The user drags the contacts tab into the group.
await sw.evaluate(async (groupId, id) => chrome.tabs.group({ groupId, tabIds: [id] }), group.groupId, contactsId);
r = await tool('browser_get_text', { tabId: contactsId }, { allow: false });
check('grouped tab readable via tabId without asking', r.ok && r.text.includes('grace@navy.example'), r.text);
r = await tool('browser_search_tabs', { text: 'grace@navy' }, { allow: false });
check('search across tabs finds the match in the grouped tab', r.ok && new RegExp(`tab ${contactsId} "Contacts" — 1 match`).test(r.text), r.text);
r = await tool('browser_get_text', { tabId: otherId }, { allow: false });
check('tab outside the group needs approval', !r.ok && /did not allow/.test(r.text), r.text);
r = await tool('browser_tabs', { action: 'list' }, { allow: false });
check('tab list includes shared group tabs', r.text.includes(`${contactsId}: Contacts`) && !r.text.includes(`${otherId}:`), r.text);
await sw.evaluate(async (id) => chrome.tabs.ungroup([id]), contactsId);
r = await tool('browser_get_text', { tabId: contactsId }, { allow: false });
check('tab dragged out of the group needs approval again', !r.ok, r.text);
await contacts.close();
await other.close();

// --- Navigation
r = await tool('browser_navigate', { url: `${url}page2` });
check('navigate', r.ok && r.text.includes('page2'), r.text);
r = await tool('browser_go_back');
check('go back', r.ok && r.text.endsWith(`${url}.`), r.text);
r = await tool('browser_go_forward');
check('go forward', r.ok && r.text.includes('page2'), r.text);
r = await tool('browser_reload');
check('reload', r.ok && r.text.includes('page2'), r.text);
r = await tool('browser_wait', { text: 'Second page' });
check('wait for text', r.ok && r.text.includes('is on the page'), r.text);

console.log(failures ? `\n${failures} check(s) failed` : '\nALL TOOL CHECKS PASSED');
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
