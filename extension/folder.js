// Optional working folder for the chat: agents start in it, can create and edit
// files and run commands there, and pick up the project's AGENTS.md and skills.

const $ = (id) => document.getElementById(id);
let port;
let tabId;
let folder = null; // { path, name, instructions, skills, git }
let onChange = () => {};
let nextRequest = 1;
const pending = new Map();

export async function initFolder(panelPort, chatTabId, { changed }) {
  port = panelPort;
  tabId = chatTabId;
  onChange = changed;
  $('folder-pick').onclick = pick;
  $('folder-type').onclick = () => {
    $('folder-form').hidden = !$('folder-form').hidden;
    if (!$('folder-form').hidden) $('folder-path').focus();
  };
  $('folder-clear').onclick = () => setFolder(null);
  $('folder-form').onsubmit = async (e) => {
    e.preventDefault();
    const info = await request({ type: 'folder_info', path: $('folder-path').value });
    if (info.error) return showError(info.error);
    $('folder-form').hidden = true;
    setFolder(info);
  };
  // Keep the folder while the panel is reopened during this browser session.
  folder = (await chrome.storage.session.get(`folder:${tabId}`))[`folder:${tabId}`] || null;
  await renderRecent();
  render();
}

// Restores a saved chat's folder without restarting the agent.
export async function restoreFolder(path) {
  if (!path) return;
  const info = await request({ type: 'folder_info', path });
  if (info.error) return;
  folder = { path: info.path, name: info.name, instructions: info.instructions, skills: info.skills, git: info.git };
  await chrome.storage.session.set({ [`folder:${tabId}`]: folder });
  render();
}

export function currentFolder() {
  return folder?.path || null;
}

export function handleFolderMessage(msg) {
  if (msg.type !== 'folder_info') return false;
  pending.get(msg.requestId)?.(msg);
  pending.delete(msg.requestId);
  return true;
}

// Auto-approve inside a project means unattended file edits and commands.
export function updateFolderWarning(autoApprove) {
  $('folder-warning').hidden = !(folder && autoApprove);
}

function request(message) {
  return new Promise((resolve) => {
    const requestId = nextRequest++;
    pending.set(requestId, resolve);
    port.postMessage({ ...message, requestId });
  });
}

async function pick() {
  $('folder-pick').disabled = true;
  const info = await request({ type: 'pick_folder' });
  $('folder-pick').disabled = false;
  if (info.cancelled) return;
  if (info.error) {
    // No native dialog (or it failed): let the user type the path.
    $('folder-form').hidden = false;
    return showError(info.error);
  }
  setFolder(info);
}

async function setFolder(info) {
  const before = folder?.path || null;
  folder = info ? { path: info.path, name: info.name, instructions: info.instructions, skills: info.skills, git: info.git } : null;
  await chrome.storage.session.set({ [`folder:${tabId}`]: folder });
  if (folder) {
    const { recentFolders = [] } = await chrome.storage.local.get('recentFolders');
    await chrome.storage.local.set({ recentFolders: [folder.path, ...recentFolders.filter((p) => p !== folder.path)].slice(0, 8) });
    await renderRecent();
  }
  render();
  if ((folder?.path || null) !== before) onChange(folder);
}

function render() {
  const label = $('folder-label');
  if (!folder) {
    label.textContent = 'No working folder';
    label.title = 'Optional: a project folder where agents can work with files and run commands';
  } else {
    const extras = [...folder.instructions, folder.skills.length ? `${folder.skills.length} skill${folder.skills.length > 1 ? 's' : ''}` : null, folder.git ? 'git' : null].filter(Boolean);
    label.textContent = `📁 ${folder.name}${extras.length ? ` · ${extras.join(' · ')}` : ''}`;
    label.title = `${folder.path}${folder.skills.length ? `\nSkills: ${folder.skills.join(', ')}` : ''}`;
  }
  $('folder-clear').hidden = !folder;
  updateFolderWarning($('auto').checked);
}

async function renderRecent() {
  const { recentFolders = [] } = await chrome.storage.local.get('recentFolders');
  $('folder-recent').replaceChildren(...recentFolders.map((p) => new Option(p)));
}

function showError(text) {
  const el = $('folder-error');
  el.textContent = text;
  el.hidden = false;
  setTimeout(() => (el.hidden = true), 6000);
}
