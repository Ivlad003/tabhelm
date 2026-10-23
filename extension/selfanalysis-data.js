// Self-analysis I/O (Self-analysis flag): reads saved chats and diagnostics from
// chrome.storage, runs the pure analyzer and keeps its small state. No DOM, so
// the service worker uses it too (the agent's tabhelm_diagnose tool).
// Everything here stays on this computer; only renderers in report-format.js
// produce text that may leave it, and only redacted.

import { analyze, nextState } from './analyzer.js';
import { toDigest } from './report-format.js';
import { hostOf } from './redact.js';
import { getFeatures, getSetting } from './features.js';

const DAY = 86_400_000;
const SCOPE_DAYS = { '7d': 7, '30d': 30, '90d': 90 };
const BATCH = 25;

export function scopeFor(days) {
  return { 7: '7d', 30: '30d', 90: '90d' }[days] || 'all';
}

// Values of the user's named secrets, used only to redact them out of messages.
export async function loadSecretValues() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k, v]) => k.startsWith('secret:') && typeof v === 'string' && v.length >= 4)
    .map(([, v]) => v);
}

export async function readState() {
  return (await chrome.storage.local.get('selfAnalysisState')).selfAnalysisState || {};
}

export async function writeState(report, prev) {
  try {
    await chrome.storage.local.set({ selfAnalysisState: nextState(report, prev) });
  } catch {}
}

async function enabledSkills() {
  const { skills = [], authoredSkills = [] } = await chrome.storage.local.get(['skills', 'authoredSkills']);
  return [...skills, ...authoredSkills].filter((s) => s.enabled !== false).map((s) => ({ name: s.name, desc: String(s.description || '').slice(0, 300) }));
}

// Collects the analyzer input. `liveChat` (the panel's in-memory chat) replaces
// its stored copy, which may lag a few hundred milliseconds behind. `state`
// replaces the stored selfAnalysisState (the report keeps its New / Regressed
// baseline while it is open).
export async function collectInput({ scope = '30d', chatId = null, includeTests = false, problem = '', hideSites = true } = {}, { liveChat = null, live = null, logDigest = null, now = Date.now(), hostVersion = null, agents = [], state = null } = {}) {
  const store = await chrome.storage.local.get(['chatIndex', 'swErrors', 'versionHistory', 'selfAnalysisState']);
  const index = store.chatIndex || [];
  const from = SCOPE_DAYS[scope] ? now - SCOPE_DAYS[scope] * DAY : 0;
  const ids = scope === 'chat' ? (chatId ? [chatId] : []) : index.filter((c) => (c.updated || c.created || 0) >= from).map((c) => c.id);
  const chats = [];
  const sizes = {};
  for (let i = 0; i < ids.length; i += BATCH) {
    const keys = ids.slice(i, i + BATCH).map((id) => `chat:${id}`);
    const got = await chrome.storage.local.get(keys);
    for (const k of keys) {
      const c = got[k];
      if (!c?.journal) continue;
      const meta = index.find((m) => m.id === c.id) || {};
      sizes[c.id] = JSON.stringify(c).length;
      chats.push({ id: c.id, created: c.created, updated: c.updated || meta.updated, url: c.url ?? meta.url, tabId: c.tabId ?? meta.tabId, agent: c.agent ?? meta.agent, folder: c.folder ?? meta.folder, test: Boolean(c.test || meta.test), scheduled: Boolean(c.scheduled || meta.scheduled), journal: c.journal });
    }
  }
  // The panel's busy state is about its own chat (the analyzer's running turn).
  if (live && liveChat?.id && live.chatId == null) live = { ...live, chatId: liveChat.id };
  if (liveChat?.id && liveChat.journal) {
    const i = chats.findIndex((c) => c.id === liveChat.id);
    const merged = { ...(i >= 0 ? chats[i] : {}), ...liveChat };
    if (i >= 0) chats[i] = merged;
    else if (scope === 'chat') chats.push(merged);
  } else if (scope === 'chat' && liveChat?.journal) {
    chats.push({ id: 'current', ...liveChat }); // a chat not saved yet (no message sent)
  }
  // Ids present in storage, for the index/storage invariant (whole history only).
  let storageIds = null;
  if (scope !== 'chat') {
    const keys = chrome.storage.local.getKeys ? await chrome.storage.local.getKeys() : Object.keys(await chrome.storage.local.get(null));
    storageIds = keys.filter((k) => k.startsWith('chat:')).map((k) => k.slice(5));
  }
  const features = await getFeatures();
  return {
    chats,
    index,
    storageIds,
    sizes,
    logDigest,
    swErrors: store.swErrors || [],
    versionHistory: store.versionHistory || [],
    state: state || store.selfAnalysisState || {},
    live,
    skills: await enabledSkills(),
    env: {
      ext: chrome.runtime.getManifest().version,
      host: hostVersion,
      chrome: (/Chrome\/([\d.]+)/.exec(globalThis.navigator?.userAgent || '') || [])[1] || null,
      platform: globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || null,
      features: Object.keys(features).filter((k) => features[k]),
      agents,
    },
    now,
    options: { scope, chatId, includeTests, problem: String(problem || '').slice(0, 300), hideSites },
    secretValues: await loadSecretValues(),
  };
}

// Runs the whole analysis. History scopes remember what was reported (for
// "new" / "regressed" / hidden findings) unless `opts.persist` is false; the
// per-chat card never does. `logDigestFor(tabIds)` fetches the host.log digest
// once the chats in scope, and so their tabs, are known.
export async function runSelfAnalysis(opts, deps = {}) {
  const input = await collectInput(opts, deps);
  if (!input.logDigest && deps.logDigestFor) {
    const tabIds = [...new Set(input.chats.map((c) => c.tabId).filter(Number.isInteger))].slice(-200);
    input.logDigest = await deps.logDigestFor(tabIds).catch(() => null);
  }
  const report = analyze(input);
  if (opts.scope !== 'chat' && opts.persist !== false) await writeState(report, input.state);
  return { report, input };
}

// The agent's tabhelm_diagnose tool (service worker). The agent only ever gets
// the redacted digest; other chats need the user's explicit, non-routine OK.
export async function diagnoseTool(chatTabId, args, ui) {
  const features = await getFeatures();
  const settings = await getSetting('selfAnalysis');
  if (!features.selfAnalysis || settings.agentTool === false) throw new Error('This tool needs the "Self-analysis" feature, which is off. The user can enable it in TabHelm → Settings → Experimental.');
  const scope = args?.scope === 'recent' ? '7d' : 'chat';
  const panel = ui.liveChat ? await ui.liveChat(chatTabId).catch(() => null) : null;
  const liveChat = panel?.chat || null;
  const chatId = liveChat?.id || (await chrome.storage.session.get(`activeChat:${chatTabId}`))[`activeChat:${chatTabId}`] || null;
  const now = Date.now();
  const chat = liveChat || (chatId ? (await chrome.storage.local.get(`chat:${chatId}`))[`chat:${chatId}`] : null);
  // The agent is mid-task while it calls this tool: its running turn has no
  // outcome yet, which is not a lost one.
  const live = { busy: true, chatId };
  const input = await collectInput({ scope, chatId, problem: args?.problem || '', hideSites: settings.hideSites !== false }, { liveChat, live, now, hostVersion: panel?.hostVersion || null, agents: panel?.agents || [] });
  if (settings.includeHostLog !== false && ui.logDigest) {
    const since = scope === 'chat' ? (Number(chat?.created) || now - DAY) - 60_000 : now - 7 * DAY;
    const tabIds = scope === 'chat' ? [chatTabId] : [...new Set(input.chats.map((c) => c.tabId).filter(Number.isInteger))].slice(-200);
    input.logDigest = await ui.logDigest({ chatTabId, since, until: now + 60_000, tabIds }).catch(() => null);
  }
  const report = analyze(input);
  // The site this chat works on stays readable for the agent; other sites are aliased.
  const tabUrl = (await chrome.tabs.get(chatTabId).catch(() => null))?.url;
  const keepHost = scope === 'chat' ? hostOf(chat?.url || tabUrl || '') : null;
  const digest = toDigest(report, { hideSites: settings.hideSites !== false, keepHost, secrets: input.secretValues });
  if (scope !== 'chat') {
    const ok = await ui.confirm(chatTabId, 'Share a self-check of your last 7 days of chats with the agent?', digest.slice(0, 600));
    if (!ok) throw new Error('The user declined sharing the self-check of other chats.');
  }
  return { content: [{ type: 'text', text: digest }], label: scope === 'chat' ? 'this chat' : 'last 7 days' };
}
