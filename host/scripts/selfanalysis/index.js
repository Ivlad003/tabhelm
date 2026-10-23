// Entry point for `node --test host/scripts/selfanalysis/`. Node 22+ treats a
// directory argument to --test as a module path, not as a folder to search,
// and resolves it to this file; it loads every *.test.js here so the short
// command runs the whole suite. The glob form also works and skips this file:
//   node --test 'host/scripts/selfanalysis/*.test.js'

import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

for (const name of readdirSync(here).filter((f) => f.endsWith('.test.js')).sort()) {
  await import(pathToFileURL(`${here}/${name}`).href);
}
