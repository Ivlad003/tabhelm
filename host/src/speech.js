// Text to speech for the Narration feature, through OpenRouter's
// OpenAI-style POST /audio/speech (one key for everything: OPENROUTER_API_KEY in
// ~/.tabhelm/env, the same one the built-in agent uses).
// The panel sends short pieces of text (a guide step, a sentence or two of a
// reply); each comes back as one MP3 small enough for a native-messaging frame.
// Every answer carries what was sent and what it cost, so the panel can show it.

import { loadEnvFile, readEnvFile } from './env.js';

loadEnvFile();
const env = (k) => process.env[k] || readEnvFile()[k] || '';

export const DEFAULT_SPEECH_MODEL = 'elevenlabs/eleven-flash-v2.5';
// One piece of text per request. ~450 characters is about half a minute of MP3,
// which stays well under Chrome's 1 MB limit for host → extension frames.
export const MAX_SPEECH_CHARS = 450;
const MAX_AUDIO_BYTES = 700 * 1024; // base64 adds a third

export const openRouterBase = () => (env('TABHELM_OPENROUTER_BASE_URL') || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
export const openRouterKey = () => env('OPENROUTER_API_KEY');
export const openRouterHeaders = () => ({ 'HTTP-Referer': 'https://ivlad003.github.io/tabhelm/', 'X-Title': 'TabHelm', ...(openRouterKey() ? { authorization: `Bearer ${openRouterKey()}` } : {}) });

let catalog = null; // { at, models }

// Speech models with their price and voices, from OpenRouter's catalogue (cached for an hour).
export async function speechModels({ fresh = false } = {}) {
  if (!fresh && catalog && Date.now() - catalog.at < 3600_000) return catalog.models;
  const res = await fetch(`${openRouterBase()}/models?output_modalities=speech`, { headers: openRouterHeaders(), signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`OpenRouter models HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const models = (json.data || []).map((m) => {
    const prompt = Number(m.pricing?.prompt) || 0;
    const completion = Number(m.pricing?.completion) || 0;
    return {
      id: m.id,
      name: m.name || m.id,
      // Priced per character of text when only the input side has a price;
      // token- or duration-priced models cannot be costed from the text alone.
      perChar: prompt > 0 && !completion ? prompt : null,
      free: !prompt && !completion,
      voices: Array.isArray(m.supported_voices) ? m.supported_voices.map(String) : [],
    };
  });
  catalog = { at: Date.now(), models };
  return models;
}

export async function speechStatus() {
  const ready = Boolean(openRouterKey());
  try {
    return { ready, models: await speechModels(), defaultModel: DEFAULT_SPEECH_MODEL, maxChars: MAX_SPEECH_CHARS };
  } catch (err) {
    return { ready, models: [], defaultModel: DEFAULT_SPEECH_MODEL, maxChars: MAX_SPEECH_CHARS, error: err.message };
  }
}

// One piece of text → MP3. Returns { data (base64), mimeType, chars, cost, model, voice, generationId }.
export async function speak({ text, model, voice } = {}) {
  const input = String(text || '').trim();
  if (!input) throw new Error('Nothing to speak.');
  if (input.length > MAX_SPEECH_CHARS) throw new Error(`Text is too long for one speech request (${input.length} characters; the limit is ${MAX_SPEECH_CHARS}).`);
  if (!openRouterKey()) throw new Error('No OpenRouter key: run "npm run set-key -- openrouter" in the host folder (https://openrouter.ai/keys).');
  const chosen = model || DEFAULT_SPEECH_MODEL;
  const info = (await speechModels().catch(() => [])).find((m) => m.id === chosen);
  // A voice the model does not have is a 400 at the provider: fall back to its first one.
  const useVoice = info?.voices.length ? (info.voices.includes(voice) ? voice : info.voices[0]) : voice || undefined;
  const res = await fetch(`${openRouterBase()}/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...openRouterHeaders() },
    body: JSON.stringify({ model: chosen, input, ...(useVoice ? { voice: useVoice } : {}), response_format: 'mp3' }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`speech API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const audio = Buffer.from(await res.arrayBuffer());
  if (!audio.length) throw new Error('The speech API returned no audio.');
  if (audio.length > MAX_AUDIO_BYTES) throw new Error(`The audio is too large to send to the panel (${Math.round(audio.length / 1024)} KB).`);
  return {
    data: audio.toString('base64'),
    mimeType: (res.headers.get('content-type') || 'audio/mpeg').split(';')[0],
    chars: input.length,
    cost: info?.free ? 0 : info?.perChar != null ? input.length * info.perChar : null,
    model: chosen,
    voice: useVoice || null,
    generationId: res.headers.get('x-generation-id') || null,
  };
}
