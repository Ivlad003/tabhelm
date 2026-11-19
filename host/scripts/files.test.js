// Files an agent produced: what counts as produced, what is offered, and that
// only offered files can be read back.
// Usage: node --test scripts/files.test.js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotDir, changedFiles, editedPaths, describeFiles, offeredPath, readOffered, saveGenerated, OFFER_MAX } from '../src/files.js';

const base = mkdtempSync(join(tmpdir(), 'tabhelm-files-'));
after(() => rmSync(base, { recursive: true, force: true }));
const dir = (name) => {
  const d = join(base, name);
  mkdirSync(d, { recursive: true });
  return d;
};
const write = (root, rel, text) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
};

test('new and changed files are found; untouched ones, dot-folders and node_modules are not', () => {
  const root = dir('work');
  write(root, 'notes.md', 'old');
  write(root, 'keep.txt', 'same');
  write(root, 'src/app.js', 'v1');
  const before = snapshotDir(root);
  write(root, 'report.csv', 'a,b\n1,2\n');
  write(root, 'out/chart.svg', '<svg/>');
  write(root, 'notes.md', 'old and new');
  write(root, 'src/app.js', 'v2'); // same size: the time tells
  utimesSync(join(root, 'src/app.js'), new Date(), new Date(Date.now() + 5000));
  write(root, '.claude/session.json', '{}');
  write(root, 'node_modules/pkg/index.js', 'x');
  const changed = changedFiles(before, snapshotDir(root));
  assert.deepEqual(changed.map((f) => [f.rel.replace(/\\/g, '/'), f.created]), [
    ['out/chart.svg', true],
    ['report.csv', true],
    ['notes.md', false],
    ['src/app.js', false],
  ]);
});

test('a folder too big or too deep to compare says so', () => {
  const root = dir('big');
  for (let i = 0; i < 12; i++) write(root, `f${i}.txt`, 'x');
  assert.equal(snapshotDir(root, { maxFiles: 10 }).truncated, true);
  assert.equal(snapshotDir(root, { maxFiles: 100 }).truncated, false);
  write(root, 'a/b/c/deep.txt', 'x');
  assert.equal(snapshotDir(root, { maxDepth: 2 }).truncated, true);
});

test('edits an agent reports are collected from locations and diffs', () => {
  assert.deepEqual(editedPaths({ kind: 'edit', locations: [{ path: '/w/a.txt' }, { line: 3 }], content: [{ type: 'diff', path: '/w/b.txt', newText: 'x' }] }), ['/w/a.txt', '/w/b.txt']);
  assert.deepEqual(editedPaths({ kind: 'read', locations: [{ path: '/w/secret.txt' }] }), []); // reading is not producing
  assert.deepEqual(editedPaths({ locations: [{ path: '/w/c.txt' }] }, 'edit'), ['/w/c.txt']); // an update without its kind
  assert.deepEqual(editedPaths({ kind: 'execute', content: [{ type: 'content', content: { type: 'text', text: 'ok' } }] }), []);
  assert.deepEqual(editedPaths(null), []);
});

test('the list for the panel: ids, sizes, paths inside the folder, files elsewhere marked', () => {
  const root = dir('list');
  const elsewhere = dir('elsewhere');
  write(root, 'data/prices.csv', '1,2,3');
  write(elsewhere, 'export.json', '{"a":1}');
  const { files, more } = describeFiles(7, root, [{ rel: join('data', 'prices.csv'), created: true }, { rel: 'gone.txt', created: true }], [join(elsewhere, 'export.json'), join(root, 'data', 'prices.csv'), root]);
  assert.equal(more, 0);
  assert.deepEqual(files.map(({ id, ...f }) => f), [
    { name: 'prices.csv', path: 'data/prices.csv', size: 5, created: true, outside: false },
    { name: 'export.json', path: join(elsewhere, 'export.json'), size: 7, created: false, outside: true },
  ]);
  assert.match(files[0].id, /^f\d+$/);
  assert.equal(offeredPath(7, files[0].id), join(root, 'data', 'prices.csv'));
  // The same file offered again keeps its id; another chat does not see it.
  assert.equal(describeFiles(7, root, [{ rel: join('data', 'prices.csv'), created: false }]).files[0].id, files[0].id);
  assert.equal(offeredPath(8, files[0].id), null);
});

test('a long list is capped and says how many are left out', () => {
  const root = dir('many');
  const changed = [];
  for (let i = 0; i < OFFER_MAX + 5; i++) {
    write(root, `f${String(i).padStart(3, '0')}.txt`, 'x');
    changed.push({ rel: `f${String(i).padStart(3, '0')}.txt`, created: true });
  }
  const { files, more } = describeFiles(9, root, changed);
  assert.equal(files.length, OFFER_MAX);
  assert.equal(more, 5);
});

test('an offered file comes back whole, in chunks; anything else is refused', () => {
  const root = dir('read');
  const bytes = Buffer.from(Array.from({ length: 2500 }, (_, i) => i % 251));
  writeFileSync(join(root, 'blob.bin'), bytes);
  write(root, 'empty.txt', '');
  const { files } = describeFiles(11, root, [{ rel: 'blob.bin', created: true }, { rel: 'empty.txt', created: true }]);
  const chunks = [...readOffered(11, files[0].id, { chunkBytes: 1000 })];
  assert.deepEqual(chunks.map((c) => [c.seq, c.last, c.size, c.name]), [[0, false, 2500, 'blob.bin'], [1, false, 2500, 'blob.bin'], [2, true, 2500, 'blob.bin']]);
  assert.ok(Buffer.concat(chunks.map((c) => Buffer.from(c.data, 'base64'))).equals(bytes));
  assert.deepEqual([...readOffered(11, files[1].id)], [{ seq: 0, last: true, data: '', size: 0, name: 'empty.txt' }]);
  // Not offered: an id from nowhere, a path instead of an id, another chat's id.
  assert.throws(() => [...readOffered(11, 'f999999')], /no longer offered/);
  assert.throws(() => [...readOffered(11, join(root, 'blob.bin'))], /no longer offered/);
  assert.throws(() => [...readOffered(12, files[0].id)], /no longer offered/);
  assert.throws(() => [...readOffered(11, files[0].id, { maxBytes: 100 })], /too large/);
  rmSync(join(root, 'blob.bin'));
  assert.throws(() => [...readOffered(11, files[0].id)], /The file is gone/);
});

test('file_save writes a plain file name into the folder and never overwrites what was there', () => {
  const root = dir('save');
  write(root, 'report.md', 'the user\'s own report');
  const first = saveGenerated(21, root, { name: 'report.md', content: '# Agent report' });
  assert.equal(first.name, 'report (2).md');
  assert.equal(readFileSync(join(root, 'report.md'), 'utf8'), 'the user\'s own report');
  // Its own file may be replaced by a newer version.
  const again = saveGenerated(21, root, { name: 'report (2).md', content: '# Agent report, v2' });
  assert.equal(again.path, first.path);
  assert.equal(readFileSync(first.path, 'utf8'), '# Agent report, v2');
  // Folders in the name are dropped: nothing is written outside the agent's folder.
  const sneaky = saveGenerated(21, root, { name: '../../outside/evil.sh', content: 'echo' });
  assert.equal(sneaky.path, join(root, 'evil.sh'));
  assert.equal(saveGenerated(21, root, { name: 'C:\\Windows\\win.ini', content: 'x' }).path, join(root, 'win.ini'));
  assert.equal(saveGenerated(21, root, { name: 'таблиця', content: 'a,b' }).name, 'таблиця.txt');
  assert.equal(saveGenerated(21, root, { name: '  ', content: 'x' }).name, 'file.txt');
  assert.throws(() => saveGenerated(21, root, { name: 'a.txt', content: '' }), /needs content/);
  assert.throws(() => saveGenerated(21, root, { name: 'a.txt', content: 'x'.repeat(2_000_001) }), /too long/);
});
