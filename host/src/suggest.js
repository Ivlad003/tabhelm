// Message suggestions: one short "what you would probably send next", written by
// a model through OpenRouter (the key the built-in agent uses) from the last
// exchanges of the chat. The panel shows it as the message box's placeholder;
// Tab puts it into the box. Nothing is sent to the agent until the user sends it.

import { completeDetailed } from './llm.js';
import { DEFAULT_SUGGEST_PROMPT, customPrompt } from './prompts.js';

export const SUGGEST_MAX_CHARS = 160;
const CONTEXT_MAX_CHARS = 6000;

// The model's answer as one line a person could send: no quotes, labels or line breaks.
export function cleanSuggestion(text) {
  let s = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  s = s.replace(/^(?:next message|suggestion|user|message)\s*:\s*/i, '').replace(/^["'«“„`]+|["'»”`]+$/g, '').trim();
  if (!s || /^(?:none|nothing|n\/a|-+|\(.*\))\.?$/i.test(s)) return '';
  return s.length > SUGGEST_MAX_CHARS ? '' : s; // a paragraph is not a suggestion
}

// `context`: the last exchanges as plain text ("User: …", "Agent: …"), newest last.
export async function suggestNext({ context, model, prompt } = {}) {
  const text = String(context || '').trim();
  if (!text) return { text: '' };
  const out = await completeDetailed({
    provider: 'openrouter',
    model: model || undefined,
    system: customPrompt(prompt, DEFAULT_SUGGEST_PROMPT) || DEFAULT_SUGGEST_PROMPT,
    user: `Conversation so far:\n${text.slice(-CONTEXT_MAX_CHARS)}\n\nThe user's next message:`,
    maxTokens: 60,
    timeoutMs: 20_000,
  });
  return { text: cleanSuggestion(out.text), model: out.model, ...(out.cost != null ? { cost: out.cost } : {}) };
}
