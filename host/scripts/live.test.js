// Live conversation: what counts as a command, how a spoken sentence answers a
// question card, where an utterance starts and ends, and how a reply is said.
// Usage: node --test scripts/live.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, matchAnswer, createSegmenter, isPhantom, normalizeSpeech } from '../../extension/live.js';
import { normalizeQuestions } from '../../extension/questions.js';
import { plainSpeech } from '../../extension/narration.js';

test('a command is the whole sentence, in Ukrainian or English', () => {
  assert.deepEqual(parseCommand('Стоп!'), { type: 'stop' });
  assert.deepEqual(parseCommand(' stop. '), { type: 'stop' });
  assert.deepEqual(parseCommand('Тихо'), { type: 'quiet' });
  assert.deepEqual(parseCommand('Вимкни мікрофон.'), { type: 'liveOff' });
  // Part of a longer sentence is a message for the agent, not a command.
  assert.equal(parseCommand('зупинись на третьому кроці і поясни'), null);
  assert.equal(parseCommand('stop the video on this page'), null);
  assert.equal(parseCommand(''), null);
});

test('guide commands work only while a guide is on the page', () => {
  assert.equal(parseCommand('далі'), null);
  assert.equal(parseCommand('next'), null);
  const guide = { guide: true };
  assert.deepEqual(parseCommand('Далі.', guide), { type: 'guide', action: 'done' });
  assert.deepEqual(parseCommand('Next step', guide), { type: 'guide', action: 'done' });
  assert.deepEqual(parseCommand('назад', guide), { type: 'guide', action: 'back' });
  assert.deepEqual(parseCommand('пропусти', guide), { type: 'guide', action: 'skipped' });
  assert.deepEqual(parseCommand('Пауза', guide), { type: 'guide', action: 'pause' });
  assert.deepEqual(parseCommand('auto', guide), { type: 'guide', action: 'auto' });
  assert.deepEqual(parseCommand('стоп', guide), { type: 'stop' });
});

const plan = normalizeQuestions({ question: 'Який тариф?', options: [{ label: 'Безкоштовний' }, { label: 'Pro' }, { label: 'Pro Max' }] });

test('one question: an option by name, by number or inside a sentence', () => {
  assert.deepEqual(matchAnswer('Pro', plan), { picks: [{ index: 0, label: 'Pro' }] });
  assert.deepEqual(matchAnswer('безкоштовний.', plan), { picks: [{ index: 0, label: 'Безкоштовний' }] });
  assert.deepEqual(matchAnswer('другий', plan), { picks: [{ index: 0, label: 'Pro' }] });
  assert.deepEqual(matchAnswer('варіант три', plan), { picks: [{ index: 0, label: 'Pro Max' }] });
  assert.deepEqual(matchAnswer('the first one', plan), { picks: [{ index: 0, label: 'Безкоштовний' }] });
  assert.deepEqual(matchAnswer('давай Pro Max', plan), { picks: [{ index: 0, label: 'Pro Max' }] }); // the longer label wins
  assert.deepEqual(matchAnswer('давай про запас візьмемо Pro', plan), { picks: [{ index: 0, label: 'Pro' }] });
});

test('one question: skip, send, your own words — or nothing when only the options are allowed', () => {
  assert.deepEqual(matchAnswer('пропусти', plan), { skip: true });
  assert.deepEqual(matchAnswer('надіслати', plan), { submit: true });
  assert.deepEqual(matchAnswer('Щось середнє, якщо є', plan), { index: 0, other: 'Щось середнє, якщо є' });
  const strict = normalizeQuestions({ questions: [{ question: 'Так чи ні?', options: [{ label: 'Так' }, { label: 'Ні' }], other: false }] });
  assert.equal(matchAnswer('можливо', strict), null);
  assert.deepEqual(matchAnswer('ні', strict), { picks: [{ index: 0, label: 'Ні' }] });
  assert.deepEqual(matchAnswer('Київ, Хрещатик один', normalizeQuestions({ question: 'Адреса?' })), { index: 0, other: 'Київ, Хрещатик один' });
  assert.equal(matchAnswer('', plan), null);
});

test('several questions: options are picked by name, each for its own question', () => {
  const questions = normalizeQuestions({ questions: [{ question: 'Тариф?', options: [{ label: 'Free' }, { label: 'Pro' }] }, { question: 'Оплата?', options: [{ label: 'Щомісяця' }, { label: 'Щороку' }] }, { question: 'Коментар?' }] });
  assert.deepEqual(matchAnswer('Pro і щороку', questions), { picks: [{ index: 0, label: 'Pro' }, { index: 1, label: 'Щороку' }] });
  assert.deepEqual(matchAnswer('щомісяця', questions), { picks: [{ index: 1, label: 'Щомісяця' }] });
  assert.equal(matchAnswer('перший', questions), null); // which question?
  assert.equal(matchAnswer('не розумію', questions), null);
  assert.deepEqual(matchAnswer('готово', questions), { submit: true });
});

// Feeds the segmenter 50 ms readings: [level, milliseconds] spans.
function run(segmenter, spans) {
  const events = [];
  let now = 1000;
  for (const [level, ms] of spans) {
    for (let t = 0; t < ms; t += 50) {
      const e = segmenter.feed(level, now);
      if (e) events.push(e);
      now += 50;
    }
  }
  return events;
}

test('an utterance starts with speech and ends after a pause', () => {
  assert.deepEqual(run(createSegmenter(), [[0.002, 1000], [0.2, 1500], [0.002, 1000]]), ['start', 'end']);
  // A short pause inside a sentence does not cut it.
  assert.deepEqual(run(createSegmenter(), [[0.002, 500], [0.2, 800], [0.002, 400], [0.2, 800], [0.002, 1200]]), ['start', 'end']);
  // Two sentences with a real pause between them.
  assert.deepEqual(run(createSegmenter(), [[0.2, 800], [0.002, 1200], [0.2, 800], [0.002, 1200]]), ['start', 'end', 'start', 'end']);
});

test('a click is dropped, steady noise is not speech, and a monologue is cut', () => {
  assert.deepEqual(run(createSegmenter(), [[0.002, 500], [0.3, 100], [0.002, 1000]]), ['start', 'drop']);
  // A fan: loud but steady — the threshold follows it, a voice over it still counts.
  const fan = createSegmenter();
  assert.deepEqual(run(fan, [[0.008, 6000]]), []);
  assert.deepEqual(run(fan, [[0.2, 1000], [0.008, 1200]]), ['start', 'end']);
  assert.deepEqual(run(createSegmenter({ maxMs: 3000 }), [[0.2, 4000]]).slice(0, 2), ['start', 'end']);
});

test('Whisper\'s stock phrases for silence are not something the user said', () => {
  for (const t of ['Дякую за перегляд!', 'Thanks for watching.', 'Субтитри створено спільнотою', '[музика]', ' ', '...']) assert.equal(isPhantom(t), true, t);
  for (const t of ['Дякую, далі сам', 'Відкрий налаштування', 'stop']) assert.equal(isPhantom(t), false, t);
  assert.equal(normalizeSpeech('  Привіт,   СВІТ!  '), 'привіт світ');
});

test('a Markdown reply is said without markup, code or link addresses', () => {
  const md = '## Готово\n\nЯ **відкрив** сторінку [налаштувань](https://example.com/settings) і ввімкнув `2FA`.\n\n- перший крок\n- другий крок\n\n```js\nconsole.log(1)\n```\n\n| a | b |\n|---|---|\n\nДеталі: https://example.com/x';
  assert.equal(plainSpeech(md), 'Готово Я відкрив сторінку налаштувань і ввімкнув 2FA. перший крок другий крок Деталі:');
  assert.equal(plainSpeech(''), '');
});
