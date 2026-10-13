// Speech to text for the Voice feature. Two engines, chosen by what is set up:
//   1. an OpenAI-compatible /v1/audio/transcriptions API
//      (TABHELM_TRANSCRIBE_BASE_URL, TABHELM_TRANSCRIBE_API_KEY, TABHELM_TRANSCRIBE_MODEL in ~/.tabhelm/env;
//       e.g. https://api.groq.com/openai/v1 with whisper-large-v3, or https://api.openai.com/v1 with whisper-1)
//   2. whisper.cpp on this machine (`whisper-cli`, model from TABHELM_WHISPER_MODEL or the default ggml path);
//      audio is converted to 16 kHz WAV with ffmpeg first.
// Chunks arrive as base64 webm/opus from the panel; each is transcribed on its own.

import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadEnvFile, readEnvFile } from './env.js';

loadEnvFile();
const run = promisify(execFile);
const env = (k) => process.env[k] || readEnvFile()[k] || '';

async function has(cmd) {
  try {
    await run(process.platform === 'win32' ? 'where' : 'which', [cmd]);
    return true;
  } catch {
    return false;
  }
}

export async function transcribeStatus() {
  const api = Boolean(env('TABHELM_TRANSCRIBE_BASE_URL'));
  const whisper = (await has('whisper-cli')) && (await has('ffmpeg'));
  const model = env('TABHELM_WHISPER_MODEL') || defaultWhisperModel();
  return { api, apiBase: env('TABHELM_TRANSCRIBE_BASE_URL') || null, whisper, whisperModel: whisper && existsSync(model) ? model : null, ready: api || (whisper && existsSync(model)) };
}

function defaultWhisperModel() {
  for (const p of [join(homedir(), '.tabhelm', 'models', 'ggml-base.bin'), join(homedir(), '.cache', 'whisper.cpp', 'ggml-base.bin'), '/usr/share/whisper.cpp/models/ggml-base.bin']) if (existsSync(p)) return p;
  return join(homedir(), '.tabhelm', 'models', 'ggml-base.bin');
}

export async function transcribe({ data, mimeType = 'audio/webm', language = '' }) {
  const buffer = Buffer.from(data, 'base64');
  if (buffer.length < 2000) return { text: '' }; // silence / empty chunk
  const status = await transcribeStatus();
  if (status.api) return transcribeApi(buffer, mimeType, language);
  if (status.whisper && status.whisperModel) return transcribeWhisper(buffer, mimeType, language, status.whisperModel);
  throw new Error('No transcription engine: set TABHELM_TRANSCRIBE_BASE_URL (+ key, model) in ~/.tabhelm/env, or install whisper-cli + ffmpeg and a ggml model.');
}

async function transcribeApi(buffer, mimeType, language) {
  const base = env('TABHELM_TRANSCRIBE_BASE_URL').replace(/\/$/, '');
  const key = env('TABHELM_TRANSCRIBE_API_KEY') || env('OPENAI_API_KEY') || env('GROQ_API_KEY');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }), `chunk.${mimeType.includes('ogg') ? 'ogg' : 'webm'}`);
  form.append('model', env('TABHELM_TRANSCRIBE_MODEL') || 'whisper-1');
  form.append('response_format', 'json');
  if (language && language !== 'auto') form.append('language', language.split('-')[0]);
  const res = await fetch(`${base}/audio/transcriptions`, { method: 'POST', headers: key ? { authorization: `Bearer ${key}` } : {}, body: form, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`transcription API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return { text: (json.text || '').trim() };
}

async function transcribeWhisper(buffer, mimeType, language, model) {
  const dir = mkdtempSync(join(tmpdir(), 'tabhelm-voice-'));
  try {
    const input = join(dir, 'in.webm');
    const wav = join(dir, 'in.wav');
    writeFileSync(input, buffer);
    await run('ffmpeg', ['-v', 'error', '-y', '-i', input, '-ar', '16000', '-ac', '1', '-f', 'wav', wav]);
    const args = ['-m', model, '-f', wav, '-nt', '-np', '-otxt', '-of', join(dir, 'out')];
    if (language && language !== 'auto') args.push('-l', language.split('-')[0]);
    else args.push('-l', 'auto');
    await run('whisper-cli', args, { timeout: 120_000 });
    const text = existsSync(join(dir, 'out.txt')) ? readFileSync(join(dir, 'out.txt'), 'utf8') : '';
    return { text: text.replace(/\s+/g, ' ').trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
