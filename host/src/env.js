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
