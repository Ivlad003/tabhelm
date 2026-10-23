// Builds the golden "real-shape" self-analysis datasets with no real content:
//   golden.json      — 101 chats shaped like the real backup of 2026-10-21
//                      (100 e2e chats on 127.0.0.1:<ephemeral>, one without a
//                      URL, 89 % legacy turns with no recorded outcome, the
//                      failover crashes, the about:blank navigate/go_forward
//                      dead end, fill_form with Developer tools off, a
//                      recovered single-tab refusal, guide asks);
//   golden-real.json — the same patterns on public hosts, instrumented (turn
//                      ids, stopReason, versions, action hosts), plus custom
//                      dropdowns on one shop.
// Deterministic (seeded, fixed dates), so the files only change with this code.
//   node host/scripts/selfanalysis/fixtures/gen-golden.mjs           check the files are current
//   node host/scripts/selfanalysis/fixtures/gen-golden.mjs --update  rewrite them

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FILES = { legacy: join(HERE, 'golden.json'), real: join(HERE, 'golden-real.json') };
export const NOW = '2026-10-23T12:00:00.000Z';

// mulberry32: small, seeded, the same on every machine.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AGENTS = [
  { id: 'claude', name: 'Claude Code', installHint: 'npm i -g @anthropic-ai/claude-code' },
  { id: 'codex', name: 'Codex', installHint: 'npm i -g @openai/codex' },
  { id: 'opencode', name: 'OpenCode', installHint: 'npm i -g opencode-ai' },
];

const PROMPTS = {
  form: 'Fill this form with the name Ada Lovelace and the email ada@example.test, then submit it.',
  guide: 'Guide me through changing the delivery address, one step at a time.',
  secret: 'Type the secret code {{SECRET:code}} into the code field and press Check.',
  group: 'Put the open fixture tabs into a tab group called Research.',
  noTools: 'Do not use any tools. Reply with the single word ready.',
  folder: 'List the files in the working folder.',
  contacts: 'Open the contacts page of this site and read the phone number.',
  shop: 'Order the blue T-shirt in size M.',
  mail: 'Archive every newsletter in the inbox.',
  docs: 'Fill the feedback form with my name and a short comment.',
};

const ABOUT_BLANK = 'Chrome does not allow extensions to control about:blank. Navigate to a normal web page first.';
const DEVTOOLS_OFF = 'This tool needs the "Developer tools" feature, which is off. The user can enable it in TabHelm → Settings → Experimental.';
const SINGLE_TAB = 'Single-tab mode is on: work only in this tab — navigate it (browser_navigate) instead of opening or switching tabs.';
const NOT_SELECT = (ref) => `${ref} is not a <select>; click it and pick the option instead.`;

// One chat's journal, written the way the panel writes it.
function chat({ id, start, url, tabId, agent, folder = null, instrumented = false, ext = null }) {
  const journal = [];
  let ms = Date.parse(start);
  let turn = 0;
  const c = {
    id, created: ms, tabId, url, agent: agent.name, folder, journal,
    push(type, data = {}, gap = 2) {
      ms += gap * 1000;
      const e = { ts: new Date(ms).toISOString(), type, ...data };
      if (instrumented && turn) e.turn = turn;
      journal.push(e);
      return c;
    },
    user(text, data = {}) {
      if (instrumented && !data.queued) turn++;
      return c.push('user', { text, attachments: [], ...data }, 5);
    },
    connect(model = 'sonnet') {
      c.push('agent_connected', instrumented ? { agent: agent.name, agentId: agent.id, ext, host: ext, features: ['trimWaits'], autoApprove: false, skills: [] } : { agent: agent.name });
      return c.push('model', { agent: agent.name, model });
    },
    act(tool, args = {}, error = null, extra = {}) {
      const host = instrumented ? { host: extra.host ?? hostOf(url) } : {};
      return c.push('action', { agent: agent.name, tool, args, desc: tool.replace(/^browser_/, ''), ok: !error, error, ...host, ...(instrumented ? { ms: 120 } : {}), ...extra.more }, 2);
    },
    tool(title) {
      return c.push('agent_tool', { agent: agent.name, title, ok: true }, 1);
    },
    // A failure is written right after the error notice that announced it.
    done(text = 'Done.', failure = null, stopReason = failure ? null : 'end_turn') {
      return c.push('agent', { agent: agent.name, model: 'sonnet', text, thought: '', failure, ...(instrumented ? { stopReason } : {}), stats: { ms: 14_500, tokens: null, cost: null, context: null } }, failure ? 0 : 3);
    },
    notice(text, error = false) {
      return c.push('notice', { text, error }, 1);
    },
    save() {
      const { push, user, connect, act, tool, done, notice, save, ...data } = c;
      return { ...data, updated: ms };
    },
  };
  return c;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// e2e pages of the fixture server: a page on 127.0.0.1 with an ephemeral port.
const fixtureUrl = (rand, path) => `http://127.0.0.1:${32768 + Math.floor(rand() * 28000)}/${path}`;

function formSteps(c) {
  return c.act('browser_snapshot').act('browser_type', { ref: 'e3', text: 'Ada Lovelace' }).act('browser_type', { ref: 'e5', text: 'ada@example.test' }).act('browser_click', { ref: 'e9' });
}

// The legacy, test-shaped backup.
function buildLegacy() {
  const rand = rng(20261021);
  const chats = [];
  const day0 = Date.parse('2026-10-13T09:00:00.000Z');
  const kinds = [
    ...Array(62).fill('form'), ...Array(6).fill('guide'), ...Array(6).fill('secret'), ...Array(6).fill('group'),
    ...Array(8).fill('noTools'), ...Array(3).fill('folder'), ...Array(10).fill('contacts'),
  ];
  let restored = 3;
  let extraUsers = 15;
  let skillReads = 2;
  let video = 1;
  kinds.forEach((kind, i) => {
    const n = kinds.slice(0, i).filter((k) => k === kind).length; // index within its kind
    const agent = kind === 'form' && n >= 54 ? AGENTS[n >= 58 ? 2 : 1] : AGENTS[0];
    // The about:blank dead end happened on the last day, after everything else.
    const late = kind === 'contacts' && n >= 8;
    const start = late ? `2026-10-21T${n === 8 ? '13:37' : '14:40'}:00.000Z` : new Date(day0 + Math.floor((i / kinds.length) * 7.9 * 86_400_000)).toISOString();
    const noUrl = kind === 'contacts' && n === 7;
    const folder = kind === 'folder' ? `/tmp/tabhelm-e2e-${1000 + n}/demo-project` : null;
    const c = chat({ id: `c${String(i).padStart(3, '0')}lg`, start, url: noUrl ? null : fixtureUrl(rand, kind), tabId: 900_000 + i, agent, folder });
    c.notice(`Restored ${restored} item(s) from the host backup.`);
    restored = Math.min(110, restored + 1);
    c.connect();
    c.user(PROMPTS[kind]);
    switch (kind) {
      case 'form':
        if (n < 3) {
          // E2E_FAILOVER: the agent is SIGKILLed mid-turn and the user switches agent.
          formSteps(c).notice('ACP connection closed', true).done('', 'ACP connection closed').notice('Agent exited (SIGKILL)', true);
          c.push('agent_switch', { to: 'Codex', reason: 'ACP connection closed' });
        } else if (n < 6) {
          c.act('browser_snapshot').act('browser_fill_form', { fields: [{ ref: 'e3', value: 'Ada Lovelace' }, { ref: 'e5', value: 'ada@example.test' }] }, DEVTOOLS_OFF);
          formSteps(c);
        } else {
          formSteps(c);
          if (n % 3 === 0) c.tool('ToolSearch').tool('execute');
        }
        if (n >= 10 && n < 10 + extraUsers) c.user('Now submit it again with a different email.').act('browser_snapshot');
        break;
      case 'guide':
        c.act('browser_snapshot').act('browser_guide', { steps: [{ text: 'Open the address form' }] });
        for (let k = 0; k < (n < 1 ? 3 : 2); k++) c.push('ask', { kind: 'guide', message: `Step ${k + 1}: press the highlighted button.` });
        if (n < 3) c.push('ask', { kind: 'guide', answer: `Finished (${n === 0 ? 1 : 0} skipped)` });
        break;
      case 'secret':
        if (n === 0) {
          // A single-tab refusal the agent recovers from, in a turn that finished.
          c.act('browser_get_text', { tabId: 7 }, SINGLE_TAB).act('browser_navigate', { url: 'http://127.0.0.1:40000/secret' }).act('browser_snapshot').done('The code was accepted.');
        } else {
          c.act('browser_snapshot').act('browser_type', { ref: 'e4', text: '{{SECRET:code}}' }).act('browser_click', { ref: 'e6' });
          if (n === 1) c.done('Checked.');
          if (n < 3 && skillReads-- > 0) c.act('skill_read', { name: 'fixture-skill' });
        }
        break;
      case 'group':
        c.act('browser_tabs', { action: 'list' }).push('group', {}).tool('Guardian Review');
        break;
      case 'noTools':
        c.tool('Guardian Review').done('ready');
        break;
      case 'folder':
        c.push('folder', { path: folder }).tool('Read').tool('Write');
        if (video-- > 0) c.push('video', { path: `/tmp/tabhelm-e2e-${1000 + n}/videos/run.webm` });
        break;
      case 'contacts':
        if (n === 7) {
          c.act('browser_snapshot').act('browser_click', { ref: 'e2' }).act('browser_snapshot').act('browser_get_text', {}).act('browser_screenshot');
        } else if (n >= 8) {
          // tabs new → go_back lands on about:blank → navigate and go_forward are refused.
          c.act('browser_tabs', { action: 'new' }).act('browser_go_back');
          c.act('browser_navigate', { url: 'http://127.0.0.1:40001/contacts' }, ABOUT_BLANK);
          if (n === 8) c.act('browser_navigate', { url: 'http://127.0.0.1:40001/contacts' }, ABOUT_BLANK);
          c.act('browser_go_forward', {}, ABOUT_BLANK).act('browser_tabs', { action: 'new', url: 'http://127.0.0.1:40001/contacts' });
          c.push('confirm', { title: 'Allow controlling another tab?', detail: 'browser_tabs', answer: 'Auto-approved' });
        } else if (n === 6) {
          c.act('browser_snapshot').act('browser_get_text', { ref: 'e7' });
          c.push('confirm', { title: 'Allow reading the page?', detail: 'browser_get_text', answer: 'Auto-approved' });
        } else {
          // With the single-tab chat these are the 7 navigations that worked (10 in all, 3 refused).
          c.act('browser_navigate', { url: `http://127.0.0.1:40001/contacts/${n}` }).act('browser_snapshot').act('browser_get_text', { ref: 'e7' });
        }
        break;
    }
    chats.push(c.save());
  });
  return dataset(chats, {
    description: 'Shaped like the real backup of 2026-10-21: e2e chats on 127.0.0.1, legacy journals. No real content.',
    env: { ext: '0.31.1', host: '0.31.1', chrome: '141.0.7390.54', platform: 'linux', features: ['trimWaits'], agents: AGENTS },
    versionHistory: [],
  });
}

// The same patterns as real use: public hosts, instrumented journals.
function buildReal() {
  const chats = [];
  const ext = '0.31.0';
  const base = Date.parse('2026-10-18T08:00:00.000Z');
  let i = 0;
  const next = (prompt, url, agent = AGENTS[0]) => {
    const c = chat({ id: `c${String(i).padStart(3, '0')}rl`, start: new Date(base + i * 5 * 3_600_000).toISOString(), url, tabId: 910_000 + i, agent, instrumented: true, ext });
    i++;
    c.connect().user(prompt);
    return c;
  };
  const shop = 'https://shop.example.com/catalog/t-shirts?color=blue';
  // Custom dropdowns on the shop: select_option fails, the agent clicks instead.
  for (let n = 0; n < 2; n++) {
    const c = next(PROMPTS.shop, shop).act('browser_snapshot').act('browser_select_option', { ref: 'e21', values: ['M'] }, NOT_SELECT('e21'));
    if (n === 0) c.act('browser_select_option', { ref: 'e21', values: ['Medium'] }, NOT_SELECT('e21'));
    chats.push(c.act('browser_click', { ref: 'e21' }, null, { more: { label: 'Size' } }).act('browser_click', { ref: 'e33' }, null, { more: { label: 'M' } }).act('browser_click', { ref: 'e40' }, null, { more: { label: 'Add to cart' } }).done('Added to the cart.').save());
  }
  for (let n = 0; n < 2; n++) chats.push(next(PROMPTS.shop, shop).act('browser_navigate', { url: shop }).act('browser_snapshot').act('browser_click', { ref: 'e40' }).done('Done.').save());
  // Failover: the agent process is killed mid-task.
  for (let n = 0; n < 3; n++) {
    const c = next(PROMPTS.mail, 'https://mail.example.org/inbox').act('browser_snapshot').act('browser_click', { ref: 'e11' });
    c.notice('ACP connection closed', true).push('agent_exit', { agent: 'Claude Code', code: null, signal: 'SIGKILL', detail: 'Agent exited (SIGKILL)' }, 0);
    chats.push(c.done('', 'ACP connection closed', null).notice('Agent exited (SIGKILL)', true).push('agent_switch', { to: 'Codex', reason: 'ACP connection closed' }).save());
  }
  // about:blank dead end after go_back from a new tab.
  for (let n = 0; n < 2; n++) {
    const c = next(PROMPTS.contacts, 'https://news.example.com.ua/contacts').act('browser_tabs', { action: 'new' }, null, { host: 'about:blank' }).act('browser_go_back', {}, null, { host: 'about:blank' });
    c.act('browser_navigate', { url: 'https://news.example.com.ua/contacts' }, ABOUT_BLANK, { host: 'about:blank' });
    if (n === 0) c.act('browser_navigate', { url: 'https://news.example.com.ua/contacts' }, ABOUT_BLANK, { host: 'about:blank' });
    chats.push(c.act('browser_go_forward', {}, ABOUT_BLANK, { host: 'about:blank' }).act('browser_tabs', { action: 'new', url: 'https://news.example.com.ua/contacts' }).act('browser_snapshot').done('The number is on the page.').save());
  }
  // fill_form while Developer tools is off; the agent types instead.
  for (let n = 0; n < 3; n++) {
    const c = next(PROMPTS.docs, 'https://docs.example.net/feedback').act('browser_snapshot');
    c.act('browser_fill_form', { fields: [{ ref: 'e3', value: 'Ada' }, { ref: 'e4', value: 'Nice docs' }] }, DEVTOOLS_OFF);
    chats.push(c.act('browser_type', { ref: 'e3', text: 'Ada' }).act('browser_type', { ref: 'e4', text: 'Nice docs' }).act('browser_click', { ref: 'e9' }).done('Sent.').save());
  }
  // Single-tab refusal, recovered.
  chats.push(next(PROMPTS.contacts, 'https://mail.example.org/contacts').act('browser_get_text', { tabId: 7 }, SINGLE_TAB).act('browser_navigate', { url: 'https://mail.example.org/contacts' }).act('browser_snapshot').done('Found it.').save());
  // Guide mode, one step skipped.
  const g = next(PROMPTS.guide, 'https://shop.example.com/account').act('browser_snapshot').act('browser_guide', { steps: [{ text: 'Open the address form' }] });
  chats.push(g.push('ask', { kind: 'guide', message: 'Step 1: open Account.' }).push('ask', { kind: 'guide', message: 'Step 2: press Edit.' }).push('ask', { kind: 'guide', answer: 'Finished (1 skipped)' }).done('Guided.').save());
  // Plain successful tasks; navigate is used 10 times in all, 3 of them refused.
  for (let n = 0; n < 4; n++) chats.push(next(PROMPTS.contacts, `https://docs.example.net/page-${n}`).act('browser_navigate', { url: `https://docs.example.net/page-${n}` }).act('browser_snapshot').act('browser_get_text', {}).done('Read it.').save());
  chats.push(next(PROMPTS.noTools, 'https://docs.example.net/').done('ready').save());
  chats.push(next(PROMPTS.mail, 'https://mail.example.org/inbox', AGENTS[1]).act('browser_snapshot').act('browser_click', { ref: 'e12' }).done('Archived.').save());
  return dataset(chats, {
    description: 'Real-use variant: the golden patterns on public hosts, instrumented journals. No real content.',
    env: { ext, host: ext, chrome: '141.0.7390.54', platform: 'linux', features: ['trimWaits', 'selfAnalysis'], agents: AGENTS },
    versionHistory: [{ v: '0.30.0', at: '2026-10-01T00:00:00.000Z' }, { v: ext, at: '2026-10-14T00:00:00.000Z' }],
  });
}

function dataset(chats, meta) {
  const index = chats.map((c) => ({
    id: c.id, title: c.journal.find((e) => e.type === 'user').text.slice(0, 90), updated: c.updated, created: c.created, tabId: c.tabId, url: c.url,
    pageTitle: 'Fixture page', agent: c.agent, folder: c.folder, messages: c.journal.filter((e) => e.type === 'user').length,
  })).sort((a, b) => b.updated - a.updated);
  return {
    ...meta,
    now: NOW,
    chats,
    index,
    storageIds: chats.map((c) => c.id),
    sizes: Object.fromEntries(chats.map((c) => [c.id, JSON.stringify(c).length])),
  };
}

export function buildGolden() {
  return { legacy: buildLegacy(), real: buildReal() };
}

const serialize = (data) => `${JSON.stringify(data, null, 1)}\n`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const built = buildGolden();
  let stale = 0;
  for (const [key, file] of Object.entries(FILES)) {
    const text = serialize(built[key]);
    if (process.argv.includes('--update')) {
      writeFileSync(file, text);
      console.log(`wrote ${file} (${built[key].chats.length} chats)`);
    } else if (!existsSync(file) || readFileSync(file, 'utf8') !== text) {
      console.error(`${file} is out of date; run with --update`);
      stale++;
    }
  }
  process.exitCode = stale ? 1 : 0;
}

export { serialize };
