#!/usr/bin/env node
// Entry point launched by Chrome through Native Messaging (see install.js).
// Extension <-> host protocol (JSON messages):
//   ext -> host: list_agents | start {tabId, agentId} | prompt {tabId, text}
//                cancel {tabId} | stop {tabId} | permission_response {tabId, id, optionId}
//                set_auto_approve {tabId, value} | set_config {tabId, configId, value} | authenticate {tabId, methodId}
//                tool_result {id, ok, content|error}
//                save_recording {tabId, id, filename, seq, last, data(base64)}
//                set_skills {tabId, skills} | skill_preview {tabId, requestId, url} | delete_recording {tabId, id, path}
//                pick_folder {tabId, requestId} | folder_info {tabId, requestId, path}   (start may carry folder)
//   host -> ext: agents {agents} | status {tabId, state} | update {tabId, update} | config {tabId, options}
//                auth {tabId, agent, methods} | recording_saved {tabId, id, path}
//                skill_info {tabId, requestId, name, description | error}
//                permission {tabId, id, ...} | done {tabId} | error {tabId, message}
//                tool_call {id, tabId, tool, args}

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createNativeChannel } from './native-messaging.js';
import { listAgents, getAgent } from './agents.js';
import { loadEnvFile } from './env.js';
import { loadSkill, runSkillTool } from './skills.js';
import { folderInfo, pickFolder, projectInstructions, projectSkills } from './folders.js';
import { reviewAction } from './critic.js';
import { providerReady } from './llm.js';
import { loadMemory, addNote, deleteNote, clearMemory, runMemoryTool } from './memory.js';
import { onePasswordAvailable, onePasswordItems, onePasswordCredential } from './passwords.js';
import { parseSkill } from './skills.js';
import { startToolServer } from './tool-server.js';
import { AgentSession } from './session.js';

// API keys and endpoints from ~/.tabhelm/env reach every agent the host starts.
loadEnvFile();

const home = join(homedir(), '.tabhelm');
const workspace = join(home, 'workspace');
mkdirSync(workspace, { recursive: true });
const logFile = join(home, 'host.log');
// Videos go to ~/Videos/TabHelm when ~/Videos exists, else ~/.tabhelm/recordings
// (TABHELM_RECORDINGS_DIR overrides, e.g. in tests).
const recordingsDir =
  process.env.TABHELM_RECORDINGS_DIR ||
  (existsSync(join(homedir(), 'Videos')) ? join(homedir(), 'Videos', 'TabHelm') : join(home, 'recordings'));

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
  runTool: async (tabId, tool, args) => {
    // memory_* tools are answered here when Memory is on.
    if (tool.startsWith('memory_')) {
      const session = sessions.get(tabId);
      let result;
      if (!session?.features?.memory) result = { ok: false, error: 'Memory is off. The user can enable it in Settings → Experimental → Memory.' };
      else {
        try {
          result = { ok: true, content: runMemoryTool(tool, args, session.pageUrl) };
        } catch (err) {
          result = { ok: false, error: err.message };
        }
      }
      send({ type: 'tool_activity', tabId, tool, args, label: args.text || args.query, ok: result.ok, error: result.error });
      return result;
    }
    // skill_* tools are answered here; everything else runs in the extension.
    if (tool.startsWith('skill_')) {
      const skills = sessions.get(tabId)?.skills || [];
      let result;
      try {
        result = { ok: true, content: await runSkillTool(skills, tool, args) };
      } catch (err) {
        result = { ok: false, error: err.message };
      }
      send({ type: 'tool_activity', tabId, tool, args, label: args.name, ok: result.ok, error: result.error });
      return result;
    }
    return new Promise((resolve) => {
      const id = nextToolId++;
      pendingTools.set(id, resolve);
      send({ type: 'tool_call', id, tabId, tool, args });
    });
  },
});
log(`host started, tool server ${toolServer.url}`);
const hostVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
send({ type: 'agents', agents: listAgents(), hostVersion });

async function handleMessage(msg) {
  const { tabId } = msg;
  try {
    switch (msg.type) {
      case 'list_agents':
        send({ type: 'agents', agents: listAgents(), hostVersion });
        break;

      case 'start': {
        await stopSession(tabId);
        const agent = getAgent(msg.agentId);
        if (!agent) throw new Error(`Unknown agent ${msg.agentId}`);
        send({ type: 'status', tabId, state: 'starting', agent: { id: agent.id, name: agent.name } });
        const session = new AgentSession({ tabId, agent, toolServer, workspace, send, log });
        session.autoApprove = Boolean(msg.autoApprove);
        if (msg.folder) {
          session.folder = folderInfo(msg.folder).path;
          session.instructions = projectInstructions(session.folder);
        }
        session.features = msg.features || {};
        session.featureSettings = msg.featureSettings || {};
        session.pageUrl = msg.pageUrl || null;
        session.skills = await loadSkills(tabId, msg.skills, session.folder, msg.inlineSkills);
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
        session.prompt(msg.text, msg.context, msg.attachments).catch((err) => send({ type: 'error', tabId, message: err.message || String(err) }));
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

      case 'set_skills': {
        const session = sessions.get(tabId);
        if (session) session.setSkills(await loadSkills(tabId, msg.skills, session.folder, msg.inlineSkills));
        break;
      }

      case 'set_features': {
        const session = sessions.get(tabId);
        if (session) {
          session.features = msg.features || {};
          session.featureSettings = msg.featureSettings || {};
        }
        break;
      }

      case 'page_url': {
        const session = sessions.get(tabId);
        if (session) session.pageUrl = msg.url;
        break;
      }

      // Action critic (extension asks before running a page-changing tool).
      case 'critic': {
        const s = msg.settings || {};
        const verdict = await reviewAction({ provider: s.provider || 'openrouter', model: s.model, ...msg.action });
        send({ type: 'critic_result', tabId, requestId: msg.requestId, ...verdict });
        break;
      }

      case 'critic_status':
        send({ type: 'critic_status', tabId, ready: providerReady(msg.provider || 'openrouter') });
        break;

      // Memory view in Settings.
      case 'memory_list':
        send({ type: 'memory_notes', tabId, notes: loadMemory() });
        break;
      case 'memory_add':
        addNote({ text: msg.text, site: msg.site || null, source: 'user' });
        send({ type: 'memory_notes', tabId, notes: loadMemory() });
        break;
      case 'memory_delete':
        deleteNote(msg.id);
        send({ type: 'memory_notes', tabId, notes: loadMemory() });
        break;
      case 'memory_clear':
        clearMemory();
        send({ type: 'memory_notes', tabId, notes: [] });
        break;

      // Password manager hand-off (1Password CLI). Passwords go only to the extension.
      case 'password_status':
        send({ type: 'password_status', tabId, onePassword: await onePasswordAvailable() });
        break;
      case 'password_items': {
        try {
          send({ type: 'password_items', tabId, requestId: msg.requestId, items: await onePasswordItems(msg.url) });
        } catch (err) {
          send({ type: 'password_items', tabId, requestId: msg.requestId, error: /not signed in|session/i.test(err.message) ? 'Run "op signin" in a terminal first.' : err.message });
        }
        break;
      }
      case 'password_credential': {
        try {
          send({ type: 'password_credential', tabId, requestId: msg.requestId, ...(await onePasswordCredential(msg.id)) });
        } catch (err) {
          send({ type: 'password_credential', tabId, requestId: msg.requestId, error: err.message });
        }
        break;
      }

      // Working folder: native picker and a summary of what the project contains.
      case 'pick_folder': {
        try {
          const path = await pickFolder();
          send({ type: 'folder_info', tabId, requestId: msg.requestId, ...(path ? folderInfo(path) : { cancelled: true }) });
        } catch (err) {
          send({ type: 'folder_info', tabId, requestId: msg.requestId, error: err.message });
        }
        break;
      }

      case 'folder_info': {
        try {
          send({ type: 'folder_info', tabId, requestId: msg.requestId, ...folderInfo(msg.path) });
        } catch (err) {
          send({ type: 'folder_info', tabId, requestId: msg.requestId, error: err.message });
        }
        break;
      }

      // Settings panel: fetch a skill to show its name/description before saving it.
      case 'skill_preview': {
        try {
          const s = await loadSkill(msg.url, { force: true });
          send({ type: 'skill_info', tabId, requestId: msg.requestId, url: msg.url, name: s.name, title: s.title, description: s.description });
        } catch (err) {
          send({ type: 'skill_info', tabId, requestId: msg.requestId, url: msg.url, error: err.message });
        }
        break;
      }

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

      case 'save_recording':
        saveRecordingChunk(msg);
        break;

      // Only files inside the recordings folder can be deleted this way.
      case 'delete_recording': {
        const path = resolve(String(msg.path || ''));
        if (dirname(path) !== resolve(recordingsDir) || !/\.(webm|mp4)$/.test(path)) throw new Error('Not a TabHelm recording');
        rmSync(path, { force: true });
        log(`recording deleted: ${path}`);
        send({ type: 'recording_deleted', tabId, id: msg.id, path });
        break;
      }

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

// Recordings arrive in chunks: Chrome -> host messages may be large, but a
// long video can still exceed the 64 MB per-message limit.
function saveRecordingChunk({ tabId, id, filename, seq, last, data }) {
  const safeName = /^[\w.-]{1,100}\.(webm|mp4)$/.test(filename || '') ? filename : `tabhelm-${Date.now()}.webm`;
  mkdirSync(recordingsDir, { recursive: true });
  const partial = join(recordingsDir, `.${id}.part`);
  if (seq === 0) rmSync(partial, { force: true });
  appendFileSync(partial, Buffer.from(data, 'base64'));
  if (!last) return;
  const path = join(recordingsDir, safeName);
  renameSync(partial, path);
  log(`recording saved: ${path}`);
  send({ type: 'recording_saved', tabId, id, path });
}

// Loads the enabled skills (plus the working folder's own skills and skills
// written in the panel); failures are reported in the chat, not fatal.
async function loadSkills(tabId, urls = [], folder = null, inline = []) {
  const loaded = await Promise.all(
    urls.map((url) =>
      loadSkill(url).catch((err) => {
        send({ type: 'error', tabId, message: err.message });
        return null;
      }),
    ),
  );
  const skills = loaded.filter(Boolean);
  for (const s of folder ? projectSkills(folder) : []) if (!skills.some((x) => x.name === s.name)) skills.push(s);
  for (const s of inline || []) {
    const parsed = parseSkill(`---\nname: ${s.name}\ndescription: ${s.description}\n---\n${s.body}`, s.name);
    if (!skills.some((x) => x.name === parsed.name)) skills.push({ ...parsed, url: 'panel', source: 'panel', base: null, inline: true });
  }
  return skills;
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
