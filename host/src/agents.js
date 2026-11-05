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

// Where the Cursor Agent CLI lives besides PATH. The PATH baked into the host
// wrapper by install-host can predate the CLI install (on Windows the installer
// only adds it to PATH for new processes), and Cursor IDE keeps its own copy.
export function cursorLocations({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  const win = platform === 'win32';
  const configDir =
    platform === 'darwin' ? join(home, 'Library', 'Application Support') : win ? env.APPDATA || join(home, 'AppData', 'Roaming') : env.XDG_CONFIG_HOME || join(home, '.config');
  return {
    // Official installer: ~/.local/bin on macOS/Linux, %LOCALAPPDATA%\cursor-agent on Windows.
    standalone: win ? join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'cursor-agent', 'cursor-agent') : join(home, '.local', 'bin', 'cursor-agent'),
    // Cursor IDE's copy, downloaded for its agent worker.
    ide: join(configDir, 'Cursor', 'User', 'globalStorage', 'anysphere.cursor-agent-worker', 'agent-cli'),
  };
}

// Cursor IDE's copy: a cursor-agent link on macOS/Linux; on Windows the IDE runs
// node.exe with index.js from the newest build, so TabHelm does the same.
export function cursorIdeLaunch(ideDir, platform = process.platform) {
  if (platform !== 'win32') return { command: join(ideDir, '.local', 'bin', 'cursor-agent'), args: ['acp'] };
  const versions = join(ideDir, '.local', 'share', 'cursor-agent', 'versions');
  let builds;
  try {
    builds = readdirSync(versions).filter((d) => !d.startsWith('.')).sort().reverse();
  } catch {
    return null;
  }
  const dir = builds.map((d) => join(versions, d)).find((d) => existsSync(join(d, 'node.exe')) && existsSync(join(d, 'index.js')));
  return dir ? { command: join(dir, 'node.exe'), args: [join(dir, 'index.js'), 'acp'], env: { CURSOR_INVOKED_AS: 'cursor-agent' } } : null;
}

const cursor = cursorLocations();

// Every agent is launched as an ACP server over stdio. `launch` lists
// candidates in priority order; the first whose command exists is used.
// `requires` (optional) must also be on PATH, e.g. the CLI an adapter drives;
// `requiresEnv` (optional) must be set (environment or ~/.tabhelm/env).
export const AGENTS = [
  {
    id: 'claude',
    name: 'Claude Code',
    requires: 'claude',
    // Its MCP client waits for long tool calls (a guide the user takes minutes
    // over); other clients give up after about a minute (see TOOL_WAIT_SEC).
    longToolCalls: true,
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
      { command: cursor.standalone, args: ['acp'] },
      () => cursorIdeLaunch(cursor.ide),
    ],
    installHint:
      process.platform === 'win32'
        ? "Install Cursor CLI (PowerShell): irm 'https://cursor.com/install?win32=true' | iex"
        : 'Install Cursor CLI: curl https://cursor.com/install -fsS | bash',
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
    return { command: path, args: candidate.args, ...(candidate.env && { env: candidate.env }) };
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
  return { id: agent.id, name: agent.name, defaultModel: agent.defaultModel, longToolCalls: Boolean(agent.longToolCalls), builtin: agent.launch.some((l) => l.args?.[0]?.endsWith('builtin-agent.js')), ...launch };
}
