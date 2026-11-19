// Message suggestions (feature flag): what the model is shown to guess the
// user's next message — the last exchanges of the chat, shortened. Pure, so the
// node tests run it; the request itself goes through the host to OpenRouter.

const clip = (text, max) => {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
};

// "User: …" / "Agent: …" for the last `exchanges` exchanges, oldest first.
// Empty when there is nothing to follow up on: no answer yet, or the last task failed.
export function suggestionContext(journal = [], { exchanges = 3, userMax = 400, agentMax = 900 } = {}) {
  const said = journal.filter((e) => e?.type === 'user' || e?.type === 'agent');
  const last = said.at(-1);
  if (!last || last.type !== 'agent' || last.failure || !String(last.text || '').trim()) return '';
  return said
    .filter((e) => String(e.text || '').trim())
    .slice(-exchanges * 2)
    .map((e) => (e.type === 'user' ? `User: ${clip(e.text, userMax)}` : `Agent: ${clip(e.text, agentMax)}`))
    .join('\n\n');
}

// The placeholder that shows a suggestion, and how to take it.
export const suggestionPlaceholder = (text) => `${text}   ⇥ Tab`;
