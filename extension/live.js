// Live conversation (feature flag): you talk, TabHelm listens all the time,
// cuts what it hears into utterances and hands each one to the panel — which
// runs it as a command ("stop", "next"), takes it as the answer to an open
// question, or sends it to the agent as a message. Replies are read aloud by
// narration.js; while TabHelm speaks the microphone is ignored (no echo), unless
// "interrupt by voice" is on.
//   engine "host":    the microphone is cut at pauses here (a small energy
//                     detector) and each utterance is transcribed by the host —
//                     OpenRouter's Whisper with your key, cost reported
//   engine "browser": Chrome's own speech recognition (instant, live interim
//                     text, no cost; the audio goes to Chrome's service)

import { getSetting } from './features.js';

// ---------- Pure parts (also run by the node tests) ----------

export const normalizeSpeech = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

// A command is the whole utterance, never a part of a longer sentence:
// "stop" stops, "stop at the third step and explain" goes to the agent.
const COMMANDS = {
  liveOff: ['вимкни мікрофон', 'вимкни розмову', 'кінець розмови', 'закінчити розмову', 'stop listening', 'end conversation', 'live off'],
  quiet: ['тихо', 'тихіше', 'замовкни', 'помовч', 'досить', 'quiet', 'hush', 'silence', 'enough'],
  stop: ['стоп', 'зупинись', 'зупини', 'скасуй', 'відміна', 'stop', 'cancel', 'abort'],
};
const GUIDE_COMMANDS = {
  done: ['далі', 'наступний', 'наступний крок', 'готово', 'зроблено', 'next', 'next step', 'continue', 'done'],
  back: ['назад', 'попередній', 'попередній крок', 'back', 'previous', 'go back'],
  skipped: ['пропусти', 'пропустити', 'skip'],
  pause: ['пауза', 'зачекай', 'pause', 'wait'],
  auto: ['авто', 'автоматично', 'грай', 'auto', 'play'],
};

// { type: 'liveOff' | 'quiet' | 'stop' } or { type: 'guide', action }, or null for anything else.
export function parseCommand(text, { guide = false } = {}) {
  const said = normalizeSpeech(text);
  if (!said) return null;
  for (const [type, phrases] of Object.entries(COMMANDS)) if (phrases.includes(said)) return { type };
  if (guide) for (const [action, phrases] of Object.entries(GUIDE_COMMANDS)) if (phrases.includes(said)) return { type: 'guide', action };
  return null;
}

const ORDINALS = [
  ['перший', 'перша', 'перше', 'один', 'first', 'one', '1'],
  ['другий', 'друга', 'друге', 'два', 'second', 'two', '2'],
  ['третій', 'третя', 'третє', 'три', 'third', 'three', '3'],
  ['четвертий', 'четверта', 'четверте', 'чотири', 'fourth', 'four', '4'],
  ["п'ятий", "п'ята", "п'яте", "п'ять", 'пятий', 'пять', 'fifth', 'five', '5'],
  ['шостий', 'шоста', 'шосте', 'шість', 'sixth', 'six', '6'],
  ['сьомий', 'сьома', 'сьоме', 'сім', 'seventh', 'seven', '7'],
  ['восьмий', 'восьма', 'восьме', 'вісім', 'eighth', 'eight', '8'],
];
const SKIP_WORDS = ['пропусти', 'пропустити', 'не знаю', 'skip', 'no answer'];
const SEND_WORDS = ['надіслати', 'надішли', 'відправ', 'відправити', 'готово', 'send', 'submit', 'done'];

// The option a sentence names: its label, its number ("the second one") or the label inside the sentence.
function optionSaid(said, q, { ordinals = true } = {}) {
  const labels = q.options.map((o) => normalizeSpeech(o.label));
  let i = labels.indexOf(said);
  if (i < 0 && ordinals) i = ORDINALS.findIndex((words, k) => k < labels.length && (words.includes(said) || words.some((w) => said === `${w} варіант` || said === `варіант ${w}` || said === `option ${w}` || said === `the ${w} one`)));
  // The label inside a sentence ("давай Pro"), longest label first so "Pro" does not win over "Pro Max".
  if (i < 0) {
    const padded = ` ${said} `;
    const hits = labels.map((l, k) => [l, k]).filter(([l]) => l && padded.includes(` ${l} `)).sort((a, b) => b[0].length - a[0].length);
    if (hits.length && (hits.length === 1 || hits[0][0].length > hits[1][0].length)) i = hits[0][1];
  }
  return i >= 0 ? q.options[i].label : null;
}

// What a spoken sentence means for an open question card:
// { skip } | { submit } | { picks: [{ index, label }] } | { index, other } | null (not understood).
export function matchAnswer(text, questions = []) {
  const said = normalizeSpeech(text);
  if (!said || !questions.length) return null;
  if (SKIP_WORDS.includes(said)) return { skip: true };
  if (questions.length === 1) {
    const [q] = questions;
    const label = optionSaid(said, q);
    if (label) return { picks: [{ index: 0, label }] };
    if (SEND_WORDS.includes(said)) return { submit: true };
    return q.other ? { index: 0, other: String(text).trim() } : null;
  }
  if (SEND_WORDS.includes(said)) return { submit: true };
  // Several questions: every option named in the sentence is picked for its question
  // (by name only — "the first one" would not say which question is meant).
  const picks = questions.map((q, index) => ({ index, label: optionSaid(said, q, { ordinals: false }) })).filter((p) => p.label);
  return picks.length ? { picks } : null;
}

// Cuts a stream of loudness readings into utterances. feed(level, now) returns
// 'start' when speech begins, 'end' when it is over (a pause of silenceMs),
// 'drop' when what began was too short to be speech, otherwise null.
// The threshold follows the room's noise, so a fan does not count as talking.
export function createSegmenter({ silenceMs = 900, minSpeechMs = 250, maxMs = 30_000, floor = 0.012, ratio = 3 } = {}) {
  let noise = floor / ratio;
  let state = 'idle'; // idle | maybe | speech
  let startedAt = 0;
  let loudMs = 0;
  let lastLoud = 0;
  let last = 0;
  const reset = () => {
    state = 'idle';
    loudMs = 0;
  };
  return {
    reset,
    get speaking() {
      return state === 'speech';
    },
    // Something has started (also the first moments, before it counts as speech).
    get active() {
      return state !== 'idle';
    },
    feed(level, now) {
      const dt = last ? Math.min(200, now - last) : 0;
      last = now;
      const loud = level > Math.max(floor, noise * ratio);
      if (state === 'idle') {
        if (!loud) {
          noise = noise * 0.95 + level * 0.05;
          return null;
        }
        state = 'maybe';
        startedAt = now;
        loudMs = 0;
        lastLoud = now;
        return 'start';
      }
      if (loud) {
        loudMs += dt;
        lastLoud = now;
        if (state === 'maybe' && loudMs >= minSpeechMs) state = 'speech';
        noise = noise * 0.999 + level * 0.001; // a room that got louder for good stops counting as speech
      }
      if (now - startedAt >= maxMs) {
        reset();
        return 'end';
      }
      if (now - lastLoud >= (state === 'speech' ? silenceMs : Math.min(silenceMs, 400))) {
        const real = state === 'speech';
        reset();
        return real ? 'end' : 'drop';
      }
      return null;
    },
  };
}

// A working microphone always delivers some noise. Exact digital silence for
// deadMs means the stream is dead — the device was unplugged, a headset switched
// its profile, the system took the input away. feed(peak, now) says when.
export function createSignalWatch({ deadMs = 6000, epsilon = 1e-6 } = {}) {
  let silentSince = 0;
  return {
    reset() {
      silentSince = 0;
    },
    feed(peak, now) {
      if (peak > epsilon) {
        silentSince = 0;
        return false;
      }
      if (!silentSince) silentSince = now;
      return now - silentSince >= deadMs;
    },
  };
}

// Whisper answers silence and clicks with stock phrases; those are not something the user said.
const PHANTOMS = /^(?:дякую за перегляд|дякую за увагу|субтитр\S* .*|thanks? for watching|thank you for watching|thank you|you|subtitles? by .*|\[.*\]|\(.*\))[.!… ]*$/i;
export const isPhantom = (text) => !normalizeSpeech(text) || PHANTOMS.test(String(text).trim());

// ---------- The microphone ----------

let port;
let handlers = { utterance: () => {}, state: () => {}, error: () => {}, level: () => {}, event: () => {}, speaking: () => false };
let session = null; // { engine, stream, ctx, analyser, timer, guard, recorder, recognition, muted, settings }
let nextRequest = 1;
const waits = new Map();

// level(0..1): how loud the microphone is right now (for a meter). event(name, detail):
// things worth keeping in the chat's journal. speaking(): is TabHelm's voice playing?
export function initLive(panelPort, { utterance, state, error, level, event, speaking } = {}) {
  port = panelPort;
  handlers = { utterance: utterance || handlers.utterance, state: state || handlers.state, error: error || handlers.error, level: level || handlers.level, event: event || handlers.event, speaking: speaking || handlers.speaking };
}

// Our own transcriptions carry "live-N" ids, so the Voice feature's replies are left alone.
export function handleLiveMessage(msg) {
  if (msg.type !== 'transcript' || !waits.has(msg.requestId)) return false;
  waits.get(msg.requestId)(msg);
  waits.delete(msg.requestId);
  return true;
}

export const liveOn = () => Boolean(session);

// While TabHelm speaks, what the microphone hears is its own voice: ignore it.
export function setLiveMuted(muted) {
  if (!session || session.muted === muted) return;
  session.muted = muted;
  session.mutedIdleSince = 0;
  session.segmenter?.reset();
  if (session.engine === 'host' && session.stream) restartRecorder(session, false);
  setState(muted ? 'speaking' : 'listening');
}

function setState(state, interim = '') {
  handlers.state(session ? state : 'off', interim);
}

function transcribeRequest(message) {
  return new Promise((resolve) => {
    const requestId = `live-${nextRequest++}`;
    const timer = setTimeout(() => waits.has(requestId) && (waits.delete(requestId), resolve({ error: 'no answer from the host' })), 75_000);
    waits.set(requestId, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
    port.postMessage({ ...message, requestId });
  });
}

export async function startLive() {
  if (session) return;
  const settings = await getSetting('live');
  const me = (session = { engine: settings.engine === 'browser' ? 'browser' : 'host', settings, muted: false, pending: 0 });
  try {
    if (me.engine === 'browser') startRecognition(me);
    else await startHostEngine(me);
    if (session !== me) return;
    // Being deaf for good is the worst failure of a conversation: if the microphone
    // is still ignored although TabHelm's voice stopped a while ago, listen again.
    me.guard = setInterval(() => {
      if (session !== me || !me.muted) return;
      const now = Date.now();
      if (handlers.speaking()) me.mutedIdleSince = 0;
      else if (!me.mutedIdleSince) me.mutedIdleSince = now;
      else if (now - me.mutedIdleSince > 1500) {
        handlers.event('unmuted', 'the voice had stopped');
        setLiveMuted(false);
      }
    }, 300);
    // Headphones plugged in or out, a headset connecting: Chrome keeps the old stream,
    // which goes silent — and on some systems takes the sound output with it. Take the
    // microphone again on the devices that are there now. Several events come in a burst.
    me.onDevices = () => {
      clearTimeout(me.devicesTimer);
      me.devicesTimer = setTimeout(() => {
        if (session !== me) return;
        handlers.event('devices_changed', '');
        if (me.engine === 'host') reopenMic(me, 'the audio devices changed', { counted: false });
        else {
          // Chrome's recognition: ending it makes onend start it again on the new device.
          try {
            me.recognition?.abort();
          } catch {}
        }
      }, 700);
    };
    navigator.mediaDevices?.addEventListener?.('devicechange', me.onDevices);
    handlers.event('on', me.engine);
    setState('listening');
  } catch (err) {
    if (session === me) stopLive();
    throw micError(err);
  }
}

export function stopLive() {
  const s = session;
  if (!s) return;
  session = null;
  clearInterval(s.timer);
  clearInterval(s.guard);
  clearTimeout(s.devicesTimer);
  if (s.onDevices) navigator.mediaDevices?.removeEventListener?.('devicechange', s.onDevices);
  handlers.event('off', '');
  handlers.level(0);
  if (s.recognition) {
    s.recognition.onend = null;
    try {
      s.recognition.stop();
    } catch {}
  }
  closeMic(s);
  handlers.state('off', '');
}

function micError(err) {
  if (err?.name === 'NotAllowedError' || /not-allowed/.test(err?.message || '')) {
    // The one-time permission page (the same one the Voice feature uses).
    chrome.tabs.create({ url: chrome.runtime.getURL('permissions.html') });
    return new Error('Microphone access needed: press “Allow microphone” on the page that just opened, then turn Live on again.');
  }
  return err instanceof Error ? err : new Error(String(err));
}

// An empty utterance still carries its cost: the transcription was paid for.
function deliver(me, text, cost) {
  if (session !== me) return;
  const said = String(text || '').trim();
  handlers.utterance(isPhantom(said) ? '' : said, cost ?? null);
}

// Engine "browser": Chrome cuts the speech into final results by itself.
function startRecognition(me) {
  const Rec = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  if (!Rec) throw new Error('Speech recognition is not available in this Chrome; switch Live conversation to the OpenRouter engine in its settings.');
  const rec = new Rec();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = me.settings.language === 'auto' ? navigator.language : me.settings.language;
  rec.onresult = (e) => {
    if (session !== me || me.muted) return;
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) deliver(me, r[0].transcript, null);
      else interim += r[0].transcript;
    }
    setState(interim ? 'hearing' : 'listening', interim);
  };
  rec.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    const err = micError(e.error === 'not-allowed' || e.error === 'service-not-allowed' ? { name: 'NotAllowedError' } : new Error(`Speech recognition: ${e.error}`));
    stopLive();
    handlers.error(err.message);
  };
  // Chrome ends recognition after a silence; keep it going until Live is turned off.
  rec.onend = () => {
    if (session !== me) return;
    try {
      rec.start();
    } catch {}
  };
  rec.start();
  me.recognition = rec;
}

// Engine "host": loudness decides where an utterance starts and ends; the
// recording of it goes to the host for transcription.
async function openMic(me) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  if (session !== me) return stream.getTracks().forEach((t) => t.stop());
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  // A microphone that goes away (unplugged, a headset switching its profile) is opened again.
  for (const track of stream.getAudioTracks()) track.onended = () => session === me && me.stream === stream && reopenMic(me, 'the microphone was disconnected');
  // Chrome may suspend or interrupt the audio graph (another app, a device change): wake it.
  ctx.onstatechange = () => session === me && me.ctx === ctx && ctx.state !== 'running' && ctx.state !== 'closed' && ctx.resume().catch(() => {});
  Object.assign(me, { stream, ctx, analyser, samples: new Float32Array(analyser.fftSize) });
}

function closeMic(me) {
  if (me.recorder?.state === 'recording') {
    me.recorder.keep = false;
    try {
      me.recorder.stop();
    } catch {}
  }
  me.recorder = null;
  me.stream?.getTracks().forEach((t) => {
    t.onended = null;
    t.stop();
  });
  me.ctx?.close().catch(() => {});
  me.stream = me.ctx = me.analyser = null;
}

// The microphone stopped delivering sound: take it again. Three times in a row
// without ever hearing anything means it is not coming back by itself.
// `counted: false` for a reopen the user caused (plugging headphones in or out): that
// is not a sign of a broken microphone.
async function reopenMic(me, why, { counted = true } = {}) {
  if (session !== me || me.reopening) return;
  me.reopening = true;
  if (counted) me.reopens = (me.reopens || 0) + 1;
  try {
    if (me.reopens > 3) throw new Error(`the microphone gives no sound (${why})`);
    closeMic(me);
    await openMic(me);
    if (session !== me) return;
    me.segmenter.reset();
    me.signal.reset();
    restartRecorder(me, false);
    handlers.event('mic_reopened', why);
    setState(me.muted ? 'speaking' : 'listening');
  } catch (err) {
    if (session === me) {
      stopLive();
      handlers.error(`Live conversation stopped: ${micError(err).message}. Check the input device in Chrome and in the system settings, then turn Live on again.`);
    }
  } finally {
    me.reopening = false;
  }
}

async function startHostEngine(me) {
  await openMic(me);
  if (session !== me) return;
  me.segmenter = createSegmenter({ silenceMs: Math.min(3000, Math.max(400, Number(me.settings.silenceMs) || 900)) });
  me.signal = createSignalWatch();
  restartRecorder(me, false);
  let quietSince = Date.now();
  let meterAt = 0;
  let resumeAt = 0;
  me.timer = setInterval(() => {
    if (session !== me || me.reopening || !me.analyser) return;
    const now = Date.now();
    if (me.ctx.state !== 'running' && now - resumeAt > 1000) {
      resumeAt = now;
      me.ctx.resume().catch(() => {});
    }
    me.analyser.getFloatTimeDomainData(me.samples);
    let sum = 0;
    let peak = 0;
    for (const x of me.samples) {
      sum += x * x;
      if (x > peak) peak = x;
      else if (-x > peak) peak = -x;
    }
    const level = Math.sqrt(sum / me.samples.length);
    // Checked also while TabHelm speaks: a dead microphone is found before the user talks to it.
    if (me.signal.feed(peak, now)) {
      me.signal.reset();
      return void reopenMic(me, 'no sound came from it');
    }
    if (now - meterAt > 100) {
      meterAt = now;
      handlers.level(me.muted ? 0 : level);
    }
    if (me.muted) return;
    const event = me.segmenter.feed(level, now);
    if (event === 'start') {
      me.reopens = 0; // it hears something: the microphone is alive
      setState('hearing');
    } else if (event === 'end') {
      restartRecorder(me, true); // the recording so far is the utterance
      quietSince = now;
    } else if (event === 'drop') {
      restartRecorder(me, false);
      quietSince = now;
      setState(me.pending ? 'thinking' : 'listening');
    } else if (!me.segmenter.active && now - quietSince > 3000) {
      // Nothing said: start the recording afresh, so an utterance never begins with long
      // silence. Never while something has just started — that would cut off its first syllable.
      restartRecorder(me, false);
      quietSince = now;
    }
  }, 50);
}

// One MediaRecorder per utterance, so every blob is a complete, decodable file.
function restartRecorder(me, keep) {
  const old = me.recorder;
  if (old?.state === 'recording') {
    old.keep = keep;
    try {
      old.stop();
    } catch {}
  }
  if (session !== me || !me.stream) return;
  try {
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
    const recorder = new MediaRecorder(me.stream, mime ? { mimeType: mime } : {});
    const parts = [];
    recorder.ondataavailable = (e) => e.data.size && parts.push(e.data);
    recorder.onstop = () => recorder.keep && sendUtterance(me, new Blob(parts, { type: recorder.mimeType }));
    recorder.start();
    me.recorder = recorder;
  } catch (err) {
    // The stream cannot be recorded any more (its track ended): take the microphone again.
    me.recorder = null;
    reopenMic(me, `recording could not start (${err.name || err.message})`);
  }
}

async function sendUtterance(me, blob) {
  if (session !== me || blob.size < 2000) return;
  me.pending++;
  setState('thinking');
  const data = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  }).catch(() => null);
  const reply = data ? await transcribeRequest({ type: 'transcribe', seq: 0, data, mimeType: blob.type.split(';')[0], language: me.settings.language }) : { error: 'could not read the recording' };
  me.pending--;
  if (session !== me) return;
  if (!me.muted && !me.segmenter.speaking) setState(me.pending ? 'thinking' : 'listening');
  if (reply.error) {
    stopLive();
    return handlers.error(`Live conversation stopped: ${reply.error}`);
  }
  deliver(me, reply.text, reply.cost);
}
