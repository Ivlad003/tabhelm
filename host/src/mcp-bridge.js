#!/usr/bin/env node
// stdio MCP server that each agent launches (passed via ACP session/new).
// It exposes browser tools and forwards every call to the native host's
// loopback tool server, which relays it to the extension for the bound tab.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const { TABHELM_URL, TABHELM_TOKEN, TABHELM_TAB } = process.env;
const tabId = Number(TABHELM_TAB);

const server = new McpServer({ name: 'tabhelm-browser', version: '0.13.0' });

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
  skill_read_file: {
    description: "Read another file of a skill (e.g. references/forms.md) by its path relative to the skill's folder.",
    inputSchema: { name: z.string(), path: z.string() },
  },
  browser_evaluate: {
    description: 'Run a JavaScript expression in the page and return its JSON result (awaits promises). The user must approve every call.',
    inputSchema: { expression: z.string() },
  },
};

for (const [name, def] of Object.entries(tools)) {
  server.registerTool(name, def, (args) => call(name, args));
}

await server.connect(new StdioServerTransport());
