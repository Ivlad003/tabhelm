// Files an agent produced, offered to the panel for download.
// What counts: files created or changed in the agent's folder while it worked
// on a message (the folder is compared before and after), plus files the agent
// reported editing anywhere else, plus files saved with the file_save tool.
// Only files offered this way can be read back: the panel asks by id, never by
// path, so it cannot be used to read anything else on this machine.

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// Folders that are never the result of a task, and are slow to walk.
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'venv', 'target']);
export const SCAN_MAX_FILES = 5000; // bigger folders are not compared: only what the agent reports counts there
export const SCAN_MAX_DEPTH = 8;
export const OFFER_MAX = 40; // files listed for one task
export const DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024;
export const CHUNK_BYTES = 256 * 1024; // base64 makes it a third larger: well under the 1 MB frame limit
export const SAVE_MAX_CHARS = 2_000_000;

// rel path -> "mtime:size" of every file under root (dot-folders and SKIP_DIRS are
// left out). `truncated` when the folder is too big to compare reliably.
export function snapshotDir(root, { maxFiles = SCAN_MAX_FILES, maxDepth = SCAN_MAX_DEPTH } = {}) {
  const files = new Map();
  let truncated = false;
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (truncated) return;
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
        if (depth >= maxDepth) truncated = true;
        else walk(path, depth + 1);
      } else if (e.isFile()) {
        if (files.size >= maxFiles) {
          truncated = true;
          return;
        }
        try {
          const st = statSync(path);
          files.set(relative(root, path), `${Math.round(st.mtimeMs)}:${st.size}`);
        } catch {}
      }
    }
  };
  walk(root, 0);
  return { files, truncated };
}

// Files that are new or different after the task: [{ rel, created }], new ones first.
export function changedFiles(before, after) {
  const out = [];
  for (const [rel, sig] of after.files) {
    const old = before.files.get(rel);
    if (old === undefined) out.push({ rel, created: true });
    else if (old !== sig) out.push({ rel, created: false });
  }
  return out.sort((a, b) => Number(b.created) - Number(a.created) || a.rel.localeCompare(b.rel));
}

// Paths an agent reports with a tool call that edits files (ACP: kind "edit" or
// "move" with locations, and "diff" content).
export function editedPaths(update, kindOf = update?.kind) {
  const paths = [];
  if (kindOf === 'edit' || kindOf === 'move') for (const l of update.locations || []) if (typeof l?.path === 'string') paths.push(l.path);
  for (const item of Array.isArray(update?.content) ? update.content : []) if (item?.type === 'diff' && typeof item.path === 'string') paths.push(item.path);
  return paths;
}

// ---- What was offered, per chat tab (kept while the host runs, also across agent restarts) ----

const offered = new Map(); // tabId -> Map(id -> absolute path)
let nextId = 1;

export function offerFile(tabId, path) {
  const abs = resolve(path);
  let mine = offered.get(tabId);
  if (!mine) offered.set(tabId, (mine = new Map()));
  for (const [id, p] of mine) if (p === abs) return id;
  // Bounded: the oldest offers of a long chat make room.
  if (mine.size >= 500) mine.delete(mine.keys().next().value);
  const id = `f${nextId++}`;
  mine.set(id, abs);
  return id;
}

export const offeredPath = (tabId, id) => offered.get(tabId)?.get(String(id)) || null;

// The list for the panel: what changed under `root` plus `extra` absolute paths
// (reported by the agent, possibly outside root). Missing files are left out.
export function describeFiles(tabId, root, changed, extra = []) {
  const seen = new Set();
  const list = [];
  const add = (abs, created) => {
    abs = resolve(abs);
    if (seen.has(abs)) return;
    seen.add(abs);
    let st;
    try {
      st = statSync(abs);
    } catch {
      return;
    }
    if (!st.isFile()) return;
    const inside = !relative(root, abs).startsWith('..') && !isAbsolute(relative(root, abs));
    list.push({ id: offerFile(tabId, abs), name: basename(abs), path: inside ? relative(root, abs).split(sep).join('/') : abs, size: st.size, created, outside: !inside });
  };
  for (const f of changed) add(join(root, f.rel), f.created);
  for (const p of extra) add(isAbsolute(p) ? p : join(root, p), false);
  return { files: list.slice(0, OFFER_MAX), more: Math.max(0, list.length - OFFER_MAX) };
}

// Reads an offered file in chunks: yields { seq, last, data (base64), size, name }.
export function* readOffered(tabId, id, { chunkBytes = CHUNK_BYTES, maxBytes = DOWNLOAD_MAX_BYTES } = {}) {
  const path = offeredPath(tabId, id);
  if (!path) throw new Error('This file is no longer offered for download (the host was restarted). It is still on the computer the agent ran on.');
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new Error(`The file is gone: ${path}`);
  }
  if (!st.isFile()) throw new Error(`Not a file: ${path}`);
  if (st.size > maxBytes) throw new Error(`The file is too large to download through the panel (${Math.round(st.size / 1024 / 1024)} MB; the limit is ${Math.round(maxBytes / 1024 / 1024)} MB). It is at ${path}`);
  const name = basename(path);
  if (!st.size) {
    yield { seq: 0, last: true, data: '', size: 0, name };
    return;
  }
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(chunkBytes);
    let offset = 0;
    let seq = 0;
    while (offset < st.size) {
      const n = readSync(fd, buffer, 0, chunkBytes, offset);
      if (!n) break;
      offset += n;
      yield { seq: seq++, last: offset >= st.size, data: buffer.subarray(0, n).toString('base64'), size: st.size, name };
    }
  } finally {
    closeSync(fd);
  }
}

// file_save tool: text from the agent becomes a file in its folder. The name is
// reduced to a plain file name; a file that is already there is never overwritten
// unless this chat saved it itself.
const savedByTool = new Map(); // tabId -> Set(absolute path)
export function saveGenerated(tabId, dir, { name, content } = {}) {
  const text = typeof content === 'string' ? content : '';
  if (!text) throw new Error('file_save needs content (the text of the file).');
  if (text.length > SAVE_MAX_CHARS) throw new Error(`The content is too long (${text.length} characters; the limit is ${SAVE_MAX_CHARS}). Save it in parts.`);
  let clean = basename(String(name || '').replace(/\\/g, '/')).replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim();
  if (!clean) clean = 'file.txt';
  if (!extname(clean)) clean += '.txt';
  mkdirSync(dir, { recursive: true });
  let mine = savedByTool.get(tabId);
  if (!mine) savedByTool.set(tabId, (mine = new Set()));
  let path = join(dir, clean);
  for (let n = 2; existsSync(path) && !mine.has(path); n++) path = join(dir, `${basename(clean, extname(clean))} (${n})${extname(clean)}`);
  writeFileSync(path, text);
  mine.add(path);
  return { path, name: basename(path), size: Buffer.byteLength(text) };
}
