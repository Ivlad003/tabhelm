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

import { Muxer, ArrayBufferTarget } from './vendor/mp4-muxer.mjs';

const KEYFRAME_EVERY_US = 2_000_000;
const LABEL_MS = 1500;

export function webCodecsAvailable() {
  return typeof VideoEncoder === 'function' && typeof VideoFrame === 'function' && typeof OffscreenCanvas === 'function';
}

export class Recorder {
  constructor({ trimWaits = false, maxPauseMs = 1500 } = {}) {
    Object.assign(this, { trimWaits, maxPauseMs });
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
    const still = this.trimWaits && (this.#still(bitmap) || fill);
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
    // Even sizes for H.264; the screencast already caps them at 1600×1000.
    this.width = Math.max(2, w & ~1);
    this.height = Math.max(2, h & ~1);
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
    this.muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: chosen.mux, width: this.width, height: this.height }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
    this.encoder = new VideoEncoder({ output: (chunk, meta) => this.muxer.addVideoChunk(chunk, meta), error: (err) => (this.error ||= err) });
    this.encoder.configure({ ...base, codec: chosen.codec, ...(chosen.avc ? { avc: chosen.avc } : {}), latencyMode: 'quality' });
    this.codec = chosen.codec;
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
    this.muxer.finalize();
    const blob = new Blob([this.muxer.target.buffer], { type: 'video/mp4' });
    const durationMs = this.clock;
    this.#close();
    return { blob, durationMs, timeAt: (ms) => this.timeAt(ms), codec: this.codec, frames: this.frames, skippedMs: this.skippedTotal };
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
    this.bitmap?.close();
    this.bitmap = null;
  }
}
