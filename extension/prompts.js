// Settings → System prompts: the texts agents are given before the user's first
// message, shown with TabHelm's own wording and editable. Only what the user
// changed is stored (chrome.storage.local "prompts"); an empty box or the default
// text means "use the default", so later improvements to the defaults still arrive.
//   preamble  every agent's instructions (browser tools, safety rules, tone)
//   builtin   the built-in agent's system prompt (OpenRouter / Ollama / OpenAI-compatible)
//   suggest   how a suggested next message is written (Message suggestions flag)

const $ = (id) => document.getElementById(id);
export const PROMPTS = [
  { id: 'preamble', name: 'Instructions for every agent', desc: 'Sent with the first message of a chat to Claude Code, Codex, Cursor and every other agent: how to use the browser tools, what to ask you first, how to answer.' },
  { id: 'builtin', name: 'Built-in agent', desc: 'The system prompt of TabHelm\'s own agent (OpenRouter, Ollama, OpenAI-compatible). It gets the instructions above as well.' },
  { id: 'suggest', name: 'Message suggestions', desc: 'How the suggested next message is written (Experimental → Message suggestions).' },
];
export const PROMPT_MAX_CHARS = 20_000;

let port;
let defaults = null; // { preamble, builtin, suggest } from the host
let nextRequest = 1;

// What is stored for a box: '' when it holds nothing or the default itself.
export function storedValue(text, fallback) {
  const clean = String(text ?? '').replace(/\r\n/g, '\n').trim().slice(0, PROMPT_MAX_CHARS);
  return clean && clean !== String(fallback ?? '').trim() ? clean : '';
}

export async function customPrompts() {
  return (await chrome.storage.local.get('prompts')).prompts || {};
}

export function initPrompts(panelPort) {
  port = panelPort;
  port.postMessage({ type: 'prompts_default', requestId: `prompts-${nextRequest++}` });
  // A host from before this feature never answers: say so instead of "Loading…" for good.
  setTimeout(() => {
    const list = $('prompts-list');
    if (!defaults && list) list.replaceChildren(Object.assign(document.createElement('span'), { className: 'hint', textContent: 'The host did not send its texts. Update the host (run the installer again) to edit system prompts; while it is offline they cannot be shown.' }));
  }, 6000);
  // Edited in another panel: show it here too.
  chrome.storage.onChanged.addListener((changes, area) => area === 'local' && changes.prompts && defaults && render());
}

export function handlePromptsMessage(msg) {
  if (msg.type !== 'prompts_default') return false;
  defaults = msg.prompts || {};
  render();
  return true;
}

async function save(id, text) {
  const all = await customPrompts();
  const value = storedValue(text, defaults?.[id]);
  if ((all[id] || '') === value) return;
  if (value) all[id] = value;
  else delete all[id];
  await chrome.storage.local.set({ prompts: all });
}

async function render() {
  const list = $('prompts-list');
  if (!list || !defaults) return;
  const custom = await customPrompts();
  // A box being typed in is left alone.
  const editing = document.activeElement?.closest?.('.prompt-item')?.dataset.id;
  for (const p of PROMPTS) {
    if (p.id === editing) continue;
    let item = list.querySelector(`.prompt-item[data-id="${p.id}"]`);
    if (!item) {
      if (!list.querySelector('.prompt-item')) list.replaceChildren();
      item = document.createElement('div');
      item.className = 'prompt-item';
      item.dataset.id = p.id;
      const head = Object.assign(document.createElement('div'), { className: 'prompt-head' });
      const state = Object.assign(document.createElement('span'), { className: 'prompt-state' });
      const reset = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small', textContent: 'Reset' });
      reset.title = 'Bring back TabHelm\'s own text';
      head.append(Object.assign(document.createElement('b'), { textContent: p.name }), state, reset);
      const area = Object.assign(document.createElement('textarea'), { spellcheck: false, maxLength: PROMPT_MAX_CHARS });
      area.setAttribute('aria-label', p.name);
      const mark = () => {
        const changed = Boolean(storedValue(area.value, defaults[p.id]));
        item.classList.toggle('changed', changed);
        state.textContent = changed ? 'changed' : 'default';
        reset.hidden = !changed;
      };
      let timer = null;
      area.oninput = () => {
        mark();
        clearTimeout(timer);
        timer = setTimeout(() => save(p.id, area.value), 600);
      };
      // Leaving the box saves at once; an emptied box shows the default again.
      area.onblur = async () => {
        clearTimeout(timer);
        await save(p.id, area.value);
        if (!area.value.trim()) area.value = defaults[p.id] || '';
        mark();
      };
      reset.onclick = async () => {
        area.value = defaults[p.id] || '';
        await save(p.id, '');
        mark();
      };
      item.append(head, Object.assign(document.createElement('p'), { className: 'hint', textContent: p.desc }), area);
      item.mark = mark;
      list.append(item);
    }
    const area = item.querySelector('textarea');
    area.value = custom[p.id] || defaults[p.id] || '';
    item.mark();
  }
}
