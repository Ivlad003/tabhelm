import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// ~/.tabhelm/env holds KEY=VALUE lines (API keys, base URLs). Chrome starts the
// host with a minimal environment, so this is how agents get their keys.
export const ENV_FILE = join(homedir(), '.tabhelm', 'env');

export function readEnvFile() {
  if (!existsSync(ENV_FILE)) return {};
  const vars = {};
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    vars[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return vars;
}

// Values already in the environment win over the file.
export function loadEnvFile() {
  for (const [key, value] of Object.entries(readEnvFile())) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function setEnvVar(key, value) {
  mkdirSync(dirname(ENV_FILE), { recursive: true });
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').split('\n').filter((l) => l !== '') : [];
  const kept = lines.filter((l) => !new RegExp(`^\\s*(export\\s+)?${key}\\s*=`).test(l));
  kept.push(`${key}=${value}`);
  writeFileSync(ENV_FILE, `${kept.join('\n')}\n`, { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
}

// Windows: the PATH the host starts with is the one saved by install-host (and
// Chrome's own, from when Chrome started), so a CLI installed later is missing
// from it even though its installer added it to the user's PATH. The live user
// and system PATH come from the registry and their new folders are appended.

// Expands %VAR% the way Windows does for REG_EXPAND_SZ values (names ignore case).
export function expandWindowsVars(value, env = process.env) {
  return value.replace(/%([^%;]+)%/g, (match, name) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? match : env[key];
  });
}

// Appends the folders of `entries` that `current` (a Windows PATH) does not have yet.
export function mergeWindowsPath(current, entries, env = process.env) {
  const clean = (p) => p.trim().replace(/^"(.*)"$/, '$1');
  const key = (p) => clean(p).replace(/[\\/]+$/, '').toLowerCase();
  const have = new Set(current.split(';').map(key).filter(Boolean));
  const added = [];
  for (const raw of entries) {
    const entry = clean(expandWindowsVars(raw, env));
    if (!key(entry) || /%[^%]+%/.test(entry) || have.has(key(entry))) continue;
    have.add(key(entry));
    added.push(entry);
  }
  return { path: [current, ...added].filter(Boolean).join(';'), added };
}

// PowerShell reads both PATHs and prints them as base64 UTF-8, so folders with
// non-ASCII names (C:\Users\Влад) survive the console code page.
const PATH_SCRIPT = "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((@([Environment]::GetEnvironmentVariable('Path','Machine'), [Environment]::GetEnvironmentVariable('Path','User')) -join ';')))";
export const PATH_COMMAND = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(PATH_SCRIPT, 'utf16le').toString('base64')];

// PATH folders from PATH_COMMAND's output, or null when it printed something else.
export function parsePathOutput(stdout) {
  const out = String(stdout).trim();
  return /^[A-Za-z0-9+/]+=*$/.test(out) ? Buffer.from(out, 'base64').toString('utf8').split(';') : null;
}

function readRegistryPath() {
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    execFile(powershell, PATH_COMMAND, { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      const entries = err ? null : parsePathOutput(stdout);
      if (entries) resolve(entries);
      else reject(err || new Error('unexpected PowerShell output'));
    });
  });
}

let runningRefresh = null;
let lastRefresh = Promise.resolve([]);

// Merges the live Windows PATH into process.env.PATH (agents and their tools are
// found and started with it). Resolves to the folders added; a no-op elsewhere.
// Calls made while a lookup runs share it.
export function refreshWindowsPath() {
  if (process.platform !== 'win32') return lastRefresh;
  runningRefresh ??= readRegistryPath()
    .then((entries) => {
      const { path, added } = mergeWindowsPath(process.env.PATH || '', entries);
      if (added.length) process.env.PATH = path;
      return added;
    })
    .catch(() => [])
    .finally(() => {
      runningRefresh = null;
    });
  lastRefresh = runningRefresh;
  return runningRefresh;
}

// Waits for a lookup already running (if any) without starting a new one.
export const windowsPathReady = () => lastRefresh;
