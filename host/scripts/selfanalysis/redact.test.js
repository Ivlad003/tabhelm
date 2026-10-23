// Redaction and normalization (extension/redact.js): the shared redaction
// table, secret values, fingerprint stability, hostOf, topFrame, host
// aliasing, value-free step descriptions, arg keys and hashes.
// Run: node --test host/scripts/selfanalysis/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REDACTION_TABLE, redactText, normalize, norm, blankQuotes, hostOf, topFrame, aliasHosts, safeDesc, argKeys, stableHash, fnv1a32,
} from '../../../extension/redact.js';

const FULL_URL = /https?:\/\/\S+\/\S/;

test('redaction table: norm() gives the expected text for every row', () => {
  assert.ok(REDACTION_TABLE.length >= 30);
  for (const [input, expected] of REDACTION_TABLE) assert.equal(norm(input), expected, `input: ${JSON.stringify(input)}`);
});

test('redaction table is frozen, so the host parity test reads the same rows', () => {
  assert.ok(Object.isFrozen(REDACTION_TABLE));
  for (const row of REDACTION_TABLE) {
    assert.ok(Object.isFrozen(row));
    assert.equal(row.length, 2);
    assert.ok(row[0].length < 160, 'inputs stay below both truncation limits');
  }
});

test('norm() is idempotent, so redacting an already redacted line changes nothing', () => {
  for (const [, expected] of REDACTION_TABLE) assert.equal(norm(expected), expected);
});

test('known secret values become {{SECRET}}, longest first, exact match only', () => {
  const secrets = ['s3cr3t', 's3cr3tValue', 'abc', '', null];
  assert.equal(redactText('typed s3cr3tValue into e3', { secrets }), 'typed {{SECRET}} into e3');
  assert.equal(redactText('pin s3cr3t, other S3CR3TVALUE', { secrets }), 'pin {{SECRET}}, other S3CR3TVALUE');
  // Shorter than 4 characters: would hit ordinary words.
  assert.equal(redactText('abc def', { secrets }), 'abc def');
  assert.equal(norm('Value "s3cr3tValue" rejected', { secrets: ['s3cr3tValue'] }), 'Value "…" rejected');
  assert.ok(!norm('x s3cr3tValuex', { secrets: ['s3cr3tValue'] }).includes('s3cr3t'));
});

test('secret placeholders lose their names', () => {
  assert.equal(redactText('{{SECRET:x}} and {{SECRET:bank pin}}'), '{{SECRET}} and {{SECRET}}');
});

test('emails are replaced', () => {
  assert.equal(norm('Mail ada@example.com or bob.smith+tabs@mail.example.org.'), 'Mail <email> or <email>.');
});

test('URLs with a path or query keep only the host', () => {
  const out = norm('Open https://shop.example.com/orders/12345?token=abc&email=ada%40x.com#frag then http://news.example.org/a/b');
  assert.equal(out, 'Open shop.example.com then news.example.org');
  assert.doesNotMatch(out, FULL_URL);
  for (const [, expected] of REDACTION_TABLE) assert.doesNotMatch(expected, FULL_URL);
});

test('quoted typed text becomes "…" (straight and curly quotes)', () => {
  assert.equal(normalize('Type "Ada Lovelace" and “hello world”'), 'Type "…" and "…"');
  assert.equal(normalize('empty ""'), 'empty "…"');
});

test('canary: quotes inside quotes, other quote styles and unpaired quotes never keep the text', () => {
  const leaks = (s) => /Ivan|Petrenko|Vanya|Олена|Іван|CANARY/.test(s);
  for (const input of [
    'A JavaScript confirm dialog is blocking the page: "Delete "Invoice 42 for Ivan Petrenko"?". Use browser_handle_dialog first.',
    'No option matching "Ivan "Vanya" in e12',
    'No option matching "Ivan" Petrenko" in e12',
    'Typed “Hello “Ivan” Petrenko” into e3',
    "Failed to execute 'querySelector' on 'Document': 'li:has-text(Ivan Petrenko)' is not a valid selector.",
    "Cannot read properties of undefined (reading 'Ivan Petrenko')",
    "It's 'Ivan's car' now",
    'Знайдіть «Іван Петренко» або „Олена“ або ‘Ivan’',
    '"CANARY" said "Ivan" and “CANARY”',
    // A confirm() text or a typed value with line breaks in it.
    'A JavaScript confirm dialog is blocking the page: "Delete invoice?\n\nIvan Petrenko will be notified". Use browser_handle_dialog first.',
    'No option matching "Olena\nIvan" in e12',
    "Failed to execute 'querySelector' on 'Document': 'li:has-text(CANARY\nPetrenko)' is not a valid selector.",
  ]) assert.ok(!leaks(norm(input)), `${input} → ${norm(input)}`);
  // Apostrophes are not quotes; a quote that never closes is left to the renderers' guard.
  assert.equal(normalize("don't stop, it's Ada's"), "don't stop, it's Ada's");
  assert.equal(normalize('Tool "browser_wait" timed out'), 'Tool "…" timed out');
  // What redaction already replaced stays readable inside quotes.
  assert.equal(norm("EACCES: open '/home/u/.tabhelm/host.log'"), "EACCES: open '<path>.log'");
  assert.equal(norm('File "/home/u/x/y.py", line 15'), 'File "<path>.py", line N');
  assert.equal(norm("open '/home/u/x.pdf' and 'Ada'"), "open '<path>.pdf' and '…'");
});

test('blankQuotes: kept pairs, the style of the blank, unpaired quotes and toEnd', () => {
  const keep = (inner) => inner === 'ok';
  assert.equal(blankQuotes('a "ok" b “x” c "ok" d', { keep }), 'a "ok" b “…” c "ok" d');
  // A kept name glued to a word is part of a nested quote, not a pair.
  assert.equal(blankQuotes('a “ok”Ivan” b', { keep }), 'a “…” b');
  // An odd number of straight quotes: none of them pairs, the rest of the line goes.
  assert.equal(blankQuotes('a "ok" Ivan" b', { keep }), 'a "…"');
  assert.equal(blankQuotes("a 'ok' Ivan' b, it's", { keep }), "a '…'");
  assert.equal(blankQuotes('a «x» „y“ ‘z’ \'w\''), 'a «…» „…” ‘…’ \'…\'');
  assert.equal(blankQuotes('cut “Ivan Petr'), 'cut “…”');
  assert.equal(blankQuotes('a "x" b "ok" c', { keep }), 'a "…" c');
  assert.equal(blankQuotes('a "x" b "ok" c', { keep, toEnd: true }), 'a "…"');
  // A dialog message or typed value may hold line breaks: the span crosses them.
  assert.equal(blankQuotes('line "a\nb" c'), 'line "…" c');
  assert.equal(blankQuotes('line "a\nb c'), 'line "…"');
});

test('refs and numbers do not change the fingerprint', () => {
  const a = norm('Ref e12 is stale or unknown (http://localhost:41234/form, retry 12)');
  const b = norm('Ref e40 is stale or unknown (http://localhost:39001/form, retry 99)');
  assert.equal(a, b);
  assert.equal(fnv1a32(`error|page.stale-ref|browser_click|site:local|${a}`), fnv1a32(`error|page.stale-ref|browser_click|site:local|${b}`));
  assert.equal(norm('Element f2:e7 is not visible'), norm('Element e1234 is not visible'));
  assert.equal(norm('timed out after 41234 ms on port 39001'), norm('timed out after 1200 ms on port 8080'));
});

test('single digits and words that contain e-numbers stay', () => {
  assert.equal(normalize('Exited with code 1 after e2e run'), 'Exited with code 1 after e2e run');
});

test('home paths: Linux, macOS and Windows', () => {
  assert.equal(norm('/home/ivanko/x/y.pdf'), '<path>.pdf');
  assert.equal(norm('Not a folder: /Users/ada/Projects/site'), 'Not a folder: <path>');
  assert.equal(norm('Cannot read C:\\Users\\Name\\Documents\\taxes.xlsx'), 'Cannot read <path>.xlsx');
  assert.equal(norm('Saved C:\\Users\\Name'), 'Saved <path>');
  assert.equal(norm('Saved /home/ivanko'), 'Saved <path>');
  // Only the extension survives, and only a short alphanumeric one.
  assert.equal(norm('/home/u/a/report.my-secret-project'), '<path>');
  assert.equal(norm('/home/u/.tabhelm/host.log'), '<path>.log');
  assert.equal(norm('/home/u/a/.env'), '<path>');
  // Absolute paths outside home too.
  assert.equal(norm('spawn /usr/local/bin/claude ENOENT'), 'spawn <path> ENOENT');
});

test('canary: paths with spaces, other scripts, Windows profiles and shares keep no user, folder or file name', () => {
  const inputs = [
    'Not a folder: C:\\Users\\CANARY Petrenko\\Desktop\\Taxes CANARY',
    'Not a folder: /home/ivan/My CANARY/Acme CANARY Patients',
    "prompt failed for tab 100: EACCES: permission denied, open 'C:\\Users\\CANARY Petrenko\\.claude\\settings.json'",
    "[claude:4] ENOENT '/Users/ivan/Library/Mobile Documents/com~apple~CloudDocs/CANARY/Olena CANARY.pdf'",
    "uncaught: Error: ENOENT: no such file or directory, scandir '/home/CANARY/Документи/Податки CANARY'",
    'Cannot open \\\\CANARY\\share\\HR\\CANARY salaries.xlsx',
    'Cannot open //CANARY/share/x',
    'Not a folder: /Volumes/Google Drive/CANARY/Acme CANARY',
    'Not a folder: /srv/Клієнти/ТОВ CANARY',
    'Not a folder: D:\\Clients\\Acme CANARY\\2025',
    'Not a folder: C:/Users/CANARY Petrenko/Desktop',
    'JSON: {"path":"C:\\\\Users\\\\CANARY Petrenko\\\\x.txt"}',
    'Not a folder: ~/CANARY Projects/Acme CANARY',
    "open '/home/u/CANARY's Files/Olena CANARY.pdf'",
    'Saved to /home/u/CANARY notes.txt, then opened /tmp/CANARY dir/x',
    // Glued to a word and a colon, a long-path prefix, a share as a URL.
    'Bad cwd:/home/ivan/CANARY Clinic/Patients',
    'ERROR:C:\\Users\\CANARY Petrenko\\Desktop',
    'Cannot open \\\\?\\C:\\Users\\CANARY Petrenko\\x.txt',
    'Cannot open smb://fileserver/HR/CANARY Petrenko.xlsx',
  ];
  for (const input of inputs) {
    const out = norm(input);
    assert.doesNotMatch(out, /CANARY|Petrenko|Olena|Документи|Податки|Клієнти|salaries|Desktop|Acme/, `${input} → ${out}`);
  }
  assert.equal(norm(inputs[0]), 'Not a folder: <path>');
  assert.equal(norm(inputs[3]), "[claude:4] ENOENT '<path>.pdf'");
  assert.equal(norm(inputs[5]), 'Cannot open <path>.xlsx');
});

test('pairing codes in the real relay format; ordinary capitals stay', () => {
  assert.equal(norm('code K7PM-3QWX'), 'code <code>');
  assert.equal(norm('AUTHORS HTTPS README CHANGELOG'), 'AUTHORS HTTPS README CHANGELOG');
  // The dash is mandatory and I, O, 0 and 1 are not in the alphabet.
  assert.equal(norm('K7PM3QWX and IO01-ABCD'), 'K7PM3QWX and IO01-ABCD');
});

test('API keys, tokens and JWTs become <key>', () => {
  // Fake keys are split in two so secret scanners do not report them as leaks.
  for (const key of [
    'sk-' + 'ant-api03-exampleexampleexample',
    'pk-' + 'live-0000example0000',
    'ghp' + '_exampleExampleExample0123456789ab',
    'github' + '_pat_11ABCDEFG0exampleexampleexample',
    'xoxb' + '-1234-example',
    'AKIA' + 'IOSFODNN7EXAMPLE',
    'AIza' + 'SyExampleExampleExampleExample12345',
    'eyJhbGciOiJIUzI1NiJ9' + '.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlMTIz',
  ]) assert.equal(redactText(`key ${key} rejected`), 'key <key> rejected', key);
  assert.equal(redactText('Authorization: Bearer abc.def'), 'Authorization: <key>');
});

test('key=value secrets keep the key name', () => {
  assert.equal(redactText('api_key=abc&x=1 pwd=hunter2 Code=4/0Ab auth=xyz'), 'api_key=<redacted>&x=1 pwd=<redacted> Code=<redacted> auth=<redacted>');
});

test('IBANs, long digit runs and IPv4 addresses', () => {
  assert.equal(redactText('IBAN DE89370400440532013000'), 'IBAN <iban>');
  assert.equal(redactText('card 4111-1111-1111-1111, phone 067 123 45 67'), 'card <number>, phone <number>');
  assert.equal(redactText('server 8.8.8.8 and 192.168.0.10'), 'server <ip> and <ip>');
  assert.equal(redactText('loopback 127.0.0.1 stays'), 'loopback 127.0.0.1 stays');
  // Not addresses: octets above 255 and longer dotted versions.
  assert.equal(redactText('build 300.1.2.3 and 1.2.3.4.5'), 'build 300.1.2.3 and 1.2.3.4.5');
});

test('token rule: catches hex and base64, keeps tool names and code paths', () => {
  assert.equal(redactText('id 0123456789abcdef0123456789abcdef'), 'id <token>');
  assert.equal(redactText('blob QWxhZGRpbjpvcGVuIHNlc2FtZTEyMw== end'), 'blob <token> end');
  const keep = 'browser_select_option browser_handle_dialog extension/browser-tools tabhelm_diagnose memory_search Cannot_read_properties_of';
  assert.equal(redactText(keep), keep);
  // 23 characters with digits: below the minimum length.
  assert.equal(redactText('ref abcdefghij0123456789xyz'.slice(0, 27)), 'ref abcdefghij0123456789xyz'.slice(0, 27));
});

test('whitespace collapses and the result is cut to 160 characters', () => {
  const long = norm(`${'word '.repeat(100)}end`);
  assert.equal(long.length, 160);
  assert.ok(long.endsWith('…'));
  assert.equal(norm('a\n\n  b\tc  '), 'a b c');
  assert.equal(norm('x'.repeat(50), { max: 10 }), `${'x'.repeat(9)}…`);
  // No half surrogate pair before the ellipsis.
  assert.equal(norm(`${'x'.repeat(8)}😀😀`, { max: 10 }), `${'x'.repeat(8)}…`);
});

test('non-string input does not throw', () => {
  assert.equal(redactText(undefined), '');
  assert.equal(redactText(null), '');
  assert.equal(norm(42), 'N');
  assert.equal(normalize(undefined), '');
});

test('huge input stays fast (no quadratic backtracking)', () => {
  const inputs = ['a'.repeat(300_000), `${'ab1/'.repeat(75_000)}`, '1 '.repeat(150_000), '/a'.repeat(150_000), 'a.'.repeat(150_000),
    ' "a'.repeat(100_000), ' \'a'.repeat(100_000), ' «a'.repeat(100_000), '“a”'.repeat(100_000), `/home/u/${' '.repeat(300_000)}x`, ' /a b'.repeat(75_000),
    `C:\\${'a\\'.repeat(150_000)}`, '\\\\a'.repeat(100_000)];
  const t0 = performance.now();
  for (const s of inputs) norm(s);
  assert.ok(performance.now() - t0 < 1000, `took ${Math.round(performance.now() - t0)} ms`);
});

test('hostOf: hosts, local addresses, browser pages and invalid input', () => {
  const cases = [
    ['https://Shop.Example.com/cart?x=1#y', 'shop.example.com'],
    ['https://example.com./a', 'example.com'],
    ['wss://relay.example.net:8443/ws', 'relay.example.net'],
    ['http://localhost:41234/form', 'local'],
    ['http://app.localhost/', 'local'],
    ['http://127.0.0.5:9000/', 'local'],
    ['http://[::1]:9229/json', 'local'],
    ['http://[fd12:3456::1]/', 'local'],
    ['http://10.1.2.3/', 'local'],
    ['http://172.16.0.1/', 'local'],
    ['http://172.31.255.255/', 'local'],
    ['http://172.32.0.1/', '172.32.0.1'],
    ['http://192.168.1.1/admin', 'local'],
    ['http://169.254.169.254/latest', 'local'],
    ['http://8.8.8.8/', '8.8.8.8'],
    ['file:///home/ivanko/a.pdf', 'file'],
    ['chrome://settings/passwords', 'chrome://settings'],
    ['chrome://newtab/', 'chrome://newtab'],
    ['chrome://', 'chrome://'],
    ['chrome-untrusted://print/x', 'chrome-untrusted://print'],
    ['devtools://devtools/bundled/inspector.html', 'devtools://devtools'],
    ['about:blank', 'about:blank'],
    ['about:blank#frag', 'about:blank'],
    ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/sidepanel.html', 'chrome-extension'],
    ['data:text/html,<p>secret</p>', 'data'],
    ['javascript:alert(1)', 'javascript'],
    ['canary5:payload', null],
    ['not a url', null],
    ['example.com/path', null],
    ['https://', null],
    ['', null],
    [undefined, null],
    [42, null],
  ];
  for (const [url, want] of cases) assert.equal(hostOf(url), want, String(url));
});

test('topFrame: first frame in extension or host code, as basename:line', () => {
  const chrome = [
    "TypeError: Cannot read properties of null (reading 'x')",
    '    at findText (chrome-extension://abcdefghijklmnop/browser-tools.js:965:12)',
    '    at async runTool (chrome-extension://abcdefghijklmnop/browser-tools.js:631:5)',
  ].join('\n');
  assert.equal(topFrame(chrome), 'browser-tools.js:965');
  assert.equal(topFrame('chrome-extension://abc/browser-tools.js:965:12'), 'browser-tools.js:965');
  assert.equal(topFrame('    at chrome-extension://abc/sidepanel.js:1941:7'), 'sidepanel.js:1941');

  const node = [
    'Error: write EPIPE',
    '    at afterWriteDispatched (node:internal/stream_base_commons:161:15)',
    '    at writeGeneric (node:internal/stream_base_commons:152:3)',
    '    at Session.prompt (/home/u/.tabhelm/app/host/src/session.js:181:11)',
    '    at NativeHost.handle (/home/u/.tabhelm/app/host/src/native-host.js:90:3)',
  ].join('\n');
  assert.equal(topFrame(node), 'session.js:181');
  assert.equal(topFrame('    at file:///home/u/.tabhelm/app/host/src/native-host.js:120:7'), 'native-host.js:120');
  assert.equal(topFrame('    at run (C:\\Users\\u\\tabhelm\\host\\src\\session.js:44:9)'), 'session.js:44');
  assert.equal(topFrame('    at analyze (/home/ivanko/pet_project/tabhelm/extension/analyzer.js:12:3)'), 'analyzer.js:12');
  assert.equal(topFrame('    at x (chrome-extension://abc/browser-tools.js?v=2:10:1)'), 'browser-tools.js:10');
});

test('topFrame: null for pages, dependencies, internals and junk', () => {
  for (const stack of [
    '    at app (https://example.com/extension/app.js:1:2)',
    '    at x (/home/u/.tabhelm/app/host/node_modules/ws/lib/websocket.js:10:1)',
    '    at y (/home/u/.tabhelm/app/host/scripts/e2e.js:10:1)',
    '    at node:internal/main/run_main_module:28:49',
    '    at <anonymous>:1:1',
    'Error: no stack',
    '',
    null,
    undefined,
    { stack: 'x' },
  ]) assert.equal(topFrame(stack), null, String(stack));
});

test('aliasHosts: whole hosts only, longest first, case-insensitive', () => {
  const map = { 'example.com': 'site-1', 'shop.example.com': 'site-2', 'shop-helper': 'skill-1' };
  assert.equal(
    aliasHosts('shop.example.com and example.com, not example.com.ua or myexample.com; EXAMPLE.COM.', map),
    'site-2 and site-1, not example.com.ua or myexample.com; site-1.',
  );
  assert.equal(aliasHosts('site:shop.example.com|https://example.com/x skill shop-helper', map), 'site:site-2|https://site-1/x skill skill-1');
  // An alias is never aliased again.
  assert.equal(aliasHosts('a.com b.com', new Map([['a.com', 'b.com'], ['b.com', 'site-2']])), 'b.com site-2');
  assert.equal(aliasHosts('keep me', {}), 'keep me');
  assert.equal(aliasHosts('keep me', null), 'keep me');
  assert.equal(aliasHosts('a+b.com', { 'a+b.com': 'site-1' }), 'site-1');
});

const CANARY_ARGS = {
  ref: 'e5',
  text: 'CANARY_TEXT',
  value: 'CANARY_VALUE',
  url: 'https://shop.example.com/CANARY_PATH?q=CANARY_QUERY',
  fields: [{ ref: 'e1', value: 'CANARY_FIELD' }, { ref: 'e2', value: 'CANARY_FIELD2' }],
  key: 'CANARY_KEY',
  expression: 'CANARY_JS',
  message: 'CANARY_MESSAGE',
  query: 'CANARY_QUERY2',
  name: 'CANARY_NAME',
  path: 'CANARY_FILE',
  action: 'new',
  direction: 'CANARY_DIR',
  paths: ['/home/u/CANARY_UPLOAD.pdf'],
};
const TOOLS = [
  'browser_click', 'browser_click_xy', 'browser_hover', 'browser_drag', 'browser_type', 'browser_select_option', 'browser_fill_form',
  'browser_navigate', 'browser_tabs', 'browser_press_key', 'browser_scroll', 'browser_wait', 'browser_handle_dialog', 'browser_find',
  'browser_evaluate', 'browser_upload_file', 'browser_snapshot', 'browser_network_body', 'browser_request_human', 'browser_storage',
  'memory_save', 'memory_search', 'skill_read', 'skill_read_file', 'browser_some_new_tool', 'tabhelm_diagnose', undefined,
];

test('safeDesc never contains typed text, values, URL paths or (by default) labels', () => {
  for (const tool of TOOLS) {
    for (const opts of [undefined, {}, { labels: false }]) {
      const d = safeDesc(tool, CANARY_ARGS, 'CANARY_LABEL', opts);
      assert.doesNotMatch(d, /CANARY/, `${tool}: ${d}`);
      assert.doesNotMatch(d, FULL_URL);
    }
    const withLabels = safeDesc(tool, CANARY_ARGS, 'Size', { labels: true });
    assert.doesNotMatch(withLabels, /CANARY/, `${tool} (labels): ${withLabels}`);
  }
});

test('safeDesc: the described forms', () => {
  assert.equal(safeDesc('browser_click', { ref: 'e5' }, 'Buy now'), 'Click <ref>');
  assert.equal(safeDesc('browser_click', { ref: 'e5', double: true }, 'Buy now', { labels: true }), 'Double-click “Buy now”');
  assert.equal(safeDesc('browser_hover', { ref: 'e5' }, 'Menu', { labels: true }), 'Hover “Menu”');
  assert.equal(safeDesc('browser_drag', { fromRef: 'e1', toRef: 'e2' }, null, { labels: true }), 'Drag <ref>');
  assert.equal(safeDesc('browser_type', { ref: 'e3', text: 'hello world', submit: true }, 'Search', { labels: true }), 'Type <11 chars> into “Search” + Enter');
  assert.equal(safeDesc('browser_type', { ref: 'e3', text: 'x' }, 'Search'), 'Type <1 char> into <ref>');
  assert.equal(safeDesc('browser_select_option', { ref: 'e9', value: 'XL' }, 'Size', { labels: true }), 'Select an option in “Size”');
  assert.equal(safeDesc('browser_fill_form', { fields: [{}, {}, {}] }), 'Fill 3 fields');
  assert.equal(safeDesc('browser_fill_form', { fields: [{}] }), 'Fill 1 field');
  assert.equal(safeDesc('browser_navigate', { url: 'https://shop.example.com/p/1?q=x' }), 'Open shop.example.com');
  assert.equal(safeDesc('browser_navigate', { url: 'nonsense' }), 'Open a page');
  assert.equal(safeDesc('browser_tabs', { action: 'new', url: 'http://localhost:3000/x' }), 'Open local');
  assert.equal(safeDesc('browser_tabs', { action: 'switch', tabId: 4 }), 'Switch tab');
  assert.equal(safeDesc('browser_press_key', { key: 'enter' }), 'Press Enter');
  assert.equal(safeDesc('browser_press_key', { key: 'ctrl+Shift+Tab' }), 'Press Control+Shift+Tab');
  assert.equal(safeDesc('browser_press_key', { key: 'a' }), 'Press a key');
  assert.equal(safeDesc('browser_press_key', { key: 'Control+a' }), 'Press a key');
  assert.equal(safeDesc('browser_press_key', { key: 'Hyper+Enter' }), 'Press a key');
  assert.equal(safeDesc('browser_scroll', { direction: 'down' }), 'Scroll down');
  assert.equal(safeDesc('browser_handle_dialog', { accept: true }), 'Accept dialog');
  assert.equal(safeDesc('browser_snapshot', {}), 'Read the page');
  assert.equal(safeDesc('browser_some_new_tool', {}), 'Some new tool');
  assert.equal(safeDesc('weird tool name!', {}), 'Use a tool');
  assert.equal(safeDesc('browser_click', null), 'Click <ref>');
});

test('safeDesc labels are redacted and short', () => {
  const d = safeDesc('browser_click', { ref: 'e1' }, 'Email ada@example.com and a very long label that keeps going on', { labels: true });
  assert.ok(!d.includes('ada@'));
  assert.ok(d.length <= 'Click “”'.length + 40);
});

test('argKeys: sorted key names, one level deep, never values', () => {
  assert.deepEqual(argKeys({ text: 'CANARY', ref: 'e1', submit: true }), ['ref', 'submit', 'text']);
  assert.deepEqual(argKeys({ fields: [{ ref: 'e1', value: 'CANARY' }, { ref: 'e2', value: 'x', kind: 'text' }] }), ['fields.kind', 'fields.ref', 'fields.value']);
  assert.deepEqual(argKeys({ from: { x: 1, y: 2 }, to: {}, deep: { a: { b: 'CANARY' } } }), ['deep.a', 'from.x', 'from.y', 'to']);
  assert.deepEqual(argKeys({ paths: ['/home/u/CANARY.pdf'], 'Ada Lovelace': 1 }), ['?', 'paths']);
  assert.deepEqual(argKeys(null), []);
  assert.deepEqual(argKeys('CANARY'), []);
  assert.deepEqual(argKeys([1, 2]), []);
  assert.doesNotMatch(JSON.stringify(argKeys(CANARY_ARGS)), /CANARY/);
});

test('fnv1a32: standard vectors, 8 lowercase hex digits', () => {
  assert.equal(fnv1a32(''), '811c9dc5');
  assert.equal(fnv1a32('a'), 'e40c292c');
  assert.equal(fnv1a32('foobar'), 'bf9cf968');
  assert.match(fnv1a32('не працює'), /^[0-9a-f]{8}$/);
  assert.notEqual(fnv1a32('error|a'), fnv1a32('error|b'));
});

test('stableHash: key order does not matter, values and array order do', () => {
  const a = { ref: 'e1', options: { b: 2, a: [1, { y: 1, x: 2 }] } };
  const b = { options: { a: [1, { x: 2, y: 1 }], b: 2 }, ref: 'e1' };
  assert.equal(stableHash(a), stableHash(b));
  assert.match(stableHash(a), /^[0-9a-f]{8}$/);
  assert.notEqual(stableHash({ ref: 'e1' }), stableHash({ ref: 'e2' }));
  assert.notEqual(stableHash([1, 2]), stableHash([2, 1]));
  // Undefined members are dropped, as JSON.stringify does.
  assert.equal(stableHash({ a: 1, b: undefined }), stableHash({ a: 1 }));
  assert.equal(stableHash({ ref: 'e1' }), fnv1a32('{"ref":"e1"}'));
  assert.equal(stableHash(undefined), stableHash(null));
  const loop = { a: 1 };
  loop.self = loop;
  assert.match(stableHash(loop), /^[0-9a-f]{8}$/);
});

test('truncation never leaves part of a host name: the cut word is dropped', () => {
  const out = norm(`${'x'.repeat(140)} failed at portal.privatbank.ua today`);
  assert.ok(out.length <= 160);
  assert.doesNotMatch(out, /portal|privat/);
  assert.match(out, /failed at…$/);
  // A cut inside a plain word keeps the cut as before.
  assert.match(norm(`${'y'.repeat(158)} abcdef`), /^y+ a…$|^y+…$/);
});

// GitHub secret scanning reported the fake Google key once (0.31.0). No test
// or fixture may hold a whole key-shaped literal again; build fakes from parts.
test('no test or fixture source contains a whole key-shaped literal', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const files = [
    ...readdirSync(dir).filter((f) => /\.(?:js|mjs)$/.test(f)).map((f) => join(dir, f)),
    ...readdirSync(join(dir, 'fixtures')).map((f) => join(dir, 'fixtures', f)),
    join(dir, '../../../extension/redact.js'),
  ];
  const KEYISH = /AIza[\w-]{35}|AKIA[0-9A-Z]{16}|\bgh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{20,}|xox[abprs]-\d|sk-ant-\w|eyJ[\w-]{10,}\.eyJ/;
  for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), KEYISH, f);
});
