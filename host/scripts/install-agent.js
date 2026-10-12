#!/usr/bin/env node
// Installs any agent from the official ACP registry into ~/.tabhelm/agents/<id>
// and records how to launch it (tabhelm.json), so TabHelm lists it automatically.
// Usage: npm run install-agent -- <name> [--pinned]   e.g. kilo, cline, codebuddy, qoder, antigravity
//        npm run install-agent -- --list               (everything the registry offers)
//
// npm packages are installed at @latest because registry pins can lag far
// behind (e.g. Qoder 0.2.14 vs 1.x); --pinned uses the registry's version.
// Registry "binary" distributions are downloaded and unpacked.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENTS_DIR } from '../src/agents.js';

const REGISTRY = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
// Short TabHelm names -> ACP registry ids; any other registry id works as is.
const ALIASES = {
  antigravity: 'antigravity-acp',
  codebuddy: 'codebuddy-code',
  copilot: 'github-copilot-cli',
  amp: 'amp-acp',
  droid: 'factory-droid',
  glm: 'glm-acp-agent',
  minimax: 'minimax-code',
  vibe: 'mistral-vibe',
};

const arg = process.argv[2];
const registry = await (await fetch(REGISTRY)).json();
const entries = registry.agents || registry;

if (!arg || arg === '--list') {
  const back = Object.fromEntries(Object.entries(ALIASES).map(([k, v]) => [v, k]));
  console.log(`ACP registry (${entries.length} agents). Install with: npm run install-agent -- <name>\n`);
  for (const e of entries) console.log(`  ${(back[e.id] || e.id).padEnd(22)} ${e.name} ${e.version}`);
  process.exit(arg ? 0 : 1);
}

const registryId = ALIASES[arg] || arg;
const entry = entries.find((e) => e.id === registryId);
if (!entry) {
  console.error(`"${arg}" is not in the ACP registry. See: npm run install-agent -- --list`);
  process.exit(1);
}
const id = Object.keys(ALIASES).find((k) => ALIASES[k] === registryId) || registryId;
const dir = join(AGENTS_DIR, id);
console.log(`Installing ${entry.name} into ${dir}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

let launch;
const { binary, npx } = entry.distribution;
if (binary) {
  const os = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[process.platform];
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
  const target = binary[`${os}-${arch}`];
  if (!target) throw new Error(`${entry.name} has no build for ${os}-${arch}`);

  const ext = target.archive.endsWith('.zip') ? '.zip' : target.archive.endsWith('.tar.bz2') ? '.tar.bz2' : '.tar.gz';
  const archive = join(tmpdir(), `tabhelm-${id}-${Date.now()}${ext}`);
  console.log(`Downloading ${target.archive}`);
  const res = await fetch(target.archive);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  if (ext === '.zip') execFileSync('unzip', ['-q', '-o', archive, '-d', dir]);
  else execFileSync('tar', [ext === '.tar.bz2' ? '-xjf' : '-xzf', archive, '-C', dir]);
  rmSync(archive);
  const command = join(dir, target.cmd);
  chmodSync(command, 0o755);
  launch = { command, args: target.args || [] };
} else if (npx) {
  const pkgName = npx.package.replace(/(.)@[^@/]+$/, '$1');
  const spec = process.argv.includes('--pinned') ? npx.package : `${pkgName}@latest`;
  console.log(`npm install ${spec}`);
  writeFileSync(join(dir, 'package.json'), '{"private": true}\n');
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', spec], { cwd: dir, stdio: 'inherit' });
  // Pick the package's command: the one named like the package, else the first.
  const pkg = JSON.parse(readFileSync(join(dir, 'node_modules', pkgName, 'package.json'), 'utf8'));
  const bins = typeof pkg.bin === 'string' ? { [pkgName.split('/').pop()]: pkg.bin } : pkg.bin || {};
  const names = Object.keys(bins);
  const bin = names.find((n) => n === pkgName.split('/').pop()) || names[0];
  if (!bin || !existsSync(join(dir, 'node_modules', '.bin', bin))) throw new Error(`${pkgName} has no command to run`);
  launch = { command: join(dir, 'node_modules', '.bin', bin), args: npx.args || [] };
} else {
  throw new Error(`${entry.name} uses an unsupported distribution: ${Object.keys(entry.distribution).join(', ')}`);
}

writeFileSync(join(dir, 'tabhelm.json'), `${JSON.stringify({ id, name: entry.name, registryId, website: entry.website, ...launch }, null, 2)}\n`);
console.log(`\n✓ ${entry.name} installed (${launch.command} ${launch.args.join(' ')}).`);
console.log('Reopen the TabHelm panel to see it in the agent list. The agent may ask you to sign in on first use.');
