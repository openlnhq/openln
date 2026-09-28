import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync('artifacts/web/landing.html', 'utf8');
const head = html.slice(0, html.indexOf('</head>'));
// From an opening marker to the first </section> after it.
const section = (marker) => { const i = html.indexOf(marker); assert.ok(i >= 0, `missing ${marker}`); return html.slice(i, html.indexOf('</section>', i)); };
const between = (s, a, b) => { const i = s.indexOf(a); assert.ok(i >= 0, `missing ${a}`); return s.slice(i, s.indexOf(b, i)); };
const text = (s) => s.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

test('no third-party font origin; fonts are self-hosted', () => {
  assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
  assert.match(html, /@font-face\{font-family:'Archivo'[^}]*url\(\/media\/fonts\/archivo-latin\.woff2\)/);
  assert.match(head, /<link rel="preload" href="\/media\/fonts\/archivo-latin\.woff2" as="font" type="font\/woff2" crossorigin>/);
});
test('brand icons: tab icon on landing and app, installable icons in the manifest', () => {
  const app = fs.readFileSync('artifacts/web/index.html', 'utf8');
  for (const s of ['<link rel="icon" href="/media/brand/favicon.svg" type="image/svg+xml">', '<link rel="icon" href="/media/brand/favicon-32.png" sizes="32x32" type="image/png">', '<link rel="apple-touch-icon" href="/media/brand/apple-touch-icon.png">']) {
    assert.ok(head.includes(s), `landing: ${s}`);
    assert.ok(app.includes(s), `app: ${s}`);
  }
  const m = JSON.parse(fs.readFileSync('artifacts/web/manifest.webmanifest', 'utf8'));
  assert.deepEqual(m.icons.map((i) => i.sizes), ['192x192', '512x512', '512x512']);
  for (const f of ['favicon.svg', 'favicon-32.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png']) assert.ok(fs.existsSync(`artifacts/web/media/brand/${f}`), f);
});
test('head carries share and search metadata', () => {
  for (const s of ['<link rel="canonical" href="https://openln.com/">', '<meta name="theme-color" content="#050e0e">', '<meta property="og:type" content="website">', '<meta property="og:url" content="https://openln.com/">', '<meta property="og:image" content="https://openln.com/media/og-card.jpg">', '<meta property="og:image:width" content="1200">', '<meta property="og:image:height" content="630">', '<meta name="twitter:card" content="summary_large_image">', '<meta name="twitter:site" content="@Open_LN">']) assert.ok(head.includes(s), s);
  const ld = JSON.parse(head.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  const product = ld['@graph'].find((n) => n['@type'] === 'Product');
  assert.ok(ld['@graph'].some((n) => n['@type'] === 'Organization'));
  assert.equal(product.offers.price, '49'); assert.equal(product.offers.priceCurrency, 'USD');
  assert.equal(product.offers.url, 'https://cards.openln.com/shop/ric');
  assert.ok(fs.existsSync('artifacts/web/media/og-card.jpg'));
});
test('FAQ answers what a shop owner asks, in plain words', () => {
  const faq = section('<section class="faq" id="faq"');
  assert.ok((faq.match(/<details>/g) || []).length >= 7, 'at least 7 questions');
  for (const q of ['What do I need to start?', 'Who holds the money?', 'What does it cost?', 'How do customers pay?']) assert.ok(faq.includes(`<summary>${q}</summary>`), q);
  assert.match(html, /<a href="#faq">FAQ<\/a><\/nav>/);
});
