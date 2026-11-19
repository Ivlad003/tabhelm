// Narration and voice input through OpenRouter, against a local mock of its API:
// text → MP3 with the right cost, the models catalogue, the transcription
// fallback, and how the panel cuts text into pieces.
// Usage: node --test scripts/speech.test.js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A fake home (no ~/.tabhelm/env) and an empty PATH (no whisper-cli), set before the modules read them.
const home = mkdtempSync(join(tmpdir(), 'tabhelm-speech-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const emptyBin = join(home, 'empty-bin');
mkdirSync(emptyBin);
process.env.PATH = emptyBin;
for (const k of ['TABHELM_TRANSCRIBE_BASE_URL', 'TABHELM_TRANSCRIBE_API_KEY', 'TABHELM_TRANSCRIBE_MODEL', 'TABHELM_WHISPER_MODEL', 'OPENAI_API_KEY', 'GROQ_API_KEY']) delete process.env[k];

const seen = { speech: [], transcriptions: [], auth: [] };
const MP3 = Buffer.from('ID3-fake-mp3-bytes');
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    seen.auth.push(req.headers.authorization || '');
    if (req.url.startsWith('/api/v1/models')) {
      res.setHeader('content-type', 'application/json');
      return res.end(
        JSON.stringify({
          data: [
            { id: 'elevenlabs/eleven-flash-v2.5', name: 'ElevenLabs: Eleven Flash v2.5', pricing: { prompt: '0.00004', completion: '0' }, supported_voices: ['george', 'sarah'] },
            { id: 'google/gemini-tts', name: 'Token priced', pricing: { prompt: '0.0000005', completion: '0.000006' }, supported_voices: ['Kore'] },
            { id: 'heygen/voice:free', name: 'Free', pricing: { prompt: '0', completion: '0' } },
          ],
        }),
      );
    }
    if (req.url === '/api/v1/audio/speech') {
      const json = JSON.parse(body.toString('utf8'));
      seen.speech.push(json);
      if (json.input === 'boom') {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { message: 'bad voice' } }));
      }
      res.setHeader('content-type', 'audio/mpeg');
      res.setHeader('x-generation-id', 'gen-123');
      return res.end(MP3);
    }
    if (req.url === '/api/v1/audio/transcriptions') {
      seen.transcriptions.push({ type: req.headers['content-type'], text: body.toString('latin1') });
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ text: ' привіт світ ', usage: { seconds: 3, cost: 0.00001 } }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.TABHELM_OPENROUTER_BASE_URL = `http://127.0.0.1:${server.address().port}/api/v1`;
after(() => {
  server.close();
  rmSync(home, { recursive: true, force: true });
});

const { speak, speechModels, speechStatus, MAX_SPEECH_CHARS } = await import('../src/speech.js');
const { transcribe, transcribeStatus, OPENROUTER_TRANSCRIBE_MODEL } = await import('../src/transcribe.js');
const { splitForSpeech, initNarration, handleNarrationMessage, say, hush, speaking, estimateCost } = await import('../../extension/narration.js');

// The panel side runs here with stand-ins for Chrome's storage, the port to the host and <audio>.
globalThis.chrome = { storage: { local: { get: async () => ({ features: { narration: true }, featureSettings: {} }) } } };
const panel = { sent: [], played: [], spoken: [], errors: [], states: [], failNext: false, playMs: 5 };
globalThis.Audio = class {
  constructor(url) {
    this.url = url;
    panel.played.push(this);
  }
  play() {
    setTimeout(() => !this.paused && this.onended?.(), panel.playMs);
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
};
const port = {
  postMessage(m) {
    panel.sent.push(m);
    if (m.type !== 'speak') return;
    const reply = panel.failNext ? { error: 'speech API HTTP 402: no credits' } : { data: MP3.toString('base64'), mimeType: 'audio/mpeg', chars: m.text.length, cost: m.text.length * 0.00004, model: m.model, voice: 'george' };
    setTimeout(() => handleNarrationMessage({ type: 'speech', requestId: m.requestId, ...reply }), 1);
  },
};
initNarration(port, { spoken: (info) => panel.spoken.push(info), error: (text) => panel.errors.push(text), state: (on) => panel.states.push(on) });
const spokeRequests = () => panel.sent.filter((m) => m.type === 'speak');
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('without a key nothing is sent and the error says how to add one', async () => {
  delete process.env.OPENROUTER_API_KEY;
  await assert.rejects(speak({ text: 'hello' }), /set-key -- openrouter/);
  assert.equal(seen.speech.length, 0);
  assert.equal((await speechStatus()).ready, false);
  assert.equal((await transcribeStatus()).ready, false);
  await assert.rejects(transcribe({ data: Buffer.alloc(4000, 1).toString('base64') }), /No transcription engine/);
});

test('the catalogue gives per-character prices and voices', async () => {
  process.env.OPENROUTER_API_KEY = 'sk-test';
  const models = await speechModels({ fresh: true });
  assert.deepEqual(models.map((m) => [m.id, m.perChar, m.free, m.voices.length]), [
    ['elevenlabs/eleven-flash-v2.5', 0.00004, false, 2],
    ['google/gemini-tts', null, false, 1], // tokens in and out: no price per character
    ['heygen/voice:free', null, true, 0],
  ]);
  const status = await speechStatus();
  assert.equal(status.ready, true);
  assert.equal(status.models.length, 3);
});

test('speak sends the text once and reports what it cost', async () => {
  const text = 'Натисніть кнопку «Зберегти».';
  const out = await speak({ text, voice: 'sarah' });
  assert.equal(Buffer.from(out.data, 'base64').toString(), MP3.toString());
  assert.equal(out.mimeType, 'audio/mpeg');
  assert.equal(out.chars, text.length);
  assert.ok(Math.abs(out.cost - text.length * 0.00004) < 1e-12);
  assert.equal(out.generationId, 'gen-123');
  assert.deepEqual(seen.speech.at(-1), { model: 'elevenlabs/eleven-flash-v2.5', input: text, voice: 'sarah', response_format: 'mp3' });
  assert.equal(seen.auth.at(-1), 'Bearer sk-test');
});

test('an unknown voice falls back to the model\'s first one; unpriced and free models say so', async () => {
  assert.equal((await speak({ text: 'hi', voice: 'nobody' })).voice, 'george');
  assert.equal((await speak({ text: 'hi', model: 'google/gemini-tts' })).cost, null);
  assert.equal((await speak({ text: 'hi', model: 'heygen/voice:free' })).cost, 0);
});

test('too long, empty and rejected requests fail with a clear message', async () => {
  const before = seen.speech.length;
  await assert.rejects(speak({ text: 'x'.repeat(MAX_SPEECH_CHARS + 1) }), /too long/);
  await assert.rejects(speak({ text: '   ' }), /Nothing to speak/);
  assert.equal(seen.speech.length, before);
  await assert.rejects(speak({ text: 'boom' }), /speech API HTTP 400.*bad voice/);
});

test('voice input falls back to OpenRouter and passes the cost on', async () => {
  const status = await transcribeStatus();
  assert.equal(status.engine, 'openrouter');
  assert.equal(status.openrouterModel, OPENROUTER_TRANSCRIBE_MODEL);
  const out = await transcribe({ data: Buffer.alloc(4000, 1).toString('base64'), mimeType: 'audio/webm', language: 'uk-UA' });
  assert.equal(out.text, 'привіт світ');
  assert.equal(out.cost, 0.00001);
  const sent = seen.transcriptions.at(-1);
  assert.match(sent.type, /^multipart\/form-data/);
  assert.match(sent.text, /name="model"\r\n\r\nopenai\/whisper-large-v3-turbo/);
  assert.match(sent.text, /name="language"\r\n\r\nuk\r\n/);
  assert.equal(seen.auth.at(-1), 'Bearer sk-test');
});

test('an API you configured yourself still wins over OpenRouter', async () => {
  process.env.TABHELM_TRANSCRIBE_BASE_URL = 'http://127.0.0.1:9/v1';
  assert.equal((await transcribeStatus()).engine, 'api');
  delete process.env.TABHELM_TRANSCRIBE_BASE_URL;
});

test('text is cut into pieces at sentence ends', () => {
  assert.deepEqual(splitForSpeech('  One.  Two!\nThree? '), ['One. Two! Three?']);
  assert.deepEqual(splitForSpeech('Перше речення. Друге речення. Третє.', 20), ['Перше речення.', 'Друге речення.', 'Третє.']);
  // One sentence longer than a piece is cut at spaces, and nothing is lost.
  const endless = `${'слово '.repeat(200)}кінець.`;
  const long = splitForSpeech(endless, 100);
  assert.ok(long.length > 5 && long.every((p) => p.length <= 100 && p.length > 0));
  assert.equal(long.join(' '), endless);
  assert.deepEqual(splitForSpeech(''), []);
});

test('the panel speaks piece by piece and reports once what was sent', async () => {
  const text = `${'Перше речення гайда. '.repeat(15)}${'Друге речення гайда. '.repeat(15)}`.trim(); // more than one piece
  assert.equal(await say(text, { kind: 'guide' }), true);
  await settle();
  const requests = spokeRequests();
  assert.equal(requests.length, 2);
  assert.equal(requests.map((m) => m.text).join(' '), text);
  assert.equal(requests[0].model, 'elevenlabs/eleven-flash-v2.5');
  assert.equal(panel.played.length, 2);
  assert.equal(panel.spoken.length, 1);
  const [info] = panel.spoken;
  assert.deepEqual([info.kind, info.chars, info.cached, info.finished], ['guide', requests[0].text.length + requests[1].text.length, false, true]);
  assert.ok(Math.abs(info.cost - info.chars * 0.00004) < 1e-12);
  assert.deepEqual(panel.states, [true, false]);
  assert.equal(speaking(), false);
});

test('text spoken before is replayed from the cache: nothing is sent, nothing is charged', async () => {
  const text = `${'Перше речення гайда. '.repeat(15)}${'Друге речення гайда. '.repeat(15)}`.trim();
  const before = spokeRequests().length;
  assert.equal(await say(text, { kind: 'guide' }), true);
  await settle();
  assert.equal(spokeRequests().length, before);
  assert.deepEqual([panel.spoken.at(-1).chars, panel.spoken.at(-1).cost, panel.spoken.at(-1).cached], [0, 0, true]);
});

test('a new sentence replaces the one being spoken; hush stops the voice', async () => {
  panel.playMs = 200;
  const first = say('Довге перше повідомлення.', { kind: 'guide' });
  await settle();
  assert.equal(speaking('guide'), true);
  panel.playMs = 5;
  const second = say('Готово.', { kind: 'event' });
  assert.equal(await first, false);
  assert.equal(await second, true);
  panel.playMs = 200;
  const third = say('Ще одне.', { kind: 'reply' });
  await settle();
  hush('guide'); // another kind: keeps talking
  assert.equal(speaking('reply'), true);
  hush('reply');
  assert.equal(await third, false);
  assert.equal(speaking(), false);
  panel.playMs = 5;
  await settle();
  // Stopped or not, what was generated is reported with its cost.
  assert.deepEqual(panel.spoken.slice(-3).map((s) => [s.kind, s.finished, s.chars > 0]), [['guide', false, true], ['event', true, true], ['reply', false, true]]);
});

test('a failure is said once, not for every sentence', async () => {
  panel.failNext = true;
  assert.equal(await say('Не вийде.', { kind: 'guide' }), false);
  assert.equal(await say('І це теж.', { kind: 'guide' }), false);
  panel.failNext = false;
  assert.deepEqual(panel.errors, ['Narration failed: speech API HTTP 402: no credits']);
});

test('the price is known before anything is sent', () => {
  assert.equal(estimateCost(1000, 'elevenlabs/eleven-flash-v2.5'), null); // no catalogue yet
  handleNarrationMessage({ type: 'speech_status', ready: true, models: [{ id: 'elevenlabs/eleven-flash-v2.5', perChar: 0.00004, free: false, voices: [] }, { id: 'tokens', perChar: null, free: false, voices: [] }] });
  assert.ok(Math.abs(estimateCost(1000, 'elevenlabs/eleven-flash-v2.5') - 0.04) < 1e-12);
  assert.equal(estimateCost(1000, 'tokens'), null);
});
