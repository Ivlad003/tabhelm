#!/usr/bin/env node
// Installs an ACP agent from the official ACP registry into ~/.tabhelm/agents/<id>.
// Usage: npm run install-agent <antigravity|qoder> [--pinned]
//        npm run install-agent -- --list      (show what the registry offers)
//
// npm packages are installed at @latest because registry pins can lag far
// behind (e.g. Qoder 0.2.14 vs 1.x); --pinned uses the registry's version.
//
// Registry "binary" distributions are downloaded and unpacked; "npx"
// distributions are installed with npm into the agent's folder.

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENTS_DIR } from '../src/agents.js';

const REGISTRY = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
// TabHelm agent id -> ACP registry id
const REGISTRY_IDS = { antigravity: 'antigravity-acp', qoder: 'qoder' };

const arg = process.argv[2];
const registry = await (await fetch(REGISTRY)).json();
const entries = registry.agents || registry;

if (!arg || arg === '--list') {
  console.log('Installable with this script:', Object.keys(REGISTRY_IDS).join(', '));
  console.log(`\nACP registry (${entries.length} agents):`);
  for (const e of entries) console.log(`  ${e.id.padEnd(24)} ${e.name} ${e.version}`);
  process.exit(arg ? 0 : 1);
}

const entry = entries.find((e) => e.id === REGISTRY_IDS[arg]);
if (!entry) {
  console.error(`Unknown agent "${arg}". Supported: ${Object.keys(REGISTRY_IDS).join(', ')}`);
  process.exit(1);
}

const dir = join(AGENTS_DIR, arg);
console.log(`Installing ${entry.name} ${entry.version} into ${dir}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const { binary, npx } = entry.distribution;
if (binary) {
  const os = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[process.platform];
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
  const target = binary[`${os}-${arch}`];
  if (!target) throw new Error(`${entry.name} has no build for ${os}-${arch}`);

  const archive = join(tmpdir(), `tabhelm-${arg}-${Date.now()}${target.archive.endsWith('.zip') ? '.zip' : '.tar.gz'}`);
  console.log(`Downloading ${target.archive}`);
  const res = await fetch(target.archive);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  if (archive.endsWith('.zip')) execFileSync('unzip', ['-q', '-o', archive, '-d', dir]);
  else execFileSync('tar', ['-xzf', archive, '-C', dir]);
  rmSync(archive);
  chmodSync(join(dir, target.cmd), 0o755);
} else if (npx) {
  const pkgName = npx.package.replace(/(.)@[^@/]+$/, '$1');
  const spec = process.argv.includes('--pinned') ? npx.package : `${pkgName}@latest`;
  console.log(`npm install ${spec}`);
  writeFileSync(join(dir, 'package.json'), '{"private": true}\n');
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', spec], { cwd: dir, stdio: 'inherit' });
} else {
  throw new Error(`${entry.name} uses an unsupported distribution: ${Object.keys(entry.distribution).join(', ')}`);
}

console.log(`\n✓ ${entry.name} installed. Reopen the TabHelm panel to see it in the agent list.`);
console.log('The agent may ask you to sign in on first use; follow its instructions in the panel or log in once in a terminal.');
