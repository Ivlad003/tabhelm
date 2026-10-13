// Action policy, evaluated in the service worker before a browser tool runs:
// site rules, the sensitive-action gate, the action critic, secrets and the
// take-over pause. Every layer is behind a feature flag (features.js).

import { getFeatures, getSetting } from './features.js';

export const READ_ONLY = new Set([
  'browser_snapshot', 'browser_find', 'browser_get_text', 'browser_screenshot', 'browser_wait', 'browser_console',
  'browser_network', 'browser_tabs', 'browser_search_tabs', 'browser_handle_dialog', 'browser_network_body',
  'browser_highlight', 'browser_request_human', 'browser_request_login', 'browser_guide', 'skill_save', 'memory_search', 'memory_save',
  'skill_list', 'skill_read', 'skill_read_file',
]);

// Domain patterns per category; users extend them with deny/allow lists.
export const CATEGORIES = {
  banking: ['paypal.com', 'wise.com', 'revolut.com', 'monobank.ua', 'privat24.ua', 'privatbank.ua', 'oschadbank.ua', 'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com', 'hsbc.com', 'barclays.co.uk', 'n26.com', 'coinbase.com', 'binance.com', 'kraken.com', 'robinhood.com', 'stripe.com/dashboard', 'ing.com', 'bank'],
  government: ['.gov', '.gov.ua', 'diia.gov.ua', 'irs.gov', 'ssa.gov', 'gov.uk', 'europa.eu', 'tax.'],
  health: ['helsi.me', 'mychart', 'nhs.uk', 'healthcare.gov', 'doctolib', 'zocdoc.com', 'webmd.com', 'patient'],
  adult: ['pornhub.com', 'xvideos.com', 'xnxx.com', 'onlyfans.com', 'redtube.com', 'xhamster.com'],
  piracy: ['thepiratebay', '1337x', 'rarbg', 'yts.', 'fitgirl', 'nyaa.si'],
};

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function matches(pattern, url, host) {
  const p = pattern.toLowerCase();
  if (p.startsWith('.')) return host.endsWith(p) || host === p.slice(1);
  if (p.includes('/')) return url.toLowerCase().includes(p);
  if (p.endsWith('.')) return host.includes(p) || host.startsWith(p);
  return host === p || host.endsWith(`.${p}`) || (!p.includes('.') && host.includes(p));
}

// 'allow' | 'ask' | 'block' for a URL under the site rules.
export function siteDecision(url, rules) {
  const host = hostOf(url);
  if (!host) return { decision: 'allow' };
  for (const p of rules.allow || []) if (matches(p, url, host)) return { decision: 'allow', reason: `allowed by your list (${p})` };
  for (const p of rules.deny || []) if (matches(p, url, host)) return { decision: 'block', reason: `on your deny list (${p})` };
  for (const [category, patterns] of Object.entries(CATEGORIES)) {
    const mode = rules.categories?.[category];
    if (!mode || mode === 'allow') continue;
    if (patterns.some((p) => matches(p, url, host))) return { decision: mode, reason: `${category} site`, category };
  }
  return { decision: 'allow' };
}

// Does this call look like a payment / send / delete / sign-in?
export function sensitiveMatch(tool, args, label, keywords) {
  if (READ_ONLY.has(tool)) return null;
  const hay = [label, args?.text, args?.url, args?.key, args?.value].filter(Boolean).join(' ').toLowerCase();
  if (['browser_click', 'browser_click_xy', 'browser_press_key', 'browser_type', 'browser_fill_form', 'browser_navigate'].includes(tool)) {
    if (tool === 'browser_press_key' && !/enter/i.test(args?.key || '')) return null;
    if (tool === 'browser_type' && !args?.submit) return null;
    for (const k of keywords) if (hay.includes(k.toLowerCase())) return k;
  }
  return null;
}

// Replaces {{SECRET:name}} in text arguments with stored values. Only the
// substituted copy goes to the page; logs keep the placeholder.
export async function substituteSecrets(args) {
  const text = JSON.stringify(args);
  if (!/\{\{SECRET:/.test(text)) return { args, used: [] };
  const names = [...text.matchAll(/\{\{SECRET:([\w.-]+)\}\}/g)].map((m) => m[1]);
  const stored = await chrome.storage.local.get(names.map((n) => `secret:${n}`));
  const used = [];
  const replaced = text.replace(/\{\{SECRET:([\w.-]+)\}\}/g, (m, name) => {
    const value = stored[`secret:${name}`];
    if (value == null) return m;
    used.push(name);
    return JSON.stringify(value).slice(1, -1);
  });
  return { args: JSON.parse(replaced), used };
}

// Pause state per chat (take-over).
const paused = new Map(); // chatTabId -> { promise, resolve }

export function pauseChat(chatTabId) {
  if (paused.has(chatTabId)) return;
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  paused.set(chatTabId, { promise, resolve });
}

export function resumeChat(chatTabId) {
  paused.get(chatTabId)?.resolve();
  paused.delete(chatTabId);
}

export function isPaused(chatTabId) {
  return paused.has(chatTabId);
}

export async function waitIfPaused(chatTabId) {
  const p = paused.get(chatTabId);
  if (p) await p.promise;
}

// Runs the policy layers. Returns { allow: true, args } or { allow: false, error }.
// `ui.confirm` shows a card in the panel; `critic` asks the host's critic model.
export async function checkPolicy({ chatTabId, tool, args, tab, label, task, recentActions, ui, critic }) {
  const features = await getFeatures();
  if (!READ_ONLY.has(tool)) await waitIfPaused(chatTabId);

  let effectiveArgs = args;
  let secretsUsed = [];
  if (features.secrets) ({ args: effectiveArgs, used: secretsUsed } = await substituteSecrets(args));

  if (features.siteRules) {
    const rules = await getSetting('siteRules');
    // The page the tool acts on, plus the destination of a navigation.
    const dest = tool === 'browser_navigate' ? args.url : tool === 'browser_tabs' && args.action === 'new' ? args.url : null;
    const urls = [tab?.url, dest && (/^[a-z][a-z0-9+.-]*:/i.test(dest) ? dest : `https://${dest}`)].filter(Boolean);
    for (const u of urls) {
      const d = siteDecision(u, rules);
      if (d.decision === 'block') return { allow: false, error: `Blocked by site rules: ${d.reason} (${u}). Change this in Settings → Site rules.` };
      if (d.decision === 'ask' && !READ_ONLY.has(tool)) {
        const ok = await ui.confirm(chatTabId, `Act on a ${d.category || 'restricted'} site?`, `${tab?.title || ''}\n${u}\n\n${label}`);
        if (!ok) return { allow: false, error: 'The user did not allow acting on this site.' };
      }
    }
  }

  if (features.sensitiveGate && !READ_ONLY.has(tool)) {
    const { keywords } = await getSetting('sensitiveGate');
    const hit = sensitiveMatch(tool, args, label, keywords);
    if (hit) {
      const ok = await ui.confirm(chatTabId, `Sensitive action (“${hit}”) — allow?`, `${label}\n${tab?.title || ''}\n${tab?.url || ''}`);
      if (!ok) return { allow: false, error: `The user did not allow this sensitive action (${hit}).` };
    }
  }

  if (features.critic && !READ_ONLY.has(tool)) {
    const verdict = await critic({ task, tool, args, label, url: tab?.url, title: tab?.title, recentActions });
    if (verdict?.decision === 'block') return { allow: false, error: `Blocked by the action critic: ${verdict.reason}` };
    if (verdict?.decision === 'ask') {
      const ok = await ui.confirm(chatTabId, 'The action critic is unsure — allow?', `${label}\n\nCritic: ${verdict.reason}`);
      if (!ok) return { allow: false, error: 'The user did not allow this action after the critic flagged it.' };
    }
  }

  return { allow: true, args: effectiveArgs, secretsUsed };
}
