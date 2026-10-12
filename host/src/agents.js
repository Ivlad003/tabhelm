import { accessSync, constants } from 'node:fs';
import { delimiter, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const hostRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const localBin = (name) => join(hostRoot, 'node_modules', '.bin', name);

// Every agent is launched as an ACP server over stdio. `requires` is the
// binary that must be on PATH for the agent to be offered in the side panel.
export const AGENTS = [
  {
    id: 'claude',
    name: 'Claude Code',
    requires: 'claude',
    command: localBin('claude-agent-acp'),
    args: [],
  },
  {
    id: 'codex',
    name: 'Codex',
    requires: 'codex',
    command: localBin('codex-acp'),
    args: [],
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    requires: 'gemini',
    command: 'gemini',
    args: ['--acp'],
  },
  {
    id: 'cursor',
    name: 'Cursor Agent',
    requires: 'cursor-agent',
    command: 'cursor-agent',
    args: ['acp'],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    requires: 'opencode',
    command: 'opencode',
    args: ['acp'],
  },
  {
    id: 'grok',
    name: 'Grok (experimental)',
    requires: 'grok',
    command: 'grok',
    args: ['agent', 'stdio'],
  },
];

function onPath(binary) {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, binary), constants.X_OK);
      return true;
    } catch {}
  }
  return false;
}

export function availableAgents() {
  return AGENTS.filter((a) => onPath(a.requires)).map(({ id, name }) => ({ id, name }));
}

export function getAgent(id) {
  return AGENTS.find((a) => a.id === id);
}
