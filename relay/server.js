// TabHelm relay: pairs a TabHelm host running anywhere (a VPS, a dev box behind
// NAT, a container) with the TabHelm extension in your Chrome, over outbound
// WebSockets only. It forwards JSON messages between the two and nothing else.
//
//   host   ──wss /host?key=RELAY_KEY[&token=…]──▶ relay ◀── wss /client?code=XXXX-XXXX | token=… ── extension
//
// Security model (the relay is yours, behind TLS from Dokploy/Traefik):
//   - a host may register only with RELAY_KEY (set in the relay's environment);
//   - a freshly registered host gets a short pairing code (8 chars, 10 minutes,
//     single use); the extension exchanges it for a long random session token;
//   - afterwards both sides reconnect with the token; codes are rate limited.
// Run: RELAY_KEY=... node server.js   (PORT, default 8080)

import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8080);
const KEY = process.env.RELAY_KEY || '';
if (KEY.length < 12) {
  console.error('Set RELAY_KEY (12+ characters) in the environment.');
  process.exit(1);
}
const CODE_TTL = 10 * 60_000;
const MAX_PAYLOAD = 2 * 1024 * 1024;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

const pairs = new Map(); // token -> { host, client, code, codeUntil, name }
const codes = new Map(); // code -> token
const attempts = new Map(); // ip -> { n, until }

const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const newCode = () => {
  const bytes = randomBytes(8);
  const s = [...bytes].map((b) => ALPHABET[b % 32]).join('');
  return `${s.slice(0, 4)}-${s.slice(4)}`;
};
const limited = (ip) => {
  const a = attempts.get(ip) || { n: 0, until: Date.now() + 60_000 };
  if (Date.now() > a.until) Object.assign(a, { n: 0, until: Date.now() + 60_000 });
  a.n++;
  attempts.set(ip, a);
  return a.n > 10;
};

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') return res.writeHead(200, { 'content-type': 'text/plain' }).end(`TabHelm relay: ${pairs.size} host(s)\n`);
  res.writeHead(404).end();
});
const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  if (url.pathname === '/host') return attachHost(ws, url, ip);
  if (url.pathname === '/client') return attachClient(ws, url, ip);
  ws.close(4404, 'unknown path');
});

function attachHost(ws, url, ip) {
  if (!same(url.searchParams.get('key') || '', KEY)) {
    if (limited(ip)) return ws.close(4429, 'too many attempts');
    return ws.close(4401, 'bad key');
  }
  let token = url.searchParams.get('token') || '';
  let pair = token && pairs.get(token);
  if (pair) {
    pair.host?.close(4409, 'replaced by a new host connection');
  } else {
    token = randomBytes(32).toString('base64url');
    pair = { host: null, client: null, code: newCode(), codeUntil: Date.now() + CODE_TTL, name: url.searchParams.get('name') || 'host' };
    pairs.set(token, pair);
    codes.set(pair.code, token);
  }
  pair.host = ws;
  ws.send(JSON.stringify({ type: 'relay', role: 'host', token, code: pair.client ? null : pair.code, paired: Boolean(pair.client) }));
  if (pair.client) pair.client.send(JSON.stringify({ type: 'relay', event: 'host_connected' }));
  console.log(`host connected (${pair.name}) ${pair.client ? 'paired' : `code ${pair.code}`}`);

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    pair.client?.send(data.toString());
  });
  ws.on('close', () => {
    if (pair.host !== ws) return;
    pair.host = null;
    pair.client?.send(JSON.stringify({ type: 'relay', event: 'host_disconnected' }));
    // An unpaired host that goes away takes its code with it.
    if (!pair.client) {
      codes.delete(pair.code);
      pairs.delete(token);
    }
  });
}

function attachClient(ws, url, ip) {
  let token = url.searchParams.get('token') || '';
  let pair = token && pairs.get(token);
  if (!pair) {
    if (limited(ip)) return ws.close(4429, 'too many attempts');
    const code = (url.searchParams.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const t = codes.get(`${code.slice(0, 4)}-${code.slice(4)}`);
    pair = t && pairs.get(t);
    if (!pair || Date.now() > pair.codeUntil) return ws.close(4401, 'unknown or expired code');
    token = t;
    codes.delete(pair.code); // single use
    pair.code = null;
    console.log(`client paired with ${pair.name}`);
  }
  pair.client?.close(4409, 'replaced by a new client connection');
  pair.client = ws;
  ws.send(JSON.stringify({ type: 'relay', role: 'client', token, name: pair.name, hostOnline: Boolean(pair.host) }));
  // The host greets every (re)connected client with its agent list.
  pair.host?.send(JSON.stringify({ type: 'relay', event: 'client_connected' }));

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    if (!pair.host) return ws.send(JSON.stringify({ type: 'error', message: 'The remote TabHelm host is offline.' }));
    pair.host.send(data.toString());
  });
  ws.on('close', () => {
    if (pair.client === ws) {
      pair.client = null;
      pair.host?.send(JSON.stringify({ type: 'relay', event: 'client_disconnected' }));
    }
  });
}

// Drop dead sockets (NAT timeouts) and expired, never-paired hosts.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  }
  for (const [token, pair] of pairs) {
    if (!pair.client && !pair.host) pairs.delete(token);
    if (!pair.client && pair.code && Date.now() > pair.codeUntil) {
      pair.host?.close(4408, 'pairing code expired — restart the host for a new one');
      codes.delete(pair.code);
      pairs.delete(token);
    }
  }
}, 30_000);

server.listen(PORT, () => console.log(`TabHelm relay listening on :${PORT}`));
