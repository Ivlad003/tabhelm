// Quick settings view in the side panel: skills loaded from links (nothing is
// installed) and version / update checks.

import { showNews } from './news.js';
import { initExperimental, handleExperimentalMessage, authoredSkills, setAgentsForSchedules, refreshExperimental } from './experimental.js';

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
let skillsEdited = false; // the user changed the skill list in this panel
let skillWrites = 0; // saves of the skill list still in flight

// Every chat tab has its own side panel, each with its own copy of Settings.
// A bound control saves to its storage key on change, follows changes made in
// other panels, and is never reset by the value read while the panel loads
// once the user has changed it (that reset used to turn Auto-play guides off).
const settingBindings = new Map(); // storage key -> { loaded(value), external(value) }

function bindSetting(key, els, { show, value, changed }) {
  let newer = false; // the control already has a newer value than the startup read
  let writes = 0;
  let current; // the value this panel last loaded, saved or was told about
  // A number field the user is typing in is left alone.
  const showAll = (v) => els.forEach((el) => (el.type === 'checkbox' || el !== document.activeElement) && show(el, v));
  for (const el of els) {
    el.onchange = async () => {
      newer = true;
      current = value(el);
      showAll(current); // the twin switch (singleTab) and a clamped number follow at once
      writes++;
      try {
        await chrome.storage.local.set({ [key]: current });
      } finally {
        writes--;
      }
      changed?.();
    };
  }
  settingBindings.set(key, {
    loaded(v) {
      if (newer) return;
      current = v;
      showAll(v);
    },
    // Our own saves come back here too: while one is in flight the control
    // already shows the newest value, so an older echo must not undo a click.
    external(v) {
      if (writes || Object.is(v, current)) return;
      newer = true;
      current = v;
      showAll(v);
      changed?.();
    },
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const [key, change] of Object.entries(changes)) settingBindings.get(key)?.external(change.newValue);
  // A skill added or removed in another panel: a later save here must not drop it.
  if (changes.skills && !skillWrites && port && JSON.stringify(changes.skills.newValue || []) !== JSON.stringify(skills)) {
    skills = changes.skills.newValue || [];
    render();
    pushSkills();
  }
});

export async function initSettings(panelPort) {
  port = panelPort;
  // Handlers first, so a click right after the panel opens is not lost while storage loads.
  $('settings-open').onclick = () => toggle(true);
  $('settings-close').onclick = () => toggle(false);
  $('skill-form').onsubmit = (e) => {
    e.preventDefault();
    addSkill($('skill-url').value.trim());
  };
  $('check-updates').onclick = checkUpdates;
  initRemote();
  const tellAgent = () => port.postMessage({ type: 'set_features' }); // the running agent's prompt mentions these
  const checkbox = (fallback) => ({ show: (el, v) => (el.checked = v === undefined ? fallback : Boolean(v)), value: (el) => el.checked });
  bindSetting('highlightFinds', [$('highlight-finds')], checkbox(true));
  // One-tab mode: two switches (Settings → Page and the ＋ menu), one setting.
  bindSetting('singleTab', [$('single-tab'), $('single-tab-menu')], { ...checkbox(false), changed: tellAgent });
  bindSetting('guidePause', [$('guide-pause')], { show: (el, v) => (el.value = v || 3), value: (el) => Math.min(30, Math.max(1, Number(el.value) || 3)) });
  bindSetting('guideAutoPlay', [$('guide-autoplay')], { ...checkbox(false), changed: tellAgent });
  const stored = await chrome.storage.local.get(['skills', ...settingBindings.keys()]);
  for (const [key, binding] of settingBindings) binding.loaded(stored[key]);
  if (!skillsEdited) skills = stored.skills || [];
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
  await initExperimental(port, {
    changed(id) {
      port.postMessage({ type: 'set_features' });
      if (id === 'skillAuthoring') pushSkills();
      onFeatureChange(id);
    },
  });
}

let onFeatureChange = () => {};
export function onFeaturesChanged(fn) {
  onFeatureChange = fn;
}

export function setAgents(list) {
  setAgentsForSchedules(list);
}

async function pushSkills() {
  port.postMessage({ type: 'set_skills', skills: enabledSkillUrls(), inlineSkills: await authoredSkills() });
}

// A skill was saved by the agent (skill_save): the host gets the new list and
// Settings shows it (the Skill authoring flag was switched on by the save).
export async function skillsChanged() {
  await pushSkills();
  refreshExperimental();
}

// Skills for the host: links plus skills written in the panel.
export async function skillPayload() {
  return { skills: enabledSkillUrls(), inlineSkills: await authoredSkills() };
}

// Names for the / menu.
export async function slashSkills() {
  const inline = await authoredSkills();
  return [...inline.map((s) => ({ name: s.name, description: s.description })), ...skills.filter((s) => s.enabled).map((s) => ({ name: s.name, description: s.description }))];
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
  if (handleExperimentalMessage(msg)) return true;
  if (msg.type === 'skill_info') {
    pending.get(msg.requestId)?.(msg);
    pending.delete(msg.requestId);
    return true;
  }
  if (msg.type === 'agents' && msg.hostVersion) {
    hostVersion = msg.hostVersion;
    remoteName = msg.remote?.name || null;
    renderVersion();
    renderRemote();
  }
  return false;
}

// ---------- Remote host (relay) ----------
let remoteName = null;
async function renderRemote() {
  const { remote } = await chrome.storage.local.get('remote');
  const status = $('remote-status');
  const paired = Boolean(remote?.token);
  const active = Boolean(remote?.url);
  $('remote-url').value = remote?.url || $('remote-url').value;
  $('remote-url').disabled = paired;
  $('remote-code').hidden = paired;
  $('remote-connect').hidden = paired && Boolean(remote?.url);
  $('remote-local').hidden = !active;
  $('remote-forget').hidden = !paired;
  if (paired) status.textContent = `Paired with ${remote.name || 'the remote host'} via ${remote.url}${remoteName ? ` — connected (${remoteName})` : ''}.`;
  else if (active) status.textContent = `Pairing with ${remote.url}…`;
  else status.textContent = remote?.offUrl ? `Using the local host. Previous relay: ${remote.offUrl}` : 'Using the local host (agents on this computer).';
}

function initRemote() {
  $('remote-connect').onclick = async () => {
    const url = $('remote-url').value.trim().replace(/\/$/, '');
    const code = $('remote-code').value.trim().toUpperCase();
    const fail = (t) => ($('remote-status').textContent = t);
    if (!/^(wss?|https?):\/\//.test(url)) return fail('Enter the relay URL, e.g. wss://relay.example.com');
    const { remote } = await chrome.storage.local.get('remote');
    // Resume a paused pairing with the same relay without a new code.
    if (!code && remote?.offToken && remote.offUrl === url) await chrome.storage.local.set({ remote: { url, token: remote.offToken, name: remote.offName } });
    else if (!/^[A-Z0-9]{4}-?[A-Z0-9]{4}$/.test(code)) return fail('Enter the 8-character pairing code the remote host printed.');
    else await chrome.storage.local.set({ remote: { url, code } });
    port.postMessage({ type: 'host_switch' });
    renderRemote();
  };
  $('remote-local').onclick = async () => {
    const { remote } = await chrome.storage.local.get('remote');
    // Keep the token so the same pairing can be resumed from "Connect" later.
    await chrome.storage.local.set({ remote: { offUrl: remote?.url, offToken: remote?.token, offName: remote?.name } });
    port.postMessage({ type: 'host_switch' });
    renderRemote();
  };
  $('remote-forget').onclick = async () => {
    await chrome.storage.local.remove('remote');
    port.postMessage({ type: 'host_switch' });
    renderRemote();
  };
  renderRemote();
}
// A stored-but-paused pairing resumes without a new code.
chrome.storage.onChanged.addListener((changes, area) => area === 'local' && changes.remote && renderRemote());

export function getHostVersion() {
  return hostVersion;
}

export function hostVersionMismatch() {
  const mine = chrome.runtime.getManifest().version;
  return hostVersion && hostVersion !== mine ? { host: hostVersion, extension: mine } : null;
}

function toggle(open) {
  $('settings').hidden = !open;
  if (open) {
    $('history').hidden = true;
    $('report').hidden = true;
    $('history-open').setAttribute('aria-pressed', 'false');
  }
  $('log').hidden = open || !$('report').hidden;
  $('settings-open').setAttribute('aria-pressed', String(open));
}

export function closeSettings() {
  toggle(false);
}

// Opens Settings at a section ('skills') or a feature ('experimental:<flag>')
// and briefly highlights it — used by self-analysis remedies, which never
// change a setting themselves.
export function openSettingsAt(target) {
  toggle(true);
  const [kind, id] = String(target || '').split(':');
  const node = kind === 'experimental' ? document.querySelector(`#features-list li[data-id="${id}"]`) : kind === 'skills' ? $('skill-form') : null;
  if (!node) return;
  node.scrollIntoView({ block: 'center' });
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 2000);
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
  if (info.collection) return showPicker(url, info.collection);
  if (skills.some((s) => s.name === info.name)) return showError(`A skill named "${info.name}" is already in the list.`);

  skills.push({ url, name: info.name, title: info.title, description: info.description, enabled: true });
  $('skill-url').value = '';
  await save();

  function showError(text) {
    error.textContent = text;
    error.hidden = false;
  }
}

// A repository with many skills: the user picks which ones to add.
function showPicker(source, items) {
  const box = $('skill-picker');
  const present = new Set(skills.map((s) => s.url));
  const rows = items.map((it) => {
    const check = Object.assign(document.createElement('input'), { type: 'checkbox', checked: false, disabled: present.has(it.url) });
    const li = document.createElement('li');
    li.className = 'skill';
    const textEl = document.createElement('div');
    textEl.className = 'skill-text';
    textEl.append(Object.assign(document.createElement('b'), { textContent: it.name }), Object.assign(document.createElement('div'), { className: 'skill-desc', textContent: it.description || it.path }));
    if (present.has(it.url)) textEl.append(Object.assign(document.createElement('div'), { className: 'skill-url', textContent: 'already added' }));
    li.append(check, textEl);
    li.onclick = (e) => {
      if (e.target !== check && !check.disabled) check.checked = !check.checked;
      updateCount();
    };
    return { it, li, check };
  });
  const head = Object.assign(document.createElement('div'), { className: 'hint', textContent: `${items.length} skills found in ${source}. Pick the ones to add:` });
  const filter = Object.assign(document.createElement('input'), { type: 'search', placeholder: 'Filter', className: 'history-search' });
  filter.oninput = () => {
    const q = filter.value.trim().toLowerCase();
    for (const r of rows) r.li.hidden = Boolean(q) && !`${r.it.name} ${r.it.description} ${r.it.path}`.toLowerCase().includes(q);
  };
  const list = document.createElement('ul');
  list.className = 'skill-list';
  list.append(...rows.map((r) => r.li));
  const all = Object.assign(document.createElement('button'), { className: 'btn small', type: 'button', textContent: 'Select all' });
  all.onclick = () => {
    const visible = rows.filter((r) => !r.li.hidden && !r.check.disabled);
    const on = visible.some((r) => !r.check.checked);
    for (const r of visible) r.check.checked = on;
    all.textContent = on ? 'Select none' : 'Select all';
    updateCount();
  };
  const add = Object.assign(document.createElement('button'), { className: 'btn small primary', type: 'button', textContent: 'Add selected' });
  add.onclick = async () => {
    const chosen = rows.filter((r) => r.check.checked && !r.check.disabled);
    if (!chosen.length) return;
    for (const { it } of chosen) {
      if (skills.some((s) => s.url === it.url || s.name === it.name)) continue;
      skills.push({ url: it.url, name: it.name, title: it.title, description: it.description, enabled: true });
    }
    box.hidden = true;
    box.replaceChildren();
    $('skill-url').value = '';
    await save();
  };
  const cancel = Object.assign(document.createElement('button'), { className: 'btn small', type: 'button', textContent: 'Cancel' });
  cancel.onclick = () => {
    box.hidden = true;
    box.replaceChildren();
  };
  const actions = document.createElement('div');
  actions.className = 'options';
  actions.append(all, add, cancel);
  function updateCount() {
    const n = rows.filter((r) => r.check.checked && !r.check.disabled).length;
    add.textContent = n ? `Add ${n} selected` : 'Add selected';
  }
  box.replaceChildren(head, filter, actions, list);
  box.hidden = false;
}

async function save() {
  skillsEdited = true;
  skillWrites++;
  try {
    await chrome.storage.local.set({ skills });
  } finally {
    skillWrites--;
  }
  render();
  // Applies to the running agent from its next message.
  pushSkills();
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
