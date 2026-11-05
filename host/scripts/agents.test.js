// Agent detection: Cursor Agent CLI must be found even when it is not on PATH.
// Usage: node --test scripts/agents.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// A fake home and an empty PATH, set before agents.js reads them.
const home = mkdtempSync(join(tmpdir(), 'tabhelm-agents-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.XDG_CONFIG_HOME;
const emptyBin = join(home, 'empty-bin');
mkdirSync(emptyBin);
process.env.PATH = emptyBin;

const { listAgents, getAgent, cursorLocations, cursorIdeLaunch } = await import('../src/agents.js');
const posix = process.platform !== 'win32';

function script(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '#!/bin/sh\n');
  chmodSync(path, 0o755);
}

const cursorListed = () => listAgents().find((a) => a.id === 'cursor').installed;
const reset = () => {
  rmSync(join(home, '.local'), { recursive: true, force: true });
  rmSync(cursorLocations().ide, { recursive: true, force: true });
};

test('Cursor is not installed when nothing is there', () => {
  reset();
  assert.equal(cursorListed(), false);
  assert.throws(() => getAgent('cursor'), /not installed/);
});

test('Cursor CLI from the official installer is found outside PATH', { skip: !posix }, () => {
  reset();
  const versioned = join(home, '.local', 'share', 'cursor-agent', 'versions', '2026.11.05-abc', 'cursor-agent');
  script(versioned);
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  symlinkSync(versioned, join(home, '.local', 'bin', 'cursor-agent'));
  assert.equal(cursorListed(), true);
  const agent = getAgent('cursor');
  assert.equal(agent.command, join(home, '.local', 'bin', 'cursor-agent'));
  assert.deepEqual(agent.args, ['acp']);
});

test("Cursor IDE's own copy of the CLI is found", { skip: !posix }, () => {
  reset();
  const link = join(cursorLocations().ide, '.local', 'bin', 'cursor-agent');
  script(link);
  assert.equal(cursorListed(), true);
  assert.equal(getAgent('cursor').command, link);
});

test('Windows locations follow LOCALAPPDATA and APPDATA', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' };
  const loc = cursorLocations({ platform: 'win32', home: 'C:\\Users\\u', env });
  assert.equal(loc.standalone, join(env.LOCALAPPDATA, 'cursor-agent', 'cursor-agent'));
  assert.equal(loc.ide, join(env.APPDATA, 'Cursor', 'User', 'globalStorage', 'anysphere.cursor-agent-worker', 'agent-cli'));
});

test('macOS and Linux IDE locations', () => {
  assert.ok(cursorLocations({ platform: 'darwin', home: '/h', env: {} }).ide.startsWith(join('/h', 'Library', 'Application Support', 'Cursor')));
  assert.ok(cursorLocations({ platform: 'linux', home: '/h', env: {} }).ide.startsWith(join('/h', '.config', 'Cursor')));
  assert.ok(cursorLocations({ platform: 'linux', home: '/h', env: { XDG_CONFIG_HOME: '/x' } }).ide.startsWith(join('/x', 'Cursor')));
});

test("On Windows the IDE's copy runs node.exe with the newest complete build", () => {
  const ide = join(home, 'win-ide');
  const versions = join(ide, '.local', 'share', 'cursor-agent', 'versions');
  assert.equal(cursorIdeLaunch(ide, 'win32'), null);
  for (const build of ['2026.10.22-old', '2026.11.05-new', '.tmp-2026.12.01-partial']) {
    mkdirSync(join(versions, build), { recursive: true });
    writeFileSync(join(versions, build, 'node.exe'), '');
    writeFileSync(join(versions, build, 'index.js'), '');
  }
  // A newer build that is still missing index.js is skipped.
  mkdirSync(join(versions, '2026.11.30-incomplete'));
  writeFileSync(join(versions, '2026.11.30-incomplete', 'node.exe'), '');
  const launch = cursorIdeLaunch(ide, 'win32');
  const dir = join(versions, '2026.11.05-new');
  assert.deepEqual(launch, { command: join(dir, 'node.exe'), args: [join(dir, 'index.js'), 'acp'], env: { CURSOR_INVOKED_AS: 'cursor-agent' } });
});

test.after(() => rmSync(home, { recursive: true, force: true }));
