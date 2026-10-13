// Settings → Experimental: feature flags (all off by default) and the settings
// each feature needs. Per-feature panels appear only when the flag is on.

import { FEATURES, getFeatures, setFeature, getSetting, setSetting } from './features.js';
import { CATEGORIES } from './policy.js';
import { syncAlarms } from './scheduler.js';

const $ = (id) => document.getElementById(id);
let port;
let onChange = () => {};
let memoryNotes = [];
let passwordStatus = null;
let criticReady = null;
let agents = [];

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
};
const hint = (text) => el('p', { className: 'hint', textContent: text });
const field = (labelText, input) => el('label', { className: 'field' }, el('span', { textContent: labelText }), input);

export async function initExperimental(panelPort, { changed, agents: agentList }) {
  port = panelPort;
  onChange = changed;
  agents = agentList || [];
  await render();
}

export function setAgentsForSchedules(list) {
  agents = list.filter((a) => a.installed);
}

export function handleExperimentalMessage(msg) {
  if (msg.type === 'memory_notes') {
    memoryNotes = msg.notes || [];
    renderMemoryList();
    return true;
  }
  if (msg.type === 'password_status') {
    passwordStatus = msg;
    renderPasswordStatus();
    return true;
  }
  if (msg.type === 'transcribe_status') {
    const line = $('voice-status-line');
    if (line) line.textContent = msg.ready ? `Host engine ready: ${msg.api ? `API ${msg.apiBase}` : `whisper.cpp (${msg.whisperModel})`}.` : 'Host engine not set up (needed for tab audio).';
    return true;
  }
  if (msg.type === 'critic_status') {
    criticReady = msg.ready;
    renderCriticStatus();
    return true;
  }
  return false;
}

// Skills written in the panel (Skill authoring flag) — sent to the host inline.
export async function authoredSkills() {
  const features = await getFeatures();
  if (!features.skillAuthoring) return [];
  const { authoredSkills: list = [] } = await chrome.storage.local.get('authoredSkills');
  return list.filter((s) => s.enabled !== false).map(({ name, description, body }) => ({ name, description, body }));
}

async function render() {
  const features = await getFeatures();
  const list = $('features-list');
  list.replaceChildren(
    ...FEATURES.map((f) => {
      const box = el('input', { type: 'checkbox', checked: features[f.id] });
      box.onchange = async () => {
        await setFeature(f.id, box.checked);
        await render();
        onChange(f.id, box.checked);
      };
      const item = el('li', { className: 'feature' }, box, el('div', { className: 'feature-text' }, el('b', { textContent: f.name }), el('div', { className: 'skill-desc', textContent: f.desc })));
      const panel = el('div', { className: 'feature-panel' });
      if (features[f.id]) {
        const builder = PANELS[f.id];
        if (f.id === 'skillAuthoring') {
          // Written skills belong with the other skills, in the Skills section.
          const home = $('skills-authoring');
          home.replaceChildren(panel);
          builder(panel);
          item.append(el('div', { className: 'feature-panel' }, hint('Write and edit skills in the Skills section above; run them with /name.')));
        } else if (builder) {
          builder(panel);
          item.append(panel);
        }
      }
      return item;
    }),
  );
  $('skills-authoring').hidden = !features.skillAuthoring;
  $('skills-write-hint').hidden = !features.skillAuthoring;
  if (!features.skillAuthoring) $('skills-authoring').replaceChildren();
}

const PANELS = {
  async critic(panel) {
    const s = await getSetting('critic');
    const provider = el('select');
    for (const [v, n] of [['openrouter', 'OpenRouter'], ['ollama', 'Ollama (local)'], ['openai', 'OpenAI-compatible']]) provider.append(new Option(n, v, false, s.provider === v));
    const model = el('input', { value: s.model || '', placeholder: 'model id (empty = default free model)' });
    const save = async () => {
      await setSetting('critic', { provider: provider.value, model: model.value.trim() });
      port.postMessage({ type: 'critic_status', provider: provider.value });
      onChange('critic');
    };
    provider.onchange = save;
    model.onchange = save;
    panel.append(hint('Checks every page-changing action with a separate model: allow, ask you, or block. Uses the same keys as the built-in agent (~/.tabhelm/env).'), field('Provider', provider), field('Model', model), el('div', { id: 'critic-status', className: 'hint' }));
    port.postMessage({ type: 'critic_status', provider: provider.value });
    renderCriticStatus();
  },

  async siteRules(panel) {
    const s = await getSetting('siteRules');
    const cats = el('div', { className: 'cats' });
    for (const cat of Object.keys(CATEGORIES)) {
      const sel = el('select');
      for (const mode of ['allow', 'ask', 'block']) sel.append(new Option(mode, mode, false, (s.categories[cat] || 'allow') === mode));
      sel.onchange = async () => {
        s.categories[cat] = sel.value;
        await setSetting('siteRules', s);
      };
      cats.append(field(cat, sel));
    }
    const deny = el('textarea', { rows: 3, value: (s.deny || []).join('\n'), placeholder: 'one domain per line, e.g. example.com' });
    const allow = el('textarea', { rows: 3, value: (s.allow || []).join('\n'), placeholder: 'always allowed, e.g. my-company.com' });
    deny.onchange = async () => setSetting('siteRules', { ...s, deny: deny.value.split('\n').map((l) => l.trim()).filter(Boolean) });
    allow.onchange = async () => setSetting('siteRules', { ...s, allow: allow.value.split('\n').map((l) => l.trim()).filter(Boolean) });
    panel.append(hint('Categories: allow, ask before acting, or block entirely. Your deny list blocks; your allow list wins over everything.'), cats, field('Deny list', deny), field('Allow list', allow));
  },

  async sensitiveGate(panel) {
    const s = await getSetting('sensitiveGate');
    const words = el('textarea', { rows: 3, value: s.keywords.join(', ') });
    words.onchange = async () => setSetting('sensitiveGate', { keywords: words.value.split(',').map((w) => w.trim()).filter(Boolean) });
    panel.append(hint('Clicks, Enter and navigations whose target contains one of these words always ask first, even with auto-approve on.'), field('Keywords', words));
  },

  planPreview(panel) {
    panel.append(hint('Each new task starts with a plan; the agent acts only after you press Start.'));
  },

  takeOver(panel) {
    panel.append(hint('A Pause button appears while the agent works. The agent can also call browser_request_human to ask for your help.'));
  },

  async schedules(panel) {
    const s = await getSetting('schedules');
    const list = el('ul', { className: 'skill-list' });
    const renderList = () => {
      list.replaceChildren(
        ...s.items.map((it) => {
          const on = el('input', { type: 'checkbox', checked: it.enabled !== false, title: 'Enabled' });
          on.onchange = async () => {
            it.enabled = on.checked;
            await setSetting('schedules', s);
            await syncAlarms();
          };
          const run = el('button', { className: 'btn small', type: 'button', textContent: 'Run now' });
          run.onclick = () => port.postMessage({ type: 'run_schedule', id: it.id });
          const del = el('button', { className: 'banner-close', textContent: '×', title: 'Delete' });
          del.onclick = async () => {
            s.items = s.items.filter((x) => x.id !== it.id);
            await setSetting('schedules', s);
            await syncAlarms();
            renderList();
          };
          const meta = `${it.agentName} · every ${it.everyMinutes} min · ${it.url}${it.lastRun ? ` · last: ${new Date(it.lastRun).toLocaleString()} — ${it.lastResult || ''}` : ''}`;
          return el('li', { className: 'skill' }, on, el('div', { className: 'skill-text' }, el('b', { textContent: it.name }), el('div', { className: 'skill-desc', textContent: it.prompt }), el('div', { className: 'skill-url', textContent: meta })), run, del);
        }),
      );
    };
    renderList();
    const name = el('input', { placeholder: 'Name' });
    const url = el('input', { placeholder: 'https://page to open' });
    const prompt = el('textarea', { rows: 2, placeholder: 'What the agent should do' });
    const agent = el('select');
    for (const a of agents) agent.append(new Option(a.name, a.id));
    const every = el('input', { type: 'number', min: 1, value: 60, placeholder: 'minutes' });
    const auto = el('input', { type: 'checkbox', checked: true });
    const add = el('button', { className: 'btn small primary', type: 'button', textContent: 'Add schedule' });
    add.onclick = async () => {
      if (!name.value.trim() || !url.value.trim() || !prompt.value.trim() || !agent.value) return;
      s.items.push({ id: `s${Date.now().toString(36)}`, name: name.value.trim(), url: url.value.trim(), prompt: prompt.value.trim(), agentId: agent.value, agentName: agent.selectedOptions[0].text, everyMinutes: Math.max(1, Number(every.value) || 60), autoApprove: auto.checked, enabled: true });
      await setSetting('schedules', s);
      await syncAlarms();
      name.value = url.value = prompt.value = '';
      renderList();
    };
    panel.append(
      hint('Runs in a background tab while Chrome is open; results are saved to History and you get a notification. Scheduled runs cannot ask you anything — tasks that need approval fail.'),
      list,
      field('Name', name), field('Page', url), field('Task', prompt), field('Agent', agent), field('Every (minutes)', every), field('Auto-approve actions', auto), add,
    );
  },

  devTools(panel) {
    panel.append(hint('Adds browser_fill_form, browser_network_body, browser_storage, browser_emulate and browser_highlight. Storage changes ask first.'));
  },

  async secrets(panel) {
    const s = await getSetting('secrets');
    const list = el('ul', { className: 'skill-list' });
    const renderList = () => {
      list.replaceChildren(
        ...s.names.map((n) => {
          const del = el('button', { className: 'banner-close', textContent: '×', title: 'Delete' });
          del.onclick = async () => {
            s.names = s.names.filter((x) => x !== n);
            await chrome.storage.local.remove(`secret:${n}`);
            await setSetting('secrets', s);
            renderList();
          };
          return el('li', { className: 'skill' }, el('div', { className: 'skill-text' }, el('b', { textContent: `{{SECRET:${n}}}` })), del);
        }),
      );
    };
    renderList();
    const name = el('input', { placeholder: 'name (letters, digits, - _ .)' });
    const value = el('input', { type: 'password', placeholder: 'value' });
    const add = el('button', { className: 'btn small primary', type: 'button', textContent: 'Add secret' });
    add.onclick = async () => {
      const n = name.value.trim();
      if (!/^[\w.-]{1,40}$/.test(n) || !value.value) return;
      await chrome.storage.local.set({ [`secret:${n}`]: value.value });
      if (!s.names.includes(n)) s.names.push(n);
      await setSetting('secrets', s);
      name.value = value.value = '';
      renderList();
    };
    panel.append(hint('Tell the agent to use {{SECRET:name}} where a value goes (e.g. "type {{SECRET:api_key}} into the token field"). It is substituted on the page; the model, logs and exports only see the placeholder. Stored in this browser profile.'), list, field('Name', name), field('Value', value), add);
  },

  memory(panel) {
    const list = el('ul', { className: 'skill-list', id: 'memory-list' });
    const text = el('input', { placeholder: 'A fact to remember' });
    const site = el('input', { placeholder: 'site (optional, e.g. github.com)' });
    const add = el('button', { className: 'btn small primary', type: 'button', textContent: 'Add note' });
    add.onclick = () => {
      if (!text.value.trim()) return;
      port.postMessage({ type: 'memory_add', text: text.value.trim(), site: site.value.trim() || null });
      text.value = site.value = '';
    };
    const clear = el('button', { className: 'btn small', type: 'button', textContent: 'Clear all' });
    clear.onclick = () => confirm('Delete all memory notes?') && port.postMessage({ type: 'memory_clear' });
    panel.append(hint('Notes saved by you or the agent (memory_save) in ~/.tabhelm/memory.json. Global notes go to every chat; site notes only to chats on that site.'), list, field('Note', text), field('Site', site), el('div', { className: 'options' }, add, clear));
    port.postMessage({ type: 'memory_list' });
    renderMemoryList();
  },

  async skillAuthoring(panel) {
    const { authoredSkills: items = [] } = await chrome.storage.local.get('authoredSkills');
    const list = el('ul', { className: 'skill-list' });
    const save = async () => {
      await chrome.storage.local.set({ authoredSkills: items });
      onChange('skillAuthoring');
    };
    const renderList = () => {
      list.replaceChildren(
        ...items.map((sk, i) => {
          const on = el('input', { type: 'checkbox', checked: sk.enabled !== false });
          on.onchange = () => {
            items[i].enabled = on.checked;
            save();
          };
          const edit = el('button', { className: 'btn small', type: 'button', textContent: 'Edit' });
          edit.onclick = () => {
            name.value = sk.name;
            desc.value = sk.description;
            body.value = sk.body;
            editing = i;
            add.textContent = 'Save skill';
          };
          const del = el('button', { className: 'banner-close', textContent: '×', title: 'Delete' });
          del.onclick = () => {
            items.splice(i, 1);
            save();
            renderList();
          };
          return el('li', { className: 'skill' }, on, el('div', { className: 'skill-text' }, el('b', { textContent: `/${sk.name}` }), el('div', { className: 'skill-desc', textContent: sk.description })), edit, del);
        }),
      );
    };
    renderList();
    let editing = -1;
    const name = el('input', { placeholder: 'name (used as /name)' });
    const desc = el('input', { placeholder: 'When to use it (one sentence)' });
    const body = el('textarea', { rows: 6, placeholder: 'Instructions for the agent (Markdown)' });
    const add = el('button', { className: 'btn small primary', type: 'button', textContent: 'Add skill' });
    add.onclick = () => {
      const n = name.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!n || !body.value.trim()) return;
      const sk = { name: n, description: desc.value.trim() || n, body: body.value.trim(), enabled: true };
      if (editing >= 0) items[editing] = { ...items[editing], ...sk };
      else items.push(sk);
      editing = -1;
      add.textContent = 'Add skill';
      name.value = desc.value = body.value = '';
      save();
      renderList();
    };
    panel.append(el('h4', { textContent: 'Written here' }), list, field('Name', name), field('Description', desc), field('Instructions', body), add);
  },

  async passwordManager(panel) {
    const s = await getSetting('passwordManager');
    const op = el('input', { type: 'checkbox', checked: s.onePassword !== false });
    const ch = el('input', { type: 'checkbox', checked: s.chrome !== false });
    const save = async () => {
      await setSetting('passwordManager', { onePassword: op.checked, chrome: ch.checked });
      onChange('passwordManager');
    };
    op.onchange = save;
    ch.onchange = save;
    panel.append(
      hint('When a page needs a sign-in, the agent asks and you choose: fill from 1Password (needs the op CLI, signed in), or hand over to Chrome\'s password manager and sign in yourself. The model never sees credentials.'),
      field('1Password (op CLI)', op), field('Chrome password manager (hand over)', ch), el('div', { id: 'password-status', className: 'hint' }),
    );
    port.postMessage({ type: 'password_status' });
    renderPasswordStatus();
  },

  actionDb(panel) {
    panel.append(hint('Steps get timestamps; a recording shows its steps and jumps to them in the video; History search also looks through steps.'));
  },

  notifications(panel) {
    panel.append(hint('A badge on the tab (✓ done, ! stopped, ? needs you) and a system notification; clicking it opens the tab.'));
  },

  async voice(panel) {
    const s = await getSetting('voice');
    const engine = el('select');
    for (const [v, n] of [['browser', 'Chrome speech recognition (microphone only, no setup)'], ['host', 'TabHelm host: whisper.cpp or a transcription API']]) engine.append(new Option(n, v, false, s.engine === v));
    const language = el('select');
    for (const [v, n] of [['auto', 'Auto'], ['uk-UA', 'Українська'], ['en-US', 'English'], ['de-DE', 'Deutsch'], ['pl-PL', 'Polski'], ['es-ES', 'Español'], ['fr-FR', 'Français']]) language.append(new Option(n, v, false, s.language === v));
    const chunk = el('input', { type: 'number', min: 3, max: 30, value: s.chunkSeconds || 8 });
    const save = async () => {
      await setSetting('voice', { engine: engine.value, language: language.value, chunkSeconds: Math.min(30, Math.max(3, Number(chunk.value) || 8)) });
      onChange('voice');
    };
    engine.onchange = language.onchange = chunk.onchange = save;
    const mic = el('button', { className: 'btn small', type: 'button', textContent: 'Grant microphone access' });
    mic.onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('permissions.html') });
    panel.append(
      hint('Microphone: Chrome\'s own recognition transcribes live without any setup (needs internet; auto language uses the panel language). Tab audio always goes through the host: install whisper-cli + ffmpeg and a ggml model, or set TABHELM_TRANSCRIBE_BASE_URL / _API_KEY / _MODEL in ~/.tabhelm/env (e.g. Groq or OpenAI Whisper).'),
      field('Engine for the microphone', engine), field('Language', language), field('Chunk length for the host engine (seconds)', chunk), mic, el('div', { id: 'voice-status-line', className: 'hint' }),
    );
    port.postMessage({ type: 'transcribe_status' });
  },
};

function renderMemoryList() {
  const list = $('memory-list');
  if (!list) return;
  list.replaceChildren(
    ...memoryNotes
      .slice()
      .reverse()
      .map((n) => {
        const del = el('button', { className: 'banner-close', textContent: '×', title: 'Delete' });
        del.onclick = () => port.postMessage({ type: 'memory_delete', id: n.id });
        return el('li', { className: 'skill' }, el('div', { className: 'skill-text' }, el('div', { textContent: n.text }), el('div', { className: 'skill-url', textContent: `${n.site || 'global'} · ${n.source} · ${new Date(n.created).toLocaleDateString()}` })), del);
      }),
  );
  if (!memoryNotes.length) list.append(el('li', { className: 'hint', textContent: 'No notes yet.' }));
}

function renderPasswordStatus() {
  const s = $('password-status');
  if (!s) return;
  s.textContent = passwordStatus == null ? 'Checking 1Password CLI…' : passwordStatus.onePassword ? '1Password CLI (op) found.' : '1Password CLI (op) not found — install it from 1password.com/downloads/command-line and run "op signin".';
}

function renderCriticStatus() {
  const s = $('critic-status');
  if (!s) return;
  s.textContent = criticReady == null ? 'Checking…' : criticReady ? 'Critic model reachable.' : 'Not configured: add the provider key with "npm run set-key" (OpenRouter) or start Ollama.';
}
