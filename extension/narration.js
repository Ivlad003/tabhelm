// Narration (feature flag): TabHelm speaks — each guide step, a short phrase
// when a task needs you or ends, and any reply you press 🔊 on.
// The host turns text into speech through OpenRouter (/audio/speech) and sends
// back short MP3s. One thing is spoken at a time: a new one replaces the one
// playing. Everything sent is reported with its length and cost; text spoken
// before comes from a cache and costs nothing.

import { getFeatures, getSetting } from './features.js';

let port;
let onSpoken = () => {};
let onError = () => {};
let onState = () => {};
let onPlayed = () => {}; // a clip started to sound: { url, at, kind } — the video recorder takes it from here
let onStopped = () => {}; // …and was cut off before its end: { at }
let nextRequest = 1;
const waits = new Map(); // requestId -> resolve
const cache = new Map(); // model|voice|text -> { url }
const CACHE_MAX = 80;
const START_DEADLINE_MS = 8000; // a clip that has not started playing by then is given up
let current = null; // what is being fetched or played: { kind, audio, cancelled, sent }
let catalog = { ready: false, models: [], maxChars: 450, defaultModel: 'elevenlabs/eleven-flash-v2.5' };
let lastError = { text: '', at: 0 };

// Fixed phrases for the moments a task needs you or ends.
const PHRASES = {
  en: { needsYou: 'I need your answer.', done: 'Done.', failed: 'The task stopped before finishing.', test: 'This is the voice TabHelm will use.' },
  uk: { needsYou: 'Потрібна ваша відповідь.', done: 'Готово.', failed: 'Завдання зупинилось, не завершившись.', test: 'Таким голосом говоритиме TabHelm.' },
};

export function phrase(id, language = 'auto') {
  const lang = language === 'auto' ? (navigator.language || 'en').slice(0, 2) : language;
  return (PHRASES[lang] || PHRASES.en)[id] || '';
}

export function initNarration(panelPort, { spoken, error, state, played, stopped } = {}) {
  port = panelPort;
  onSpoken = spoken || onSpoken;
  onError = error || onError;
  onState = state || onState;
  onPlayed = played || onPlayed;
  onStopped = stopped || onStopped;
  getFeatures().then((f) => f.narration && port.postMessage({ type: 'speech_status' }));
  // Headphones plugged in or out: what is being spoken moves to the new output. The
  // events come in a burst, and Live conversation takes the microphone again first.
  let devicesTimer = null;
  globalThis.navigator?.mediaDevices?.addEventListener?.('devicechange', () => {
    clearTimeout(devicesTimer);
    devicesTimer = setTimeout(replayOnNewDevice, 1200);
  });
}

// 'speech' answers a request of ours; 'speech_status' is also read by Settings, so it is not consumed.
export function handleNarrationMessage(msg) {
  if (msg.type === 'speech_status') {
    catalog = { ...catalog, ...msg };
    return false;
  }
  if (msg.type !== 'speech' || !waits.has(msg.requestId)) return false;
  waits.get(msg.requestId)(msg);
  waits.delete(msg.requestId);
  return true;
}

// Live conversation speaks with the same voice, whether or not the Narration flag is on.
let forced = false;
export function forceNarration(on) {
  forced = Boolean(on);
  if (forced && !catalog.models.length) port?.postMessage({ type: 'speech_status' });
}

// The flag and its settings, as they are now.
export async function narrationSettings() {
  const [features, settings] = await Promise.all([getFeatures(), getSetting('narration')]);
  return { ...settings, on: Boolean(features.narration) || forced, ...(forced ? { guide: true, events: true } : {}), model: settings.model || catalog.defaultModel };
}

// A Markdown reply as it should be said: no code, tables, link addresses or markup.
export function plainSpeech(markdown) {
  return String(markdown || '')
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
}

export function speechCatalog() {
  return catalog;
}

// What speaking `chars` characters costs with this model, or null when the model is not priced per character.
export function estimateCost(chars, modelId) {
  const m = catalog.models.find((x) => x.id === modelId);
  if (!m) return null;
  return m.free ? 0 : m.perChar != null ? chars * m.perChar : null;
}

// Pieces of at most `max` characters, cut at sentence ends where possible.
export function splitForSpeech(text, max = 450) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const out = [];
  let piece = '';
  const push = () => {
    if (piece.trim()) out.push(piece.trim());
    piece = '';
  };
  for (const sentence of clean.match(/[^.!?…]+[.!?…]*\s*/g) || [clean]) {
    let rest = sentence;
    // A single sentence longer than a piece is cut at a space.
    while (rest.length > max) {
      push();
      let cut = rest.lastIndexOf(' ', max);
      if (cut < max / 2) cut = max;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut);
    }
    if (piece.length + rest.length > max) push();
    piece += rest;
  }
  push();
  return out;
}

export function speaking(kind) {
  return Boolean(current && (!kind || current.kind === kind));
}

// Stops the voice (only when it is speaking something of `kind`, if given).
export function hush(kind) {
  if (!current || (kind && current.kind !== kind)) return;
  const u = current;
  current = null;
  u.cancelled = true;
  u.audio?.pause();
  u.stopPlaying?.();
  onState(false, u.kind);
}

// The audio devices changed (headphones plugged in or out) while something is being
// spoken: the clip may be left playing into a device that is gone. It is started
// again on the output that is the default now, a moment before where it was.
// Returns whether there was something to restart.
export function replayOnNewDevice() {
  const audio = current?.audio;
  if (!audio || audio.ended) return false;
  try {
    audio.pause();
    audio.currentTime = Math.max(0, (audio.currentTime || 0) - 0.5);
  } catch {}
  // Naming the default output again makes Chrome open it afresh.
  const rebound = typeof audio.setSinkId === 'function' ? audio.setSinkId('default').catch(() => {}) : Promise.resolve();
  rebound.then(() => current?.audio === audio && audio.play().catch(() => {}));
  return true;
}

function request(message) {
  return new Promise((resolve) => {
    const requestId = nextRequest++;
    const timer = setTimeout(() => waits.has(requestId) && (waits.delete(requestId), resolve({ error: 'no answer from the host' })), 75_000);
    waits.set(requestId, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
    port.postMessage({ ...message, requestId });
  });
}

async function fetchPiece(text, settings, u) {
  const key = `${settings.model}|${settings.voice || ''}|${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const reply = await request({ type: 'speak', text, model: settings.model, voice: settings.voice || undefined });
  if (reply.error) throw new Error(reply.error);
  const bytes = Uint8Array.from(atob(reply.data), (c) => c.charCodeAt(0));
  const item = { url: URL.createObjectURL(new Blob([bytes], { type: reply.mimeType || 'audio/mpeg' })) };
  cache.set(key, item);
  if (cache.size > CACHE_MAX) {
    const [oldKey, old] = cache.entries().next().value;
    URL.revokeObjectURL(old.url);
    cache.delete(oldKey);
  }
  // Billed once it is generated, also when the voice is stopped before it plays.
  u.sent.chars += reply.chars || text.length;
  u.sent.pieces++;
  if (reply.cost == null) u.sent.unpriced = true;
  else u.sent.cost += reply.cost;
  u.sent.model = reply.model || settings.model;
  u.sent.voice = reply.voice || settings.voice || null;
  return item;
}

function play(item, u) {
  return new Promise((resolve, reject) => {
    const audio = new Audio(item.url);
    u.audio = audio;
    // A clip that never starts or never reports its end (a suspended page, a broken
    // file) must not hold a guide or the queue: it gets a deadline either way.
    let timer = setTimeout(() => reject(new Error('The audio did not start playing.')), START_DEADLINE_MS);
    let sounding = false;
    const done = (finished) => {
      clearTimeout(timer);
      if (sounding && !finished) onStopped({ at: Date.now() });
      resolve(finished);
    };
    const failed = (err) => {
      clearTimeout(timer);
      reject(err);
    };
    u.stopPlaying = () => done(false);
    audio.onended = () => done(true);
    audio.onerror = () => failed(new Error('The audio could not be played.'));
    audio.onplaying = () => {
      // Once per clip: a restart on another output device is the same clip.
      if (!sounding) {
        sounding = true;
        onPlayed({ url: item.url, at: Date.now(), kind: u.kind });
      }
      clearTimeout(timer);
      timer = setTimeout(() => done(true), (Number.isFinite(audio.duration) ? audio.duration : 60) * 1000 + 2000);
    };
    audio.play().catch((err) => failed(err.name === 'NotAllowedError' ? new Error('Chrome blocked the sound: click anywhere in the panel once, then try again.') : err));
  });
}

function fail(message) {
  // The same failure (no key, offline) for every sentence is said once.
  if (message === lastError.text && Date.now() - lastError.at < 30_000) return;
  lastError = { text: message, at: Date.now() };
  onError(message);
}

// Speaks `text`, replacing whatever is being spoken. Resolves true when it was
// spoken to the end, false when it was replaced, stopped or failed.
export async function say(text, { kind = 'event', settings } = {}) {
  const s = settings || (await narrationSettings());
  const pieces = splitForSpeech(text, catalog.maxChars || 450);
  if (!pieces.length) return false;
  hush();
  const u = { kind, cancelled: false, sent: { chars: 0, cost: 0, pieces: 0, unpriced: false, model: s.model, voice: s.voice || null } };
  current = u;
  onState(true, kind);
  const fetches = [];
  const get = (i) => {
    const p = fetchPiece(pieces[i], s, u);
    fetches.push(p.catch(() => {}));
    return p;
  };
  let finished = false;
  try {
    let next = get(0);
    for (let i = 0; i < pieces.length && !u.cancelled; i++) {
      const item = await next;
      if (u.cancelled) break;
      if (i + 1 < pieces.length) next = get(i + 1); // the next piece loads while this one plays
      if (!(await play(item, u))) break;
      finished = i === pieces.length - 1;
    }
  } catch (err) {
    if (!u.cancelled) fail(`Narration failed: ${err.message}`);
  }
  if (current === u) {
    current = null;
    onState(false, kind);
  }
  // Report once every request of this utterance has answered (one may still be on its way).
  Promise.all(fetches).then(() => onSpoken({ kind, text: pieces.join(' '), chars: u.sent.chars, cost: u.sent.unpriced ? null : u.sent.cost, model: u.sent.model, voice: u.sent.voice, cached: u.sent.pieces === 0, finished }));
  return finished;
}
