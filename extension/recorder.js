// Video encoder for recordings: JPEG frames of the tab → WebCodecs (H.264, or
// VP9 when H.264 is missing) → a regular MP4 with its index at the start
// (fast start). Unlike MediaRecorder's streaming output, the result has a
// duration and keyframes every two seconds, so players can seek it and Slack,
// QuickTime and messengers can preview it. WebCodecs does not depend on the
// panel being painted, so it keeps working while the side panel is hidden.
//
// Trim waits (Experimental flag "Skip waiting in recordings"): frames that only
// repeat a still page (`fill` frames from the extension) stop advancing the
// video clock after `maxPauseMs`; the next real change shows a short
// "⏩ N s of waiting skipped" label. timeAt(realMs) maps wall-clock times to
// video times, so step lists can still seek to the right moment.
//
// Voice (`audio: true`): what TabHelm says aloud while recording (Narration,
// Live conversation) goes into the video as an AAC track. The panel hands over
// each clip when it starts playing; it is decoded here and laid on the video's
// own clock, with silence in between, so the track is one unbroken stream that
// every player accepts. While a clip plays the picture is never "still": cutting
// the wait would pull the voice away from what it describes.

import { Muxer, ArrayBufferTarget } from './vendor/mp4-muxer.mjs';

const KEYFRAME_EVERY_US = 2_000_000;
const LABEL_MS = 1500;
const MAX_W = 1600;
const MAX_H = 1000;
const LAST_FRAME_US = 66_667; // one frame at 15 fps
const SAMPLE_RATE = 48_000;
const SILENCE = new Float32Array(SAMPLE_RATE); // one second of nothing, reused

export function webCodecsAvailable() {
  return typeof VideoEncoder === 'function' && typeof VideoFrame === 'function' && typeof OffscreenCanvas === 'function';
}

export class Recorder {
  constructor({ trimWaits = false, maxPauseMs = 1500, audio = false } = {}) {
    Object.assign(this, { trimWaits, maxPauseMs });
    this.wantAudio = Boolean(audio) && typeof AudioEncoder === 'function' && typeof OfflineAudioContext === 'function';
    this.audioEncoder = null;
    this.audioChannels = 1;
    this.audioCursor = 0; // samples written to the audio track so far
    this.pendingSpeech = null; // the clip playing now: { samples, startMs, startReal } — written when it is over
    this.speechUntil = 0; // wall clock until which TabHelm is speaking
    this.spokenSamples = 0;
    this.started = 0; // wall clock of the first frame
    this.lastReal = 0; // wall clock of the last frame
    this.clock = 0; // video time of the last frame, ms
    this.lastKey = -Infinity; // video time of the last keyframe, µs
    this.stillMs = 0; // how long the page has been still
    this.skippedMs = 0; // waiting cut since the last change
    this.labelUntil = 0; // video time until which the "skipped" label shows
    this.label = '';
    this.points = []; // [realMs, videoMs] for timeAt()
    this.queue = Promise.resolve();
    this.error = null;
    this.bitmap = null;
    this.frames = 0;
    this.muxed = 0; // chunks the muxer accepted
    this.skippedTotal = 0;
    this.thumb = null; // tiny grayscale copy of the last frame, to tell still pages apart
  }

  // True when the picture barely changed (a blinking caret or a moving cursor
  // does not count as activity).
  #still(bitmap) {
    const W = 48;
    const H = 30;
    this.thumbCanvas ||= new OffscreenCanvas(W, H);
    const c = this.thumbCanvas.getContext('2d', { willReadFrequently: true });
    c.drawImage(bitmap, 0, 0, W, H);
    const px = c.getImageData(0, 0, W, H).data;
    const gray = new Uint8Array(W * H);
    for (let i = 0; i < gray.length; i++) gray[i] = (px[i * 4] * 3 + px[i * 4 + 1] * 6 + px[i * 4 + 2]) / 10;
    const prev = this.thumb;
    this.thumb = gray;
    if (!prev) return false;
    let changed = 0;
    for (let i = 0; i < gray.length; i++) if (Math.abs(gray[i] - prev[i]) > 24) changed++;
    return changed / gray.length < 0.004; // under ~6 of 1440 cells
  }

  // Frames are processed one at a time, in arrival order.
  add(frame) {
    this.queue = this.queue.then(() => this.#add(frame)).catch((err) => (this.error ||= err));
    return this.queue;
  }

  async #add({ data, fill = false, at = Date.now() }) {
    if (this.closed) return;
    const blob = await (await fetch(`data:image/jpeg;base64,${data}`)).blob();
    const bitmap = await createImageBitmap(blob);
    if (!this.encoder) await this.#open(bitmap.width, bitmap.height);
    if (!this.started) {
      this.started = at;
      this.lastReal = at;
      this.points.push([at, 0]);
    }
    const gap = Math.max(0, at - this.lastReal);
    this.lastReal = at;
    // Not while TabHelm is speaking: the voice and the picture must keep the same clock.
    const still = this.trimWaits && (this.#still(bitmap) || fill) && at > this.speechUntil;
    if (still) {
      // A still page: keep up to maxPauseMs of it, cut the rest.
      const keep = Math.max(0, Math.min(gap, this.maxPauseMs - this.stillMs));
      this.stillMs += gap;
      this.skippedMs += gap - keep;
      this.skippedTotal += gap - keep;
      this.clock += keep;
      this.points.push([at, this.clock]);
      if (!keep) {
        this.bitmap?.close();
        this.bitmap = bitmap; // newest picture of the still page
        return;
      }
    } else {
      if (this.trimWaits && this.skippedMs >= 1000) {
        this.label = `⏩ ${Math.round(this.skippedMs / 1000)} s of waiting skipped`;
        this.labelUntil = this.clock + gap + LABEL_MS;
      }
      this.stillMs = 0;
      this.skippedMs = 0;
      this.clock += gap;
      this.points.push([at, this.clock]);
    }
    this.bitmap?.close();
    this.bitmap = bitmap;
    this.#encode(this.clock);
  }

  async #open(w, h) {
    // Even sizes for H.264, at most 1600×1000. The screencast already caps its
    // frames, but the first picture may be a full-resolution screenshot (twice
    // the size on a Retina display). That is more than H.264 level 4 allows, so
    // Chrome would fall back to VP9, which QuickTime and messengers cannot play.
    const fit = Math.min(1, MAX_W / w, MAX_H / h);
    this.width = Math.max(2, Math.round(w * fit) & ~1);
    this.height = Math.max(2, Math.round(h * fit) & ~1);
    this.canvas = new OffscreenCanvas(this.width, this.height);
    this.ctx = this.canvas.getContext('2d');
    const base = { width: this.width, height: this.height, bitrate: 4_000_000, framerate: 15 };
    const candidates = [
      { codec: 'avc1.640028', mux: 'avc', avc: { format: 'avc' } },
      { codec: 'avc1.4d0028', mux: 'avc', avc: { format: 'avc' } },
      { codec: 'avc1.42001f', mux: 'avc', avc: { format: 'avc' } },
      { codec: 'vp09.00.10.08', mux: 'vp9' },
    ];
    let chosen = null;
    for (const c of candidates) {
      const { supported } = await VideoEncoder.isConfigSupported({ ...base, codec: c.codec, ...(c.avc ? { avc: c.avc } : {}) }).catch(() => ({ supported: false }));
      if (supported) {
        chosen = c;
        break;
      }
    }
    if (!chosen) throw new Error('This Chrome cannot encode H.264 or VP9 video.');
    const sound = this.wantAudio ? await this.#audioConfig() : null;
    this.muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: chosen.mux, width: this.width, height: this.height },
      ...(sound ? { audio: { codec: sound.mux, numberOfChannels: sound.numberOfChannels, sampleRate: SAMPLE_RATE } } : {}),
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });
    if (sound) {
      this.audioChannels = sound.numberOfChannels;
      // A problem with the sound must not cost the picture: the video is kept, the track just ends early.
      this.audioEncoder = new AudioEncoder({
        output: (chunk, meta) => {
          try {
            this.muxer.addAudioChunk(chunk, meta);
          } catch (err) {
            this.audioError ||= err;
          }
        },
        error: (err) => (this.audioError ||= err),
      });
      this.audioEncoder.configure({ codec: sound.codec, sampleRate: SAMPLE_RATE, numberOfChannels: sound.numberOfChannels, bitrate: sound.bitrate });
      this.audioCodec = sound.codec;
    }
    this.encoder = new VideoEncoder({ output: (chunk, meta) => this.#mux(chunk, meta), error: (err) => (this.error ||= err) });
    this.encoder.configure({ ...base, codec: chosen.codec, ...(chosen.avc ? { avc: chosen.avc } : {}), latencyMode: 'quality' });
    this.codec = chosen.codec;
  }

  // AAC plays everywhere an MP4 does; Opus is the fallback where Chrome has no AAC encoder.
  async #audioConfig() {
    const candidates = [
      { codec: 'mp4a.40.2', mux: 'aac', numberOfChannels: 1, bitrate: 96_000 },
      { codec: 'mp4a.40.2', mux: 'aac', numberOfChannels: 2, bitrate: 128_000 },
      { codec: 'opus', mux: 'opus', numberOfChannels: 1, bitrate: 64_000 },
    ];
    for (const c of candidates) {
      const { supported } = await AudioEncoder.isConfigSupported({ codec: c.codec, sampleRate: SAMPLE_RATE, numberOfChannels: c.numberOfChannels, bitrate: c.bitrate }).catch(() => ({ supported: false }));
      if (supported) return c;
    }
    return null;
  }

  // A clip TabHelm starts playing now (`url`: its audio file). Queued with the frames,
  // so frames that come after it already know someone is speaking.
  speech({ url, at = Date.now() }) {
    if (!this.wantAudio) return this.queue;
    // A clip that cannot be read leaves that stretch of the video silent, nothing more.
    this.queue = this.queue.then(() => this.#speech(url, at)).catch(() => {});
    return this.queue;
  }

  // The voice was stopped before the clip ended (Stop, a newer sentence): the video stops it there too.
  speechStopped(at = Date.now()) {
    if (!this.wantAudio) return this.queue;
    this.queue = this.queue.then(() => {
      const p = this.pendingSpeech;
      if (p) p.samples = p.samples.subarray(0, Math.min(p.samples.length, Math.max(0, Math.round(((at - p.startReal) / 1000) * SAMPLE_RATE))));
      this.speechUntil = Math.min(this.speechUntil, at);
    });
    return this.queue;
  }

  async #speech(url, at) {
    if (this.closed || !this.audioEncoder) return; // before the first frame there is no video to speak over
    const bytes = await (await fetch(url)).arrayBuffer();
    // Decoding at the track's rate also resamples the clip.
    const decoded = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(bytes);
    const samples = new Float32Array(decoded.length);
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const channel = decoded.getChannelData(c);
      for (let i = 0; i < samples.length; i++) samples[i] += channel[i] / decoded.numberOfChannels;
    }
    this.#writeSpeech();
    // Where "now" is on the video's clock: after the last frame the clock runs on in real time.
    const startMs = at <= this.lastReal ? this.timeAt(at) : this.clock + (at - this.lastReal);
    this.pendingSpeech = { samples, startMs, startReal: at };
    this.speechUntil = at + (samples.length / SAMPLE_RATE) * 1000;
  }

  // Writes the clip that was playing: silence up to where it starts, then the clip
  // (never past `limit` samples — the end of the video).
  #writeSpeech(limit = Infinity) {
    const p = this.pendingSpeech;
    if (!p) return;
    this.pendingSpeech = null;
    const start = Math.max(this.audioCursor, Math.round((p.startMs / 1000) * SAMPLE_RATE)); // right after the previous clip at the earliest
    const samples = start + p.samples.length > limit ? p.samples.subarray(0, Math.max(0, limit - start)) : p.samples;
    this.#silence(Math.min(start, limit) - this.audioCursor);
    this.#pcm(samples);
    this.spokenSamples += samples.length;
  }

  #silence(count) {
    for (let left = count; left > 0; left -= SAMPLE_RATE) this.#pcm(SILENCE.subarray(0, Math.min(left, SAMPLE_RATE)));
  }

  // Mono samples → the encoder, in pieces of at most a second, one after another on the track.
  #pcm(samples) {
    if (this.audioError || this.audioEncoder?.state !== 'configured') return;
    for (let offset = 0; offset < samples.length; offset += SAMPLE_RATE) {
      const part = samples.subarray(offset, offset + SAMPLE_RATE);
      let data = part;
      if (this.audioChannels === 2) {
        data = new Float32Array(part.length * 2);
        for (let i = 0; i < part.length; i++) data[i * 2] = data[i * 2 + 1] = part[i];
      }
      const audio = new AudioData({ format: 'f32', sampleRate: SAMPLE_RATE, numberOfFrames: part.length, numberOfChannels: this.audioChannels, timestamp: Math.round((this.audioCursor / SAMPLE_RATE) * 1e6), data });
      try {
        this.audioEncoder.encode(audio);
      } catch (err) {
        this.audioError ||= err;
      }
      audio.close();
      this.audioCursor += part.length;
    }
  }

  // Hands an encoded chunk to the muxer. Chrome 157+ reports no duration for
  // frames that were given none (earlier versions filled one in), and the muxer
  // rejects that; it only uses the value for the last frame anyway, the others
  // last until the next timestamp. An error here would otherwise be lost as an
  // uncaught exception and leave an empty video.
  #mux(chunk, meta) {
    try {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      this.muxer.addVideoChunkRaw(data, chunk.type, chunk.timestamp, chunk.duration ?? LAST_FRAME_US, meta);
      this.muxed++;
    } catch (err) {
      this.error ||= err;
    }
  }

  // Draws the current picture (letterboxed if a tab of another size is shown)
  // plus the "skipped" label, and encodes it at video time `ms`.
  #encode(ms) {
    const { ctx, width: W, height: H, bitmap } = this;
    if (!bitmap) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const s = Math.min(W / bitmap.width, H / bitmap.height);
    const w = bitmap.width * s;
    const h = bitmap.height * s;
    ctx.drawImage(bitmap, (W - w) / 2, (H - h) / 2, w, h);
    if (this.label && ms <= this.labelUntil) {
      ctx.font = `600 ${Math.round(H / 32)}px system-ui, sans-serif`;
      const pad = Math.round(H / 80);
      const tw = ctx.measureText(this.label).width;
      ctx.fillStyle = 'rgba(28,125,92,.92)';
      ctx.fillRect(W - tw - pad * 4, pad * 2, tw + pad * 2, Math.round(H / 32) + pad * 2);
      ctx.fillStyle = '#fff';
      ctx.fillText(this.label, W - tw - pad * 3, pad * 3 + Math.round(H / 40));
    }
    const us = Math.round(ms * 1000);
    if (this.encoder.encodeQueueSize > 8 && us - this.lastKey < KEYFRAME_EVERY_US) return; // falling behind: drop
    const keyFrame = us - this.lastKey >= KEYFRAME_EVERY_US;
    if (keyFrame) this.lastKey = us;
    const frame = new VideoFrame(this.canvas, { timestamp: us });
    this.encoder.encode(frame, { keyFrame });
    frame.close();
    this.frames++;
  }

  // Wall-clock time → video time (ms), for jumping to a step in the video.
  timeAt(realMs) {
    const p = this.points;
    if (!p.length) return 0;
    if (realMs <= p[0][0]) return 0;
    for (let i = 1; i < p.length; i++) {
      if (realMs <= p[i][0]) {
        const [r0, v0] = p[i - 1];
        const [r1, v1] = p[i];
        return v0 + ((realMs - r0) / Math.max(1, r1 - r0)) * (v1 - v0);
      }
    }
    return p[p.length - 1][1];
  }

  // Ends the video at the stop time (the last picture holds until then) and
  // returns { blob, durationMs, timeAt } or null when nothing was recorded.
  async finish(at = Date.now()) {
    await this.queue;
    if (!this.encoder || this.error) {
      this.#close();
      if (this.error) throw this.error;
      return null;
    }
    const gap = Math.max(0, at - this.lastReal);
    const tail = this.trimWaits ? Math.min(gap, Math.max(0, this.maxPauseMs - this.stillMs) || 300) : gap;
    this.clock += Math.max(tail, 100);
    this.points.push([at, this.clock]);
    this.lastKey = -Infinity; // a keyframe at the very end helps players show it
    this.#encode(this.clock);
    await this.encoder.flush();
    if (this.audioEncoder) {
      // The track ends with the picture: the clip still playing is cut there, the rest is silence.
      const end = Math.round((this.clock / 1000) * SAMPLE_RATE);
      this.#writeSpeech(end);
      this.#silence(end - this.audioCursor);
      await this.audioEncoder.flush().catch((err) => (this.audioError ||= err));
    }
    if (this.error || !this.muxed) {
      const err = this.error || new Error('the encoder produced no video data.');
      this.#close();
      throw err;
    }
    this.muxer.finalize();
    const blob = new Blob([this.muxer.target.buffer], { type: 'video/mp4' });
    const durationMs = this.clock;
    this.#close();
    return { blob, durationMs, timeAt: (ms) => this.timeAt(ms), codec: this.codec, frames: this.frames, skippedMs: this.skippedTotal, audio: this.spokenSamples > 0, audioCodec: this.audioEncoder ? this.audioCodec : null, spokenMs: Math.round((this.spokenSamples / SAMPLE_RATE) * 1000) };
  }

  discard() {
    this.closed = true;
    this.#close();
  }

  #close() {
    this.closed = true;
    try {
      if (this.encoder?.state !== 'closed') this.encoder?.close();
    } catch {}
    try {
      if (this.audioEncoder && this.audioEncoder.state !== 'closed') this.audioEncoder.close();
    } catch {}
    this.pendingSpeech = null;
    this.bitmap?.close();
    this.bitmap = null;
  }
}
