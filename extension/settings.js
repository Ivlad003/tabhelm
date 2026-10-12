// Quick settings view in the side panel: skills loaded from links (nothing is
// installed) and version / update checks.

import { showNews } from './news.js';

const $ = (id) => document.getElementById(id);
const EXAMPLES = [
  { label: 'webapp-testing (Anthropic)', url: 'https://github.com/anthropics/skills/tree/main/skills/webapp-testing' },
  { label: 'brand-guidelines (Anthropic)', url: 'https://github.com/anthropics/skills/tree/main/skills/brand-guidelines' },
];

let port;
let skills = []; // { url, name, title, description, enabled }
let hostVersion = null;
let nextRequest = 1;
const pending = new Map(); // requestId -> resolve

export async function initSettings(panelPort) {
  port = panelPort;
  skills = (await chrome.storage.local.get('skills')).skills || [];

  $('settings-open').onclick = () => toggle(true);
  $('settings-close').onclick = () => toggle(false);
  $('skill-form').onsubmit = (e) => {
    e.preventDefault();
    addSkill($('skill-url').value.trim());
  };
  $('check-updates').onclick = checkUpdates;
  const examples = $('skill-examples');
  for (const ex of EXAMPLES) {
    const a = Object.assign(document.createElement('a'), { href: ex.url, textContent: ex.label });
    a.onclick = (e) => {
      e.preventDefault();
      $('skill-url').value = ex.url;
    };
    examples.append(a, document.createTextNode(' '));
  }
  render();
  renderVersion();
}

// URLs of the enabled skills; sent to the host with every session start.
export function enabledSkillUrls() {
  return skills.filter((s) => s.enabled).map((s) => s.url);
}

export function enabledSkillCount() {
  return skills.filter((s) => s.enabled).length;
}

// Messages from the host that belong to the settings view.
export function handleSettingsMessage(msg) {
  if (msg.type === 'skill_info') {
    pending.get(msg.requestId)?.(msg);
    pending.delete(msg.requestId);
    return true;
  }
  if (msg.type === 'agents' && msg.hostVersion) {
    hostVersion = msg.hostVersion;
    renderVersion();
  }
  return false;
}

export function hostVersionMismatch() {
  const mine = chrome.runtime.getManifest().version;
  return hostVersion && hostVersion !== mine ? { host: hostVersion, extension: mine } : null;
}

function toggle(open) {
  $('settings').hidden = !open;
  if (open) {
    $('history').hidden = true;
    $('history-open').setAttribute('aria-pressed', 'false');
  }
  $('log').hidden = open;
  $('settings-open').setAttribute('aria-pressed', String(open));
}

function preview(url) {
  return new Promise((resolve) => {
    const requestId = nextRequest++;
    pending.set(requestId, resolve);
    port.postMessage({ type: 'skill_preview', url, requestId });
    setTimeout(() => pending.has(requestId) && (pending.delete(requestId), resolve({ error: 'The TabHelm host did not answer.' })), 20_000);
  });
}

async function addSkill(url) {
  const error = $('skill-error');
  error.hidden = true;
  if (!url) return;
  try {
    new URL(url);
  } catch {
    return showError('That is not a valid link.');
  }
  if (skills.some((s) => s.url === url)) return showError('This skill is already in the list.');

  const button = $('skill-form').querySelector('button');
  button.disabled = true;
  button.textContent = 'Loading…';
  const info = await preview(url);
  button.disabled = false;
  button.textContent = 'Add';
  if (info.error) return showError(info.error);
  if (skills.some((s) => s.name === info.name)) return showError(`A skill named "${info.name}" is already in the list.`);

  skills.push({ url, name: info.name, title: info.title, description: info.description, enabled: true });
  $('skill-url').value = '';
  await save();

  function showError(text) {
    error.textContent = text;
    error.hidden = false;
  }
}

async function save() {
  await chrome.storage.local.set({ skills });
  render();
  // Applies to the running agent from its next message.
  port.postMessage({ type: 'set_skills', skills: enabledSkillUrls() });
}

function render() {
  const list = $('skill-list');
  list.replaceChildren(
    ...skills.map((s, i) => {
      const li = document.createElement('li');
      li.className = 'skill';
      const toggleBox = Object.assign(document.createElement('input'), { type: 'checkbox', checked: s.enabled, title: 'Enabled' });
      toggleBox.onchange = () => {
        skills[i].enabled = toggleBox.checked;
        save();
      };
      const text = document.createElement('div');
      text.className = 'skill-text';
      const name = Object.assign(document.createElement('b'), { textContent: s.title || s.name });
      const desc = Object.assign(document.createElement('div'), { className: 'skill-desc', textContent: s.description });
      const src = Object.assign(document.createElement('a'), { className: 'skill-url', href: s.url, textContent: s.url, target: '_blank' });
      text.append(name, desc, src);
      const remove = Object.assign(document.createElement('button'), { className: 'banner-close', textContent: '×', title: 'Remove' });
      remove.setAttribute('aria-label', `Remove ${s.name}`);
      remove.onclick = () => {
        skills.splice(i, 1);
        save();
      };
      li.append(toggleBox, text, remove);
      return li;
    }),
  );
  $('skills-empty').hidden = skills.length > 0;
  const count = enabledSkillCount();
  $('settings-open').textContent = count ? `Settings · ${count} skill${count > 1 ? 's' : ''}` : 'Settings';
}

function renderVersion() {
  const mine = chrome.runtime.getManifest().version;
  const mismatch = hostVersionMismatch();
  $('version-info').textContent = `Extension ${mine}${hostVersion ? ` · host ${hostVersion}` : ''}`;
  const warn = $('version-warning');
  warn.hidden = !mismatch;
  if (mismatch) {
    warn.textContent = `The native host (${mismatch.host}) and the extension (${mismatch.extension}) are different versions. Run the installer again and press ↻ for TabHelm on chrome://extensions.`;
  }
}

async function checkUpdates() {
  const out = $('update-result');
  out.textContent = 'Checking…';
  const res = await showNews($('news'), { force: true });
  if (!res.latest) out.textContent = 'Could not reach the update feed. Check your connection.';
  else if (res.newer) out.textContent = `TabHelm ${res.latest} is available — see the banner above.`;
  else out.textContent = `You have the latest version (${res.mine}).`;
}
