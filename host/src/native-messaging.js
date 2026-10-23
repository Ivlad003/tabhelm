// Chrome Native Messaging framing: each message is a 4-byte little-endian
// length followed by UTF-8 JSON. stdout is reserved for these frames, so
// nothing else in the host may write to it.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_TO_CHROME = 1024 * 1024; // Chrome rejects host->extension frames above 1 MB

export function createNativeChannel({ input = process.stdin, output = process.stdout, onMessage, onClose }) {
  let buffer = Buffer.alloc(0);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    onClose?.();
  };
  // Chrome closes the pipe when the extension disconnects; late writes must not crash the host.
  output.on('error', close);

  input.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const len = buffer.readUInt32LE(0);
      if (buffer.length < 4 + len) break;
      const body = buffer.subarray(4, 4 + len).toString('utf8');
      buffer = buffer.subarray(4 + len);
      try {
        onMessage(JSON.parse(body));
      } catch (err) {
        process.stderr.write(`[native] bad message: ${err.message}\n`);
      }
    }
  });
  input.on('end', close);
  input.on('close', close);

  function send(message) {
    if (closed) return;
    let json = JSON.stringify(message);
    if (Buffer.byteLength(json) > MAX_TO_CHROME) {
      json = JSON.stringify({
        type: 'error',
        tabId: message.tabId,
        message: `Message of type "${message.type}" exceeded the 1 MB native messaging limit and was dropped.`,
      });
    }
    const body = Buffer.from(json, 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    output.write(Buffer.concat([header, body]));
  }

  return { send };
}

// Relay channel: the same JSON messages, but over an outbound WebSocket to a
// TabHelm relay (relay/server.js) instead of Chrome's stdio pipe. Reconnects
// on its own; the pairing token is kept in ~/.tabhelm/relay.json.
export function createRelayChannel({ url, key, name, tokenFile, onMessage, onClientGone, log = () => {} }) {
  let ws = null;
  let closed = false;
  let backoff = 1000;
  let clientOnline = false;
  const readToken = () => {
    try {
      const saved = JSON.parse(readFileSync(tokenFile, 'utf8'));
      return saved.url === url ? saved.token || '' : '';
    } catch {
      return '';
    }
  };

  async function connect() {
    if (closed) return;
    const { default: WebSocket } = await import('ws');
    const target = new URL(url);
    target.pathname = `${target.pathname.replace(/\/$/, '')}/host`;
    target.searchParams.set('key', key);
    if (name) target.searchParams.set('name', name);
    const token = readToken();
    if (token) target.searchParams.set('token', token);
    ws = new WebSocket(target.href, { maxPayload: 2 * 1024 * 1024 });
    ws.on('open', () => {
      backoff = 1000;
      log(`relay: connected to ${url}`);
    });
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'relay') return control(msg);
      onMessage(msg);
    });
    ws.on('close', (code, reason) => {
      ws = null;
      if (clientOnline) {
        clientOnline = false;
        onClientGone?.();
      }
      if (closed) return;
      const why = reason?.toString() || '';
      if (code === 4401) {
        process.stderr.write(`TabHelm relay rejected the key (${why}). Check --key / RELAY_KEY.\n`);
        return process.exit(1);
      }
      log(`relay: disconnected (${code} ${why}); retrying in ${backoff / 1000}s`);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    });
    ws.on('error', (err) => log(`relay: ${err.message}`));
  }

  function control(msg) {
    if (msg.role === 'host') {
      if (msg.token) {
        mkdirSync(dirname(tokenFile), { recursive: true });
        writeFileSync(tokenFile, `${JSON.stringify({ token: msg.token, url, saved: new Date().toISOString() })}\n`);
      }
      if (msg.code) {
        const banner = `\nTabHelm relay pairing code:  ${msg.code}\n(valid 10 minutes — enter it in the panel: Settings → Remote host, relay ${url})\n\n`;
        process.stderr.write(banner);
        log('relay: pairing code issued (valid 10 minutes)'); // the code itself stays on the terminal only
      } else if (msg.paired) log('relay: paired, waiting for the panel');
    }
    if (msg.event === 'client_connected') {
      clientOnline = true;
      log('relay: panel connected');
      onMessage({ type: 'list_agents' });
    }
    if (msg.event === 'client_disconnected') {
      clientOnline = false;
      log('relay: panel disconnected');
      onClientGone?.();
    }
  }

  function send(message) {
    if (!ws || ws.readyState !== 1) return;
    let json = JSON.stringify(message);
    if (Buffer.byteLength(json) > MAX_TO_CHROME) {
      json = JSON.stringify({ type: 'error', tabId: message.tabId, message: `Message of type "${message.type}" exceeded the 1 MB limit and was dropped.` });
    }
    ws.send(json);
  }

  connect();
  return { send, close: () => ((closed = true), ws?.close()) };
}
