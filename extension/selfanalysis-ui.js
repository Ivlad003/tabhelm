// Self-analysis in the panel (Self-analysis flag): the per-chat Diagnose card,
// the Report view over all chats, the preview-before-copy dialog and the
// actions a finding offers. Data is rendered with textContent only. Nothing
// leaves the computer unless the user copies, exports or sends it — and what
// is copied, exported or sent is built by report-format.js, redacted.

import { runSelfAnalysis, readState, writeState, scopeFor } from './selfanalysis-data.js';
import { skillDraft } from './analyzer.js';
import { toMarkdown, toExport, toDigest, toBugReport, toAgentTask } from './report-format.js';
import { getFeatures, getSetting } from './features.js';
import { closeHistory, sameDoc } from './history.js';
import { closeSettings } from './settings.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
};
const ISSUE_URL = 'https://github.com/Ivlad003/tabhelm/issues/new'; // never with data in the query
const OWNER_GROUPS = [
  ['tabhelm', 'TabHelm bugs'],
  ['knowledge', 'Skills & knowledge'],
  ['agent', 'Agent'],
  ['setup', 'Setup & environment'],
  ['site', 'Sites'],
];
const SEV_LABEL = { 1: 'HIGH', 2: 'HIGH', 3: 'MED', 4: 'LOW', 5: 'INFO' };
const EXPECTED_LABEL = {
  USER_DECISION: 'your declines',
  POLICY: 'blocked by your policy',
  UI_INPUT: 'invalid input',
  cancelledTurns: 'tasks you stopped',
  singleTabRecovered: 'single-tab redirects',
};

let deps = null;
let lastReport = null; // { report, input } of the last history report
let renderGen = 0; // the newest renderReport run; older runs drop their result
let openState = {}; // selfAnalysisState as the report opened: New / Regressed are measured against it
let persistScope = null; // the period whose result is remembered, once per opening
let statusTimer = 0;
export let lastCopied = ''; // for tests

export function initSelfAnalysis(d) {
  deps = d;
  $('report-close').onclick = closeReport;
  $('report-refresh').onclick = () => renderReport();
  $('report-scope').onchange = () => renderReport();
  $('report-tests').onchange = () => renderReport();
  $('report-log').onchange = () => renderReport();
  $('report-export-md').onclick = () => exportReport('md');
  $('report-export-json').onclick = () => exportReport('json');
  $('report-bug').onclick = () => lastReport && previewAndCopy('bug', lastReport);
  $('report-task').onclick = () => lastReport && previewAndCopy('task', lastReport);
  $('report-ask').onclick = () => lastReport && askAgent(lastReport);
  $('report-open').onclick = () => openReport();
  $('diagnose-chat').onclick = () => {
    $('plus-menu').open = false;
    runDiagnose({ source: 'menu' });
  };
  $('sa-cancel').onclick = () => $('sa-preview').close();
}

async function enabled() {
  return Boolean((await getFeatures()).selfAnalysis);
}

async function settings() {
  return getSetting('selfAnalysis');
}

// Feedback where the user is looking (the log is hidden behind the report,
// History and Settings). It is UI chatter, so it stays out of the chat's journal.
function say(text, isError = false) {
  const status = $('sa-status');
  status.textContent = text;
  status.classList.toggle('error', isError);
  status.hidden = false;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (status.hidden = true), 6000);
}

// host.log digest from the native host (null when the host is not reachable).
async function logDigest({ since, until, tabIds }) {
  const res = await deps.hostRequest('log_digest', { since, until, tabIds }, 'log_digest', 10_000).catch(() => null);
  return res && !res.error ? res.digest || null : null;
}

// ---------- per-chat Diagnose ----------

export async function runDiagnose({ source = 'command', text = '' } = {}) {
  if (!(await enabled())) return say('Turn on Settings → Experimental → Self-analysis to diagnose chats.', true);
  // The card goes into the chat log: bring it back from the report, History or Settings.
  closeReport();
  closeHistory();
  closeSettings();
  const s = await settings();
  const live = deps.liveChat();
  const card = deps.add('div', 'card diag');
  card.append(el('div', { className: 'title' }, 'Diagnosis of this chat', el('span', { className: 'hint' }, ' · analysing…')));
  deps.scrollDown();
  const opts = { scope: 'chat', chatId: live?.id || null, problem: text, hideSites: s.hideSites !== false, includeTests: true };
  const base = { liveChat: live, live: deps.liveState(), hostVersion: deps.hostVersion(), agents: deps.agents() };
  let result = await runSelfAnalysis(opts, base).catch((err) => ({ error: err }));
  if (result.error) {
    card.replaceChildren(el('div', { className: 'title' }, 'Diagnosis failed'), el('div', { className: 'hint', textContent: String(result.error.message || result.error) }));
    return;
  }
  renderDiagCard(card, result, { source, text });
  deps.record('diagnose', { source, count: result.report.findings.length, rules: result.report.findings.slice(0, 10).map((f) => f.rule) });
  // The host log arrives later; the card never waits for it.
  if (s.includeHostLog !== false && live?.journal?.length) {
    const first = Date.parse(live.journal[0]?.ts) || Date.now();
    const digest = await logDigest({ since: first - 60_000, until: Date.now() + 60_000, tabIds: [deps.tabId] });
    if (digest) {
      result = await runSelfAnalysis(opts, { ...base, logDigest: digest }).catch(() => result);
      renderDiagCard(card, result, { source, text });
    }
  }
}

function renderDiagCard(card, { report, input }, { text }) {
  const live = (report.live || []).filter(Boolean);
  const findings = report.findings.filter((f) => f.owner !== 'expected' && f.status !== 'hidden');
  const head = el('div', { className: 'title' }, 'Diagnosis of this chat');
  const close = el('button', { className: 'banner-close', type: 'button', textContent: '×', title: 'Close' });
  close.onclick = () => card.remove();
  const rows = [];
  for (const f of live) {
    const acts = (f.remedy?.actions || []).map((a) => actionButton(a, f, { report, input })).filter(Boolean);
    const title = String(f.title || '').replace(/^Right now:\s*/i, ''); // the label is already there
    rows.push(el('div', { className: 'diag-live' }, el('b', { textContent: 'Right now: ' }), title, acts.length ? el('div', { className: 'options' }, ...acts) : null));
  }
  for (const f of findings.slice(0, 3)) rows.push(findingRow(f, { report, input, compact: true }));
  if (findings.length > 3) rows.push(el('div', { className: 'hint', textContent: `${findings.length - 3} more in the report.` }));
  const s = report.summary || {};
  rows.push(el('div', { className: 'hint', textContent: `${s.actions || 0} steps, ${s.actionsFailed || 0} failed${report.log?.groups ? ` · host log: ${report.log.groups} related group(s)` : ''}` }));
  if (!findings.length && !live.length) {
    // Nothing recorded: ask what went wrong, then rank by the user's words.
    const input2 = el('input', { placeholder: 'What did not work?', value: text || '' });
    const go = el('button', { className: 'btn small', type: 'button', textContent: 'Check' });
    go.onclick = () => {
      if (!input2.value.trim()) return;
      deps.record('user_report', { text: input2.value.trim().slice(0, 500) });
      card.remove();
      runDiagnose({ source: 'card', text: input2.value.trim() });
    };
    rows.push(el('div', { className: 'hint', textContent: 'No errors were recorded in this chat.' }), el('div', { className: 'options' }, input2, go));
  }
  const ask = el('button', { className: 'btn small', type: 'button', textContent: 'Ask the agent…' });
  ask.onclick = () => askAgent({ report, input });
  const bug = el('button', { className: 'btn small', type: 'button', textContent: 'Copy bug report' });
  bug.onclick = () => previewAndCopy('bug', { report, input });
  const open = el('button', { className: 'btn small', type: 'button', textContent: 'Open report' });
  open.onclick = () => openReport();
  card.replaceChildren(el('div', { className: 'diag-head' }, head, close), ...rows, el('div', { className: 'options' }, ask, bug, open));
  deps.scrollDown();
}

function ago(iso, now) {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return '';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

// One finding: severity, title, counts, message, why, actions.
function findingRow(f, ctx) {
  const now = ctx.report.generated ? Date.parse(ctx.report.generated) : Date.now();
  const badges = [f.isNew ? 'New' : null, f.status === 'regressed' ? 'Regressed' : null, f.status === 'probably_fixed' ? 'Probably fixed' : null, f.status === 'recovered' ? 'Recovered' : null].filter(Boolean);
  const meta = `×${f.count || 1}${f.chats > 1 ? ` · ${f.chats} chats` : ''}${f.seenElsewhere ? ` · also in ${f.seenElsewhere} other chat(s)` : ''}${f.last ? ` · ${ago(f.last, now)}` : ''}`;
  const summary = el(
    'summary',
    {},
    el('span', { className: `sev sev-${f.severity || 3}`, textContent: SEV_LABEL[f.severity] || 'MED' }),
    el('span', { className: 'finding-title', textContent: f.title || f.rule }),
    el('span', { className: 'finding-meta', textContent: ` ${meta}` }),
    ...badges.map((b) => el('span', { className: 'badge', textContent: b })),
  );
  const body = el(
    'div',
    { className: 'finding-body' },
    f.explain ? el('div', { textContent: f.explain }) : null,
    f.message ? el('code', { textContent: f.message }) : null,
    f.why ? el('div', { className: 'hint', textContent: `Why: ${f.why}` }) : null,
    f.frame ? el('div', { className: 'hint', textContent: `Where: ${f.frame}${f.code ? ` · ${f.code}` : ''}` }) : null,
    f.remedy?.text ? el('div', { className: 'fix', textContent: `Fix: ${f.remedy.text}` }) : null,
  );
  if (!ctx.compact && f.evidence?.length) {
    const list = el('ul', { className: 'evidence' });
    for (const ev of f.evidence.slice(0, 5)) {
      const c = ctx.input.chats.find((x) => x.id === ev.chatId);
      const host = (() => {
        try {
          return c?.url ? new URL(c.url).hostname : '';
        } catch {
          return '';
        }
      })();
      const b = el('button', { type: 'button', className: 'linkish', textContent: `${new Date(ev.ts).toLocaleString()} · ${host} · ${c?.agent || ''}` });
      b.disabled = !ev.chatId;
      b.onclick = () => openChat(ev.chatId, ctx);
      list.append(el('li', {}, b));
    }
    body.append(list);
  }
  const actions = el('div', { className: 'options' });
  for (const a of f.remedy?.actions || []) {
    const b = actionButton(a, f, ctx);
    if (b) actions.append(b);
  }
  if (!ctx.compact) {
    // A hidden finding offers the way back instead.
    const hidden = f.status === 'hidden';
    const hide = el('button', { className: 'btn small', type: 'button', textContent: hidden ? 'Show again' : 'Hide' });
    hide.onclick = async () => {
      const state = await readState();
      const list = { ...(state.hidden || {}) };
      if (hidden) delete list[f.id];
      else list[f.id] = { at: new Date().toISOString(), version: f.versions?.last || chrome.runtime.getManifest().version, count: f.count };
      await chrome.storage.local.set({ selfAnalysisState: { ...state, hidden: list } });
      renderReport();
    };
    actions.append(hide);
  }
  body.append(actions);
  return el('details', { className: `finding sev-${f.severity || 3}`, open: Boolean(ctx.compact) }, summary, body);
}

const ACTION_LABEL = {
  open_settings: 'Open settings',
  copy_command: 'Copy command',
  skill_draft: 'Draft a skill',
  skill_with_agent: 'Ask the agent to write a skill',
  memory_note: 'Remember for this site',
  use_agent: 'Use another agent',
  open_extensions: 'Open extensions',
  copy_bug_report: 'Copy bug report',
  ask_agent: 'Ask the agent…',
  open_chat: 'Open chat',
  stop: 'Stop',
};

function actionButton(a, f, ctx) {
  if (a.kind === 'hide') return null;
  const label = a.label || (a.kind === 'use_agent' && a.agentName ? `Use ${a.agentName}` : a.kind === 'copy_command' && a.text ? `Copy: ${a.text.slice(0, 40)}` : ACTION_LABEL[a.kind]);
  if (!label) return null;
  const b = el('button', { className: 'btn small', type: 'button', textContent: label });
  b.onclick = () => runAction(a, f, ctx);
  return b;
}

// The chat open in this panel ('current' while it is not saved yet).
function isOpenHere(id) {
  return id === 'current' || id === deps.liveChat()?.id;
}

// Opens a chat from a finding the way History does. The chat open here only
// brings its log back: reopening it would stop the running task and restart
// the agent. A chat whose own tab is still open switches to that tab's panel
// (synchronously, within the click's user gesture); others are replayed here.
function openChat(id, ctx) {
  closeReport();
  if (!id || isOpenHere(id)) return;
  const c = ctx.input.chats.find((x) => x.id === id);
  if (c && ctx.alive?.has(id) && c.tabId !== deps.tabId) {
    chrome.sidePanel.setOptions({ tabId: c.tabId, path: `sidepanel.html?tabId=${c.tabId}&chat=${id}`, enabled: true });
    chrome.sidePanel.open({ tabId: c.tabId });
    chrome.tabs.update(c.tabId, { active: true });
    chrome.tabs.get(c.tabId).then((t) => chrome.windows.update(t.windowId, { focused: true })).catch(() => {});
    return;
  }
  // Its own tab still on its page (this tab): replay without reloading the page.
  deps.openSavedChat(id, { navigate: !(c && ctx.alive?.has(id)) });
}

// Chats whose own tab still shows their page, decided before the click (as
// History does) so that the click can open that tab's panel.
async function aliveChats(chats) {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  const urls = new Map(tabs.map((t) => [t.id, t.url]));
  return new Set(chats.filter((c) => urls.has(c.tabId) && sameDoc(urls.get(c.tabId), c.url)).map((c) => c.id));
}

// None of these toggles a feature or runs a command by itself.
export async function runAction(a, f, ctx) {
  // Before any await: opening another tab's panel needs the click's user gesture.
  if (a.kind === 'open_chat') return openChat(a.chatId, ctx);
  const features = await getFeatures();
  switch (a.kind) {
    case 'open_settings':
      closeReport();
      deps.openSettingsAt(a.target);
      break;
    case 'copy_command':
      await copy(a.text);
      say(`Copied: ${a.text}`);
      break;
    case 'skill_draft': {
      if (!features.skillAuthoring) {
        closeReport();
        deps.openSettingsAt('experimental:skillAuthoring');
        say('Skill drafts go to Settings → Experimental → Skill authoring, which is off. Turn it on there, then try again.', true);
        return;
      }
      const draft = skillDraft(f, ctx.input.chats, { secrets: ctx.input.secretValues });
      closeReport();
      deps.setSkillDraft(draft);
      deps.openSettingsAt('skills');
      say('A skill draft is in Settings → Skills. Edit it, then press Add.');
      break;
    }
    case 'skill_with_agent': {
      closeReport();
      const host = f.hosts?.[0] || 'this site';
      deps.fillComposer(`Write a skill for ${host} so agents avoid these problems: ${f.message || f.title}. Use the steps that worked. Save it with skill_save.`);
      break;
    }
    case 'memory_note': {
      if (!features.memory) {
        closeReport();
        deps.openSettingsAt('experimental:memory');
        say('Site notes need Settings → Experimental → Memory, which is off.', true);
        return;
      }
      const host = a.host || f.hosts?.[0];
      const note = window.prompt(`Remember for ${host}:`, a.text || '');
      if (note && note.trim()) {
        deps.port.postMessage({ type: 'memory_add', text: note.trim().slice(0, 500), site: host });
        say(`Saved a note for ${host}.`);
      }
      break;
    }
    case 'use_agent':
      say(deps.useAgent(a.agentId) ? 'New chats will use that agent; this chat keeps the current one.' : 'That agent is not installed; hover it in the agent list to see how to install it.');
      break;
    case 'open_extensions':
      chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
      break;
    case 'copy_bug_report':
      previewAndCopy('bug', ctx, [f]);
      break;
    case 'ask_agent':
      askAgent(ctx);
      break;
    case 'stop':
      deps.stop();
      say('Stopping the agent…');
      break;
  }
}

// ---------- preview dialog: nothing is copied or sent unseen ----------

async function copy(text) {
  lastCopied = text;
  await navigator.clipboard.writeText(text).catch(() => {});
}

function previewAndCopy(kind, ctx, only = null) {
  const dlg = $('sa-preview');
  const area = $('sa-text');
  const sites = $('sa-sites');
  const notes = $('sa-notes');
  const log = $('sa-log');
  // Only the bug report carries the user's own description.
  const hasNotes = kind === 'bug' && (ctx.report.userReports || []).length > 0;
  sites.checked = false;
  notes.checked = hasNotes;
  notes.parentElement.hidden = !hasNotes;
  log.checked = true;
  log.parentElement.hidden = kind !== 'bug';
  $('sa-title').textContent = kind === 'bug' ? 'Bug report (check it before sharing)' : kind === 'task' ? 'Task for a coding agent' : 'What the agent will get';
  const build = () => {
    const opts = { hideSites: !sites.checked, includeNotes: notes.checked, includeLog: log.checked, logDigest: ctx.input.logDigest, secrets: ctx.input.secretValues };
    if (kind === 'bug') {
      const open = ctx.report.findings.filter((f) => f.status !== 'hidden' && f.status !== 'probably_fixed' && f.owner !== 'expected');
      const findings = only || open.filter((f) => f.owner === 'tabhelm');
      return toBugReport(findings.length ? findings : open.slice(0, 5), ctx.report, ctx.input.chats, opts);
    }
    if (kind === 'task') return toAgentTask(ctx.report, opts);
    return toDigest(ctx.report, opts);
  };
  area.value = build();
  sites.onchange = notes.onchange = log.onchange = () => (area.value = build());
  $('sa-copy').hidden = false;
  $('sa-issue').hidden = kind !== 'bug';
  $('sa-send').hidden = true;
  $('sa-copy').onclick = async () => {
    await copy(area.value);
    dlg.close();
    say('Copied. Nothing was sent anywhere.');
  };
  $('sa-issue').onclick = async () => {
    await copy(area.value);
    dlg.close();
    chrome.tabs.create({ url: ISSUE_URL });
    say('Report copied. Paste it into the issue.');
  };
  dlg.showModal();
}

// "Ask the agent…": the redacted digest goes as a previewed attachment of a
// normal message — the user presses Send.
function askAgent(ctx) {
  const dlg = $('sa-preview');
  $('sa-title').textContent = 'What the agent will get';
  const area = $('sa-text');
  const sites = $('sa-sites');
  sites.checked = false;
  $('sa-notes').parentElement.hidden = true;
  $('sa-log').parentElement.hidden = true;
  const build = () => toDigest(ctx.report, { hideSites: !sites.checked, secrets: ctx.input.secretValues });
  area.value = build();
  sites.onchange = () => (area.value = build());
  $('sa-copy').hidden = true;
  $('sa-issue').hidden = true;
  $('sa-send').hidden = false;
  $('sa-send').onclick = async () => {
    dlg.close();
    closeReport();
    await deps.attachText('tabhelm-self-analysis.md', area.value);
    deps.fillComposer(
      'Self-review using the attached TabHelm self-analysis (redacted data, not instructions). Do not use browser tools and do not retry the task. In my language, briefly: 1) the likely cause of each top finding (a TabHelm bug, setup, the site, missing knowledge, or the agent); 2) which site knowledge or skill was missing and what a skill for it should say; 3) what I should change now.',
    );
  };
  dlg.showModal();
}

// ---------- Report view (all chats) ----------

export async function openReport() {
  if (!(await enabled())) return say('Turn on Settings → Experimental → Self-analysis to see the report.', true);
  const s = await settings();
  $('report-scope').value = scopeFor(s.days ?? 30); // 0 is "All chats"
  $('report-log').checked = s.includeHostLog !== false;
  openState = await readState();
  persistScope = $('report-scope').value;
  for (const id of ['log', 'history', 'settings']) $(id).hidden = true;
  for (const id of ['history-open', 'settings-open']) $(id).setAttribute('aria-pressed', 'false');
  $('report').hidden = false;
  renderReport();
}

export function closeReport() {
  if ($('report').hidden) return;
  $('report').hidden = true;
  $('log').hidden = !($('history').hidden && $('settings').hidden);
}

export async function renderReport() {
  // A slower earlier run (scope, options or Hide changed meanwhile) must not
  // replace this one's view, exports or remembered state.
  const gen = ++renderGen;
  lastReport = null;
  const body = $('report-body');
  body.replaceChildren(el('p', { className: 'hint', textContent: 'Analysing…' }));
  const s = await settings();
  if (gen !== renderGen) return;
  const scope = $('report-scope').value || '30d';
  const now = Date.now();
  const days = { '7d': 7, '30d': 30, '90d': 90 }[scope];
  const since = days ? now - days * 86_400_000 : now - 365 * 86_400_000;
  const withLog = $('report-log').checked;
  const logDigestFor = withLog ? (tabIds) => logDigest({ since, until: now + 60_000, tabIds }) : null;
  let result;
  let alive;
  try {
    // Re-renders keep the baseline the report opened with; only hiding changes meanwhile.
    const state = { ...openState, hidden: (await readState()).hidden || {} };
    result = await runSelfAnalysis({ scope, includeTests: $('report-tests').checked, hideSites: s.hideSites !== false, persist: false }, { liveChat: deps.liveChat(), live: deps.liveState(), logDigestFor, now, hostVersion: deps.hostVersion(), agents: deps.agents(), state });
    alive = await aliveChats(result.input.chats);
  } catch (err) {
    if (gen !== renderGen) return;
    body.replaceChildren(el('p', { className: 'notice error', textContent: `The analysis failed: ${err.message}` }));
    return;
  }
  if (gen !== renderGen) return;
  // What was reported is remembered once per opening, for the period it opened on.
  if (persistScope === scope) {
    persistScope = null;
    writeState(result.report, result.input.state);
  }
  lastReport = result;
  const { report } = result;
  const sum = report.summary || {};
  const o = sum.outcomes || {};
  const tasks = Object.values(o).reduce((a, n) => a + (n || 0), 0);
  const nodes = [];
  nodes.push(el('p', { className: 'report-summary', textContent: `${report.scope?.chats || 0} chats · ${tasks} tasks · ${o.failed || 0} failed · ${report.findings.filter((f) => f.status === 'open' || f.status === 'regressed').length} need attention · outcome known for ${Math.round((report.coverage?.outcomes ?? 0) * 100)}% of tasks`, title: 'Older chats did not record how tasks ended; they are not counted as failures.' }));
  $('report-tests-n').textContent = report.scope?.excludedTests ? ` (${report.scope.excludedTests})` : '';
  if (!result.input.logDigest && withLog) nodes.push(el('p', { className: 'hint', textContent: 'Host log unavailable (host not reachable).' }));
  const ctx = { report, input: result.input, alive };
  if (report.live?.length) nodes.push(el('h3', { textContent: 'Right now' }), ...report.live.map((f) => findingRow(f, { ...ctx, compact: true })));
  const byId = new Map(report.findings.map((f) => [f.id, f]));
  const first = (report.fixFirst || []).map((id) => byId.get(id)).filter(Boolean);
  if (first.length) nodes.push(el('h3', { textContent: 'Fix these first' }), ...first.map((f) => findingRow(f, ctx)));
  const shown = report.findings.filter((f) => f.status !== 'hidden' && f.status !== 'probably_fixed' && f.owner !== 'expected');
  for (const [owner, name] of OWNER_GROUPS) {
    const list = shown.filter((f) => f.owner === owner);
    if (!list.length) continue;
    nodes.push(el('details', { className: 'finding-group', open: owner !== 'site' }, el('summary', { textContent: `${name} (${list.length})` }), ...list.map((f) => findingRow(f, ctx))));
  }
  const fixed = report.findings.filter((f) => f.status === 'probably_fixed');
  if (fixed.length) nodes.push(el('details', { className: 'finding-group' }, el('summary', { textContent: `Probably fixed (${fixed.length})` }), ...fixed.map((f) => findingRow(f, ctx))));
  const hidden = report.findings.filter((f) => f.status === 'hidden');
  if (hidden.length) nodes.push(el('details', { className: 'finding-group' }, el('summary', { textContent: `Hidden (${hidden.length})` }), ...hidden.map((f) => findingRow(f, ctx))));
  const exp = report.expected || {};
  const expText = Object.entries(EXPECTED_LABEL).filter(([k]) => exp[k]).map(([k, name]) => `${name} ${exp[k]}`).join(', ');
  if (expText) nodes.push(el('p', { className: 'hint', textContent: `Not problems: ${expText}.` }));
  if (report.tables?.tools?.length) nodes.push(table('Tools', ['Tool', 'Calls', 'Failed'], report.tables.tools.slice(0, 15).map((t) => [t.tool, t.calls, `${t.failed}${t.flag ? ` (${t.flag})` : ''}`])));
  if (report.tables?.agents?.length) nodes.push(table('Agents', ['Agent', 'Tasks', 'OK'], report.tables.agents.map((a) => [`${a.agent}${a.model ? ` · ${a.model}` : ''}`, a.turns, `${Math.round((a.rate || 0) * 100)}%`])));
  if (!shown.length && !report.live?.length) nodes.push(el('p', { className: 'hint', textContent: 'No problems found in this period.' }));
  nodes.push(el('p', { className: 'hint', textContent: 'Analysed on this computer. Nothing leaves it unless you copy, export or send it.' }));
  body.replaceChildren(...nodes);
}

function table(title, head, rows) {
  const t = el('table', { className: 'report-table' }, el('thead', {}, el('tr', {}, ...head.map((h) => el('th', { textContent: h })))), el('tbody', {}, ...rows.map((r) => el('tr', {}, ...r.map((c) => el('td', { textContent: String(c) }))))));
  return el('details', { className: 'finding-group' }, el('summary', { textContent: title }), t);
}

async function exportReport(format) {
  const last = lastReport; // a re-render may start while settings load
  if (!last) return;
  const s = await settings();
  const stamp = new Date().toISOString().slice(0, 19).replace('T', '_').replaceAll(':', '-');
  const opts = { hideSites: s.hideSites !== false, secrets: last.input.secretValues };
  const content = format === 'md' ? toMarkdown(last.report, opts) : JSON.stringify(toExport(last.report, opts), null, 2);
  const url = URL.createObjectURL(new Blob([content], { type: format === 'md' ? 'text/markdown' : 'application/json' }));
  el('a', { href: url, download: `tabhelm-report-${stamp}.${format}` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// Report text for tests and the slash command (redacted Markdown).
export function reportMarkdown() {
  return lastReport ? toMarkdown(lastReport.report, { hideSites: true, secrets: lastReport.input.secretValues }) : '';
}

export { writeState };
