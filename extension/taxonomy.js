// Error taxonomy for the self-analysis: one ordered ruleset that turns an error
// text into a category, a stable rule id, a severity and an owner, plus the
// fixed English texts and remedies a finding shows. Pure (no chrome.*, no DOM,
// no clock), so the panel, the service worker and the node tests share it.
// The host never classifies; it only groups and redacts its own log lines.

import { FEATURES } from './features.js';

// Bump by hand whenever RULES or WRAPPERS change meaning; the test fails while
// RULESET_HASH and the rules drift apart, which is the reminder.
export const RULESET_VERSION = 1;

// Ordered: the first match wins. Ids are stable (they go into fingerprints and
// "hidden" state), so rename one only together with a RULESET_VERSION bump.
// `code` is a coarse "file symbol" hint; a test keeps it pointing at real code.
// Adjacent rules with the same category are split only to give finer ids.
export const RULES = [
  { id: 'misuse.chrome-signature', cat: 'AGENT_MISUSE', re: /^Invalid arguments for [\w-]+ \((?:Error in invocation of|[^)]*No matching signature|[^)]*Value must be)/ },
  { id: 'bug.invalid-args', cat: 'TABHELM_BUG', conf: 'medium', code: 'extension/browser-tools.js runTool', re: /^Invalid arguments for (?!tool )[\w-]+ \(/ },
  { id: 'bug.unknown-tool', cat: 'TABHELM_BUG', code: 'host/src/mcp-bridge.js tools', re: /^Unknown (?:tool|memory tool|skill tool) [\w-]+$/ },
  { id: 'bug.frame-1mb', cat: 'TABHELM_BUG', code: 'host/src/native-messaging.js createNativeChannel', re: /exceeded the 1 MB (?:native messaging )?limit and was dropped/ },
  { id: 'bug.host-uncaught', cat: 'TABHELM_BUG', sev: 1, code: 'host/src/native-host.js handleMessageNow', re: /^(?:uncaught|unhandled): |^error handling \w+: (?:TypeError|ReferenceError|RangeError|SyntaxError)/ },
  { id: 'bug.js-error', cat: 'TABHELM_BUG', re: /\b(?:is not a function|is not iterable|is not defined|Cannot read propert(?:y|ies) of (?:undefined|null)|Cannot destructure|Maximum call stack size exceeded)\b/ },
  { id: 'bug.desync', cat: 'TABHELM_BUG', code: 'host/src/session.js prompt', re: /^Agent is still working on the previous message$|^No agent is connected for this tab yet/ },
  { id: 'bug.internal', cat: 'TABHELM_BUG', re: /^Unknown error$|^Unknown session$|^Not a TabHelm recording$|^Bad recording id$|^Recording chunk must be base64 text$|^critic needs an action$/ },
  { id: 'bug.protocol', cat: 'TABHELM_BUG', re: /^unknown message type |^\[native\] bad message: / },
  { id: 'bug.debugger-detached', cat: 'TABHELM_BUG', code: 'extension/cdp.js cdp', re: /Debugger is not attached to the tab with id|Detached while handling command/ },
  { id: 'sched.no-approval', cat: 'SCHEDULE_NO_APPROVAL', re: /^No one could approve "|^needs approval \(scheduled runs cannot ask\)$/ },
  { id: 'policy.block', cat: 'POLICY', re: /^Blocked by (?:site rules|the action critic): / },
  { id: 'user.decision', cat: 'USER_DECISION', re: /^The user (?:did not allow|declined|cancelled|stopped|rejected)\b|^(?:cancelled|Request cancelled.*)$|^Stopped$/ },
  { id: 'flag.off', cat: 'FEATURE_OFF', re: /^This tool needs the "[^"]+" feature, which is off|^Memory is off\./ },
  { id: 'ui.input', cat: 'UI_INPUT', re: /^Up to \d+ (?:files|items) per message|is not supported\. Attach images or text files|^Could not attach "|^Could not add the image: |^Nothing (?:is selected on the page|was picked|was transcribed|to turn into a skill yet)|^This chat is no longer saved|No 1Password logins for this site|^That script no longer exists\.|^That is not a valid link\.|is already in the list\./ },
  { id: 'setup.native-host', cat: 'SETUP', re: /Specified native messaging host not found|Access to the specified native messaging host is forbidden/ },
  { id: 'setup.version', cat: 'SETUP', re: /are different versions\. Run the installer again/ },
  { id: 'setup.spawn', cat: 'SETUP', re: /^Failed to start .+: spawn \S+ (?:ENOENT|EACCES)/ },
  { id: 'setup.agent-missing', cat: 'SETUP', re: / is not installed\. |^No agent is installed|^Unknown agent |^No agents found on PATH/ },
  { id: 'setup.voice', cat: 'SETUP', sev: 3, re: /^Speech recognition: (?:audio-capture|language-not-supported)|^No transcription engine|Speech recognition is not available in this Chrome|^Microphone access needed/ },
  { id: 'setup.provider', cat: 'SETUP', re: /is not configured \(key missing in ~\/\.tabhelm\/env\)|^No model for |^Set TABHELM_OPENAI_BASE_URL|Ollama has no models|offers no tool-calling models|^Unknown provider / },
  { id: 'setup.critic', cat: 'SETUP', sev: 3, re: /\bcritic (?:unavailable|timed out)\b/ },
  { id: 'setup.tools', cat: 'SETUP', sev: 3, re: /1Password CLI \(op\) not found|No folder dialog is available here|^Not a folder: / },
  { id: 'setup.codec', cat: 'SETUP', sev: 3, re: /cannot encode H\.264 or VP9 video/ },
  { id: 'setup.enospc', cat: 'SETUP', sev: 3, re: /ENOSPC: System limit for number of file watchers/ },
  { id: 'setup.skill-url', cat: 'SETUP', sev: 3, re: /^Cannot load skill from \S+: |^Not a GitHub repository URL$|^Use a link to a SKILL\.md file|got a web page, not a SKILL\.md file|file is larger than 200 KB/ },
  { id: 'setup.file-urls', cat: 'SETUP', re: /Cannot access contents of (?:url|the page)[\s\S]*permission/ },
  { id: 'setup.model', cat: 'SETUP', re: /Invalid params: Unknown model |Invalid value for config option / },
  { id: 'quota', cat: 'QUOTA', re: /rate limit|rate[_-]limit|rate-limited|\b429\b|Too many (?:attempts|requests)|usage limit|not enough credits|\b402\b|overloaded|\b529\b|quota/i },
  { id: 'auth.signin', cat: 'AUTH', re: /^Authentication required|needs you to sign in|finish signing in|Sign-in required/ },
  { id: 'auth.key', cat: 'AUTH', re: /rejected the API key \(40[13]\)|Invalid API key|\bUnauthori[sz]ed\b|Please run \/login|\/login\b|not logged in|^Run "op signin"|The relay rejected the pairing code|\bHTTP 40[13]\b|\berror 40[13]: /i },
  { id: 'budget', cat: 'BUDGET', re: /^stopped early \((?:max_tokens|max_turn_requests)\)|prompt is too long|context (?:window|length)|maximum context/i },
  { id: 'refusal', cat: 'MODEL_REFUSAL', re: /^stopped early \(refusal\)/ },
  // The built-in agent built a request the provider rejected; it may also be the provider's fault.
  { id: 'bug.provider-4xx', cat: 'TABHELM_BUG', conf: 'low', code: 'host/src/builtin-agent.js', re: /\berror 4(?:00|04|22): / },
  { id: 'link.host', cat: 'HOST_LINK', re: /^Cannot reach the TabHelm host: |Native host has exited|Error when communicating with the native messaging host|^Host exited$|^TabHelm host unreachable: |^(?:No answer from the host\.|The TabHelm host did not answer\.|no answer from the host)$|^host disconnected$/ },
  { id: 'link.relay', cat: 'HOST_LINK', re: /Paired with the relay, but the remote TabHelm host|^Relay connection closed|^The remote host disconnected$|^relay: (?:disconnected|connect )/ },
  { id: 'crash.agent', cat: 'AGENT_CRASH', re: /ACP connection closed|^Agent exited \(|^the agent exited$|exited during startup|^Failed to start |The Claude Agent session has ended|Session not found|Query closed before response received|^Exited with code \d+|^Internal error$|^agent stopped$/ },
  { id: 'net', cat: 'NETWORK', re: /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH)\b|fetch failed|net::ERR_|socket hang up|stream disconnected|Frame with ID 0 is showing error page|^Cannot list .+ models: |\bHTTP 5\d\d\b|error 5\d\d: |Could not reach the update feed|^Speech recognition: network$/i },
  { id: 'timeout', cat: 'TIMEOUT', re: /^Tool "[^"]+" timed out after \d+s|The guide timed out after 30 minutes|^timed out after 15 minutes$/ },
  { id: 'chrome.restricted', cat: 'CHROME_LIMIT', re: /^Chrome does not allow extensions to control |^Cannot control this tab: |Another debugger \(probably DevTools\) is attached/ },
  { id: 'chrome.window', cat: 'CHROME_LIMIT', re: /Tab groups need a normal Chrome window|Chrome does not allow tab groups in this window|Tabs cannot be edited right now/ },
  { id: 'chrome.render', cat: 'CHROME_LIMIT', re: /Screenshot timed out\. Background tabs may not render|Unable to capture screenshot|the tab did not render any frames/ },
  { id: 'chrome.script', cat: 'CHROME_LIMIT', re: /The extensions gallery cannot be scripted|Cannot access a (?:chrome|chrome-extension|devtools|chrome-untrusted):\/\/ URL|cannot be scripted due to an ExtensionsSettings policy|Cannot attach to this target|^Cannot capture the tab's audio: |Elements can be picked only on web pages/ },
  { id: 'gap.iframe', cat: 'TABHELM_GAP', re: /File inputs inside iframes are not supported yet|DOM click: iframe position unknown/ },
  { id: 'page.dialog-or-closed', cat: 'PAGE_STATE', re: /A JavaScript (?:alert|confirm|prompt|beforeunload) dialog is blocking the page|^The tab was closed\.$|^No tab \d+|^No tab with id|^Tab \d+ of step \d+ is gone/ },
  { id: 'page.navigating', cat: 'PAGE_STATE', re: /The page did not respond \(it may be navigating\)|Could not read the page \(it may still be loading\)|Cannot find context with specified id|Execution context was destroyed|Inspected target navigated or closed|No frame with id \d+|frame was removed|Frame with ID \d+ was removed/i },
  { id: 'page.stale-ref', cat: 'PAGE_ELEMENT', re: /^Ref \S+ is stale or unknown/ },
  { id: 'page.not-select', cat: 'PAGE_ELEMENT', re: /is not a <select>|^No option matching / },
  { id: 'page.element', cat: 'PAGE_ELEMENT', re: /^Element \S+ is not visible \(zero size\)|is not a file input|^Could not find the file input|^Cannot position \S+: it is inside a cross-origin iframe/ },
  { id: 'page.element-soft', cat: 'PAGE_ELEMENT', re: /Warning: the point was covered by|No visible element contains |did not appear within 30s|Could not compute box model|Node does not have a layout object|No node with given id/ },
  { id: 'misuse.ref', cat: 'AGENT_MISUSE', re: /^Invalid ref "|^Provide .+: a ref or x\/y coordinates\.$|^Unknown modifier in "|^Unsupported key "|^action must be list, new, switch or close\.$/ },
  { id: 'misuse.args', cat: 'AGENT_MISUSE', re: /^paths must list at least one absolute file path|needs fields: \[\{ ref, value \}|needs refs: \[|^Give js and\/or css\.$|^key is required$|^skill_save needs a name|^Pass the ref of a file input/ },
  { id: 'misuse.no-skill', cat: 'AGENT_MISUSE', re: /^No skill named "/ },
  { id: 'misuse.lookup', cat: 'AGENT_MISUSE', re: /^No captured request containing |^No page script named "/ },
  { id: 'misuse.single-tab', cat: 'AGENT_MISUSE', re: /^Single-tab mode is on: work only in this tab/ },
  { id: 'misuse.tabs', cat: 'AGENT_MISUSE', re: /^The chat tab cannot be closed by the agent|^Only tabs the agent opened or was allowed to control can be closed|^Step \d+ points at tab \d+, which this chat cannot use/ },
  { id: 'misuse.mcp', cat: 'AGENT_MISUSE', re: /Input validation error: Invalid arguments for tool |^MCP error -32602|^Error: arguments for \S+ were not valid JSON|^Error: unknown tool / },
  { id: 'misuse.other', cat: 'AGENT_MISUSE', re: /^Use a path relative to the skill folder|has no extra files|^Empty note$|^There is no (?:next|previous) page in this tab/ },
];

// Wrappers whose inner message carries the real cause.
export const WRAPPERS = [
  /^Recording failed: ([\s\S]+)$/, /^Script “[^”]*” failed: ([\s\S]+)$/, /^Transcription failed: ([\s\S]+)$/,
  /^Cannot pick on this page: ([\s\S]+)$/, /^Cannot read the selection on this page: ([\s\S]+)$/,
  /^Could not encode the video: ([\s\S]+)$/, /^.{1,60} stopped before finishing: ([\s\S]+)$/,
  /^auto-click failed: ([\s\S]+)$/, /^Scheduled run of "[^"]*" failed: ([\s\S]+)$/,
];
// Indexes into WRAPPERS that also say where the error came from.
const PAGE_SCRIPT_WRAPPER = 1;
const SCHEDULED_WRAPPER = 8;

// Rules that only the context overrides in classify() produce. Same shape as RULES.
export const OVERRIDES = [
  { id: 'misuse.page-script', cat: 'AGENT_MISUSE' },
  // Inferred from the chat being scheduled, not from the text itself.
  { id: 'sched.user-decision', cat: 'SCHEDULE_NO_APPROVAL', conf: 'medium' },
  { id: 'crash.agent-stderr', cat: 'AGENT_CRASH' },
];

export const UNCLASSIFIED = { id: 'unclassified', cat: 'UNCLASSIFIED', conf: 'low' };

// FNV-1a, 32 bit, over UTF-16 code units; 8 lowercase hex digits.
export function fnv1a32(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Committed on purpose: a test recomputes it, so editing a rule without
// updating this (and RULESET_VERSION) fails loudly.
export const RULESET_HASH = 'd8dbf172';

export const rulesetHash = (rules = RULES) => fnv1a32(rules.map((r) => r.id + r.cat + r.re).join('\n'));

// host.log lines that look like errors but are routine. The session-title line
// carries "Query closed before response received" and would otherwise count as
// AGENT_CRASH about a hundred times.
export const LOG_NOISE = /^(?:relay: (?:connected|panel|paired|pairing)|recording (?:saved|deleted)|\[[\w-]+:\d+\] (?:Unexpected case|\[session\/|.*failed to generate a session title))/;

// A user message that says the last attempt went wrong. Plain \b does not work
// after Cyrillic letters, hence the \p{L} lookarounds. Low confidence: used only
// right after a failed or empty turn.
export const COMPLAINT_RE = /(?<!\p{L})(?:не (?:працює|спрацювал\p{L}*|вийшло|так|те)|зламал\p{L}*|помилк\p{L}*|не работает|не получилось|знову|ще раз)(?!\p{L})|\b(?:doesn'?t work|didn'?t work|not working|broken|wrong|bug|try again)\b/iu;

export const BASE_SEVERITY = {
  TABHELM_BUG: 2, AGENT_CRASH: 2, HOST_LINK: 2, SETUP: 2, AUTH: 2,
  QUOTA: 3, NETWORK: 3, TIMEOUT: 3, BUDGET: 3, TABHELM_GAP: 3, SCHEDULE_NO_APPROVAL: 3, UNCLASSIFIED: 3,
  MODEL_REFUSAL: 4, CHROME_LIMIT: 4, PAGE_STATE: 4, PAGE_ELEMENT: 4, AGENT_MISUSE: 4, FEATURE_OFF: 4,
  POLICY: 5, USER_DECISION: 5, UI_INPUT: 5,
  // Derived by the detectors, not by RULES.
  LOOP: 3, MISSING_KNOWLEDGE: 3, SKILL_UNUSED: 3, SKILL_STALE: 3, IGNORED_SNAPSHOT: 4, DATA_QUALITY: 4,
};

// Who can fix it. PAGE_* are 'site' until the missing-knowledge detectors
// promote them; AGENT_MISUSE is 'agent' until 2 agents share it (preamble_gap).
export const OWNER_OF = {
  TABHELM_BUG: 'tabhelm', TABHELM_GAP: 'tabhelm', UNCLASSIFIED: 'tabhelm', SCHEDULE_NO_APPROVAL: 'tabhelm', DATA_QUALITY: 'tabhelm',
  MISSING_KNOWLEDGE: 'knowledge', SKILL_UNUSED: 'knowledge', SKILL_STALE: 'knowledge',
  AGENT_MISUSE: 'agent', LOOP: 'agent', IGNORED_SNAPSHOT: 'agent', BUDGET: 'agent', MODEL_REFUSAL: 'agent', AGENT_CRASH: 'agent',
  SETUP: 'setup', AUTH: 'setup', QUOTA: 'setup', NETWORK: 'setup', HOST_LINK: 'setup', CHROME_LIMIT: 'setup', TIMEOUT: 'setup', FEATURE_OFF: 'setup',
  PAGE_ELEMENT: 'site', PAGE_STATE: 'site',
  POLICY: 'expected', USER_DECISION: 'expected', UI_INPUT: 'expected',
};

// Rule-level owners that differ from their category's (spec 6.11).
const RULE_OWNER = {
  'preamble_gap': 'tabhelm', 'mk.restricted-start': 'tabhelm',
  'critic.fp': 'setup', 'inv.version-mismatch': 'setup', 'live.host-offline': 'setup', 'live.version': 'setup',
  'log.enospc': 'setup', 'log.agent-auth': 'setup',
  'health.agent': 'agent', 'health.crash': 'agent', 'log.agent-crash': 'agent',
};
const PREFIX_OWNER = [['probe.', 'tabhelm'], ['inv.', 'tabhelm'], ['rt.', 'tabhelm'], ['log.', 'tabhelm'], ['live.', 'tabhelm'], ['mk.', 'knowledge'], ['skill.', 'knowledge']];

export function ownerFor(category, rule) {
  const id = String(rule || '');
  if (RULE_OWNER[id]) return RULE_OWNER[id];
  const prefixed = PREFIX_OWNER.find(([p]) => id.startsWith(p));
  if (prefixed) return prefixed[1];
  return OWNER_OF[category] || 'tabhelm';
}

// Strips known wrappers (at most 3 levels) and remembers which ones it saw.
function peel(text) {
  let inner = String(text ?? '').trim();
  const seen = [];
  for (let i = 0; i < 3; i++) {
    const k = WRAPPERS.findIndex((re) => re.test(inner));
    if (k < 0) break;
    seen.push(k);
    inner = WRAPPERS[k].exec(inner)[1].trim();
  }
  return { inner, seen };
}

export const unwrap = (text) => peel(text).inner;

const PAGE_SCRIPT_TOOLS = new Set(['browser_evaluate', 'browser_script_run']);
const PAGE_EXCEPTION_RE = /^(?:\w*Error\b|Uncaught)/;
// Engine messages whose wording is fixed (V8/Blink); any other text a page
// script throws is the page's or the script's own and may be personal.
const ENGINE_MESSAGES = [
  ['TypeError', /^Cannot (?:read|set) propert(?:y|ies) of (?:null|undefined)(?: \((?:reading|setting) '[\w$]{1,40}'\))?/],
  ['TypeError', /^[\w$.]{1,60} is not (?:a function|a constructor|iterable|an object)/],
  ['TypeError', /^Assignment to constant variable/],
  ['TypeError', /^Failed to fetch/],
  ['ReferenceError', /^[\w$]{1,60} is not defined/],
  ['SyntaxError', /^Unexpected (?:token|identifier|end of input|string|number|strict mode reserved word)\b(?: '[^'\s]{1,3}')?/],
  ['SyntaxError', /^(?:Invalid or unexpected token|Illegal (?:return|break|continue) statement)/],
  ['RangeError', /^Maximum call stack size exceeded/],
  [/^(?:\w+Error|DOMException)$/, /^Failed to execute '\w{1,40}' on '\w{1,40}'/],
];

// A page script's exception reduced to its error type plus a known engine
// message ("TypeError: Cannot read properties of null (reading 'x')");
// anything else becomes "<Type>: …".
export function pageErrorShape(text) {
  const first = String(text || '').split('\n')[0].replace(/^Uncaught\s+(?:\(in promise\)\s+)?/, '');
  const m = /^(\w*(?:Error|Exception))(?::\s*(.*))?$/.exec(first);
  if (!m) return 'Error: …';
  const known = m[2] && ENGINE_MESSAGES.filter(([type]) => (typeof type === 'string' ? type === m[1] : type.test(m[1]))).map(([, re]) => re.exec(m[2])?.[0]).find(Boolean);
  return known ? `${m[1]}: ${known}` : m[2] ? `${m[1]}: …` : m[1];
}
const OVERRIDE = Object.fromEntries(OVERRIDES.map((r) => [r.id, r]));

function result(rule, inner) {
  return {
    category: rule.cat,
    rule: rule.id,
    inner,
    confidence: rule.conf || 'high',
    code: rule.code || null,
    severity: rule.sev || BASE_SEVERITY[rule.cat] || 3,
    owner: ownerFor(rule.cat, rule.id),
  };
}

// ctx: { source, tool, scheduled, kind } (all optional). source is the event
// source letter (A F N C P T E W X L S); kind is the host.log line kind.
export function classify(text, ctx) {
  const c = ctx || {};
  const { inner, seen } = peel(text);
  // A page's own JS exception (browser_evaluate, page scripts) is the script's
  // fault, not TabHelm's, although it reads like "x is not a function".
  const pageScript = c.source === 'P' || PAGE_SCRIPT_TOOLS.has(c.tool) || seen.includes(PAGE_SCRIPT_WRAPPER);
  if (pageScript && PAGE_EXCEPTION_RE.test(inner)) return result(OVERRIDE['misuse.page-script'], pageErrorShape(inner));
  const rule = RULES.find((r) => r.re.test(inner));
  if (!rule) return result(UNCLASSIFIED, inner);
  // Nobody can answer a confirmation in a scheduled run, yet it reads "The user …".
  const scheduled = c.scheduled || seen.includes(SCHEDULED_WRAPPER);
  if (scheduled && rule.cat === 'USER_DECISION') return result(OVERRIDE['sched.user-decision'], inner);
  // A JS error on an agent's stderr is the agent crashing, not the host.
  if (c.source === 'L' && c.kind === 'agent_stderr' && (rule.id === 'bug.js-error' || rule.id === 'bug.host-uncaught')) {
    return result(OVERRIDE['crash.agent-stderr'], inner);
  }
  return result(rule, inner);
}

// Stems of the user's own words ("не працює вибір розміру") mapped to the
// parts of a finding they point at; used to rank findings (problemMatch).
export const COMPONENT_STEMS = [
  { re: /істор|history|збер|save/i, kinds: ['probe', 'invariant', 'live'], categories: [], rules: [], tools: [] },
  { re: /експорт|export/i, kinds: ['probe'], categories: [], rules: [], tools: [] },
  { re: /запуск|старт|start|connect|підключ|offline/i, kinds: [], categories: ['AGENT_CRASH', 'HOST_LINK', 'SETUP', 'AUTH'], rules: [], tools: [] },
  { re: /логін|увійт|sign.?in|login|ключ|key/i, kinds: [], categories: ['AUTH'], rules: [], tools: [] },
  // вибір/вибра/вибер/option go beyond the spec's stems: "не працює вибір розміру" names no widget.
  { re: /список|dropdown|select|випада|вибір|вибра|вибер|option/i, kinds: [], categories: [], rules: ['page.not-select', 'mk.dropdown'], tools: [] },
  { re: /файл|upload|завантаж/i, kinds: [], categories: [], rules: [], tools: ['browser_upload_file'] },
  { re: /розклад|schedul/i, kinds: [], categories: ['SCHEDULE_NO_APPROVAL'], rules: [], tools: [] },
  { re: /скіл|skill|навич|знан/i, kinds: [], categories: ['MISSING_KNOWLEDGE', 'SKILL_UNUSED', 'SKILL_STALE'], rules: [], tools: [] },
  { re: /повільн|slow|завис|hang|stuck|чека/i, kinds: ['live'], categories: ['TIMEOUT', 'LOOP'], rules: [], tools: [] },
  { re: /клік|click|кнопк|button/i, kinds: [], categories: [], rules: [], tools: ['browser_click'] },
  { re: /форм|form|введ|type/i, kinds: [], categories: [], rules: [], tools: ['browser_type', 'browser_fill_form'] },
];

// Does the user's problem text point at this finding through a component stem?
export function componentMatch(problem, finding) {
  const text = String(problem || '');
  if (!text) return false;
  return COMPONENT_STEMS.some((s) => s.re.test(text) && (
    s.kinds.includes(finding.kind) || s.categories.includes(finding.category) || s.rules.includes(finding.rule)
    || (finding.tools || []).some((t) => s.tools.includes(t))));
}

// Checklist lines for skill drafts, keyed by the rule that failed.
export const TIPS = {
  'page.stale-ref': 'Take a new browser_snapshot after every navigation or page change before using refs.',
  'page.not-select': 'Dropdowns are custom widgets: click the field, then click the option text (browser_find it if it is not in the snapshot).',
  'page.navigating': 'Wait for the page to finish loading (browser_wait for a text you expect) before acting.',
  'page.dialog-or-closed': 'Handle blocking dialogs with browser_handle_dialog first.',
  'page.element-soft': 'Close overlays or banners covering the element, or scroll it into view.',
  'chrome.restricted': 'Navigate to a normal web page first.',
  'misuse.single-tab': 'Navigate this tab instead of opening new ones.',
};

// Where TabHelm tells agents how to use a tool, for findings that blame
// TabHelm's instructions rather than one agent (preamble_gap).
const BRIDGE_TOOLS = 'host/src/mcp-bridge.js tools';
export const PREAMBLE_HINTS = {
  'misuse.ref': { code: ['host/src/session.js BROWSER_PREAMBLE', BRIDGE_TOOLS], what: 'the ref format, and the browser_press_key key list' },
  'misuse.args': { code: [BRIDGE_TOOLS], what: "that tool's schema and description" },
  'misuse.mcp': { code: [BRIDGE_TOOLS], what: "that tool's schema and description" },
  'misuse.tabs': { code: ['host/src/session.js prompt'], what: 'the tab rules' },
  'mk.restricted-start': { code: ['host/src/session.js BROWSER_PREAMBLE'], what: 'start on a normal web page, not about:blank or chrome://' },
  // Not in the spec table; every other misuse rule can also reach preamble_gap.
  'misuse.chrome-signature': { code: [BRIDGE_TOOLS], what: "that tool's required arguments" },
  'misuse.no-skill': { code: ['host/src/skills.js skillsPreamble'], what: 'how installed skills are listed' },
  'misuse.lookup': { code: [BRIDGE_TOOLS], what: "that tool's description" },
  'misuse.other': { code: [BRIDGE_TOOLS], what: "that tool's description" },
  'misuse.page-script': { code: [BRIDGE_TOOLS], what: 'the browser_evaluate description' },
  'skill.unused': { code: ['host/src/skills.js skillsPreamble'], what: 'when agents should read a skill' },
};

// Feature named in a FEATURE_OFF message ("…needs the "Developer tools" feature…",
// "Memory is off."), or null.
export function featureOf(text) {
  const s = String(text || '');
  const name = /needs the "([^"]+)" feature/.exec(s)?.[1] || (/^Memory is off\./.test(s) ? 'Memory' : null);
  if (!name) return null;
  return FEATURES.find((f) => f.name === name || f.id === name) || null;
}

// ---- Finding texts ----
// ctx holds normalized, redacted values only: { tool, host, message, agent,
// model, count, chats, agents, category, scope, feature, skill, entryType,
// hostVersion, extVersion, other: { id, name }, best: { id, name }, installHint,
// rate, calls, provider, code, cardKind, cardTitle, minutes, bytes, panel, chatId }.
// Local-only extras: inner (raw unwrapped text; read for the feature name, never
// shown), chatId, cardTitle. Missing values fall back to generic words.

const val = (v, d) => (v === undefined || v === null || v === '' ? d : v);
const times = (n) => (n > 1 ? ` (${n}×)` : '');
const toolOf = (c) => val(c.tool, 'a tool');
const siteOf = (c) => val(c.host, 'this site');
const agentOf = (c) => val(c.agent, 'The agent');
const agentModel = (c) => `${agentOf(c)}${c.model ? ` (${c.model})` : ''}`;
const msgOf = (c) => val(c.message, 'no details');

const INSTALL_HOST = 'npm run install-host';
const INOTIFY = 'echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf && sudo sysctl -p';

// Action builders; `label` is the button text. Settings targets are
// 'experimental:<flag id>' or a Settings section id ('skills').
const act = {
  bugReport: () => ({ kind: 'copy_bug_report', label: 'Copy bug report' }),
  featureRequest: () => ({ kind: 'copy_bug_report', label: 'Copy feature request' }),
  command: (text, label = `Copy “${text}”`) => ({ kind: 'copy_command', text, label }),
  installHost: () => act.command(INSTALL_HOST),
  extensions: () => ({ kind: 'open_extensions', label: 'Open extensions' }),
  flag: (id, name) => ({ kind: 'open_settings', target: `experimental:${id}`, label: `Open Experimental → ${name}` }),
  skills: () => ({ kind: 'open_settings', target: 'skills', label: 'Open Skills' }),
  skillDraft: (label = 'Draft a skill') => ({ kind: 'skill_draft', label }),
  skillWithAgent: () => ({ kind: 'skill_with_agent', label: 'Ask the agent to write a skill' }),
  askAgent: () => ({ kind: 'ask_agent', label: 'Ask the agent' }),
  hide: () => ({ kind: 'hide', label: 'Hide' }),
  stop: () => ({ kind: 'stop', label: 'Stop' }),
};
const useAgent = (a, suffix = '') => (a?.id ? [{ kind: 'use_agent', agentId: a.id, label: `Use ${val(a.name, a.id)}${suffix}` }] : []);
// A memory note is per site, so there is none to offer without a host.
const memory = (c, text) => (c.host ? [{ kind: 'memory_note', host: c.host, text, label: 'Remember for this site' }] : []);
const openChat = (c) => (c.chatId ? [{ kind: 'open_chat', chatId: c.chatId, label: 'Open chat' }] : []);
const updateAgent = (c) => (c.installHint ? [act.command(c.installHint, 'Copy the update command')] : []);

function make(title, explain, type, text, actions = []) {
  return { title, explain, remedy: { type, text, actions }, actions };
}

const tabhelmBug = (title, explain) => () => make(title, explain, 'tabhelm_fix', 'TabHelm hit an internal error; the agent is not at fault.', [act.bugReport()]);
const insideTabhelm = (c) => make(`${toolOf(c)} failed inside TabHelm`, `TabHelm's own code threw while running ${toolOf(c)}: ${msgOf(c)}.`, 'tabhelm_fix', 'TabHelm hit an internal error; the agent is not at fault.', [act.bugReport()]);
const hostCrashed = (c) => make(`The TabHelm host crashed: ${msgOf(c)}`, 'The host process hit an error it did not handle; running tasks may have stopped.', 'tabhelm_fix', 'This is a TabHelm bug. Send a bug report.', [act.bugReport()]);
const notSaving = (c) => make(
  c.scope && c.scope !== 'chat' && c.count > 1 ? `How tasks ended was not saved (${c.count} tasks)` : 'This chat is not being saved',
  'The panel stopped writing this chat to storage, so its last steps or outcome are missing.',
  'user_action', 'Close and reopen the side panel.', [act.bugReport()]);
const versions = (c) => make(
  c.hostVersion && c.extVersion ? `Host ${c.hostVersion} and extension ${c.extVersion} differ` : 'The host and the extension are different versions',
  'An older host or extension may not know newer tools and messages.',
  'command', 'Run the installer again, then reload TabHelm on chrome://extensions.', [act.installHost(), act.extensions()]);
const hostLink = (c) => (c.category === 'TABHELM_BUG'
  ? make('The TabHelm host crashed and the panel lost it', 'The connection dropped right after the host logged an uncaught error.', 'tabhelm_fix', 'This is a TabHelm bug. Send a bug report.', [act.bugReport()])
  : make('Cannot reach the TabHelm host', 'The panel could not talk to the host (or the remote host behind the relay).', 'command', 'Reinstall the host, then reopen the panel. For a remote host, check that it is running.', [act.installHost()]));
const crashed = (c) => make(
  c.code === 0 ? `${agentOf(c)} quit${times(c.count)}` : `${agentOf(c)} crashed${c.count ? ` ${c.count}×` : ''}`,
  'The agent process or its connection ended in the middle of a task.',
  'agent_choice', 'Update the agent, or use another agent for new chats.', [...useAgent(c.other, ' for new chats'), ...updateAgent(c)]);
const signIn = (c) => make(`${agentOf(c)} needs you to sign in`, 'The agent or its model provider rejected the sign-in or the API key.', 'user_action',
  `Run ${c.agent || 'the agent'} in a terminal and sign in (for the built-in agent: npm run set-key -- <provider>).`, []);
const misuse = (c) => make(`${agentModel(c)} misuses ${toolOf(c)}`, `The agent called ${toolOf(c)} wrongly: ${msgOf(c)}.`, 'skill',
  'A skill can show the agent the right way, or another agent may handle it better.', [act.skillDraft(), ...useAgent(c.other)]);
const pageTip = (title, rule) => (c) => make(`${siteOf(c)}: ${title}`, `${toolOf(c)} failed: ${msgOf(c)}.`, 'skill', TIPS[rule] || 'A skill for this site can tell the agent how it works.', [act.skillDraft(), act.hide()]);
const chromeTip = (tip) => (c) => make(`Chrome blocked ${toolOf(c)}`, `Chrome does not let extensions do this here: ${msgOf(c)}.`, 'user_action', tip, [act.hide()]);
const expected = (title) => () => make(title, 'Counted, but not a problem.', 'none', '', []);
const setupFix = (title, explain, text, actions = []) => () => make(title, explain, 'user_action', text, actions);
const gap = (c) => make(`${siteOf(c)}: not supported yet (${msgOf(c)})`, 'TabHelm cannot do this yet.', 'tabhelm_fix', 'Ask for it in a feature request.', [act.featureRequest()]);
// By rule, not by count: every finding has a count, the unavailable one too.
const critic = (title, explain) => make(title, explain, 'setting', 'Pick another critic model or provider.', [act.flag('critic', 'Action critic')]);
const criticDown = () => critic('The action critic was unavailable', 'The critic model could not answer (unreachable or too slow), so actions waited for you.');
const criticStrict = (c) => critic(`The action critic blocked actions you then allowed${c.count ? ` (${c.count}×)` : ''}`, 'The critic kept stopping actions you approved.');
const sched = () => make('A scheduled task needed an approval nobody could give', 'Scheduled runs have no panel, so nobody can answer a confirmation.', 'setting',
  'Scheduled runs cannot answer confirmations (JS on the page, other tabs, uploads). Change the task so it does not need them.', [act.flag('schedules', 'Scheduled tasks')]);
const enospc = setupFix('File-watcher limit reached', 'An agent could not watch its files because the system limit is too low.', 'Raise the inotify limit.', [act.command(INOTIFY, 'Copy the command')]);
const unclassified = () => make('Unrecognised error', 'No rule knows this error yet.', 'tabhelm_fix', 'Send a bug report so TabHelm learns it.', [act.bugReport()]);
const probe = (c) => make(`Opening or exporting saved chats fails on “${val(c.entryType, 'some')}” entries`, 'TabHelm cannot replay or export a kind of saved entry; those chats may open half empty.', 'tabhelm_fix', 'This is a TabHelm bug. Send a bug report.', [act.bugReport()]);
const runtime = (panel) => (c) => make(`TabHelm's ${val(c.panel, panel)} threw`, `An error escaped TabHelm's ${val(c.panel, panel)}: ${msgOf(c)}.`, 'tabhelm_fix', 'This is a TabHelm bug. Send a bug report.', [act.bugReport()]);

export const TEMPLATES = {
  // TabHelm bugs
  'bug.invalid-args': insideTabhelm,
  'bug.js-error': insideTabhelm,
  'bug.unknown-tool': (c) => make(`Agent and extension disagree about ${toolOf(c)}`, 'The host offered a tool the extension does not know (or the other way round).', 'command',
    'Reinstall the host, then reload the extension.', [act.installHost(), act.extensions(), act.bugReport()]),
  'bug.frame-1mb': tabhelmBug('A message was too big for Chrome (1 MB limit)', 'Chrome drops native messages over 1 MB, so a result never arrived.'),
  'bug.host-uncaught': hostCrashed,
  'bug.desync': tabhelmBug('The panel and the agent got out of sync', 'The panel sent a message while the agent was still busy, or before it had started.'),
  'bug.internal': (c) => make(`TabHelm hit an internal error: ${msgOf(c)}`, 'An internal check in TabHelm failed.', 'tabhelm_fix', 'TabHelm hit an internal error; the agent is not at fault.', [act.bugReport()]),
  'bug.protocol': () => make('Host and extension disagree about a message', 'One side sent a message the other does not understand, usually after a partial update.', 'command',
    'Reinstall the host, then reload the extension.', [act.installHost(), act.extensions(), act.bugReport()]),
  'bug.debugger-detached': tabhelmBug('TabHelm lost the debugger connection to the tab', 'The tab detached the debugger while TabHelm was using it.'),
  'bug.provider-4xx': tabhelmBug('The model provider rejected TabHelm\'s request', 'The built-in agent sent a request the provider refused (it may also be the provider\'s fault).'),
  'timeout': (c) => (c.category === 'TABHELM_BUG'
    ? make(`${toolOf(c)} hung inside TabHelm`, 'The tool never finished, and it was not waiting for you.', 'tabhelm_fix', 'This is a TabHelm bug. Send a bug report.', [act.bugReport()])
    : make(`${toolOf(c)} timed out`, 'It usually waited for an answer that never came.', 'user_action', 'Answer confirmations in the panel while a task runs, or change scheduled tasks so they do not need you.', [])),
  'unclassified': unclassified,
  'rt.panel-error': runtime('panel'),
  'rt.sw-error': runtime('service worker'),
  'probe.replay': probe,
  'probe.export': probe,
  'probe.context': probe,
  'live.replay-stuck': notSaving,
  'live.not-saving': notSaving,
  'inv.lost-outcome': notSaving,
  'inv.empty-error': (c) => make(`A failed step was saved without an error text${times(c.count)}`, 'TabHelm recorded a failure but not why it failed.', 'tabhelm_fix', 'This is a TabHelm bug. Send a bug report.', [act.bugReport()]),
  'inv.index-desync': () => make('The chat list and the saved chats disagree', 'History lists a chat that is missing, or a saved chat is not listed.', 'tabhelm_fix', 'This is a TabHelm bug. Send a bug report.', [act.bugReport()]),
  'inv.too-big': (c) => make(`${val(c.count, 'Some')} chats are too big for the host backup`,
    `They will not be restored from the host backup.${c.bytes > 2_000_000 ? ' Very large chats also slow down the panel.' : ''}`, 'user_action', 'Export them (History → ⬇) and delete them.', []),
  'inv.test-chats': (c) => make(`${val(c.count, 'Some')} test chats are in your history`, 'Chats from automated tests are left out of the report.', 'user_action', 'Delete them in History if you do not need them.', [act.hide()]),
  'log.uncaught': hostCrashed,
  'log.error-handling': (c) => make(`The TabHelm host failed to handle a message: ${msgOf(c)}`, 'A JavaScript error escaped the host while it handled a request.', 'tabhelm_fix', 'This is a TabHelm bug. Send a bug report.', [act.bugReport()]),
  'log.tool-error': (c) => make(`${toolOf(c)} failed in the host`, msgOf(c), 'tabhelm_fix', 'Send a bug report if it keeps happening.', [act.bugReport()]),
  'log.unknown-type': () => make('Host and extension disagree about a message', 'The host got a message type it does not know, usually after a partial update.', 'command',
    'Reinstall the host, then reload the extension.', [act.installHost(), act.extensions()]),
  'log.relay-orphan': (c) => make(`An old TabHelm host kept retrying a relay that is gone${c.count ? ` (${c.count} tries)` : ''}`, 'A host process outlived its relay and retries forever.', 'user_action', 'Stop old relay/host processes.', [act.bugReport()]),
  // "host.log in ~/.tabhelm", not the full path: exports redact paths, which
  // would turn the advice into "Delete <path>.log".
  'log.pairing-codes': () => make('Older host.log lines contain relay pairing codes', 'Older host.log lines contain relay pairing codes (expired); delete host.log in ~/.tabhelm if you share this machine.', 'user_action', 'Delete host.log in ~/.tabhelm if you share this machine.', []),
  'gap.iframe': gap,
  'gap.dom-click': gap,
  'mk.restricted-start': () => make('Agents start on blank or chrome:// pages', 'Agents act before opening a normal web page, and Chrome blocks them there.', 'preamble',
    'TabHelm instruction gap: tell agents to open a web page first.', [act.bugReport()]),
  'preamble_gap': (c) => make(`${val(c.agents, 'Several')} agents misuse ${toolOf(c)}: ${msgOf(c)}`, 'Different agents make the same mistake, so TabHelm\'s tool description or instructions are unclear.', 'preamble',
    'TabHelm\'s tool description or instructions are unclear.', [act.bugReport()]),
  'sched.no-approval': sched,
  'sched.user-decision': sched,
  // Knowledge
  'mk.repeat': (c) => make(`${siteOf(c)}: ${toolOf(c)} keeps failing (${msgOf(c)})`, 'The same step fails on this site in several chats.', 'skill',
    'The agent does not know how this site works; a skill or a memory note fixes it for next time.',
    [act.skillDraft(), act.skillWithAgent(), ...memory(c, `On ${siteOf(c)}, ${toolOf(c)} often fails (${msgOf(c)}).`)]),
  'mk.dropdown': (c) => make(`${siteOf(c)}: dropdowns are custom widgets, not <select>`, 'The agent tried to pick options as if they were native dropdowns.', 'memory',
    `On ${siteOf(c)}, dropdowns are not <select>: click the field, then click the option text.`,
    [...memory(c, `On ${siteOf(c)}, dropdowns are not <select>: click the field, then click the option text.`), act.skillDraft()]),
  'mk.handoff': (c) => make(`You had to take over on ${siteOf(c)}${times(c.count)}`, 'The agent handed the task to you or to another agent on this site.', 'skill',
    'A skill can teach the agent the steps you did yourself.', [act.skillWithAgent(), ...openChat(c)]),
  'mk.correction': (c) => make(`You corrected the agent after it failed on ${siteOf(c)}${times(c.count)}`, 'Your next message said the last attempt was wrong.', 'skill',
    'A skill can keep the agent from repeating it.', [act.skillDraft(), act.askAgent()]),
  'mk.no-skill': () => make('The agent looked for a skill that is not installed', 'A skill was asked for by name, or its link could not be loaded.', 'setting', 'Install the skill, or fix its link.', [act.skills()]),
  'skill.unused': (c) => make(`Skill “${val(c.skill, 'a skill')}” was not used on ${siteOf(c)}`, 'A matching skill was enabled, but the agent failed before reading it.', 'skill',
    'Name the site in the skill\'s description so agents know when to read it.', [act.skills()]),
  'skill.stale': (c) => make(`Skill “${val(c.skill, 'a skill')}” does not cover what fails on ${siteOf(c)}`, 'The agent read the skill and still hit the same error.', 'skill',
    'Add what fails to the skill.', [act.skillDraft('Draft additions'), act.skills()]),
  // Agent
  'crash.agent': crashed,
  'crash.agent-stderr': crashed,
  'health.crash': crashed,
  'log.agent-crash': crashed,
  'misuse.chrome-signature': misuse,
  'misuse.ref': misuse,
  'misuse.args': misuse,
  'misuse.no-skill': (c) => make('The agent looked for a skill that is not installed', `The agent asked for a skill by name: ${msgOf(c)}.`, 'setting', 'Install the skill, or tell the agent which skills exist.', [act.skills()]),
  'misuse.lookup': misuse,
  'misuse.single-tab': (c) => make(`${agentModel(c)} tried to leave this tab in single-tab mode`, 'Single-tab mode keeps the agent in the chat tab.', 'skill', TIPS['misuse.single-tab'], [act.hide()]),
  'misuse.tabs': misuse,
  'misuse.mcp': misuse,
  'misuse.other': misuse,
  'misuse.page-script': (c) => make(`JavaScript run on ${siteOf(c)} threw an error`, `The script's own code failed on the page: ${msgOf(c)}.`, 'skill',
    'Not a TabHelm error: fix the script, or let the agent use browser tools instead.', [act.skillDraft(), act.hide()]),
  'derived.loop': (c) => make(`${agentModel(c)} repeats the same step on ${siteOf(c)}`, 'The agent called the same tool over and over without progress.', 'skill',
    'A skill can tell the agent how this site works, or another agent may do better.', [act.skillDraft(), ...useAgent(c.other)]),
  'derived.ignored-snapshot': (c) => make(`${agentModel(c)} acts on old snapshots after navigating`, 'Refs from before a navigation point at elements that no longer exist.', 'skill',
    TIPS['page.stale-ref'], [act.skillDraft(), ...useAgent(c.other)]),
  'budget': (c) => make(`${agentOf(c)} ran out of steps or context`, 'The task needed more steps or context than the agent had.', 'user_action', 'Split the task (the built-in agent stops at 40 steps).', [...useAgent(c.other)]),
  'refusal': (c) => make(`${val(c.model, agentOf(c))} refused`, 'The model declined to do the task.', 'agent_choice', 'Rephrase the task, or use another model.', [...useAgent(c.best || c.other)]),
  'health.agent': (c) => make(typeof c.rate === 'number' ? `${agentModel(c)} finished ${Math.round(c.rate * 100)}% of tasks` : `${agentModel(c)} often fails tasks`, 'Tasks with this agent fail more often than they succeed elsewhere.', 'agent_choice',
    'Try another agent for this kind of task.', [...useAgent(c.best || c.other)]),
  'health.tool': (c) => make(`${toolOf(c)} fails often${c.calls ? ` (${val(c.count, 0)} of ${c.calls} calls)` : ''}`, `Most failures: ${msgOf(c)}.`, 'none', 'See the findings for its main failure.', []),
  // Setup
  'quota': (c) => make(`${agentOf(c)}: rate limit or credits`, 'The model provider limited requests or ran out of credits.', 'agent_choice', 'Wait, add credits, or use another model.', [...useAgent(c.best || c.other)]),
  'auth.signin': signIn,
  'auth.key': signIn,
  'log.agent-auth': signIn,
  'link.host': hostLink,
  'link.relay': hostLink,
  'live.host-offline': hostLink,
  'setup.version': versions,
  'inv.version-mismatch': versions,
  'live.version': versions,
  'setup.native-host': () => make('The TabHelm host is not installed or not allowed', 'Chrome cannot find the native host, or it is registered for another extension id.', 'command',
    'Run the installer, then reload the extension.', [act.installHost(), act.extensions()]),
  'setup.spawn': (c) => make(`${agentOf(c)} could not be started`, 'The agent program was not found or is not executable.', 'command', 'Install the agent, or fix its path.', [...updateAgent(c)]),
  'setup.agent-missing': (c) => make(`${agentOf(c)} is not installed`, 'The selected agent is not on this computer.', 'command', 'Install it, or pick another agent.', [...updateAgent(c), ...useAgent(c.other)]),
  'setup.voice': setupFix('Voice input is not set up', 'The microphone, the language or the transcription engine is not available.', 'Check Settings → Experimental → Voice.', [act.flag('voice', 'Voice')]),
  'setup.provider': (c) => make('A model provider key or model is missing', 'The built-in agent has no key, base URL or usable model for this provider.', 'command',
    'Set the key for the provider.', [act.command(`npm run set-key -- ${val(c.provider, '<provider>')}`)]),
  'setup.critic': criticDown,
  'critic.fp': criticStrict,
  'setup.tools': (c) => make('A helper program is missing', `TabHelm needs a program that is not available here: ${msgOf(c)}.`, 'user_action', 'Install it, or type the value by hand.', []),
  'setup.codec': setupFix('This Chrome cannot encode recordings', 'Chrome here has no H.264 or VP9 video encoder.', 'Use a Chrome build with video encoders to record.'),
  'setup.enospc': enospc,
  'log.enospc': enospc,
  'setup.skill-url': () => make('A skill link could not be loaded', 'The link is not a SKILL.md file, a skill folder or a GitHub repository, or it is too big.', 'setting', 'Use a link to a SKILL.md file.', [act.skills()]),
  'setup.file-urls': () => make('File pages need “Allow access to file URLs”', 'Chrome blocks extensions on file:// pages unless you allow it.', 'setting', 'Turn on “Allow access to file URLs” for TabHelm.', [act.extensions()]),
  'setup.model': setupFix('The saved model is no longer available', 'The agent rejected the model or option saved in TabHelm.', 'Pick the model again in the agent menu.'),
  'net': (c) => make(`Network errors${times(c.count)}`, `Requests failed: ${msgOf(c)}.`, 'user_action', 'Check your connection or the provider\'s status page, then retry.', []),
  'flag.off': (c) => {
    // The normalized message has lost the quoted feature name, so look it up
    // from ctx.feature (id or name) or the local inner text; only the fixed
    // FEATURES name is ever shown.
    const f = FEATURES.find((x) => x.id === c.feature || x.name === c.feature) || featureOf(c.inner) || featureOf(c.message);
    const name = f?.name || 'a feature';
    return make(`The agent tried ${toolOf(c)}, but “${name}” is off`, 'The tool belongs to an experimental feature that is turned off.', 'setting',
      'Turn it on only if you want the agent to use these tools.', f ? [act.flag(f.id, f.name)] : []);
  },
  'chrome.restricted': (c) => chromeTip(/debugger|DevTools/i.test(c.message || '') ? 'Close DevTools on that tab.' : TIPS['chrome.restricted'])(c),
  'chrome.window': chromeTip('Use a normal Chrome window, not a pop-up or app window.'),
  'chrome.render': chromeTip('Keep the tab visible while the agent works.'),
  'chrome.script': chromeTip('Navigate to a normal web page; Chrome protects its own pages and the Web Store.'),
  // Site
  'page.dialog-or-closed': pageTip('a dialog blocked the page, or the tab closed', 'page.dialog-or-closed'),
  'page.navigating': pageTip('the page was still loading or navigating', 'page.navigating'),
  'page.stale-ref': pageTip('the agent used old element refs', 'page.stale-ref'),
  'page.not-select': pageTip('dropdowns are custom widgets, not <select>', 'page.not-select'),
  'page.element': pageTip('an element could not be used', 'page.element'),
  'page.element-soft': pageTip('an element was covered or did not appear', 'page.element-soft'),
  // Expected (counted only)
  'policy.block': expected('Blocked by your site rules or the action critic'),
  'user.decision': expected('You declined or stopped a step'),
  'ui.input': expected('Something in the panel could not be used'),
  // Live (panel only, never exported)
  'live.waiting': (c) => make(`Right now: the agent is waiting for your answer: ${val(c.cardKind, 'question')}${c.cardTitle ? ` “${c.cardTitle}”` : ''}`, 'The task is paused until you answer.', 'user_action', 'Answer the card in the chat.', []),
  'live.hung': (c) => make(`No progress for ${val(c.minutes, 'several')} min`, 'The agent is busy, but nothing new happened and it is not waiting for you.', 'agent_choice', 'Stop the task, or use another agent.', [act.stop(), ...useAgent(c.other)]),
};

// Rules the analyzer emits on its own (detectors, probes, invariants, runtime,
// host log, live checks); with RULES and OVERRIDES these are every finding rule.
export const DERIVED_RULES = [
  'health.tool', 'health.agent', 'health.crash', 'derived.loop', 'derived.ignored-snapshot', 'preamble_gap',
  'mk.repeat', 'mk.dropdown', 'mk.handoff', 'mk.correction', 'mk.no-skill', 'mk.restricted-start',
  'skill.unused', 'skill.stale', 'gap.dom-click', 'critic.fp',
  'probe.replay', 'probe.export', 'probe.context',
  'inv.lost-outcome', 'inv.empty-error', 'inv.index-desync', 'inv.too-big', 'inv.version-mismatch', 'inv.test-chats',
  'rt.panel-error', 'rt.sw-error',
  'log.uncaught', 'log.error-handling', 'log.tool-error', 'log.relay-orphan', 'log.enospc', 'log.agent-auth', 'log.unknown-type', 'log.agent-crash', 'log.pairing-codes',
  'live.replay-stuck', 'live.not-saving', 'live.waiting', 'live.hung', 'live.host-offline', 'live.version',
  'unclassified',
];

// Template for a rule: exact id, then its family ('probe.x' → 'probe.replay'
// style siblings share texts), then a plain fallback so a new rule never
// renders "undefined".
const FAMILY = { 'probe.': 'probe.replay', 'sched.': 'sched.no-approval', 'chrome.': 'chrome.script', 'gap.': 'gap.iframe', 'link.': 'link.host', 'auth.': 'auth.signin',
  'misuse.': 'misuse.other', 'rt.': 'rt.panel-error', 'live.': 'live.not-saving', 'mk.': 'mk.repeat', 'skill.': 'skill.stale', 'setup.': 'setup.tools', 'bug.': 'bug.internal', 'crash.': 'crash.agent' };

export function templateFor(rule, ctx) {
  const c = ctx || {};
  const id = String(rule || '');
  const fn = TEMPLATES[id] || TEMPLATES[Object.entries(FAMILY).find(([p]) => id.startsWith(p))?.[1]];
  if (fn) return fn(c);
  if (ownerFor(c.category, id) === 'tabhelm') return unclassified(c);
  return make(c.message ? `${toolOf(c)} failed: ${c.message}` : 'Something went wrong', 'No specific advice for this error yet.', 'none', '', []);
}
