#!/usr/bin/env node
// Renders artifacts/web/media/og-card.jpg (1200x630), the social share card.
// Needs a local http server on 8765 serving artifacts/web, e.g.
//   python3 -m http.server 8765 --bind 127.0.0.1 --directory artifacts/web
// then from the repo root:  node scripts/render-landing-og.cjs
// Reads the vendored woff2 files and the brand mark, so run
// scripts/vendor-landing-fonts.mjs and have favicon.svg in place first.
const { chromium } = require(process.env.PLAYWRIGHT || '/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const fs = require('fs');
const WT = process.env.WT || process.cwd();
const font = (f) => fs.readFileSync(`${WT}/artifacts/web/media/fonts/${f}`).toString('base64');
const MARK = fs.readFileSync(`${WT}/artifacts/web/media/brand/favicon.svg`, 'utf8');
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome', args: ['--no-sandbox'] });
  const lp = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await lp.goto('http://127.0.0.1:8765/landing.html', { waitUntil: 'load' });
  // The demo loop only runs while the device is in view, so bring it into view first.
  await lp.$eval('#ric-dev', (el) => el.scrollIntoView({ block: 'center' }));
  await lp.waitForSelector('.ui.paid.on', { timeout: 20000 }); await lp.waitForTimeout(600);
  const device = (await (await lp.$('.counter')).screenshot()).toString('base64');
  const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
  await p.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:'Archivo';src:url(data:font/woff2;base64,${font('archivo-latin.woff2')}) format('woff2');font-weight:300 900;font-stretch:62% 125%}
@font-face{font-family:'Plex Mono';src:url(data:font/woff2;base64,${font('ibm-plex-mono-500-latin.woff2')}) format('woff2');font-weight:500}
*{margin:0;padding:0;box-sizing:border-box}html,body{width:1200px;height:630px;background:#050e0e;overflow:hidden}
body{position:relative;font-family:'Archivo',sans-serif;color:#eef6f5}
.glow{position:absolute;right:-140px;top:30px;width:860px;height:600px;background:radial-gradient(closest-side,rgba(14,131,136,.30),transparent 72%)}
.copy{position:absolute;left:72px;top:84px;width:540px}
.brand{display:flex;align-items:center;gap:12px;font-weight:600;font-size:32px;letter-spacing:-.02em}
.brand svg{width:40px;height:40px}.brand em{font-style:normal;color:#19a9a4;margin-left:-2px}
h1{margin-top:58px;font-size:84px;line-height:.95;letter-spacing:-.03em;font-weight:700;font-variation-settings:"wdth" 110}
h1 span{display:block;color:#19a9a4}
p{margin-top:30px;font:500 23px/1.4 'Plex Mono',monospace;color:#cfdedb}
.dev{position:absolute;right:36px;top:118px;width:560px}.dev img{display:block;width:100%}
.url{position:absolute;left:72px;bottom:54px;font:500 20px/1 'Plex Mono',monospace;letter-spacing:.16em;text-transform:uppercase;color:#9db4b0}
</style></head><body><div class="glow"></div>
<div class="copy"><div class="brand">${MARK}open<em>LN</em></div><h1>Plug &amp; Play<span>Bitcoin POS.</span></h1><p>Tap or scan. Paid to your own wallet.</p></div>
<div class="dev"><img src="data:image/png;base64,${device}"></div><div class="url">openln.com</div></body></html>`);
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: `${WT}/artifacts/web/media/og-card.jpg`, type: 'jpeg', quality: 88 });
  await b.close(); console.log('wrote og-card.jpg');
})();
