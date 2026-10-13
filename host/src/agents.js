import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const hostRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const localBin = (name) => join(hostRoot, 'node_modules', '.bin', name);
const builtin = (provider) => ({ command: process.execPath, args: [join(hostRoot, 'src', 'builtin-agent.js'), '--provider', provider] });

// Agents installed by `npm run install-agent <id>` live here, each with a
// tabhelm.json that records how to launch it.
export const AGENTS_DIR = join(homedir(), '.tabhelm', 'agents');

function installedManifest(id) {
  const file = join(AGENTS_DIR, id, 'tabhelm.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Launch candidate for an agent installed with install-agent (read at lookup time).
const installed = (id) => () => installedManifest(id);

// Every agent is launched as an ACP server over stdio. `launch` lists
// candidates in priority order; the first whose command exists is used.
// `requires` (optional) must also be on PATH, e.g. the CLI an adapter drives;
// `requiresEnv` (optional) must be set (environment or ~/.tabhelm/env).
export const AGENTS = [
  {
    id: 'claude',
    name: 'Claude Code',
    requires: 'claude',
    launch: [{ command: localBin('claude-agent-acp'), args: [] }],
    installHint: 'Install Claude Code: https://claude.com/claude-code',
  },
  {
    id: 'codex',
    name: 'Codex',
    requires: 'codex',
    launch: [{ command: localBin('codex-acp'), args: [] }],
    installHint: 'Install Codex CLI: npm i -g @openai/codex',
  },
  {
    id: 'antigravity',
    name: 'Google Antigravity',
    // Google's official ACP server (from the ACP registry), not the `agy` TUI.
    launch: [installed('antigravity'), { command: join(AGENTS_DIR, 'antigravity', 'agy_acp_server.par'), args: process.platform === 'linux' ? ['--uid='] : [] }],
    installHint: 'Run: npm run install-agent -- antigravity',
  },
  {
    id: 'cursor',
    name: 'Cursor Agent CLI',
    // The CLI ships as `agent`; older installs also have `cursor-agent`.
    launch: [
      // `agent` is a generic name, so only accept it when it resolves into a Cursor install.
      { command: 'agent', args: ['acp'], pathIncludes: 'cursor' },
      { command: 'cursor-agent', args: ['acp'] },
    ],
    installHint: 'Install Cursor CLI: curl https://cursor.com/install -fsS | bash',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    launch: [{ command: 'opencode', args: ['acp'] }],
    installHint: 'Install OpenCode: curl -fsSL https://opencode.ai/install | bash',
  },
  {
    id: 'qoder',
    name: 'Qoder CLI',
    launch: [
      { command: 'qodercli', args: ['--acp'] },
      installed('qoder'),
      { command: join(AGENTS_DIR, 'qoder', 'node_modules', '.bin', 'qodercli'), args: ['--acp'] },
    ],
    installHint: 'Run: npm run install-agent -- qoder (or curl -fsSL https://qoder.com/install | bash)',
  },
  {
    id: 'kilo',
    name: 'Kilo Code',
    // Free tier: the kilo-auto/free model routes to free models (Kilo account, no card).
    launch: [{ command: 'kilo', args: ['acp'] }, installed('kilo')],
    defaultModel: 'kilo/kilo-auto/free',
    installHint: 'Run: npm run install-agent -- kilo',
  },
  {
    id: 'cline',
    name: 'Cline',
    // Free tier: rotating free models with the Cline provider (sign in, no API key).
    launch: [{ command: 'cline', args: ['--acp'] }, installed('cline')],
    installHint: 'Run: npm run install-agent -- cline',
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy Code',
    // Free tier: 250 credits every two weeks (Tencent CodeBuddy international).
    launch: [{ command: 'codebuddy', args: ['--acp'] }, installed('codebuddy')],
    installHint: 'Run: npm run install-agent -- codebuddy',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter (built-in)',
    // TabHelm's own agent: calls the OpenRouter API directly, incl. free models.
    launch: [builtin('openrouter')],
    installHint: 'Add your key: npm run set-key -- openrouter (https://openrouter.ai/keys)',
  },
  {
    id: 'ollama',
    name: 'Ollama (built-in, local)',
    requires: 'ollama',
    launch: [builtin('ollama')],
    installHint: 'Install Ollama (https://ollama.com) and pull a model, e.g. ollama pull qwen3:30b',
  },
  {
    id: 'openai-compatible',
    name: 'OpenAI-compatible (built-in)',
    requiresEnv: 'TABHELM_OPENAI_BASE_URL',
    launch: [builtin('openai')],
    installHint: 'Set TABHELM_OPENAI_BASE_URL (and TABHELM_OPENAI_API_KEY) in ~/.tabhelm/env',
  },
  {
    id: 'grok',
    name: 'Grok (experimental)',
    launch: [{ command: 'grok', args: ['agent', 'stdio'] }],
    installHint: 'Install Grok CLI from x.ai',
  },
];

function findExecutable(command) {
  // On Windows a bare name may be foo.exe / foo.cmd / foo.bat.
  const exts = process.platform === 'win32' && !/\.[a-z0-9]+$/i.test(command) ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  const names = exts.map((e) => command + e);
  const candidates = isAbsolute(command) ? names : (process.env.PATH || '').split(delimiter).filter(Boolean).flatMap((d) => names.map((n) => join(d, n)));
  for (const path of candidates) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {}
  }
  return null;
}

function resolveLaunch(agent) {
  if (agent.requires && !findExecutable(agent.requires)) return null;
  if (agent.requiresEnv && !process.env[agent.requiresEnv]) return null;
  for (const entry of agent.launch) {
    const candidate = typeof entry === 'function' ? entry() : entry;
    if (!candidate) continue;
    const path = findExecutable(candidate.command);
    if (!path) continue;
    if (candidate.pathIncludes && !realpathSync(path).toLowerCase().includes(candidate.pathIncludes)) continue;
    return { command: path, args: candidate.args };
  }
  return null;
}

// Registry agents installed with install-agent that TabHelm has no entry for.
function extraAgents() {
  if (!existsSync(AGENTS_DIR)) return [];
  const known = new Set(AGENTS.map((a) => a.id));
  return readdirSync(AGENTS_DIR)
    .filter((id) => !known.has(id))
    .map((id) => ({ id, manifest: installedManifest(id) }))
    .filter((x) => x.manifest)
    .map(({ id, manifest }) => ({ id, name: manifest.name || id, launch: [installed(id)], installHint: `Run: npm run install-agent -- ${id}` }));
}

const allAgents = () => [...AGENTS, ...extraAgents()];

// All known agents; the panel shows uninstalled ones disabled with a hint.
export function listAgents() {
  return allAgents().map((a) => ({ id: a.id, name: a.name, installed: Boolean(resolveLaunch(a)), installHint: a.installHint }));
}

export function getAgent(id) {
  const agent = allAgents().find((a) => a.id === id);
  if (!agent) return null;
  const launch = resolveLaunch(agent);
  if (!launch) throw new Error(`${agent.name} is not installed. ${agent.installHint}`);
  return { id: agent.id, name: agent.name, defaultModel: agent.defaultModel, builtin: agent.launch.some((l) => l.args?.[0]?.endsWith('builtin-agent.js')), ...launch };
}
