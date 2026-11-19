// Experimental feature flags. Everything here is OFF by default and is switched
// on in Settings → Experimental. Shared by the panel and the service worker.

export const FEATURES = [
  { id: 'critic', name: 'Action critic', desc: 'A second model (the built-in OpenRouter/Ollama agent) checks every page-changing action against your task and can allow it, ask you, or block it.' },
  { id: 'siteRules', name: 'Site rules', desc: 'Block or require confirmation on categories of sites (banking, health, adult…) and on your own deny/allow lists.' },
  { id: 'sensitiveGate', name: 'Sensitive actions', desc: 'Always ask before paying, sending, deleting, signing in or submitting, even with auto-approve on.' },
  { id: 'planPreview', name: 'Plan preview', desc: 'The agent first proposes a short plan; it starts acting only after you press Start.' },
  { id: 'takeOver', name: 'Take over', desc: 'Pause the agent and act yourself (2FA, captcha, payment), then hand control back. The agent can also ask you for help.' },
  { id: 'schedules', name: 'Scheduled tasks', desc: 'Run a task on a schedule in a background tab and get notified when it finishes.' },
  { id: 'devTools', name: 'Developer tools', desc: 'Extra tools: fill a whole form, network request bodies, cookies and storage, device emulation, element highlighting.' },
  { id: 'secrets', name: 'Secrets', desc: 'Named secrets the agent uses as placeholders like {{SECRET:name}}; the real values never reach the model or the logs.' },
  { id: 'memory', name: 'Memory', desc: 'Notes that persist across chats (per site and global). The agent can save and search them.' },
  { id: 'skillAuthoring', name: 'Skill authoring & slash commands', desc: 'Write skills in the panel and run them with /name in the message box.' },
  { id: 'passwordManager', name: 'Password manager hand-off', desc: 'Sign-in help: fill credentials from 1Password (op CLI) without the model seeing them, or hand over to Chrome\'s password manager.' },
  { id: 'actionDb', name: 'Action database', desc: 'Every step with a timestamp, jump-to-step in recordings, and search across steps in History.' },
  { id: 'notifications', name: 'Notifications', desc: 'A badge on the tab and a system notification when a task finishes or needs you.' },
  { id: 'guideDetail', name: 'Detailed guide', desc: 'In guide mode the agent explains every step: what the element is, why this step, what will happen after the click and what to check — instead of a one-line instruction.' },
  { id: 'pageScripts', name: 'Page scripts & styles', desc: 'A library of your own JavaScript and CSS presets: run one on the current page from the ＋ menu, run it automatically on matching sites, and let the agent save, list and run presets or restyle a page.' },
  { id: 'trimWaits', name: 'Skip waiting in recordings', desc: 'Recordings keep only a moment of each wait (page loading, the agent thinking) and mark the cut with "⏩ N s of waiting skipped", so videos stay short.' },
  { id: 'selfAnalysis', name: 'Self-analysis', desc: 'Finds what went wrong in your chats: errors by cause, site knowledge or skills the agent was missing, setup problems and bugs in TabHelm itself. Diagnose a chat from a failed task, the ＋ menu or /diagnose; see all chats in History → Report; copy a redacted bug report. Analysed on this computer — the agent sees only a redacted summary, and only when you or it asks.' },
  { id: 'voice', name: 'Voice', desc: 'Record a voice message from the microphone, or capture what the tab is playing, with live transcription; the text becomes one message you can edit and send.' },
  { id: 'suggest', name: 'Message suggestions', desc: 'After a reply, the message box shows what you would probably send next, written from the last exchanges of the chat; Tab puts it into the box, where you can change it before sending. The suggestion comes from a model through OpenRouter with your key — the last messages of the chat are sent to it — and its cost is in the usage details.' },
  { id: 'live', name: 'Live conversation', desc: 'Talk to TabHelm instead of typing: 🎙 Live keeps the microphone on, every sentence you say becomes a message to the agent (or a command — "stop", "next", "back" — or the answer to a question it asked), and the reply is read aloud. Speech goes through OpenRouter with your key; what was heard, what was sent and what it cost is shown.' },
  { id: 'narration', name: 'Narration', desc: 'TabHelm speaks: every guide step (auto-play waits for the end of the sentence), a short phrase when a task needs you or ends, and any reply you press 🔊 on. Speech comes from OpenRouter with your key; each piece is listed in the steps with its length and cost.' },
];

export const DEFAULT_SETTINGS = {
  critic: { provider: 'openrouter', model: '' },
  siteRules: { categories: { banking: 'block', government: 'ask', health: 'ask', adult: 'block', piracy: 'block' }, deny: [], allow: [] },
  sensitiveGate: { keywords: ['pay', 'buy', 'checkout', 'purchase', 'order', 'send', 'submit', 'delete', 'remove', 'sign in', 'log in', 'login', 'transfer', 'confirm', 'post', 'publish', 'unsubscribe'] },
  schedules: { items: [] },
  secrets: { names: [] }, // values live under secret:<name>
  passwordManager: { onePassword: true, chrome: true },
  voice: { engine: 'browser', language: 'auto', chunkSeconds: 8 },
  suggest: { model: '' },
  live: { engine: 'host', language: 'auto', silenceMs: 900, bargeIn: false },
  narration: { model: 'elevenlabs/eleven-flash-v2.5', voice: '', guide: true, events: true, language: 'auto' },
  trimWaits: { maxPause: 1.5 },
  selfAnalysis: { agentTool: true, hideSites: true, includeHostLog: true, days: 30 },
};

export async function getFeatures() {
  const { features = {} } = await chrome.storage.local.get('features');
  return Object.fromEntries(FEATURES.map((f) => [f.id, Boolean(features[f.id])]));
}

export async function setFeature(id, on) {
  const { features = {} } = await chrome.storage.local.get('features');
  features[id] = Boolean(on);
  await chrome.storage.local.set({ features });
}

export async function getSetting(id) {
  const { featureSettings = {} } = await chrome.storage.local.get('featureSettings');
  return { ...structuredClone(DEFAULT_SETTINGS[id] || {}), ...(featureSettings[id] || {}) };
}

export async function setSetting(id, value) {
  const { featureSettings = {} } = await chrome.storage.local.get('featureSettings');
  featureSettings[id] = value;
  await chrome.storage.local.set({ featureSettings });
}

// Everything the host needs to know (flags + the settings it acts on).
export async function hostFeaturePayload() {
  const page = await chrome.storage.local.get(['singleTab', 'guideAutoPlay']);
  const features = { ...(await getFeatures()), singleTab: Boolean(page.singleTab), guideAutoPlay: Boolean(page.guideAutoPlay) };
  // The agent's self-check tool is offered only with the flag and its setting on.
  features.selfAnalysisAgent = Boolean(features.selfAnalysis && (await getSetting('selfAnalysis')).agentTool !== false);
  return { features, critic: await getSetting('critic'), passwordManager: await getSetting('passwordManager') };
}
