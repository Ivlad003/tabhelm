import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseSkill } from './skills.js';

// A chat can be bound to a project folder: agents start there (so their own
// AGENTS.md / CLAUDE.md / rules / skills loading works) and TabHelm adds the
// project's skills for every agent.

const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.cursor/rules', '.github/copilot-instructions.md', 'GEMINI.md', 'QWEN.md'];
const SKILL_DIRS = ['.claude/skills', '.agents/skills', '.opencode/skills', '.cursor/skills', 'skills'];
const MAX_INSTRUCTIONS = 20_000;

export function expandPath(p) {
  const s = String(p || '').trim();
  return resolve(s === '~' ? homedir() : s.startsWith('~/') ? join(homedir(), s.slice(2)) : s);
}

// Native "choose folder" dialog (zenity / kdialog on Linux, Finder on macOS).
export function pickFolder() {
  const run = (cmd, args) =>
    new Promise((res, rej) =>
      execFile(cmd, args, { timeout: 10 * 60_000 }, (err, stdout) => {
        if (err) return rej(err);
        res(stdout.trim());
      }),
    );
  if (process.platform === 'darwin') {
    return run('osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose a folder for TabHelm")']).catch(cancelledOrMissing);
  }
  return run('zenity', ['--file-selection', '--directory', '--title=Choose a folder for TabHelm'])
    .catch((err) => (err.code === 'ENOENT' ? run('kdialog', ['--getexistingdirectory', homedir(), '--title', 'Choose a folder for TabHelm']) : Promise.reject(err)))
    .catch(cancelledOrMissing);
}

function cancelledOrMissing(err) {
  if (err.code === 'ENOENT') throw new Error('No folder dialog is available here; type the folder path instead.');
  return null; // the user closed the dialog
}

export function folderInfo(input) {
  const path = expandPath(input);
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`Not a folder: ${path}`);
  return {
    path,
    name: path.split('/').filter(Boolean).pop() || path,
    instructions: INSTRUCTION_FILES.filter((f) => existsSync(join(path, f))),
    skills: projectSkills(path).map((s) => s.name),
    git: existsSync(join(path, '.git')),
  };
}

// SKILL.md files inside the project (one level of skill folders per skills dir).
export function projectSkills(root) {
  const found = [];
  for (const dir of SKILL_DIRS) {
    const base = join(root, dir);
    if (!existsSync(base) || !statSync(base).isDirectory()) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(base, entry.name, 'SKILL.md');
      if (!existsSync(file)) continue;
      try {
        const skill = parseSkill(readFileSync(file, 'utf8'), entry.name);
        if (!found.some((s) => s.name === skill.name)) found.push({ ...skill, url: file, source: file, base: join(base, entry.name), local: true });
      } catch {}
    }
  }
  return found;
}

// AGENTS.md (or CLAUDE.md) text, for agents that don't read project files themselves.
export function projectInstructions(root) {
  for (const f of ['AGENTS.md', 'CLAUDE.md']) {
    const file = join(root, f);
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8');
      return { file: f, text: text.length > MAX_INSTRUCTIONS ? `${text.slice(0, MAX_INSTRUCTIONS)}\n…(truncated)` : text };
    }
  }
  return null;
}
