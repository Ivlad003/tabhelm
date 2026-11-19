// Questions for the user (browser_ask_user): the agent asks, the panel shows a
// card with options, the answers go back as text. Pure functions (no DOM, no
// chrome.*): the agent's arguments made safe to show, and the user's reply
// turned into what the agent reads.

export const MAX_QUESTIONS = 5;
export const MAX_OPTIONS = 8;

const clip = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// [{ question, header, options: [{ label, description }], multiple, other }]
// A question without options is answered in the user's own words.
export function normalizeQuestions(args = {}) {
  const raw = Array.isArray(args.questions) && args.questions.length ? args.questions : args.question ? [args] : [];
  const questions = raw
    .slice(0, MAX_QUESTIONS)
    .map((q) => {
      const seen = new Set();
      const options = (Array.isArray(q?.options) ? q.options : [])
        .map((o) => (o && typeof o === 'object' ? { label: clip(o.label, 120), description: clip(o.description, 300) } : { label: clip(o, 120), description: '' }))
        .filter((o) => o.label && !seen.has(o.label) && seen.add(o.label))
        .slice(0, MAX_OPTIONS);
      return { question: clip(q?.question, 500), header: clip(q?.header, 40), options, multiple: Boolean(q?.multiple) && options.length > 1, other: options.length === 0 || q?.other !== false };
    })
    .filter((q) => q.question);
  if (!questions.length) throw new Error('browser_ask_user needs at least one question (questions: [{ question, options: [{ label }] }]).');
  return questions;
}

// One answer per question: { choices: [label…], other: 'typed text' }, or null when it was left out.
// Only labels the question offers count, and a single-choice question keeps one.
export function cleanAnswers(questions, answers) {
  return questions.map((q, i) => {
    const a = Array.isArray(answers) ? answers[i] : null;
    const offered = new Set(q.options.map((o) => o.label));
    let choices = [...new Set((Array.isArray(a?.choices) ? a.choices : []).map(String))].filter((c) => offered.has(c));
    if (!q.multiple) choices = choices.slice(0, 1);
    const other = q.other ? clip(a?.other, 1000) : '';
    return choices.length || other ? { choices, other } : null;
  });
}

const answerText = (a) => (a ? [a.choices.join(', '), a.other && (a.choices.length ? `also: “${a.other}”` : `“${a.other}”`)].filter(Boolean).join('; ') : '(no answer)');

// What the agent reads, and the short line the chat keeps.
export function formatAnswers(questions, answers) {
  const clean = cleanAnswers(questions, answers);
  const answered = clean.filter(Boolean).length;
  const lines = questions.map((q, i) => `${i + 1}. ${q.question} → ${answerText(clean[i])}`);
  const skipped = questions.length - answered;
  return {
    answered,
    text: `The user answered:\n${lines.join('\n')}${skipped ? `\n${skipped === 1 ? 'One question was' : `${skipped} questions were`} left without an answer: use your best judgement there and say what you assumed.` : ''}`,
    label: questions.length === 1 ? answerText(clean[0]) : `${answered} of ${questions.length} answered`,
    summary: questions.map((q, i) => `${q.header || q.question}: ${answerText(clean[i])}`).join(' · '),
  };
}
