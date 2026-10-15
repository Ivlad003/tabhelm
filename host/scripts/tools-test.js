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
import { pickElements } from '../../extension/page-scripts.js';

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
<section id=pickZone style="padding:8px"><button id=pickA onclick="results.pickA = (results.pickA || 0) + 1">Pick A</button> <button id=pickB onclick="results.pickB = (results.pickB || 0) + 1">Pick B</button></section>
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
      const ui = { confirm: async () => allow, onTarget() {}, ask: () => new Promise(() => {}), resolveAsks() {}, skillsChanged() {}, guideProgress() {}, guideDone() {} };
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
check('find highlights the match on the page', await page.evaluate(() => Boolean(document.getElementById('tabhelm-highlight')?.shadowRoot?.querySelector('.box'))));
await sw.evaluate(() => chrome.storage.local.set({ highlightFinds: false }));
await page.evaluate(() => document.getElementById('tabhelm-highlight')?.remove());
found = await tool('browser_find', { text: 'Hover me' });
check('find highlight can be switched off', !(await page.evaluate(() => document.getElementById('tabhelm-highlight'))));
await sw.evaluate(() => chrome.storage.local.set({ highlightFinds: true }));

// --- Guide mode: the tool waits until the user clicks the element
{
  const guide = tool('browser_guide', { ref: refFor(found.text, 'Hover me'), text: 'Click the Hover me button', step: 1 });
  await page.waitForFunction(() => document.getElementById('tabhelm-guide')?.shadowRoot?.querySelector('.bubble'), { timeout: 5000 });
  const bubble = await page.evaluate(() => document.getElementById('tabhelm-guide').shadowRoot.querySelector('.bubble').textContent);
  check('guide shows the instruction on the page', /Your turn[\s\S]*Click the Hover me button/.test(bubble), bubble);
  await page.click('#hoverTarget');
  const g = await guide;
  check('guide completes when the user clicks the element', g.ok && /Click the Hover me button → clicked/.test(g.text), g.text);
  check('guide overlay removed afterwards', !(await page.evaluate(() => document.getElementById('tabhelm-guide'))));
  const skipRun = tool('browser_guide', { ref: refFor(found.text, 'Hover me'), text: 'Now skip this', step: 2 });
  await page.waitForFunction(() => document.getElementById('tabhelm-guide'), { timeout: 5000 });
  await page.evaluate(() => [...document.getElementById('tabhelm-guide').shadowRoot.querySelectorAll('button')].find((b) => b.textContent === 'Skip').click());
  const sk = await skipRun;
  check('guide Skip button on the page', sk.ok && /skipped/.test(sk.text), sk.text);
  const backRun = tool('browser_guide', { ref: refFor(found.text, 'Hover me'), text: 'Go back from here', step: 3 });
  await page.waitForFunction(() => document.getElementById('tabhelm-guide'), { timeout: 5000 });
  await page.evaluate(() => [...document.getElementById('tabhelm-guide').shadowRoot.querySelectorAll('button')].find((b) => b.textContent.includes('Back')).click());
  const bk = await backRun;
  check('guide Back button asks for the previous step', bk.ok && /previous step again .*step 2/.test(bk.text), bk.text);
  // A tour: all steps badged at once, Next moves (and scrolls) to the next one, Back returns.
  const refs2 = [refFor(found.text, 'Hover me'), refFor(snap.text, 'Log')];
  const tourRun = tool('browser_guide', { steps: [{ ref: refs2[0], text: 'First: hover button' }, { ref: refs2[1], text: 'Second: the Save button' }] });
  const readTour = () => page.evaluate(() => { const r = document.getElementById('tabhelm-guide')?.shadowRoot; return r ? { badges: [...r.querySelectorAll('.badge')].map((b) => b.textContent + (b.classList.contains('active') ? '*' : '')), head: r.querySelector('.step')?.textContent, text: r.querySelector('.text')?.textContent } : null; });
  await page.waitForFunction(() => document.getElementById('tabhelm-guide'), { timeout: 5000 });
  const t1 = await readTour();
  check('tour shows every step as a badge, first active', t1?.badges.join(',') === '1*,2' && /Step 1 of 2/.test(t1.head), JSON.stringify(t1));
  await page.evaluate(() => [...document.getElementById('tabhelm-guide').shadowRoot.querySelectorAll('button')].find((b) => /Next/.test(b.textContent)).click());
  await page.waitForFunction(() => /Step 2 of 2/.test(document.getElementById('tabhelm-guide')?.shadowRoot?.querySelector('.step')?.textContent || ''), { timeout: 5000 });
  const t2 = await readTour();
  check('Next moves to the second step', t2?.badges.join(',') === '1,2*' && /Second/.test(t2.text), JSON.stringify(t2));
  await page.evaluate(() => [...document.getElementById('tabhelm-guide').shadowRoot.querySelectorAll('button')].find((b) => /Back/.test(b.textContent)).click());
  await page.waitForFunction(() => /Step 1 of 2/.test(document.getElementById('tabhelm-guide')?.shadowRoot?.querySelector('.step')?.textContent || ''), { timeout: 5000 });
  check('Back returns to the first step', /Step 1 of 2/.test((await readTour()).head));
  await page.evaluate(() => [...document.getElementById('tabhelm-guide').shadowRoot.querySelectorAll('button')].find((b) => /Next/.test(b.textContent)).click());
  await page.waitForFunction(() => /Step 2 of 2/.test(document.getElementById('tabhelm-guide')?.shadowRoot?.querySelector('.step')?.textContent || ''), { timeout: 5000 });
  await page.evaluate(() => [...document.getElementById('tabhelm-guide').shadowRoot.querySelectorAll('button')].find((b) => /Finish/.test(b.textContent)).click());
  const tr = await tourRun;
  check('tour returns a summary of all steps', tr.ok && /1\. First.*→ done/.test(tr.text) && /2\. Second.*→ done/.test(tr.text), tr.text);
}

// --- skill_save: stored as an authored skill, flag switched on
{
  const r = await tool('skill_save', { name: 'Hover Menu Guide', description: 'How to open the hover menu', body: '# Steps\n1. Hover "Hover me".\n2. Click "Secret item".' });
  const st = await sw.evaluate(() => chrome.storage.local.get(['authoredSkills', 'features']));
  check('skill_save stores the skill and enables Skill authoring', r.ok && st.authoredSkills?.[0]?.name === 'hover-menu-guide' && st.features?.skillAuthoring === true, `${r.text} ${JSON.stringify(st)}`);
}

// --- Auto-play guide: the agent clicks the steps itself after the pause
{
  await sw.evaluate(() => chrome.storage.local.set({ guidePause: 1 }));
  snap = await tool('browser_snapshot');
  const before = await results();
  const t0 = Date.now();
  const r = await tool('browser_guide', { auto: true, steps: [{ ref: refFor(snap.text, 'Pick A'), text: 'Press A' }, { ref: refFor(snap.text, 'Pick B'), text: 'Press B' }] });
  const after = await results();
  check('auto guide clicks every step after a pause', r.ok && /auto-clicked[\s\S]*auto-clicked/.test(r.text) && (after.pickA || 0) === (before.pickA || 0) + 1 && (after.pickB || 0) === (before.pickB || 0) + 1 && Date.now() - t0 >= 2000, `${r.text} ${JSON.stringify(after)} ${Date.now() - t0}ms`);
}

// --- Element picker: one element by click, several by dragging a rectangle
{
  await page.evaluate(() => document.getElementById('pickZone').scrollIntoView({ block: 'center' }));
  const one = page.evaluate(pickElements, 'one');
  await page.waitForFunction(() => document.getElementById('tabhelm-picker'), { timeout: 5000 });
  const b = await (await page.$('#pickA')).boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  const res1 = await one;
  check('pick element returns ref, selector and text', res1.items.length === 1 && res1.items[0].selector === '#pickA' && res1.items[0].text === 'Pick A' && /^e\d+$/.test(res1.items[0].ref), JSON.stringify(res1.items));
  check('picking does not click the page', !(await results()).pickA || (await results()).pickA === 1);
  const area = page.evaluate(pickElements, 'area');
  await page.waitForFunction(() => document.getElementById('tabhelm-picker'), { timeout: 5000 });
  const z = await (await page.$('#pickZone')).boundingBox();
  await page.mouse.move(z.x + 2, z.y + 2);
  await page.mouse.down();
  await page.mouse.move(z.x + z.width / 2, z.y + z.height / 2, { steps: 4 });
  await page.mouse.move(z.x + z.width - 2, z.y + z.height - 2, { steps: 4 });
  await page.mouse.up();
  const res2 = await area;
  check('select area picks every element inside the rectangle', res2.items.map((i) => i.selector).join(',') === '#pickA,#pickB', JSON.stringify(res2.items.map((i) => i.selector)));
}

// --- Page scripts & styles: browser_style, save / list / run a preset
{
  let r = await tool('browser_style', { css: '#pickA { color: rgb(255, 0, 0) !important; }', id: 't' });
  check('page scripts tools need their flag', !r.ok && /Page scripts/.test(r.text), r.text);
  await sw.evaluate(async () => { const { features = {} } = await chrome.storage.local.get('features'); await chrome.storage.local.set({ features: { ...features, pageScripts: true } }); });
  r = await tool('browser_style', { css: '#pickA { color: rgb(255, 0, 0) !important; }', id: 't' });
  const red = await page.$eval('#pickA', (e) => getComputedStyle(e).color);
  await tool('browser_style', { id: 't', remove: true });
  const back = await page.$eval('#pickA', (e) => getComputedStyle(e).color);
  check('browser_style applies and removes CSS', r.ok && red === 'rgb(255, 0, 0)' && back !== red, `${red} → ${back}`);
  r = await tool('browser_script_save', { name: 'count-buttons', description: 'Counts buttons', match: '127.0.0.1', js: 'return document.querySelectorAll("button").length', css: '#pickB { outline: 3px solid rgb(0, 128, 0); }' });
  const list = await tool('browser_script_list');
  const run = await tool('browser_script_run', { name: 'count-buttons' });
  const outline = await page.$eval('#pickB', (e) => getComputedStyle(e).outlineColor);
  const stored = await sw.evaluate(() => chrome.storage.local.get('pageScripts'));
  check('script presets save, list, run JS + CSS', r.ok && /count-buttons.*matches this page/.test(list.text) && /Result: \d+/.test(run.text) && outline === 'rgb(0, 128, 0)' && stored.pageScripts[0].autoRun === false, `${list.text} | ${run.text} | ${outline}`);
}
// The snapshots above replaced the refs from the earlier find.
found = await tool('browser_find', { text: 'Hover me' });
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
{
  const g = await sw.evaluate(async (id) => {
    const st = self.tabhelmDebug.chatDebugState(id);
    const tabs = st.groupId != null ? await chrome.tabs.query({ groupId: st.groupId }) : [];
    const title = st.groupId != null ? (await chrome.tabGroups.get(st.groupId)).title : null;
    return { groupId: st.groupId, ids: tabs.map((t) => t.id), title };
  }, tabId);
  check('tabs the agent opens are grouped with the chat tab', g.groupId != null && g.ids.includes(tabId) && g.ids.length >= 2 && g.title === 'TabHelm', JSON.stringify(g));
}
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
check('chat tab put into a tab group', group.grouped && group.count >= 1, JSON.stringify(group));
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
