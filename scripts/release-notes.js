#!/usr/bin/env node
// Prints the CHANGELOG.md section for a version (used as GitHub release notes).
// Usage: node scripts/release-notes.js 0.9.0
import { readFileSync } from 'node:fs';

const version = (process.argv[2] || '').replace(/^v/, '');
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const start = changelog.indexOf(`## [${version}]`);
if (start < 0) {
  console.error(`CHANGELOG.md has no section for ${version}`);
  process.exit(1);
}
const rest = changelog.slice(start).split('\n').slice(1);
const end = rest.findIndex((l) => l.startsWith('## ') || /^\[[^\]]+\]: /.test(l));
const notes = rest.slice(0, end < 0 ? undefined : end).join('\n').trim();
console.log(`${notes}

**Install or update:** \`curl -fsSL https://ivlad003.github.io/tabhelm/install.sh | bash\`, then press ↻ for TabHelm on \`chrome://extensions\`.
Or download \`tabhelm-extension.zip\` below and load it unpacked. Full history: [CHANGELOG.md](https://github.com/Ivlad003/tabhelm/blob/main/CHANGELOG.md).`);
