// browser_ask_user: the agent's questions made safe to show, and the user's reply
// turned into what the agent reads.
// Usage: node --test scripts/questions.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuestions, cleanAnswers, formatAnswers, MAX_QUESTIONS, MAX_OPTIONS } from '../../extension/questions.js';

test('questions are trimmed, capped and given sane defaults', () => {
  const [q] = normalizeQuestions({ questions: [{ question: '  Which   plan? ', header: 'Plan', options: [{ label: 'Free' }, { label: 'Pro', description: ' $10 a month ' }, { label: 'Free' }, 'Team', { label: '' }, null] }] });
  assert.deepEqual(q, { question: 'Which plan?', header: 'Plan', options: [{ label: 'Free', description: '' }, { label: 'Pro', description: '$10 a month' }, { label: 'Team', description: '' }], multiple: false, other: true });
  const many = normalizeQuestions({ questions: Array.from({ length: 9 }, (_, i) => ({ question: `Q${i}`, options: Array.from({ length: 20 }, (_, k) => ({ label: `o${k}` })) })) });
  assert.equal(many.length, MAX_QUESTIONS);
  assert.equal(many[0].options.length, MAX_OPTIONS);
});

test('a question without options is free text; multiple needs two options; the single form works', () => {
  assert.deepEqual(normalizeQuestions({ questions: [{ question: 'Your address?', other: false, multiple: true }] })[0], { question: 'Your address?', header: '', options: [], multiple: false, other: true });
  assert.equal(normalizeQuestions({ questions: [{ question: 'Pick', options: [{ label: 'a' }, { label: 'b' }], multiple: true, other: false }] })[0].multiple, true);
  assert.equal(normalizeQuestions({ questions: [{ question: 'Pick', options: [{ label: 'a' }, { label: 'b' }], other: false }] })[0].other, false);
  assert.equal(normalizeQuestions({ question: 'Just one?', options: ['Yes', 'No'] })[0].options.length, 2);
});

test('no usable question is an error the agent can act on', () => {
  for (const args of [{}, { questions: [] }, { questions: [{ question: '   ' }] }, { questions: 'what?' }]) assert.throws(() => normalizeQuestions(args), /needs at least one question/);
});

test('only offered options count, one for a single choice, and typed text only where allowed', () => {
  const questions = normalizeQuestions({
    questions: [
      { question: 'Plan?', options: [{ label: 'Free' }, { label: 'Pro' }] },
      { question: 'Colours?', options: [{ label: 'Red' }, { label: 'Blue' }], multiple: true, other: false },
      { question: 'Notes?' },
    ],
  });
  assert.deepEqual(cleanAnswers(questions, [{ choices: ['Pro', 'Free', 'Hacked'], other: ' monthly ' }, { choices: ['Blue', 'Red', 'Blue'], other: 'teal' }, { choices: [], other: '' }]), [
    { choices: ['Pro'], other: 'monthly' },
    { choices: ['Blue', 'Red'], other: '' },
    null,
  ]);
  assert.deepEqual(cleanAnswers(questions, null), [null, null, null]);
});

test('the agent reads every question with its answer', () => {
  const questions = normalizeQuestions({
    questions: [
      { question: 'Який тариф?', header: 'Тариф', options: [{ label: 'Безкоштовний' }, { label: 'Pro' }] },
      { question: 'Кольори?', options: [{ label: 'Червоний' }, { label: 'Синій' }], multiple: true },
      { question: 'Коментар?' },
    ],
  });
  const out = formatAnswers(questions, [{ choices: ['Pro'], other: '' }, { choices: ['Червоний', 'Синій'], other: 'бірюзовий' }, null]);
  assert.equal(out.answered, 2);
  assert.equal(out.text, 'The user answered:\n1. Який тариф? → Pro\n2. Кольори? → Червоний, Синій; also: “бірюзовий”\n3. Коментар? → (no answer)\nOne question was left without an answer: use your best judgement there and say what you assumed.');
  assert.equal(out.label, '2 of 3 answered');
  assert.equal(out.summary, 'Тариф: Pro · Кольори?: Червоний, Синій; also: “бірюзовий” · Коментар?: (no answer)');
  const one = formatAnswers(normalizeQuestions({ question: 'Адреса?' }), [{ choices: [], other: 'Київ, Хрещатик 1' }]);
  assert.equal(one.text, 'The user answered:\n1. Адреса? → “Київ, Хрещатик 1”');
  assert.equal(one.label, '“Київ, Хрещатик 1”');
});
