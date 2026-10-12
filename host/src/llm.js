// Small OpenAI-compatible chat helper used by host-side features (the action
// critic). Providers mirror builtin-agent.js: OpenRouter, Ollama, custom.

import { loadEnvFile, readEnvFile } from './env.js';

loadEnvFile();

const PROVIDERS = {
  openrouter: {
    baseUrl: () => process.env.TABHELM_OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    headers: { 'HTTP-Referer': 'https://ivlad003.github.io/tabhelm/', 'X-Title': 'TabHelm' },
    defaultModel: 'nvidia/nemotron-3-super-120b-a12b:free',
  },
  ollama: {
    baseUrl: () => process.env.TABHELM_OLLAMA_BASE_URL || `${(process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '')}/v1`,
    keyEnv: null,
    headers: {},
    defaultModel: null,
  },
  openai: {
    baseUrl: () => process.env.TABHELM_OPENAI_BASE_URL,
    keyEnv: 'TABHELM_OPENAI_API_KEY',
    headers: {},
    defaultModel: process.env.TABHELM_OPENAI_MODEL || null,
  },
};

export function providerReady(id) {
  const p = PROVIDERS[id];
  if (!p || !p.baseUrl()) return false;
  return !p.keyEnv || Boolean(process.env[p.keyEnv] || readEnvFile()[p.keyEnv]);
}

async function firstOllamaModel(p) {
  const res = await fetch(`${p.baseUrl().replace(/\/v1$/, '')}/api/tags`);
  const data = await res.json();
  return data.models?.[0]?.name || null;
}

// One non-streaming completion; returns the text.
export async function complete({ provider = 'openrouter', model, system, user, maxTokens = 400, timeoutMs = 45_000 }) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unknown provider ${provider}`);
  if (!providerReady(provider)) throw new Error(`${provider} is not configured (key missing in ~/.tabhelm/env)`);
  const key = p.keyEnv ? process.env[p.keyEnv] || readEnvFile()[p.keyEnv] : null;
  const chosen = model || p.defaultModel || (provider === 'ollama' ? await firstOllamaModel(p) : null);
  if (!chosen) throw new Error(`No model for ${provider}`);
  const res = await fetch(`${p.baseUrl()}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...p.headers, ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model: chosen, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${provider} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}
