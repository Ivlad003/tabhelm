#!/usr/bin/env node
// Copies design/tokens.css into the extension and the website, or with
// --check fails when a copy is out of date (used by the build).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'design/tokens.css'), 'utf8');
const copies = ['extension/tokens.css', 'site/tokens.css'];
const check = process.argv.includes('--check');

for (const rel of copies) {
  const path = join(root, rel);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (current === source) continue;
  if (check) {
    console.error(`${rel} is out of date with design/tokens.css. Run: npm run design`);
    process.exit(1);
  }
  writeFileSync(path, source);
  console.log(`updated ${rel}`);
}
