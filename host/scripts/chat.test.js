// Favourites and labels in History, message suggestions and editable system
// prompts: the parts that decide what is kept, shown, sent and stored.
// Usage: node --test scripts/chat.test.js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A fake home and an empty PATH, set before the host modules read them.
const home = mkdtempSync(join(tmpdir(), 'tabhelm-chat-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
mkdirSync(join(home, 'bin'));
process.env.PATH = join(home, 'bin');

const seen = [];
let answer = { content: 'Open the first result', cost: 0.00002 };
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
    if (answer.status) {
      res.statusCode = answer.status;
      return res.end(JSON.stringify({ error: { message: 'rate limited' } }));
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: answer.content } }], usage: answer.cost == null ? {} : { cost: answer.cost } }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.TABHELM_OPENROUTER_BASE_URL = `http://127.0.0.1:${server.address().port}/api/v1`;
process.env.OPENROUTER_API_KEY = 'sk-test';
after(() => {
  server.close();
  rmSync(home, { recursive: true, force: true });
});

const { cleanLabel, addLabels, carryMarks, pruneIndex, filterChats, labelCounts, LABELS_PER_CHAT } = await import('../../extension/history.js');
const { suggestionContext, suggestionPlaceholder } = await import('../../extension/suggest.js');
const { storedValue } = await import('../../extension/prompts.js');
const { suggestNext, cleanSuggestion } = await import('../src/suggest.js');
const { customPrompt, effectivePrompts, DEFAULT_BUILTIN_PROMPT, DEFAULT_SUGGEST_PROMPT, PROMPT_MAX_CHARS } = await import('../src/prompts.js');
const { DEFAULT_PREAMBLE, preambleText } = await import('../src/session.js');

// ---------- Favourites and labels ----------

test('labels are tidied, added once whatever the letter case, and capped', () => {
  assert.equal(cleanLabel('  work   stuff, '), 'work stuff');
  assert.equal(cleanLabel('x'.repeat(60)).length, 24);
  assert.deepEqual(addLabels(['Work'], 'work, Клієнт ,  , invoices'), ['Work', 'Клієнт', 'invoices']);
  assert.deepEqual(addLabels(undefined, ''), []);
  assert.equal(addLabels([], Array.from({ length: 20 }, (_, i) => `l${i}`).join(',')).length, LABELS_PER_CHAT);
});

test('saving a chat again keeps its star and labels', () => {
  const fresh = { id: 'a', title: 'New title', updated: 2 };
  assert.deepEqual(carryMarks(fresh, { id: 'a', title: 'Old', starred: true, labels: ['work'] }), { id: 'a', title: 'New title', updated: 2, starred: true, labels: ['work'] });
  assert.deepEqual(carryMarks(fresh, { id: 'a', labels: [] }), fresh);
  assert.deepEqual(carryMarks(fresh, undefined), fresh);
});

test('the limit drops the oldest plain chats and never a favourite', () => {
  const index = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, ...(i === 6 || i === 7 ? { starred: true } : {}) })); // newest first
  const { kept, dropped } = pruneIndex(index, 3);
  assert.deepEqual(kept.map((c) => c.id), ['c0', 'c1', 'c2', 'c6', 'c7']);
  assert.deepEqual(dropped.map((c) => c.id), ['c3', 'c4', 'c5']);
  assert.equal(pruneIndex(index, 200).dropped.length, 0);
});

const INDEX = [
  { id: '1', title: 'Find flights to Lviv', url: 'https://air.example/', pageTitle: 'Air', agent: 'Claude Code', starred: true, labels: ['Travel'] },
  { id: '2', title: 'Fill the tax form', url: 'https://tax.example/', pageTitle: 'Tax', agent: 'Codex', labels: ['work', 'Taxes'] },
  { id: '3', title: 'Compare laptops', url: 'https://shop.example/', pageTitle: 'Shop', agent: 'Codex', starred: true, labels: ['Work'] },
  { id: '4', title: 'Read the docs', url: 'https://docs.example/', pageTitle: 'Docs', agent: 'Cursor' },
];
const ids = (list) => list.map((c) => c.id).join('');

test('History filters by favourites, by a label and by search — also over labels', () => {
  assert.equal(ids(filterChats(INDEX)), '1234');
  assert.equal(ids(filterChats(INDEX, { starred: true })), '13');
  assert.equal(ids(filterChats(INDEX, { label: 'work' })), '23'); // any letter case
  assert.equal(ids(filterChats(INDEX, { starred: true, label: 'WORK' })), '3');
  assert.equal(ids(filterChats(INDEX, { q: 'taxes' })), '2'); // found by its label
  assert.equal(ids(filterChats(INDEX, { q: 'codex', label: 'work' })), '23');
  assert.equal(ids(filterChats(INDEX, { q: 'nothing like this' })), '');
  assert.equal(ids(filterChats(INDEX, { q: 'zzz' }, new Map([['4', 2]]))), '4'); // a match in the steps (Action database)
});

test('labels in use are counted across letter cases, most used first', () => {
  assert.deepEqual(labelCounts(INDEX), [{ label: 'work', n: 2 }, { label: 'Taxes', n: 1 }, { label: 'Travel', n: 1 }]);
  assert.deepEqual(labelCounts([]), []);
});

// ---------- Message suggestions ----------

test('the model sees the last exchanges, shortened — and nothing when there is nothing to follow', () => {
  const journal = [
    { type: 'user', text: 'Find the cheapest flight' },
    { type: 'action', desc: 'Click “Search”', ok: true },
    { type: 'agent', text: 'The cheapest is   159 EUR\nwith one stop.' },
    { type: 'notice', text: 'x' },
    { type: 'user', text: 'u'.repeat(1000) },
    { type: 'agent', text: 'a'.repeat(2000) },
  ];
  const context = suggestionContext(journal);
  assert.match(context, /^User: Find the cheapest flight\n\nAgent: The cheapest is 159 EUR with one stop\.\n\nUser: u{400}…\n\nAgent: a{900}…$/);
  assert.equal(suggestionContext(journal, { exchanges: 1 }).startsWith('User: uuu'), true);
  assert.equal(suggestionContext([{ type: 'user', text: 'hi' }]), ''); // no answer yet
  assert.equal(suggestionContext([{ type: 'user', text: 'hi' }, { type: 'agent', text: '', failure: 'rate limit' }]), '');
  assert.equal(suggestionContext([{ type: 'user', text: 'hi' }, { type: 'agent', text: 'partial', failure: 'crashed' }]), '');
  assert.equal(suggestionContext([]), '');
  assert.equal(suggestionPlaceholder('Open it'), 'Open it   ⇥ Tab');
});

test('a model\'s answer becomes one sendable line, or nothing', () => {
  assert.equal(cleanSuggestion('"Open the first result"'), 'Open the first result');
  assert.equal(cleanSuggestion('Next message: «Покажи деталі рейсу»\n\n(because the user asked about flights)'), 'Покажи деталі рейсу');
  assert.equal(cleanSuggestion('\n\n  Book it  \n'), 'Book it');
  for (const nothing of ['', '   ', 'None', 'nothing.', '(no suggestion)', '---', 'x'.repeat(200)]) assert.equal(cleanSuggestion(nothing), '', nothing);
});

test('a suggestion is asked through OpenRouter with the chat, the prompt in force and the cost reported', async () => {
  seen.length = 0;
  const out = await suggestNext({ context: 'User: Find flights\n\nAgent: The cheapest is 159 EUR.', model: 'vendor/fast-model' });
  assert.deepEqual(out, { text: 'Open the first result', model: 'vendor/fast-model', cost: 0.00002 });
  const { url, auth, body } = seen[0];
  assert.equal(url, '/api/v1/chat/completions');
  assert.equal(auth, 'Bearer sk-test');
  assert.equal(body.model, 'vendor/fast-model');
  assert.equal(body.messages[0].content, DEFAULT_SUGGEST_PROMPT);
  assert.match(body.messages[1].content, /^Conversation so far:\nUser: Find flights\n\nAgent: The cheapest is 159 EUR\.\n\nThe user's next message:$/);
  assert.deepEqual(body.usage, { include: true });
  // The user's own wording of the prompt is used when they changed it.
  await suggestNext({ context: 'User: a\n\nAgent: b', prompt: '  Always answer in Ukrainian.  ' });
  assert.equal(seen[1].body.messages[0].content, 'Always answer in Ukrainian.');
  // Nothing to go on: no request at all.
  assert.deepEqual(await suggestNext({ context: '   ' }), { text: '' });
  assert.equal(seen.length, 2);
  answer = { content: 'none', cost: null };
  assert.deepEqual(await suggestNext({ context: 'User: a\n\nAgent: b', model: 'm' }), { text: '', model: 'm' });
  answer = { status: 429 };
  await assert.rejects(suggestNext({ context: 'User: a\n\nAgent: b', model: 'm' }), /HTTP 429/);
  answer = { content: 'Open the first result', cost: 0.00002 };
});

// ---------- System prompts ----------

test('only a text the user really changed counts as theirs', () => {
  assert.equal(customPrompt('', DEFAULT_BUILTIN_PROMPT), '');
  assert.equal(customPrompt(`  ${DEFAULT_BUILTIN_PROMPT}\r\n`, DEFAULT_BUILTIN_PROMPT), '');
  assert.equal(customPrompt('Be brief.\r\nUse Ukrainian.', DEFAULT_BUILTIN_PROMPT), 'Be brief.\nUse Ukrainian.');
  assert.equal(customPrompt(undefined, 'x'), '');
  assert.equal(customPrompt({ not: 'text' }, 'x'), '');
  assert.equal(customPrompt('y'.repeat(PROMPT_MAX_CHARS + 500), 'x').length, PROMPT_MAX_CHARS);
  assert.deepEqual(effectivePrompts({ builtin: 'Mine', suggest: '' }, { builtin: 'B', suggest: 'S' }), { builtin: 'Mine', suggest: 'S' });
  // The panel stores by the same rule.
  assert.equal(storedValue(`${DEFAULT_PREAMBLE}\n`, DEFAULT_PREAMBLE), '');
  assert.equal(storedValue('  Mine  ', DEFAULT_PREAMBLE), 'Mine');
  assert.equal(storedValue('', DEFAULT_PREAMBLE), '');
});

test('the agents\' preamble is TabHelm\'s own unless changed, and always ends where the request begins', () => {
  assert.match(DEFAULT_PREAMBLE, /^\[TabHelm\] You are running inside a Chrome side panel/);
  assert.doesNotMatch(DEFAULT_PREAMBLE, /User request:/);
  const standard = preambleText('');
  assert.equal(standard, preambleText(DEFAULT_PREAMBLE)); // the default typed back in is still the default
  assert.ok(standard.startsWith(DEFAULT_PREAMBLE) && standard.endsWith('\n\nUser request:\n'));
  assert.equal(preambleText('Answer in Ukrainian. Never click Buy.'), 'Answer in Ukrainian. Never click Buy.\n\nUser request:\n');
});
