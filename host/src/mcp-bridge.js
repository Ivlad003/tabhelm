#!/usr/bin/env node
// stdio MCP server that each agent launches (passed via ACP session/new).
// It exposes browser tools and forwards every call to the native host's
// loopback tool server, which relays it to the extension for the bound tab.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const { TABHELM_URL, TABHELM_TOKEN, TABHELM_TAB } = process.env;
const tabId = Number(TABHELM_TAB);

const server = new McpServer({ name: 'tabhelm-browser', version: '0.28.0' });

async function call(tool, args = {}) {
  try {
    const res = await fetch(TABHELM_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${TABHELM_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tabId, tool, args }),
    });
    const data = await res.json();
    if (!data.ok) return { isError: true, content: [{ type: 'text', text: data.error || 'Unknown error' }] };
    return { content: data.content };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `TabHelm host unreachable: ${err.message}` }] };
  }
}

const ref = z.string().describe('Element ref from the latest browser_snapshot or browser_find, e.g. "e12", or "f3:e5" for an element inside iframe f3');
const xy = z.object({ x: z.number(), y: z.number() });
const button = z.enum(['left', 'right', 'middle']).optional().describe('Mouse button (default left)');
const modifiers = z
  .array(z.enum(['Control', 'Shift', 'Alt', 'Meta']))
  .optional()
  .describe('Keys held during the click, e.g. ["Control"] to open a link in a new tab');

const tools = {
  // Reading
  browser_snapshot: {
    description:
      'Read the current tab: URL, title and a compact outline of visible content, including iframes. Interactive elements are tagged with refs like [e12] (or [f3:e5] inside iframes) for use with other tools. Hidden file inputs are listed at the end. Take a new snapshot after navigation or big page changes; old refs become stale.',
    inputSchema: {},
  },
  browser_find: {
    description: 'Find visible elements whose text, label or placeholder contains the given text. Returns refs. Cheaper than a full snapshot on big pages.',
    inputSchema: { text: z.string() },
  },
  browser_get_text: {
    description: 'Get the full visible text of the page (no refs), useful for reading long articles.',
    inputSchema: {},
  },
  browser_screenshot: {
    description:
      'Capture a JPEG screenshot. By default the visible viewport, whose pixel coordinates can be used directly with browser_click_xy / browser_hover / browser_drag. Use it for canvas apps, images and layout questions.',
    inputSchema: {
      fullPage: z.boolean().optional().describe('Capture the whole scrollable page (coordinates are then page coordinates)'),
      ref: ref.optional().describe('Capture only this element'),
    },
  },

  // Mouse
  browser_click: {
    description: 'Click an element by ref with a real mouse event. Supports right/middle button, double click and modifier keys.',
    inputSchema: { ref, button, double: z.boolean().optional().describe('Double-click'), modifiers },
  },
  browser_click_xy: {
    description: 'Click at viewport coordinates taken from a viewport browser_screenshot. Use for canvas apps, maps and elements without refs.',
    inputSchema: { x: z.number(), y: z.number(), button, double: z.boolean().optional(), modifiers },
  },
  browser_hover: {
    description: 'Move the mouse over an element (ref) or a point (x, y) to reveal menus or tooltips.',
    inputSchema: { ref: ref.optional(), x: z.number().optional(), y: z.number().optional() },
  },
  browser_drag: {
    description: 'Drag from one element/point to another (HTML5 drag-and-drop, sliders, sortable lists, canvas). Give fromRef or from {x,y}, and toRef or to {x,y}.',
    inputSchema: { fromRef: ref.optional(), from: xy.optional(), toRef: ref.optional(), to: xy.optional() },
  },

  // Keyboard & forms
  browser_type: {
    description: 'Focus an input/textarea/contenteditable by ref and type text.',
    inputSchema: {
      ref,
      text: z.string(),
      clear: z.boolean().optional().describe('Clear existing value first (default true)'),
      submit: z.boolean().optional().describe('Press Enter after typing'),
    },
  },
  browser_select_option: {
    description: 'Choose an option in a <select> by ref, matching option value or visible label.',
    inputSchema: { ref, value: z.string() },
  },
  browser_press_key: {
    description: 'Press a key or shortcut on the focused element: Enter, Escape, Tab, ArrowDown, PageDown, F5, a single character, or combos like Control+A, Shift+Tab, Meta+C.',
    inputSchema: { key: z.string() },
  },
  browser_upload_file: {
    description:
      'Attach local files (absolute paths on the user\'s machine) to a file input by ref, or to a file chooser that a previous click opened (omit ref). The user must approve every upload.',
    inputSchema: { ref: ref.optional(), paths: z.array(z.string()).min(1) },
  },
  browser_scroll: {
    description: 'Scroll the page (or a scrollable element by ref). Default amount is about one screen.',
    inputSchema: { direction: z.enum(['up', 'down', 'left', 'right']), ref: ref.optional(), amount: z.number().optional().describe('Pixels') },
  },

  // Navigation & tabs
  browser_navigate: {
    description: 'Open a URL in the current tab.',
    inputSchema: { url: z.string() },
  },
  browser_go_back: { description: 'Go back in the tab history.', inputSchema: {} },
  browser_go_forward: { description: 'Go forward in the tab history.', inputSchema: {} },
  browser_reload: {
    description: 'Reload the current tab.',
    inputSchema: { bypassCache: z.boolean().optional() },
  },
  browser_search_tabs: {
    description:
      'Search for text in every tab you can use (the chat tab, tabs you opened and tabs the user shared through the chat\'s tab group). Returns matches per tab with refs; use them with that tab\'s tabId.',
    inputSchema: { text: z.string() },
  },
  browser_tabs: {
    description:
      'Work with tabs. list: tabs you may control (all: true lists every tab). new: open a URL in a new background tab and act on it. switch: act on another tab (tabs you did not open need user approval). close: close a tab you opened. The user keeps seeing the chat tab.',
    inputSchema: {
      action: z.enum(['list', 'new', 'switch', 'close']),
      url: z.string().optional(),
      tabId: z.number().optional(),
      all: z.boolean().optional(),
    },
  },

  // Waiting & dialogs
  browser_wait: {
    description: 'Wait for some seconds, or until the given text appears on the page (max 30s).',
    inputSchema: { seconds: z.number().optional(), text: z.string().optional() },
  },
  browser_handle_dialog: {
    description: 'Accept or dismiss a JavaScript alert/confirm/prompt dialog that is blocking the page.',
    inputSchema: { accept: z.boolean(), promptText: z.string().optional() },
  },

  // Diagnostics
  browser_console: {
    description: 'Read console messages and uncaught errors from the current tab (captured since the agent first touched it).',
    inputSchema: { level: z.enum(['all', 'warning', 'error']).optional(), clear: z.boolean().optional() },
  },
  browser_network: {
    description: 'List network requests of the current tab: method, status, type, URL (captured since the agent first touched it).',
    inputSchema: { filter: z.string().optional().describe('Substring of the URL'), failedOnly: z.boolean().optional(), clear: z.boolean().optional() },
  },
  skill_list: {
    description: 'List the skills the user enabled in TabHelm (name and description).',
    inputSchema: {},
  },
  skill_read: {
    description: 'Read the full instructions of an enabled skill. Do this before a task the skill covers, then follow it.',
    inputSchema: { name: z.string().describe('Skill name from the list') },
  },
  browser_guide: {
    description:
      'Guide mode: show the user what to do instead of doing it. Pass ALL steps you can see at once (steps[]): every step gets a numbered badge on the page, the active one an arrow and your instruction; Next/Back move between steps (scrolling to them, switching tabs for steps on other tabs) and a click on the element counts as done. The call returns when the user finishes, with what they did or skipped. Steps on pages that only appear after a click cannot have refs yet: give them text only, or start a new browser_guide after a snapshot. Single-step form (ref, text, step) still works.',
    inputSchema: {
      steps: z.array(z.object({ ref: z.string().optional().describe('Element ref from the latest browser_snapshot of that tab; omit for a text-only step'), text: z.string().describe('Instruction for this step'), tabId: z.number().optional().describe('Tab of this step (default: current tab)') })).optional(),
      ref: z.string().optional().describe('Single-step form: element ref'),
      text: z.string().optional().describe('Single-step form: instruction'),
      step: z.number().optional().describe('Single-step form: step number shown on the page'),
    },
  },
  skill_save: {
    description:
      'Save a reusable skill for TabHelm (shown in Settings, runnable with /name). Use it when the user asks to turn this chat, a guide or a procedure into a skill. Body: Markdown instructions another agent can follow — goal, site, exact steps with element names, checks, pitfalls.',
    inputSchema: { name: z.string().describe('Short kebab-case name'), description: z.string().describe('One sentence: when to use it'), body: z.string().describe('Markdown instructions') },
  },
  skill_read_file: {
    description: "Read another file of a skill (e.g. references/forms.md) by its path relative to the skill's folder.",
    inputSchema: { name: z.string(), path: z.string() },
  },
  // Extra tools behind feature flags (the extension refuses them when the flag is off).
  browser_fill_form: {
    description: 'Fill several fields at once (Developer tools flag). Each field: ref + value; checkboxes take "true"/"false", selects take option value or label.',
    inputSchema: { fields: z.array(z.object({ ref: z.string(), value: z.string() })).min(1), submit: z.boolean().optional().describe('Press Enter in the last field') },
  },
  browser_network_body: {
    description: 'Request and response bodies of a captured network request (Developer tools flag). Use the URL substring from browser_network.',
    inputSchema: { url: z.string().describe('Substring of the request URL'), maxChars: z.number().optional() },
  },
  browser_storage: {
    description: 'Read or write cookies, localStorage or sessionStorage of the current tab (Developer tools flag).',
    inputSchema: {
      action: z.enum(['get', 'set', 'delete']),
      kind: z.enum(['cookies', 'localStorage', 'sessionStorage']),
      key: z.string().optional(),
      value: z.string().optional(),
    },
  },
  browser_emulate: {
    description: 'Emulate a device or environment on the current tab (Developer tools flag): viewport, mobile, user agent, color scheme, geolocation, timezone, locale. Pass reset: true to undo.',
    inputSchema: {
      width: z.number().optional(),
      height: z.number().optional(),
      mobile: z.boolean().optional(),
      deviceScaleFactor: z.number().optional(),
      userAgent: z.string().optional(),
      colorScheme: z.enum(['light', 'dark']).optional(),
      latitude: z.number().optional(),
      longitude: z.number().optional(),
      timezone: z.string().optional(),
      locale: z.string().optional(),
      reset: z.boolean().optional(),
    },
  },
  browser_highlight: {
    description: 'Outline elements on the page for the user to see (Developer tools flag), e.g. to point at what you mean. Clears after a few seconds.',
    inputSchema: { refs: z.array(z.string()).min(1), label: z.string().optional() },
  },
  browser_script_list: {
    description: 'List the user\'s saved page scripts & styles presets (Page scripts & styles flag), marking which match the current page.',
    inputSchema: {},
  },
  browser_script_save: {
    description: 'Save a reusable page script preset (Page scripts & styles flag): JavaScript (runs as the body of an async function in the page; may `return` a value) and/or CSS, for pages matching a URL glob (e.g. "*://*.github.com/*" or "github.com", "*" for all). Use when the user asks to keep an automation or a restyle for later. Automatic running stays off until the user enables it.',
    inputSchema: { name: z.string(), description: z.string().optional(), match: z.string().optional().describe('URL glob(s), space separated; default "*"'), js: z.string().optional(), css: z.string().optional() },
  },
  browser_script_run: {
    description: 'Run a saved page script preset on the current tab (Page scripts & styles flag). JS presets ask the user first.',
    inputSchema: { name: z.string(), tabId: z.number().optional() },
  },
  browser_style: {
    description: 'Apply CSS to the current page right now (Page scripts & styles flag) — hide clutter, highlight, restyle. Same id replaces the previous CSS; remove:true takes it off. Lasts until reload; save with browser_script_save to reuse.',
    inputSchema: { css: z.string().optional(), id: z.string().optional(), remove: z.boolean().optional(), tabId: z.number().optional() },
  },
  browser_request_human: {
    description: 'Ask the user to do something themselves in the browser (2FA code, captcha, payment choice) and wait until they say they are done (Take over flag). Explain exactly what you need.',
    inputSchema: { message: z.string() },
  },
  browser_request_login: {
    description: 'Ask the user to sign in on the current page (Password manager flag). Give the refs of the username/email and password fields if visible; the user picks an account from their password manager or signs in themselves. Returns when done.',
    inputSchema: { usernameRef: z.string().optional(), passwordRef: z.string().optional(), note: z.string().optional() },
  },
  memory_save: {
    description: 'Remember a short fact for future chats (Memory flag): the user\'s preferences, how a site works, decisions. scope "site" ties it to the current site, "global" applies everywhere.',
    inputSchema: { text: z.string(), scope: z.enum(['site', 'global']).optional() },
  },
  memory_search: {
    description: 'Search notes saved in earlier chats (Memory flag).',
    inputSchema: { query: z.string().optional() },
  },
  browser_evaluate: {
    description: 'Run a JavaScript expression in the page and return its JSON result (awaits promises). The user must approve every call.',
    inputSchema: { expression: z.string() },
  },
};

// Every page tool can act on another tab directly (no switching) via tabId.
const tabIdParam = z
  .number()
  .optional()
  .describe('Act on this tab instead of the current one (ids from browser_tabs list or browser_search_tabs)');
for (const [name, def] of Object.entries(tools)) {
  if (name.startsWith('browser_') && !['browser_tabs', 'browser_search_tabs'].includes(name)) def.inputSchema = { ...def.inputSchema, tabId: tabIdParam };
}

for (const [name, def] of Object.entries(tools)) {
  server.registerTool(name, def, (args) => call(name, args));
}

await server.connect(new StdioServerTransport());
