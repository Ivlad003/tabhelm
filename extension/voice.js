// Voice (feature flag): record the microphone or the tab's audio, transcribe
// live, and put the whole transcript into the message box as one message.
//   engine "browser": Chrome's SpeechRecognition (microphone only, live interim text)
//   engine "host":    audio chunks → host (whisper.cpp or a transcription API)

import { getSetting } from './features.js';

const $ = (id) => document.getElementById(id);
let port;
let onText = () => {};
let onError = () => {};
let state = null; // { source, engine, stream, recognition, recorder, timer, finals: [], pending: Map, seq, ctx }
let nextRequest = 1;
const waits = new Map();

export function initVoice(panelPort, { text, error }) {
  port = panelPort;
  onText = text;
  onError = error;
  for (const b of document.querySelectorAll('[data-voice]')) {
    b.onclick = () => {
      $('plus-menu').open = false;
      start(b.dataset.voice).catch((err) => {
        stop(true);
        onError(err.message);
      });
    };
  }
  $('voice-stop').onclick = () => stop();
}

export function handleVoiceMessage(msg) {
  if (msg.type === 'transcript' || msg.type === 'tab_capture_id') {
    waits.get(msg.requestId)?.(msg);
    waits.delete(msg.requestId);
    return true;
  }
  return false;
}

export function voiceActive() {
  return Boolean(state);
}

function request(message) {
  return new Promise((resolve) => {
    const requestId = nextRequest++;
    waits.set(requestId, resolve);
    port.postMessage({ ...message, requestId });
    setTimeout(() => waits.has(requestId) && (waits.delete(requestId), resolve({ error: 'no answer from the host' })), 90_000);
  });
}

async function start(source) {
  if (state) stop();
  const settings = await getSetting('voice');
  const engine = source === 'tab' ? 'host' : settings.engine;
  state = { source, engine, finals: [], interim: '', seq: 0, pending: 0, settings };
  show(`${source === 'tab' ? 'Recording the tab' : 'Listening'}… (${engine === 'browser' ? 'Chrome recognition' : 'host transcription'})`);

  if (engine === 'browser') return startBrowserRecognition(settings);

  // Host engine: capture a stream and send complete webm chunks.
  let stream;
  if (source === 'tab') {
    const reply = await request({ type: 'tab_capture_id' });
    if (reply.error) throw new Error(`Cannot capture the tab's audio: ${reply.error}`);
    stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: reply.streamId } }, video: false });
    // Capturing mutes the tab for the user; play the audio back.
    state.ctx = new AudioContext();
    state.ctx.createMediaStreamSource(stream).connect(state.ctx.destination);
  } else {
    stream = await micStream();
  }
  state.stream = stream;
  recordChunk();
}

async function micStream() {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      chrome.tabs.create({ url: chrome.runtime.getURL('permissions.html') });
      throw new Error('Microphone not allowed yet: allow it on the page that just opened, then try again.');
    }
    throw err;
  }
}

// One MediaRecorder per chunk so every blob is a complete, decodable file.
function recordChunk() {
  if (!state?.stream) return;
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
  const recorder = new MediaRecorder(state.stream, mime ? { mimeType: mime } : {});
  const parts = [];
  recorder.ondataavailable = (e) => e.data.size && parts.push(e.data);
  recorder.onstop = () => {
    const blob = new Blob(parts, { type: recorder.mimeType });
    if (blob.size > 2000) sendChunk(blob);
    if (state?.stream) recordChunk();
  };
  recorder.start();
  state.recorder = recorder;
  state.timer = setTimeout(() => recorder.state === 'recording' && recorder.stop(), (state.settings.chunkSeconds || 8) * 1000);
}

async function sendChunk(blob) {
  const seq = state.seq++;
  const me = state;
  me.pending++;
  render();
  const data = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
  const reply = await request({ type: 'transcribe', seq, data, mimeType: blob.type.split(';')[0], language: me.settings.language });
  me.pending--;
  if (reply.error) {
    onError(`Transcription failed: ${reply.error}`);
    if (me === state) stop(true);
    return;
  }
  if (reply.text) me.finals[seq] = reply.text;
  if (me === state) render();
  else if (me.flushing) me.flushing(); // chunk arrived after Stop: deliver the final text now
}

function startBrowserRecognition(settings) {
  const Rec = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  if (!Rec) throw new Error('Speech recognition is not available in this Chrome; switch the engine to the host in Settings → Voice.');
  const rec = new Rec();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = settings.language === 'auto' ? navigator.language : settings.language;
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) state.finals.push(r[0].transcript.trim());
      else interim += r[0].transcript;
    }
    state.interim = interim;
    render();
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      chrome.tabs.create({ url: chrome.runtime.getURL('permissions.html') });
      onError('Microphone not allowed yet: allow it on the page that just opened, then try again.');
      stop(true);
    } else if (e.error !== 'no-speech' && e.error !== 'aborted') onError(`Speech recognition: ${e.error}`);
  };
  // Chrome ends recognition after silence; keep it going until Stop.
  rec.onend = () => {
    if (state?.recognition === rec) {
      try {
        rec.start();
      } catch {}
    }
  };
  rec.start();
  state.recognition = rec;
}

function show(status) {
  $('voice-live').hidden = false;
  $('voice-status').textContent = status;
  $('voice-stop').hidden = false;
  render();
}

function render() {
  if (!state) return;
  const box = $('voice-text');
  box.replaceChildren(document.createTextNode(state.finals.filter(Boolean).join(' ')));
  if (state.interim) box.append(' ', Object.assign(document.createElement('span'), { className: 'interim', textContent: state.interim }));
  if (state.pending) $('voice-status').textContent = `Transcribing ${state.pending} chunk(s)…`;
  box.scrollTop = box.scrollHeight;
}

// Stops recording; the transcript (plus any chunk still in flight) goes to the message box.
export function stop(discard = false) {
  const s = state;
  if (!s) return;
  state = null;
  clearTimeout(s.timer);
  if (s.recognition) {
    s.recognition.onend = null;
    try {
      s.recognition.stop();
    } catch {}
  }
  if (s.recorder && s.recorder.state === 'recording') s.recorder.stop(); // triggers a last chunk
  s.stream?.getTracks().forEach((t) => t.stop());
  s.ctx?.close().catch(() => {});
  $('voice-live').hidden = true;
  $('voice-stop').hidden = true;
  if (discard) return;
  const deliver = () => onText(s.finals.filter(Boolean).join(' ').trim(), s.source);
  if (s.pending > 0 || (s.recorder && s.recorder.state === 'recording')) {
    // Wait briefly for the last chunk(s), then deliver whatever we have.
    s.flushing = () => s.pending === 0 && deliver();
    setTimeout(() => s.flushing && (s.flushing = null, deliver()), 15_000);
  } else deliver();
}
