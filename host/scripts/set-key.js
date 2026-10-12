#!/usr/bin/env node
// Stores an API key in ~/.tabhelm/env (mode 600) without echoing it.
// Usage: npm run set-key -- openrouter      (or any VARIABLE_NAME)

import { createInterface } from 'node:readline';
import { ENV_FILE, setEnvVar } from '../src/env.js';

const NAMES = { openrouter: 'OPENROUTER_API_KEY', openai: 'TABHELM_OPENAI_API_KEY' };
const arg = process.argv[2];
if (!arg) {
  console.error(`Usage: npm run set-key -- <${Object.keys(NAMES).join('|')}|VARIABLE_NAME>`);
  process.exit(1);
}
const variable = NAMES[arg.toLowerCase()] || arg;
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
  console.error(`Not a valid variable name: ${variable}`);
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
process.stdout.write(`${variable}: `);
// Hide what is typed.
rl._writeToOutput = () => {};
rl.question('', (value) => {
  rl.close();
  process.stdout.write('\n');
  value = value.trim();
  if (!value) {
    console.error('Nothing entered; unchanged.');
    process.exit(1);
  }
  setEnvVar(variable, value);
  console.log(`✓ Saved ${variable} to ${ENV_FILE}. Press Connect in the TabHelm panel again.`);
});
