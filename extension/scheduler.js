// Scheduled tasks: a chrome.alarms entry per schedule; when it fires, the task
// runs in a background tab without a panel, every tool call is auto-approved
// only if the schedule says so, the result is saved to History and the user is
// notified. The chat can then be opened from History like any other.

import { getSetting, setSetting } from './features.js';
import { saveChat, newChatId } from './history.js';

export const SCHEDULE_PREFIX = 'tabhelm-schedule:';
const RUN_TIMEOUT_MS = 15 * 60_000;

export async function syncAlarms() {
  const { items } = await getSetting('schedules');
  const existing = await chrome.alarms.getAll();
  for (const a of existing) if (a.name.startsWith(SCHEDULE_PREFIX) && !items.some((s) => s.enabled && `${SCHEDULE_PREFIX}${s.id}` === a.name)) await chrome.alarms.clear(a.name);
  for (const s of items) {
    if (!s.enabled) continue;
    const name = `${SCHEDULE_PREFIX}${s.id}`;
    const have = existing.find((a) => a.name === name);
    if (have && have.periodInMinutes === s.everyMinutes) continue;
    await chrome.alarms.create(name, { periodInMinutes: Math.max(1, s.everyMinutes), delayInMinutes: Math.max(1, s.everyMinutes) });
  }
}

export async function runScheduled(id, { runners, send, release, notify }) {
  const { items } = await getSetting('schedules');
  const s = items.find((x) => x.id === id);
  if (!s || !s.enabled) return;

  // Background tab in the current window; the user keeps working.
  const tab = await chrome.tabs.create({ url: s.url, active: false });
  const tabId = tab.id;
  const journal = [];
  const record = (type, data) => journal.push({ ts: new Date().toISOString(), type, ...data });
  let answer = '';
  let finished;
  const done = new Promise((r) => (finished = r));

  runners.set(tabId, (msg) => {
    switch (msg.type) {
      case 'status':
        if (msg.state === 'ready') {
          record('agent_connected', { agent: msg.agent.name });
          send(tabId, { type: 'prompt', text: s.prompt, context: null, attachments: [] });
          record('user', { text: s.prompt });
        } else if (msg.state === 'stopped') finished({ failure: msg.detail || 'agent stopped' });
        break;
      case 'update':
        if (msg.update.kind === 'agent_message_chunk') answer += msg.update.text;
        break;
      case 'tool_activity':
        record('action', { agent: s.agentName, tool: msg.tool, args: msg.args, desc: `${msg.tool.replace(/^browser_/, '')} ${msg.label || ''}`.trim(), ok: msg.ok, error: msg.error });
        break;
      case 'auth':
        finished({ failure: 'the agent needs you to sign in' });
        break;
      case 'done':
        finished({ stopReason: msg.stopReason });
        break;
      case 'error':
        finished({ failure: msg.message });
        break;
      case 'host_disconnected':
        finished({ failure: 'host disconnected' });
        break;
    }
  });

  await new Promise((r) => setTimeout(r, 1500)); // let the page start loading
  send(tabId, { type: 'start', agentId: s.agentId, autoApprove: Boolean(s.autoApprove), skills: s.skills || [], folder: s.folder || null });

  const result = await Promise.race([done, new Promise((r) => setTimeout(() => r({ failure: 'timed out after 15 minutes' }), RUN_TIMEOUT_MS))]);
  runners.delete(tabId);
  record('agent', { agent: s.agentName, text: answer.trim(), failure: result.failure || null, stats: null });
  record('notice', { text: `Scheduled run of "${s.name}"${result.failure ? ` failed: ${result.failure}` : ' finished'}`, error: Boolean(result.failure) });

  const page = await chrome.tabs.get(tabId).catch(() => null);
  await saveChat({ id: newChatId(), created: Date.now(), tabId, url: page?.url || s.url, pageTitle: page?.title || s.name, agent: s.agentName, folder: s.folder || null, journal });
  const { items: latest } = await getSetting('schedules');
  await setSetting('schedules', { items: latest.map((x) => (x.id === id ? { ...x, lastRun: Date.now(), lastResult: result.failure ? `failed: ${result.failure}` : answer.trim().slice(0, 200) } : x)) });
  await notify(tabId, result.failure ? 'failed' : 'done', `${s.name}: ${result.failure || answer.trim().slice(0, 100) || 'finished'}`);
  release(tabId);
  if (s.closeTab !== false) chrome.tabs.remove(tabId).catch(() => {});
}
