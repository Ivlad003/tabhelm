#!/usr/bin/env node
// Writes the news feed the side panel reads: site/news.json plus the latest
// release. Run by the Pages workflow.
// Usage: node scripts/news.js <out.json>
//   TABHELM_LATEST_TAG, TABHELM_LATEST_URL, TABHELM_LATEST_DATE describe the latest
//   GitHub release; without them the version in extension/manifest.json is used.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || join(root, 'site/news.json');
const feed = JSON.parse(readFileSync(join(root, 'site/news.json'), 'utf8'));

const tag = process.env.TABHELM_LATEST_TAG;
const version = tag ? tag.replace(/^v/, '') : JSON.parse(readFileSync(join(root, 'extension/manifest.json'), 'utf8')).version;
feed.latest = {
  version,
  url: process.env.TABHELM_LATEST_URL || `https://github.com/Ivlad003/tabhelm/releases/tag/v${version}`,
  date: process.env.TABHELM_LATEST_DATE || new Date().toISOString().slice(0, 10),
  install: 'curl -fsSL https://ivlad003.github.io/tabhelm/install.sh | bash',
};
feed.generated = new Date().toISOString();

writeFileSync(out, `${JSON.stringify(feed, null, 2)}\n`);
console.log(`news feed → ${out} (latest ${version}, ${feed.news.length} news)`);
