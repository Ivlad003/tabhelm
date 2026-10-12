import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

// Loopback HTTP endpoint used by mcp-bridge.js (spawned by the agents) to run
// browser tools. It listens on 127.0.0.1 only and requires a per-run token,
// so other local processes and web pages cannot drive the browser through it.

const TOOL_TIMEOUT_MS = 90_000;

export async function startToolServer({ runTool, log }) {
  const token = randomBytes(24).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);

  const server = http.createServer(async (req, res) => {
    const auth = Buffer.from(req.headers.authorization || '');
    const authorized = auth.length === expected.length && timingSafeEqual(auth, expected);
    if (!authorized || req.method !== 'POST' || req.url !== '/call' || req.headers.origin) {
      res.writeHead(403).end();
      return;
    }

    let body = '';
    for await (const chunk of req) body += chunk;

    let result;
    try {
      const { tabId, tool, args } = JSON.parse(body);
      result = await withTimeout(runTool(tabId, tool, args || {}), TOOL_TIMEOUT_MS, tool);
    } catch (err) {
      log(`tool error: ${err.message}`);
      result = { ok: false, error: err.message };
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/call`, token, close: () => server.close() };
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Tool "${label}" timed out after ${ms / 1000}s`)), ms)),
  ]);
}
