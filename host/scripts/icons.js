#!/usr/bin/env node
// Renders site/logo.svg into the PNG icons Chrome needs (extension/icons/*.png).
// Usage: node scripts/icons.js   (CHROME_PATH overrides the browser)
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const svg = readFileSync(`${root}site/logo.svg`, 'utf8');
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewport({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`);
  await page.screenshot({ path: `${root}extension/icons/icon${size}.png`, omitBackground: true });
  console.log(`extension/icons/icon${size}.png`);
}
await browser.close();
