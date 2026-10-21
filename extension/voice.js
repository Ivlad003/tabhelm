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

let onInfo = () => {};
export function initVoice(panelPort, { text, error, info }) {
  port = panelPort;
  onText = text;
  onError = error;
  onInfo = info || (() => {});
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
  // The permission page reports back: start the recording the user asked for.
  chrome.runtime.onMessage.addListener((m) => {
    if (m?.type !== 'mic_granted' || !waitingForMic) return;
    const source = waitingForMic;
    waitingForMic = null;
    onInfo('Microphone allowed — recording now.');
    start(source).catch((err) => {
      stop(true);
      onError(err.message);
    });
  });
}

let waitingForMic = null; // the source to start once the microphone is allowed

// Opens the one-time permission page next to the chat tab; recording resumes by itself.
async function askForMic(source) {
  waitingForMic = source;
  const [current] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  chrome.tabs.create({ url: `${chrome.runtime.getURL('permissions.html')}${current ? `?back=${current.id}` : ''}`, index: current ? current.index + 1 : undefined });
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
    if (reply.error) {
      // Chrome lets an extension capture a tab only after you clicked its icon on that tab.
      const hint = /activeTab|not been invoked/i.test(reply.error) ? 'click the TabHelm icon on that tab once (Chrome needs it before an extension may capture a tab), then try again.' : reply.error;
      throw new Error(`Cannot capture the tab's audio: ${hint}`);
    }
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
      askForMic(state?.source || 'mic');
      throw new Error('Microphone access needed: press “Allow microphone” on the page that just opened — recording starts by itself afterwards.');
    }
    throw err;
  }
}

// One MediaRecorder per chunk so every blob is a complete, decodable file.
function recordChunk() {
  if (!state?.stream) return;
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
  const me = state; // onstop runs after Stop has cleared `state`
  const recorder = new MediaRecorder(me.stream, mime ? { mimeType: mime } : {});
  const parts = [];
  recorder.ondataavailable = (e) => e.data.size && parts.push(e.data);
  recorder.onstop = () => {
    const blob = new Blob(parts, { type: recorder.mimeType });
    if (!me.discarded && blob.size > 2000) sendChunk(blob, me);
    else if (me !== state) me.flushing?.(); // last chunk was silence: deliver what we have
    if (me === state && state.stream) recordChunk();
  };
  recorder.start();
  state.recorder = recorder;
  state.timer = setTimeout(() => recorder.state === 'recording' && recorder.stop(), (state.settings.chunkSeconds || 8) * 1000);
}

async function sendChunk(blob, me) {
  const seq = me.seq++;
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
  else me.flushing?.(); // chunk arrived after Stop: deliver the final text now
}

function startBrowserRecognition(settings) {
  const Rec = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  if (!Rec) throw new Error('Speech recognition is not available in this Chrome; switch the engine to the host in Settings → Voice.');
  const rec = new Rec();
  const me = state; // results can still arrive after Stop has cleared `state`
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = settings.language === 'auto' ? navigator.language : settings.language;
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) me.finals.push(r[0].transcript.trim());
      else interim += r[0].transcript;
    }
    me.interim = interim;
    if (me === state) render();
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      askForMic('mic');
      onError('Microphone access needed: press “Allow microphone” on the page that just opened — recording starts by itself afterwards.');
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
  // Checked before stopping: the recorder turns inactive at once, but its last chunk comes later.
  const lastChunk = s.recorder?.state === 'recording';
  if (discard) s.discarded = true;
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
  let delivered = false;
  const deliver = () => {
    if (delivered) return;
    delivered = true;
    s.flushing = null;
    onText(s.finals.filter(Boolean).join(' ').trim(), s.source);
  };
  if (s.pending > 0 || lastChunk) {
    // Wait for the last chunk(s) to be transcribed (at most 15 s), then deliver once.
    s.flushing = () => s.pending === 0 && deliver();
    setTimeout(deliver, 15_000);
  } else deliver();
}
