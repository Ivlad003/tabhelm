import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Skills are SKILL.md files (YAML front matter with name + description, then
// instructions) loaded straight from a URL — nothing is installed. Agents see
// the names and descriptions up front and read a skill's body (and its other
// files) on demand through the skill_* tools.

const CACHE_DIR = join(homedir(), '.tabhelm', 'skills-cache');
const CACHE_MS = 60 * 60 * 1000;
const MAX_BYTES = 200_000;

// Turns the URLs people paste into candidate raw SKILL.md URLs.
export function skillCandidates(input) {
  const url = new URL(String(input).trim());
  if (url.hostname === 'github.com') {
    const [owner, repo, kind, ref, ...rest] = url.pathname.replace(/^\/|\/$/g, '').split('/');
    if (!owner || !repo) throw new Error('Not a GitHub repository URL');
    const raw = (r, p) => `https://raw.githubusercontent.com/${owner}/${repo}/${r}/${p}`;
    if (kind === 'blob' && ref) return [raw(ref, rest.join('/'))];
    if (kind === 'tree' && ref) return [raw(ref, [...rest, 'SKILL.md'].join('/'))];
    if (!kind) return [raw('HEAD', 'SKILL.md')];
    throw new Error('Use a link to a SKILL.md file or to a skill folder on GitHub');
  }
  if (url.hostname === 'gist.github.com') return [`https://gist.githubusercontent.com${url.pathname.replace(/\/$/, '')}/raw`];
  if (/\.(md|markdown|txt)$/i.test(url.pathname)) return [url.href];
  return [url.href.replace(/\/$/, '') + '/SKILL.md', url.href];
}

export function parseSkill(text, fallbackName) {
  let name = null;
  let description = null;
  let body = text;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (fm) {
    body = text.slice(fm[0].length);
    const lines = fm[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = /^(name|description):\s*(.*)$/.exec(lines[i]);
      if (!m) continue;
      let value = m[2].trim();
      // Folded/literal block scalars and indented continuation lines.
      if (/^[>|][-+]?$/.test(value) || value === '') {
        const parts = [];
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
        value = parts.join(' ');
      }
      value = value.replace(/^(['"])(.*)\1$/, '$2');
      if (m[1] === 'name') name = value;
      else description = value;
    }
  }
  if (!name) name = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || fallbackName;
  if (!description) description = body.replace(/^#.*$/gm, '').trim().split(/\n\s*\n/)[0]?.slice(0, 300) || '';
  return { name: slug(name), title: name, description, body: body.trim() };
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'skill';

async function fetchText(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { accept: 'text/plain, text/markdown, */*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  const text = await res.text();
  if (/text\/html/.test(type) || /^\s*<(!doctype|html)/i.test(text)) throw new Error('got a web page, not a SKILL.md file');
  if (text.length > MAX_BYTES) throw new Error('file is larger than 200 KB');
  return text;
}

function cachePath(url) {
  return join(CACHE_DIR, `${createHash('sha256').update(url).digest('hex').slice(0, 24)}.json`);
}

// Loads a skill from its URL, using a 1-hour disk cache and falling back to the
// cached copy when offline.
export async function loadSkill(input, { force = false } = {}) {
  const file = cachePath(input);
  const cached = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  if (cached && !force && Date.now() - cached.fetched < CACHE_MS) return cached.skill;

  let lastError;
  for (const candidate of skillCandidates(input)) {
    try {
      const text = await fetchText(candidate);
      const fallback = decodeURIComponent(new URL(candidate).pathname.split('/').filter((p) => p && !/^skill\.md$/i.test(p)).pop() || 'skill');
      const skill = { ...parseSkill(text, fallback.replace(/\.(md|markdown|txt)$/i, '')), url: input, source: candidate, base: candidate.replace(/[^/]*$/, '') };
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(file, JSON.stringify({ fetched: Date.now(), skill }));
      return skill;
    } catch (err) {
      lastError = err;
    }
  }
  if (cached) return cached.skill;
  throw new Error(`Cannot load skill from ${input}: ${lastError?.message}`);
}

// Another file of a skill (references, scripts), relative to its SKILL.md.
export async function loadSkillFile(skill, path) {
  if (/^[a-z]+:/i.test(path) || path.startsWith('/') || path.split('/').includes('..')) throw new Error('Use a path relative to the skill folder');
  if (skill.inline) throw new Error('This skill was written in the panel and has no extra files.');
  // Project skills live on disk; the rest are fetched relative to their SKILL.md URL.
  if (skill.local) return readFileSync(joinPath(skill.base, path), 'utf8');
  return fetchText(new URL(path, skill.base).href);
}

// Executes skill_* tool calls for one session's skills.
export async function runSkillTool(skills, tool, args) {
  const text = (t) => [{ type: 'text', text: t }];
  const find = (name) => {
    const skill = skills.find((s) => s.name === slug(name || ''));
    if (!skill) throw new Error(`No skill named "${name}". Available: ${skills.map((s) => s.name).join(', ') || 'none'}`);
    return skill;
  };
  switch (tool) {
    case 'skill_list':
      return text(skills.length ? skills.map((s) => `- ${s.name}: ${s.description}`).join('\n') : 'No skills are enabled. The user can add them in TabHelm → Settings.');
    case 'skill_read': {
      const s = find(args.name);
      return text(`# Skill: ${s.title}\nSource: ${s.url}\n\n${s.body}`);
    }
    case 'skill_read_file': {
      const s = find(args.name);
      return text(await loadSkillFile(s, String(args.path || '')));
    }
    default:
      throw new Error(`Unknown skill tool ${tool}`);
  }
}

export function skillsPreamble(skills) {
  if (!skills.length) return '';
  return `Skills enabled by the user in TabHelm (instructions that improve your work). They are not installed locally, so built-in skill loaders cannot find them: read one with the skill_read tool of the tabhelm-browser MCP server, then follow it. Do this first whenever a task matches a skill:\n${skills
    .map((s) => `- ${s.name}: ${s.description}`)
    .join('\n')}\n\n`;
}

// A GitHub repository (or a folder in one) that holds many skills: every
// SKILL.md under it becomes a candidate the user can pick in the panel.
const MAX_COLLECTION = 150;
export async function listSkillCollection(input) {
  const url = new URL(String(input).trim());
  if (url.hostname !== 'github.com') return null;
  const [owner, repo, kind, refIn, ...rest] = url.pathname.replace(/^\/|\/$/g, '').split('/');
  if (!owner || !repo || (kind && kind !== 'tree')) return null;
  const api = async (path) => {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'tabhelm' } });
    if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}${res.status === 403 ? ' (rate limit — try again later)' : ''}`);
    return res.json();
  };
  const ref = refIn || (await api('')).default_branch;
  const prefix = rest.length ? `${rest.join('/')}/` : '';
  const tree = (await api(`/git/trees/${encodeURIComponent(ref)}?recursive=1`)).tree || [];
  const files = tree.filter((e) => e.type === 'blob' && /(^|\/)SKILL\.md$/.test(e.path) && e.path.startsWith(prefix)).slice(0, MAX_COLLECTION);
  if (!files.length) return null;
  const items = files.map((e) => {
    const dir = e.path.replace(/\/?SKILL\.md$/, '');
    return { url: `https://github.com/${owner}/${repo}/tree/${ref}/${dir}`, path: dir, name: slug(dir.split('/').pop() || repo), title: dir.split('/').pop() || repo, description: '' };
  });
  // Descriptions come from each SKILL.md (a few at a time); a failure just leaves it blank.
  let i = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (i < items.length) {
        const item = items[i++];
        try {
          const text = await fetchText(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${item.path ? `${item.path}/` : ''}SKILL.md`);
          const parsed = parseSkill(text, item.title);
          Object.assign(item, { name: parsed.name, title: parsed.title, description: parsed.description });
        } catch {}
      }
    }),
  );
  return { ref, items };
}
