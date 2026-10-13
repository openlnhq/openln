import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync('artifacts/web/manifest.webmanifest', 'utf8'));
const index = fs.readFileSync('artifacts/web/index.html', 'utf8');
const head = index.slice(0, index.indexOf('</head>'));
const sw = fs.readFileSync('artifacts/web/sw.js', 'utf8');

test('manifest meets the Chromium install criteria', () => {
  assert.equal(manifest.display, 'standalone', 'display must resolve to a non-browser mode or browsers offer no install');
  assert.equal(manifest.start_url, '/app');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.id, '/app');
  assert.notEqual(manifest.prefer_related_applications, true);
  assert.ok(manifest.name && manifest.short_name, 'name and short name are required');
  const sizes = manifest.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'), '192px and 512px icons are required');
  assert.ok(manifest.icons.some((i) => String(i.purpose || '').includes('maskable')), 'a maskable icon is required on Android');
  for (const i of manifest.icons) assert.ok(fs.existsSync('artifacts/web' + i.src), i.src);
});

test('app head carries the install metadata for Android and iOS', () => {
  for (const s of [
    '<link rel="manifest" href="/manifest.webmanifest">',
    '<meta name="theme-color" content="#050e0e">',
    '<meta name="mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-title" content="openLN">',
  ]) assert.ok(head.includes(s), s);
});

test('app registers the worker and wires the install surfaces', () => {
  assert.ok(index.includes("navigator.serviceWorker.register('/sw.js')"), 'service worker registration');
  assert.ok(index.includes('beforeinstallprompt'), 'install prompt capture');
  assert.ok(index.includes('id="setInstallRow"'), 'settings install row');
  assert.ok(index.includes('function paintInstallRow('), 'install row painter');
});

test('service worker is a network pass-through with an offline fallback', () => {
  assert.ok(sw.includes("addEventListener('fetch'"), 'fetch handler (also what beforeinstallprompt heuristics look for)');
  assert.ok(sw.includes("'/offline.html'"), 'offline fallback is precached');
  assert.ok(!sw.includes('caches.put'), 'the worker must never cache app or API responses');
  assert.ok(fs.existsSync('artifacts/web/offline.html'), 'offline.html exists');
});
