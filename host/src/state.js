// Mirror of the extension's chrome.storage.local (chat history, settings, skills)
// in ~/.tabhelm/state.json. Chrome wipes an extension's storage when it is
// removed, so the panel restores from here after a reinstall.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// TABHELM_STATE_FILE moves it (tests use a temporary one, never the user's).
const FILE = process.env.TABHELM_STATE_FILE || join(homedir(), '.tabhelm', 'state.json');

export function saveState(data) {
  mkdirSync(dirname(FILE), { recursive: true });
  // Write next to the file and rename, so a crash never leaves a half-written backup.
  writeFileSync(`${FILE}.tmp`, JSON.stringify({ saved: new Date().toISOString(), data }));
  renameSync(`${FILE}.tmp`, FILE);
}

export function loadState() {
  if (!existsSync(FILE)) return {};
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')).data || {};
  } catch {
    return {};
  }
}
