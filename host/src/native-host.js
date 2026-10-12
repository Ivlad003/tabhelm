#!/usr/bin/env node
// Entry point launched by Chrome through Native Messaging (see install.js).
// Extension <-> host protocol (JSON messages):
//   ext -> host: list_agents | start {tabId, agentId} | prompt {tabId, text}
//                cancel {tabId} | stop {tabId} | permission_response {tabId, id, optionId}
//                set_auto_approve {tabId, value} | set_config {tabId, configId, value} | authenticate {tabId, methodId}
//                tool_result {id, ok, content|error}
//   host -> ext: agents {agents} | status {tabId, state} | update {tabId, update} | config {tabId, options}
//                auth {tabId, agent, methods}
//                permission {tabId, id, ...} | done {tabId} | error {tabId, message}
//                tool_call {id, tabId, tool, args}

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createNativeChannel } from './native-messaging.js';
import { listAgents, getAgent } from './agents.js';
import { startToolServer } from './tool-server.js';
import { AgentSession } from './session.js';

const home = join(homedir(), '.tabhelm');
const workspace = join(home, 'workspace');
mkdirSync(workspace, { recursive: true });
const logFile = join(home, 'host.log');

function log(line) {
  appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
}

// stdout carries native messaging frames only; route stray console output to the log.
console.log = console.info = console.warn = console.error = (...args) => log(args.join(' '));
process.on('uncaughtException', (err) => log(`uncaught: ${err.stack || err}`));
process.on('unhandledRejection', (err) => log(`unhandled: ${err?.stack || err}`));

const sessions = new Map(); // tabId -> AgentSession
const pendingTools = new Map(); // id -> resolve
let nextToolId = 1;

const channel = createNativeChannel({ onMessage: handleMessage, onClose: shutdown });
const send = (message) => channel.send(message);

const toolServer = await startToolServer({
  log,
  runTool: (tabId, tool, args) =>
    new Promise((resolve) => {
      const id = nextToolId++;
      pendingTools.set(id, resolve);
      send({ type: 'tool_call', id, tabId, tool, args });
    }),
});
log(`host started, tool server ${toolServer.url}`);
send({ type: 'agents', agents: listAgents() });

async function handleMessage(msg) {
  const { tabId } = msg;
  try {
    switch (msg.type) {
      case 'list_agents':
        send({ type: 'agents', agents: listAgents() });
        break;

      case 'start': {
        await stopSession(tabId);
        const agent = getAgent(msg.agentId);
        if (!agent) throw new Error(`Unknown agent ${msg.agentId}`);
        send({ type: 'status', tabId, state: 'starting', agent: { id: agent.id, name: agent.name } });
        const session = new AgentSession({ tabId, agent, toolServer, workspace, send, log });
        session.autoApprove = Boolean(msg.autoApprove);
        sessions.set(tabId, session);
        try {
          await session.start();
        } catch (err) {
          sessions.delete(tabId);
          await session.dispose();
          throw err;
        }
        break;
      }

      case 'prompt': {
        const session = requireSession(tabId);
        session.prompt(msg.text).catch((err) => send({ type: 'error', tabId, message: err.message || String(err) }));
        break;
      }

      case 'cancel':
        await sessions.get(tabId)?.cancel();
        break;

      case 'stop':
        await stopSession(tabId);
        send({ type: 'status', tabId, state: 'idle' });
        break;

      case 'permission_response':
        sessions.get(tabId)?.resolvePermission(msg.id, msg.optionId);
        break;

      case 'set_auto_approve': {
        const session = sessions.get(tabId);
        if (session) session.autoApprove = Boolean(msg.value);
        break;
      }

      case 'authenticate':
        await requireSession(tabId).authenticate(msg.methodId);
        break;

      case 'set_config':
        await requireSession(tabId).setConfigOption(msg.configId, msg.value);
        break;

      case 'tool_result': {
        const resolve = pendingTools.get(msg.id);
        pendingTools.delete(msg.id);
        resolve?.(msg.ok ? { ok: true, content: msg.content } : { ok: false, error: msg.error });
        break;
      }

      default:
        log(`unknown message type ${msg.type}`);
    }
  } catch (err) {
    log(`error handling ${msg.type}: ${err.stack || err}`);
    send({ type: 'error', tabId, message: err.message || String(err) });
  }
}

function requireSession(tabId) {
  const session = sessions.get(tabId);
  if (!session) throw new Error('No agent is connected for this tab. Pick an agent and press Connect.');
  return session;
}

async function stopSession(tabId) {
  const session = sessions.get(tabId);
  if (!session) return;
  sessions.delete(tabId);
  await session.dispose();
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('extension disconnected, shutting down');
  await Promise.all([...sessions.keys()].map(stopSession));
  toolServer.close();
  setTimeout(() => process.exit(0), 500);
}
