#!/usr/bin/env node
// Builds a release into dist/:
//   dist/tabhelm-<version>/                 unpacked release (extension/ + host/ with production deps)
//   dist/tabhelm-extension-<version>.zip    the extension alone (Load unpacked / Chrome Web Store)
//   dist/tabhelm-<version>.tar.gz           the release without host/node_modules (install.sh installs them;
//                                           the Claude/Codex ACP adapters bundle agent binaries, ~700 MB)
//   dist/tabhelm.tar.gz, dist/tabhelm-extension.zip
//                                           unversioned copies for GitHub's releases/latest/download links
// The extension has no bundler step; the build checks syntax, strips the
// test-only debug hook and packages the files.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
const step = (msg) => console.log(`• ${msg}`);

const manifest = JSON.parse(readFileSync(join(root, 'extension/manifest.json'), 'utf8'));
const hostPkg = JSON.parse(readFileSync(join(root, 'host/package.json'), 'utf8'));
const version = manifest.version;
if (hostPkg.version !== version) {
  console.error(`Version mismatch: extension ${version}, host ${hostPkg.version}. Bump both.`);
  process.exit(1);
}

step('Checking design tokens');
run(process.execPath, [join(root, 'scripts/design.js'), '--check']);

step('Checking syntax');
const jsFiles = [
  ...readdirSync(join(root, 'extension')).filter((f) => f.endsWith('.js')).map((f) => join(root, 'extension', f)),
  ...readdirSync(join(root, 'host/src')).map((f) => join(root, 'host/src', f)),
  join(root, 'host/scripts/install.js'),
  join(root, 'host/scripts/install-agent.js'),
  join(root, 'host/scripts/set-key.js'),
];
for (const file of jsFiles) run(process.execPath, ['--check', file]);

const dist = join(root, 'dist');
const out = join(dist, `tabhelm-${version}`);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

step('Copying extension (without the test hook)');
cpSync(join(root, 'extension'), join(out, 'extension'), { recursive: true });
const bgPath = join(out, 'extension/background.js');
const bg = readFileSync(bgPath, 'utf8');
const stripped = bg.replace(/\n\/\/ Dev hook for scripts\/tools-test\.js[^\n]*\nself\.tabhelmDebug = \{ runTool, ensureGroup, chatDebugState, runSchedule: \(id\) => runScheduled\(id, scheduleDeps\) \};\n/, '\n');
if (stripped === bg) throw new Error('Debug hook not found in background.js; update scripts/build.js');
writeFileSync(bgPath, stripped);

step('Copying host and installing production dependencies');
mkdirSync(join(out, 'host/scripts'), { recursive: true });
cpSync(join(root, 'host/src'), join(out, 'host/src'), { recursive: true });
for (const f of ['install.js', 'install-agent.js', 'set-key.js']) cpSync(join(root, 'host/scripts', f), join(out, 'host/scripts', f));
for (const f of ['package.json', 'package-lock.json']) cpSync(join(root, 'host', f), join(out, 'host', f));
const pkg = JSON.parse(readFileSync(join(out, 'host/package.json'), 'utf8'));
pkg.scripts = { 'install-host': pkg.scripts['install-host'], 'install-agent': pkg.scripts['install-agent'], 'set-key': pkg.scripts['set-key'] };
delete pkg.devDependencies;
writeFileSync(join(out, 'host/package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], join(out, 'host'));

cpSync(join(root, 'README.md'), join(out, 'README.md'));
writeFileSync(
  join(out, 'install.sh'),
  `#!/bin/sh
# Registers the TabHelm native host for Chrome-family browsers on this machine.
set -e
cd "$(dirname "$0")/host"
[ -d node_modules ] || npm ci --omit=dev --no-audit --no-fund
node scripts/install.js "$@"
`,
  { mode: 0o755 },
);

step('Packing archives');
const zip = join(dist, `tabhelm-extension-${version}.zip`);
const tgz = join(dist, `tabhelm-${version}.tar.gz`);
for (const f of [zip, tgz]) if (existsSync(f)) rmSync(f);
run('zip', ['-qr', zip, '.'], join(out, 'extension'));
run('tar', ['-czf', tgz, '--exclude', 'node_modules', '--exclude', 'tabhelm-host.sh', '-C', dist, `tabhelm-${version}`]);
cpSync(zip, join(dist, 'tabhelm-extension.zip'));
cpSync(tgz, join(dist, 'tabhelm.tar.gz'));

const size = (f) => run('du', ['-sh', f]).split('\t')[0];
console.log(`\nBuilt TabHelm ${version}`);
console.log(`  ${out}/  (${size(out)})`);
console.log(`  ${zip}  (${size(zip)})`);
console.log(`  ${tgz}  (${size(tgz)})`);
