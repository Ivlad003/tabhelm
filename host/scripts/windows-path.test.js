// Live Windows PATH: agents installed after setup must be found.
// Usage: node --test scripts/windows-path.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandWindowsVars, mergeWindowsPath, parsePathOutput, PATH_COMMAND, refreshWindowsPath, windowsPathReady } from '../src/env.js';

const env = { LocalAppData: 'C:\\Users\\Влад\\AppData\\Local', USERPROFILE: 'C:\\Users\\Влад' };

test('%VAR% expands ignoring case; unknown names stay', () => {
  assert.equal(expandWindowsVars('%LOCALAPPDATA%\\cursor-agent', env), 'C:\\Users\\Влад\\AppData\\Local\\cursor-agent');
  assert.equal(expandWindowsVars('%userprofile%\\.local\\bin;%NOPE%\\x', env), 'C:\\Users\\Влад\\.local\\bin;%NOPE%\\x');
});

test('only new folders are appended, in order, without duplicates', () => {
  const current = 'C:\\Windows\\system32;C:\\Users\\Влад\\.local\\bin\\';
  const entries = [
    'C:\\WINDOWS\\System32\\', // already there (case and trailing slash differ)
    '%LOCALAPPDATA%\\cursor-agent', // installed after setup
    '',
    '   ',
    '"C:\\Program Files\\nodejs\\"',
    '%NOPE%\\bin', // cannot be expanded
    '%USERPROFILE%\\.local\\bin', // already there once expanded
    'c:\\users\\влад\\appdata\\local\\cursor-agent', // same as the second one
  ];
  const { path, added } = mergeWindowsPath(current, entries, env);
  assert.deepEqual(added, ['C:\\Users\\Влад\\AppData\\Local\\cursor-agent', 'C:\\Program Files\\nodejs\\']);
  assert.equal(path, `${current};${added.join(';')}`);
});

test('an empty PATH takes the registry folders as they are', () => {
  assert.deepEqual(mergeWindowsPath('', ['C:\\a', 'C:\\b'], {}), { path: 'C:\\a;C:\\b', added: ['C:\\a', 'C:\\b'] });
  assert.deepEqual(mergeWindowsPath('C:\\a', [], {}), { path: 'C:\\a', added: [] });
});

test('PowerShell output is base64 UTF-8, so non-ASCII folders survive', () => {
  const stdout = `${Buffer.from('C:\\Users\\Влад\\bin;C:\\x', 'utf8').toString('base64')}\r\n`;
  assert.deepEqual(parsePathOutput(stdout), ['C:\\Users\\Влад\\bin', 'C:\\x']);
  assert.equal(parsePathOutput('powershell.exe : something failed\r\n'), null);
  assert.equal(parsePathOutput(''), null);
});

test('the PowerShell command reads both the system and the user PATH', () => {
  const i = PATH_COMMAND.indexOf('-EncodedCommand');
  assert.ok(i >= 0 && PATH_COMMAND.includes('-NoProfile'));
  const script = Buffer.from(PATH_COMMAND[i + 1], 'base64').toString('utf16le');
  assert.match(script, /GetEnvironmentVariable\('Path','Machine'\)/);
  assert.match(script, /GetEnvironmentVariable\('Path','User'\)/);
  assert.match(script, /ToBase64String/);
});

test('outside Windows the refresh does nothing', { skip: process.platform === 'win32' }, async () => {
  const before = process.env.PATH;
  assert.deepEqual(await refreshWindowsPath(), []);
  assert.deepEqual(await windowsPathReady(), []);
  assert.equal(process.env.PATH, before);
});
