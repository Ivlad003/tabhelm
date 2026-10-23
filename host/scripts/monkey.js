#!/usr/bin/env node
// Monkey test: random and malformed input against every surface, looking for
// crashes, hangs and uncaught errors (not for correct answers).
//   1. host   — garbage native-messaging frames and every message type with random fields
//   2. relay  — bad keys, odd paths, binary / oversized frames, connection floods
//   3. tools  — every browser tool with random arguments on a fixture page
//   4. panel  — random clicks, typing, keys and selects in the side panel
// Everything runs with a temporary HOME and no DISPLAY, so nothing touches the
// user's ~/.tabhelm, opens dialogs or starts a paid agent (the panel talks to the
// built-in OpenAI-compatible agent backed by a local mock).
// Usage: node scripts/monkey.js [seed] [steps]   (MONKEY_ONLY=host,relay,tools,panel)

import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import WebSocket from 'ws';

const SEED = Number(process.argv[2] || Date.now() % 100000);
const STEPS = Number(process.argv[3] || 300);
const ONLY = (process.env.MONKEY_ONLY || 'host,relay,tools,panel').split(',');
const HOST = fileURLToPath(new URL('../src/native-host.js', import.meta.url));
const RELAY = fileURLToPath(new URL('../../relay/server.js', import.meta.url));
const EXT = fileURLToPath(new URL('../../extension', import.meta.url));
const INSTALL = fileURLToPath(new URL('./install.js', import.meta.url));
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const HOME = mkdtempSync(join(tmpdir(), 'tabhelm-monkey-home-'));
mkdirSync(join(HOME, '.tabhelm'), { recursive: true });
const ENV = { ...process.env, TABHELM_TEST: '1', HOME, USERPROFILE: HOME, DISPLAY: '', WAYLAND_DISPLAY: '', TABHELM_RECORDINGS_DIR: join(HOME, 'videos') };

// Deterministic RNG so a failing run can be replayed with the same seed.
let s = SEED >>> 0 || 1;
const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rand() * a.length)];
const chance = (p) => rand() < p;
const STRINGS = ['', ' ', 'a', 'e1', 'e99999', 'f9:e1', '../../etc/passwd', '<script>alert(1)</script>', '{{SECRET:x}}', 'javascript:alert(1)', 'about:blank', 'chrome://settings', 'http://127.0.0.1:1/', '💥'.repeat(50), 'x'.repeat(5000), '\u0000\u0001', 'null', 'NaN', 'Ünïcødé текст', '#', '*', '$(rm -rf /)', 'SELECT * FROM'];
const junk = (depth = 0) => {
  const r = rand();
  if (r < 0.3) return pick(STRINGS);
  if (r < 0.45) return Math.floor(rand() * 2e9) - 1e9;
  if (r < 0.5) return pick([0, -1, 1.5, NaN, Infinity, 2 ** 53]);
  if (r < 0.58) return pick([true, false, null, undefined]);
  if (r < 0.7 && depth < 2) return Array.from({ length: Math.floor(rand() * 4) }, () => junk(depth + 1));
  if (depth < 2) return Object.fromEntries(Array.from({ length: Math.floor(rand() * 4) }, () => [pick(['ref', 'text', 'url', 'tabId', 'x', 'y', 'key', 'value', 'id', 'path', 'name']), junk(depth + 1)]));
  return pick(STRINGS);
};

const findings = [];
const finding = (area, what, detail = '') => {
  const key = `${area}: ${what}`;
  if (!findings.some((f) => f.key === key)) findings.push({ key, detail: String(detail).slice(0, 400) });
  console.log(`  ✗ ${key}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`);
};
const hostLogErrors = () => {
  const f = join(HOME, '.tabhelm', 'host.log');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter((l) => /uncaught|unhandled/i.test(l));
};

// Mock OpenAI-compatible API for the built-in agent: short answers, no tools.
const api = http.createServer((req, res) => {
  if (req.url.endsWith('/models')) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok **monkey** [link](https://example.com)' } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  res.end('data: [DONE]\n\n');
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
const API = `http://127.0.0.1:${api.address().port}/v1`;
writeFileSync(join(HOME, '.tabhelm', 'env'), `TABHELM_OPENAI_BASE_URL=${API}\nTABHELM_OPENAI_API_KEY=mock\nTABHELM_OPENAI_MODEL=mock-model\n`);

// ---------------------------------------------------------------- 1. host
async function monkeyHost() {
  console.log('\n[host] fuzzing native messaging');
  const host = spawn(process.execPath, [HOST], { env: ENV, stdio: ['pipe', 'pipe', 'pipe'] });
  let exited = null;
  host.on('exit', (code, sig) => (exited = { code, sig }));
  let stderr = '';
  host.stderr.on('data', (d) => (stderr += d));
  let buf = Buffer.alloc(0);
  const got = [];
  host.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4) {
      const n = buf.readUInt32LE(0);
      if (buf.length < 4 + n) break;
      try {
        got.push(JSON.parse(buf.subarray(4, 4 + n)));
      } catch {
        finding('host', 'wrote a frame that is not JSON');
      }
      buf = buf.subarray(4 + n);
    }
  });
  const frame = (obj) => {
    const b = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
    const l = Buffer.alloc(4);
    l.writeUInt32LE(b.length);
    host.stdin.write(Buffer.concat([l, b]));
  };
  const TYPES = ['ping', 'list_agents', 'start', 'prompt', 'cancel', 'stop', 'permission_response', 'set_skills', 'set_features', 'page_url', 'critic', 'critic_status', 'transcribe', 'transcribe_status', 'memory_list', 'memory_add', 'memory_delete', 'memory_clear', 'folder_info', 'skill_preview', 'set_auto_approve', 'authenticate', 'set_config', 'save_recording', 'backup_state', 'restore_state', 'delete_recording', 'tool_result', 'interject', 'log_digest', 'no_such_type'];
  // pick_folder (desktop dialog) and password_* (1Password CLI) are left out on purpose.
  for (let i = 0; i < STEPS && !exited; i++) {
    const r = rand();
    if (r < 0.05) frame('{not json');
    else if (r < 0.08) frame('');
    else if (r < 0.1) frame(JSON.stringify(junk()) ?? 'undefined');
    else {
      const type = pick(TYPES);
      const extra = junk();
      const msg = { type, tabId: pick([1, 2, junk(), undefined]), ...(extra && typeof extra === 'object' && !Array.isArray(extra) ? extra : {}) };
      if (type === 'start') msg.agentId = pick(['openai-compatible', 'no-such-agent', junk()]);
      if (type === 'skill_preview') msg.url = pick(['http://127.0.0.1:1/x', 'not a url', 'file:///etc/passwd', junk()]);
      if (type === 'delete_recording') msg.path = pick(['/etc/passwd', '../../x.webm', junk()]);
      if (type === 'save_recording') Object.assign(msg, { id: pick(['a', '../../../evil', junk()]), data: pick(['AAAA', junk()]), done: chance(0.5) });
      if (type === 'folder_info') msg.path = pick(['/', '~', '/nonexistent', junk()]);
      frame(msg);
    }
    if (i % 25 === 0) await new Promise((r2) => setTimeout(r2, 50));
  }
  // An absurd length header must not make the host allocate gigabytes or hang.
  const big = Buffer.alloc(4);
  big.writeUInt32LE(0x7fffffff);
  host.stdin.write(big);
  await new Promise((r2) => setTimeout(r2, 1500));
  const before = got.length;
  if (!exited) {
    // After garbage the host should still be... well, it cannot resync after a bogus
    // length header; Chrome never sends one, so only crash-freedom is checked there.
  }
  if (exited) finding('host', `process exited during fuzzing (${exited.code ?? exited.sig})`, stderr.slice(-300));
  for (const l of hostLogErrors()) finding('host', 'uncaught error in host.log', l);
  const survived = !exited;
  host.kill();
  // A fresh host must still answer after all that state on disk.
  const h2 = spawn(process.execPath, [HOST], { env: ENV, stdio: ['pipe', 'pipe', 'ignore'] });
  const answered = await new Promise((res) => {
    const t = setTimeout(() => res(false), 8000);
    h2.stdout.once('data', () => (clearTimeout(t), res(true)));
  });
  if (!answered) finding('host', 'a fresh host did not answer after fuzzing (state on disk broken?)');
  h2.kill();
  // Handlers that throw on unexpected field types (caught, but worth a clean message).
  const f = join(HOME, '.tabhelm', 'host.log');
  const raw = existsSync(f) ? readFileSync(f, 'utf8') : '';
  for (const m of raw.matchAll(/error handling (\w+): (TypeError[^\n]*)/g)) finding('host', `${m[1]} throws on bad input`, m[2]);
  console.log(`  host: ${STEPS} messages, ${before} replies, ${survived ? 'alive' : 'CRASHED'}`);
}

// ---------------------------------------------------------------- 2. relay
async function monkeyRelay() {
  console.log('\n[relay] fuzzing');
  const port = 19000 + Math.floor(rand() * 900);
  const relay = spawn(process.execPath, [RELAY], { env: { ...ENV, PORT: String(port), RELAY_KEY: 'monkey-key-123456' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = null;
  let err = '';
  relay.on('exit', (c) => (exited = c));
  relay.stderr.on('data', (d) => (err += d));
  await new Promise((r) => relay.stdout.on('data', (d) => /listening/.test(String(d)) && r()));
  const base = `ws://127.0.0.1:${port}`;
  const open = (path) =>
    new Promise((res) => {
      const ws = new WebSocket(base + path);
      const t = setTimeout(() => (ws.terminate(), res(null)), 3000);
      ws.on('open', () => (clearTimeout(t), res(ws)));
      ws.on('error', () => (clearTimeout(t), res(null)));
      ws.on('unexpected-response', () => (clearTimeout(t), res(null)));
    });
  const paths = ['/', '/host', '/host?key=wrong', '/host?key=monkey-key-123456', '/client', '/client?code=AAAA-BBBB', '/client?token=xyz', '/client?code=' + 'A'.repeat(5000), '/../../etc', '/host?key=monkey-key-123456&token=' + 'z'.repeat(3000)];
  const sockets = [];
  for (let i = 0; i < Math.min(STEPS, 120) && exited == null; i++) {
    const ws = await open(pick(paths));
    if (!ws) continue;
    sockets.push(ws);
    const r = rand();
    try {
      if (r < 0.3) ws.send(JSON.stringify(junk()));
      else if (r < 0.45) ws.send(Buffer.from([0, 1, 2, 255]), { binary: true });
      else if (r < 0.5) ws.send('x'.repeat(3 * 1024 * 1024));
      else if (r < 0.7) ws.send('{oops');
      else ws.close();
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 800));
  for (const w of sockets) w.terminate();
  const health = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text()).catch((e) => `ERR ${e.message}`);
  if (exited != null) finding('relay', `relay exited (${exited})`, err.slice(-300));
  if (!/TabHelm relay/.test(health)) finding('relay', 'health check failed after fuzzing', health);
  // A real pair still works afterwards (from another address: the flood above
  // rightly rate-limited 127.0.0.1).
  const fresh = { headers: { 'x-forwarded-for': '10.20.30.40' } };
  const host = new WebSocket(`${base}/host?key=monkey-key-123456&name=after`, fresh);
  const code = await new Promise((res) => {
    host.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.code) res(m.code);
    });
    setTimeout(() => res(null), 3000);
  });
  if (!code) finding('relay', 'a host could not register after fuzzing');
  else {
    const client = await new Promise((res) => {
      const ws = new WebSocket(`${base}/client?code=${code}`, fresh);
      ws.on('open', () => res(ws));
      ws.on('error', () => res(null));
      setTimeout(() => res(null), 3000);
    });
    const echoed = client
      ? await new Promise((res) => {
          host.on('message', (d) => /hello-from-client/.test(String(d)) && res(true));
          client.send(JSON.stringify({ type: 'hello-from-client' }));
          setTimeout(() => res(false), 3000);
        })
      : false;
    if (!echoed) finding('relay', 'pairing / forwarding broken after fuzzing');
    client?.terminate();
  }
  host.terminate();
  relay.kill();
  console.log(`  relay: ${sockets.length} sockets, ${exited == null ? 'alive' : 'CRASHED'}`);
}

// ---------------------------------------------------------- 3 + 4. browser
const FIXTURE = `<!doctype html><title>Monkey fixture</title>
<h1>Monkey</h1><form onsubmit="event.preventDefault()"><input id=t placeholder=Name><select id=s><option>A<option>B</select>
<label><input type=checkbox id=c> agree</label><button id=b type=button onclick="this.textContent='clicked'">Button</button>
<textarea id=ta></textarea><input type=file id=f></form><a href="#x">anchor</a><div style="height:2000px">tall</div>
<iframe srcdoc="<button>inner</button>" style="width:200px;height:60px"></iframe>`;

async function monkeyBrowser() {
  const site = http.createServer((q, r) => r.writeHead(200, { 'content-type': 'text/html' }).end(FIXTURE));
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${site.address().port}/`;
  const profile = mkdtempSync(join(tmpdir(), 'tabhelm-monkey-'));
  execFileSync(process.execPath, [INSTALL, '--user-data-dir', profile], { stdio: 'ignore', env: ENV });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: profile,
    pipe: true,
    enableExtensions: [EXT],
    args: ['--no-first-run', '--use-fake-device-for-media-capture', '--use-fake-ui-for-media-capture'],
    env: ENV,
    protocolTimeout: 120_000,
  });
  const page = (await browser.pages())[0];
  await page.goto(url);
  const swT = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
  const extId = new URL(swT.url()).host;
  const sw = await swT.worker();
  const swErrors = [];
  sw.on('console', (m) => m.type() === 'error' && swErrors.push(m.text()));
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}*` }))[0].id, url);
  // Every flag on (read from features.js, so new flags are included), so
  // flagged tools and panels are exercised too.
  const featureIds = [...readFileSync(fileURLToPath(new URL('../../extension/features.js', import.meta.url)), 'utf8').matchAll(/^\s+\{ id: '(\w+)'/gm)].map((m) => m[1]).filter((id) => !(process.env.MONKEY_FLAGS_OFF || '').split(',').includes(id));
  await sw.evaluate(async (ids) => {
    await chrome.storage.local.set({ features: Object.fromEntries(ids.map((i) => [i, true])) });
  }, featureIds);

  if (ONLY.includes('tools')) {
    console.log('\n[tools] random tool calls');
    const bridge = readFileSync(fileURLToPath(new URL('../src/mcp-bridge.js', import.meta.url)), 'utf8');
    const TOOLS = [...bridge.matchAll(/^\s{2}(browser_[a-z_]+): \{/gm)].map((m) => m[1]).filter((t) => !['browser_guide', 'browser_wait', 'browser_request_human', 'browser_request_login'].includes(t));
    let hangs = 0;
    let calls = 0;
    for (let i = 0; i < STEPS; i++) {
      const tool = pick(TOOLS);
      const args = chance(0.15) ? junk() : Object.fromEntries(Array.from({ length: 1 + Math.floor(rand() * 4) }, () => [pick(['ref', 'text', 'url', 'tabId', 'x', 'y', 'key', 'keys', 'value', 'expression', 'direction', 'action', 'fields', 'refs', 'css', 'name', 'kind', 'files', 'submit', 'fullPage', 'all']), junk()]));
      if (args && typeof args === 'object' && 'tabId' in args && chance(0.7)) args.tabId = pick([tabId, undefined]);
      // Navigating away from the fixture or closing the chat tab ends the run; keep that rare.
      if (tool === 'browser_navigate' && chance(0.7)) continue;
      calls++;
      const res = await sw
        .evaluate(
          async (id, name, a) => {
            const ui = { confirm: async () => Math.random() < 0.5, ask: async () => null, onTarget() {}, resolveAsks() {}, skillsChanged() {}, guideProgress() {}, guideDone() {}, onInterjected() {} };
            const timeout = new Promise((r) => setTimeout(() => r({ hang: true }), 20_000));
            const run = self.tabhelmDebug.runTool(id, name, a, ui).then(
              (r) => ({ ok: true, shape: Array.isArray(r?.content) }),
              (e) => ({ ok: false, error: String(e?.message || e) }),
            );
            return Promise.race([run, timeout]);
          },
          tabId,
          tool,
          args ?? null,
        )
        .catch((e) => ({ evalError: e.message }));
      if (res.hang) {
        hangs++;
        finding('tools', `${tool} did not finish within 20 s`, JSON.stringify(args).slice(0, 200));
      } else if (res.evalError) finding('tools', `${tool} broke the service worker call`, res.evalError);
      else if (res.ok && !res.shape) finding('tools', `${tool} returned no content array`, JSON.stringify(args).slice(0, 200));
      else if (!res.ok && !/^Invalid arguments for/.test(res.error) && /is not a function|Cannot read prop|undefined \(reading|is not iterable|toLowerCase|null \(reading/.test(res.error)) finding('tools', `${tool}: unguarded ${res.error.slice(0, 80)}`, JSON.stringify(args).slice(0, 200));
      // Put the fixture back if a tool navigated or closed it.
      if (i % 20 === 0) {
        const t = await sw.evaluate((id) => chrome.tabs.get(id).then((x) => x.url).catch(() => null), tabId);
        if (!t) break;
        if (!t.startsWith(url)) await sw.evaluate((id, u) => chrome.tabs.update(id, { url: u }), tabId, url).catch(() => {});
      }
    }
    console.log(`  tools: ${calls} calls, ${hangs} hangs`);
  }

  if (ONLY.includes('panel')) {
    console.log('\n[panel] random UI actions');
    await sw.evaluate(() => chrome.storage.local.set({ lastAgent: 'openai-compatible' })).catch(() => {});
    const alive = await sw.evaluate((id) => chrome.tabs.get(id).then(() => true).catch(() => false), tabId);
    const chatTab = alive ? tabId : await sw.evaluate(async (u) => (await chrome.tabs.create({ url: u })).id, url);
    const panelUrl = `chrome-extension://${extId}/sidepanel.html?tabId=${chatTab}`;
    // The panel as a tab in the same window, like the real side panel (a pop-up
    // window would switch off tab groups in headless Chrome).
    await browser.defaultBrowserContext().overridePermissions(`chrome-extension://${extId}`, ['microphone', 'clipboard-read', 'clipboard-write']);
    await sw.evaluate((u) => chrome.tabs.create({ url: u, active: true }), panelUrl);
    const panel = await (await browser.waitForTarget((t) => t.url() === panelUrl)).page();
    const panelErrors = [];
    panel.on('pageerror', (e) => panelErrors.push(String(e)));
    panel.on('console', (m) => m.type() === 'error' && panelErrors.push(m.text()));
    panel.on('dialog', (d) => (chance(0.5) ? d.accept() : d.dismiss()).catch(() => {}));
    browser.on('targetcreated', async (t) => {
      // Downloads and new tabs from links/exports are fine; close stray tabs so the run stays small.
      if (t.type() === 'page' && !t.url().startsWith(`chrome-extension://${extId}/sidepanel`) && !t.url().startsWith(url)) (await t.page().catch(() => null))?.close().catch(() => {});
    });
    await panel.waitForSelector('#agent');
    // Keep the built-in mock agent selected so conversations really happen.
    await panel.waitForFunction(() => [...document.querySelectorAll('#agent option')].some((o) => o.value === 'openai-compatible' && !o.disabled), { timeout: 15000 }).catch(() => {});
    await panel.select('#agent', 'openai-compatible').catch(() => {});
    let actions = 0;
    for (let i = 0; i < STEPS; i++) {
      if (panel.isClosed()) {
        finding('panel', 'panel page closed itself');
        break;
      }
      const r = rand();
      try {
        if (r < 0.65) {
          const n = await panel.$$eval('button, summary, input[type=checkbox], [role=button]', (els) =>
            els.map((e, k) => ({ k, ok: e.offsetParent !== null && !e.disabled && !/remote-forget|delete|clear/i.test(e.id) })).filter((x) => x.ok).map((x) => x.k),
          );
          if (n.length) {
            const k = pick(n);
            await panel.$$eval('button, summary, input[type=checkbox], [role=button]', (els, idx) => els[idx]?.click(), k);
          }
        } else if (r < 0.85) {
          const inputs = await panel.$$('textarea:not([disabled]), input[type=text]:not([disabled]), input:not([type]):not([disabled]), input[type=search], input[type=url], input[type=number]');
          const vis = [];
          for (const h of inputs) if (await h.evaluate((e) => e.offsetParent !== null)) vis.push(h);
          if (vis.length) {
            const h = pick(vis);
            await h.evaluate((e) => (e.value = ''));
            await h.type(String(pick(STRINGS)).slice(0, 80), { delay: 0 });
            if (chance(0.4)) await h.press(pick(['Enter', 'Escape', 'Tab', 'ArrowDown', '/']));
          }
        } else if (r < 0.95) {
          const sels = await panel.$$('select:not([disabled]):not(#agent)');
          if (sels.length) {
            const h = pick(sels);
            const opts = await h.evaluate((e) => [...e.options].map((o) => o.value));
            if (opts.length) await h.select(pick(opts));
          }
        } else {
          const combo = pick([['Escape'], ['Enter'], ['Tab'], ['Alt', 'Shift', 'T'], ['Control', 'A'], ['Shift', 'Tab']]);
          for (const k of combo) await panel.keyboard.down(k);
          for (const k of [...combo].reverse()) await panel.keyboard.up(k);
        }
        actions++;
      } catch (err) {
        if (!/detached|Target closed|not clickable|Node is either not visible|Execution context was destroyed/.test(err.message)) finding('panel', 'puppeteer action failed', err.message);
      }
      await new Promise((x) => setTimeout(x, 30));
    }
    // Health: the panel still opens Settings and the composer still works.
    const healthy = await panel
      .evaluate(() => {
        document.getElementById('settings-open').click();
        const ok = !document.getElementById('settings').hidden;
        document.getElementById('settings-close').click();
        return ok && Boolean(document.getElementById('input'));
      })
      .catch(() => false);
    if (!healthy) finding('panel', 'panel unhealthy after the run (Settings would not open)');
    const ignore = /Failed to load resource|net::ERR_|Could not establish connection|The message port closed|favicon|Cannot reach the TabHelm host/;
    for (const e of [...new Set(panelErrors)]) if (!ignore.test(e)) finding('panel', 'error in the panel', e);
    const stats = await panel.evaluate(() => ({ user: document.querySelectorAll('.msg.user').length, agent: document.querySelectorAll('.msg.agent').length, notices: [...document.querySelectorAll('#log .notice.error')].map((n) => n.textContent).slice(-5), views: ['log', 'history', 'settings', 'report'].filter((id) => document.getElementById(id) && !document.getElementById(id).hidden) })).catch(() => ({}));
    console.log(`  panel: ${actions} actions, ${panelErrors.length} console errors, ${stats.user} sent, ${stats.agent} replies in the open chat · open view: ${stats.views?.join('+') || 'none'}`);
    if (stats.notices?.length) console.log(`  last error notices: ${stats.notices.join(' | ')}`);
  }

  const ignoreSw = /Could not establish connection|No tab with id|Cannot access contents|The message port closed|net::ERR_|Frame with ID|page script/;
  for (const e of [...new Set(swErrors)]) if (!ignoreSw.test(e)) finding('service worker', 'console error', e);
  for (const l of hostLogErrors()) finding('host (via Chrome)', 'uncaught error in host.log', l);
  await browser.close();
  site.close();
}

console.log(`Monkey test — seed ${SEED}, ${STEPS} steps per area, HOME=${HOME}`);
if (ONLY.includes('host')) await monkeyHost();
if (ONLY.includes('relay')) await monkeyRelay();
if (ONLY.includes('tools') || ONLY.includes('panel')) await monkeyBrowser();
api.close();
console.log(`\n${findings.length ? `${findings.length} finding(s):\n${findings.map((f) => `- ${f.key}${f.detail ? `\n    ${f.detail}` : ''}`).join('\n')}` : 'MONKEY PASS — no crashes, hangs or uncaught errors'}`);
console.log(`(replay with: node scripts/monkey.js ${SEED} ${STEPS})`);
process.exit(findings.length ? 1 : 0);
