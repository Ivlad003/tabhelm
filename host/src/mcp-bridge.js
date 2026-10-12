#!/usr/bin/env node
// stdio MCP server that each agent launches (passed via ACP session/new).
// It exposes browser tools and forwards every call to the native host's
// loopback tool server, which relays it to the extension for the bound tab.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const { TABHELM_URL, TABHELM_TOKEN, TABHELM_TAB } = process.env;
const tabId = Number(TABHELM_TAB);

const server = new McpServer({ name: 'tabhelm-browser', version: '0.1.0' });

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

const ref = z.string().describe('Element ref from the latest browser_snapshot, e.g. "e12"');

const tools = {
  browser_snapshot: {
    description:
      'Read the current tab: URL, title and a compact outline of visible content. Interactive elements are tagged with refs like [e12] for use with other tools. Call again after navigation or big page changes, refs from older snapshots become stale.',
    inputSchema: {},
  },
  browser_click: {
    description: 'Click an element by ref (real mouse click).',
    inputSchema: { ref },
  },
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
    description: 'Press a key on the focused element, e.g. Enter, Escape, Tab, ArrowDown, Backspace, PageDown.',
    inputSchema: { key: z.string() },
  },
  browser_scroll: {
    description: 'Scroll the page (or a scrollable element by ref) up or down by about one screen.',
    inputSchema: { direction: z.enum(['up', 'down']), ref: ref.optional() },
  },
  browser_navigate: {
    description: 'Open a URL in the current tab.',
    inputSchema: { url: z.string() },
  },
  browser_go_back: {
    description: 'Go back in the tab history.',
    inputSchema: {},
  },
  browser_screenshot: {
    description: 'Capture a JPEG screenshot of the visible part of the tab. Use when the snapshot is not enough (canvas, images, layout).',
    inputSchema: {},
  },
  browser_get_text: {
    description: 'Get the full visible text of the page (no refs), useful for reading long articles.',
    inputSchema: {},
  },
  browser_wait: {
    description: 'Wait for some seconds, or until the given text appears on the page (max 30s).',
    inputSchema: { seconds: z.number().optional(), text: z.string().optional() },
  },
  browser_handle_dialog: {
    description: 'Accept or dismiss a JavaScript alert/confirm/prompt dialog that is blocking the page.',
    inputSchema: { accept: z.boolean(), promptText: z.string().optional() },
  },
};

for (const [name, def] of Object.entries(tools)) {
  server.registerTool(name, def, (args) => call(name, args));
}

await server.connect(new StdioServerTransport());
