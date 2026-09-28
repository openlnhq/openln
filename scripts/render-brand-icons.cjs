#!/usr/bin/env node
// Renders the openLN brand icon set from artifacts/web/media/brand/favicon.svg.
// Run from the repo root:  node scripts/render-brand-icons.cjs
// Writes favicon-32.png, apple-touch-icon.png, icon-192.png, icon-512.png next to the svg.
// Needs the cached Playwright Chromium (override with CHROME=/path/to/chrome).
const { chromium } = require(process.env.PLAYWRIGHT || '/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const fs = require('fs');
const OUT = 'artifacts/web/media/brand';
const MARK = fs.readFileSync(`${OUT}/favicon.svg`, 'utf8').replace('<svg ', '<svg width="100%" height="100%" ');
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome', args: ['--no-sandbox'] });
  const p = await b.newPage();
  for (const j of [{ f: 'favicon-32.png', s: 32, bg: 'transparent', k: 1 }, { f: 'apple-touch-icon.png', s: 180, bg: '#050e0e', k: 0.72 }, { f: 'icon-192.png', s: 192, bg: '#050e0e', k: 0.72 }, { f: 'icon-512.png', s: 512, bg: '#050e0e', k: 0.72 }]) {
    await p.setViewportSize({ width: j.s, height: j.s });
    await p.setContent(`<body style="margin:0;background:${j.bg};width:${j.s}px;height:${j.s}px;display:grid;place-items:center"><div style="width:${Math.round(j.s * j.k)}px;height:${Math.round(j.s * j.k)}px">${MARK}</div></body>`);
    await p.screenshot({ path: `${OUT}/${j.f}`, omitBackground: j.bg === 'transparent' });
    console.log('wrote', j.f);
  }
  await b.close();
})();
