// Memory across chats: ~/.tabhelm/memory.json holds short notes, each global
// or tied to a site (hostname). Agents read matching notes with their first
// message and can add notes with memory_save.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const FILE = join(homedir(), '.tabhelm', 'memory.json');
const MAX_NOTES = 500;

export function loadMemory() {
  if (!existsSync(FILE)) return [];
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')).notes || [];
  } catch {
    return [];
  }
}

function saveMemory(notes) {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, `${JSON.stringify({ notes }, null, 2)}\n`);
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
};

export function addNote({ text, site = null, source = 'agent' }) {
  const notes = loadMemory();
  const clean = String(text).trim().slice(0, 500);
  if (!clean) throw new Error('Empty note');
  const dup = notes.find((n) => n.text === clean && n.site === site);
  if (dup) return dup;
  const note = { id: `m${Date.now().toString(36)}`, text: clean, site, source, created: new Date().toISOString() };
  notes.push(note);
  if (notes.length > MAX_NOTES) notes.splice(0, notes.length - MAX_NOTES);
  saveMemory(notes);
  return note;
}

export function deleteNote(id) {
  saveMemory(loadMemory().filter((n) => n.id !== id));
}

export function clearMemory() {
  saveMemory([]);
}

// Notes relevant to a page: global ones plus the page's site.
export function relevantNotes(url) {
  const host = hostOf(url);
  return loadMemory().filter((n) => !n.site || (host && (host === n.site || host.endsWith(`.${n.site}`))));
}

export function searchNotes(query) {
  const q = String(query || '').toLowerCase();
  return loadMemory().filter((n) => !q || `${n.text} ${n.site || ''}`.toLowerCase().includes(q));
}

export function memoryPreamble(url) {
  const notes = relevantNotes(url).slice(-30);
  if (!notes.length) return '';
  return `Memory (notes saved in earlier chats; use memory_save to add facts worth keeping, e.g. the user's preferences or how a site works):\n${notes
    .map((n) => `- ${n.site ? `[${n.site}] ` : ''}${n.text}`)
    .join('\n')}\n\n`;
}

export function runMemoryTool(tool, args, url) {
  const text = (t) => [{ type: 'text', text: t }];
  if (tool === 'memory_save') {
    const site = args.scope === 'site' ? hostOf(url) : null;
    const note = addNote({ text: args.text, site });
    return text(`Saved${site ? ` for ${site}` : ' (global)'}: ${note.text}`);
  }
  if (tool === 'memory_search') {
    const notes = searchNotes(args.query);
    return text(notes.length ? notes.map((n) => `- ${n.site ? `[${n.site}] ` : ''}${n.text}`).join('\n') : 'No matching notes.');
  }
  throw new Error(`Unknown memory tool ${tool}`);
}
