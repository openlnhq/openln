import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const paymentScenes = ['payment-small', 'payment-14ch', 'payment-large'];
let report;
let buildError;
function runHarness() {
  if (buildError) throw buildError;
  if (report) return report;
  const args = [join(root, 'tests/ric-display/render.py')];
  if (process.env.RIC_DISPLAY_OUT) args.push('--out', process.env.RIC_DISPLAY_OUT);
  if (process.env.RIC_DISPLAY_REVISION) args.push('--revision', process.env.RIC_DISPLAY_REVISION);
  const result = spawnSync('python3', args, {
    cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
  });
  try {
    assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
  } catch (error) {
    buildError = error;
    throw error;
  }
  const output = JSON.parse(result.stdout);
  report = JSON.parse(readFileSync(output.report, 'utf8'));
  return report;
}

test('RIC real PaymentScreen countdown remains live across millis rollover', () => {
  const {rollover} = runHarness();
  assert.deepEqual(rollover.actualSeconds, [60, 60, 60, 59, 56, 55, 5, 1, 1, 0, 0],
    'A new 60-second invoice near UINT32_MAX must not immediately display 0:00');
});

test('RIC real PinScreen processing returns without intentional pre-HTTP delay', () => {
  const {processing} = runHarness();
  assert.equal(processing.blockedMs, 0,
    `drawProcessing blocked ${processing.blockedMs} ms via delay calls ${JSON.stringify(processing.delayCalls)}`);
  assert.deepEqual(processing.delayCalls, []);
});

test('RIC real PaymentScreen QR has a complete four-module white quiet zone including corners', () => {
  const {scenes} = runHarness();
  for (const name of paymentScenes) {
    const qr = scenes[name].qr;
    assert.ok(qr && !qr.error, `${name}: QR must actually render`);
    assert.equal(qr.nonWhiteQuietPixels, 0,
      `${name}: ${qr.nonWhiteQuietPixels} non-white pixels in the required ${qr.quietZonePixels}px quiet zone: ${JSON.stringify(qr.nonWhiteExamples)}`);
  }
});

test('RIC real PaymentScreen amount is not overlapped or erased by timer painting', () => {
  const {scenes} = runHarness();
  for (const name of paymentScenes) {
    assert.deepEqual(scenes[name].layout.textOverlaps, [], `${name}: overlapping text rectangles`);
    assert.deepEqual(scenes[name].layout.clippedText, [], `${name}: clipped text rectangles`);
    assert.deepEqual(scenes[name].layout.occludedText, [], `${name}: later timer/status painting erased amount text`);
    assert.deepEqual(scenes[name].qr.textOverlaps, [], `${name}: text intrudes into QR or quiet zone`);
  }
});

test('RIC host uses real TFT font2/font4 pixels, widths and heights', () => {
  const {fontChecks, fontMetrics} = runHarness();
  assert.deepEqual(fontMetrics, {font2: {zeroWidth: 8, height: 16}, font4: {zeroWidth: 14, height: 26}});
  assert.deepEqual(fontChecks.map(item => item.font), [2, 4]);
  for (const item of fontChecks) {
    assert.ok(item.inkPixels > 0, `font${item.font}: actual glyph must contain ink`);
    assert.equal(item.pixelMismatches, 0, `font${item.font}: raster differs from installed font resource`);
  }
});

test('RIC rendered QR data pixels match the installed C encoder', () => {
  const {scenes, provenance} = runHarness();
  for (const path of ['screens/PaymentScreen.cpp', 'screens/PinScreen.cpp', 'ui/Numpad.cpp']) {
    assert.ok(provenance.firmwareSources.some(source => source.endsWith('/' + path)), path);
  }
  for (const name of paymentScenes) {
    assert.equal(scenes[name].qr.dataPixelMismatches, 0, `${name}: QR data differs from actual encoder output`);
    assert.ok(scenes[name].qr.modulePx >= 2, `${name}: normal payload QR modules must be at least two pixels`);
  }
});

test('RIC real PaymentScreen safely renders a 1050-character QR payload', () => {
  const {denseRender} = runHarness();
  assert.equal(denseRender.returnCode, 0,
    `1050-character screen render crashed or timed out; see ${denseRender.log}`);
  assert.ok(denseRender.qr && !denseRender.qr.error, '1050 alphanumeric characters fit ECC_LOW version 20 and must encode safely');
  assert.equal(denseRender.qr.dataPixelMismatches, 0, 'dense QR differs from installed encoder output');
  assert.equal(denseRender.qr.nonWhiteQuietPixels, 0, 'dense QR needs the full four-module quiet zone');
});

test('RIC QR location ignores unrelated black rectangles outside its encoded grid', () => {
  const {scenes} = runHarness();
  const scene = scenes['payment-small'];
  // Perturb the real framebuffer outside the QR. A rectangle-size/minimum-x
  // guess would relocate the QR here; encoder-linked coordinates must not.
  const code = `
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('ric_render', sys.argv[1])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
trace = json.loads(Path(sys.argv[2]).read_text())
w, h, pixels = mod.read_ppm(Path(sys.argv[3]))
trace['operations'].append({'kind': 'fillRect', 'rect': {'x': 1, 'y': 1, 'w': 1, 'h': 1}, 'color': 0})
pixels = bytearray(pixels); offset = (w + 1) * 3; pixels[offset:offset + 3] = b'\\0\\0\\0'
print(json.dumps(mod.qr_metrics(trace, w, h, pixels)))
`;
  const result = spawnSync('python3', ['-c', code, join(root, 'tests/ric-display/render.py'), scene.trace, scene.ppm], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), scene.qr,
    'Unrelated dark UI primitives must not be mistaken for QR modules');
});

test('RIC fiat stays complete and visually leads the timer and int32-max sats', () => {
  const {scenes} = runHarness();
  assert.equal('999,999.99 THB'.length, 14);
  for (const [name, fiatText, satsText] of [
    ['payment-small', '5.00 THB', '250 sats'],
    ['payment-14ch', '999,999.99 THB', '2,147,483,647 sats'],
    ['payment-large', '9,999,999.99 THB', '2,147,483,647 sats'],
  ]) {
    const trace = JSON.parse(readFileSync(scenes[name].trace, 'utf8'));
    const texts = trace.operations.filter(op => op.kind === 'text');
    const fiat = texts.find(op => op.text === fiatText);
    const sats = texts.find(op => op.text === satsText);
    const timer = texts.find(op => op.text === '10:00');
    assert.ok(fiat && sats && timer, `${name}: complete amount, currency and timer must actually draw`);
    for (const text of [fiat, sats, timer]) {
      assert.ok(text.inkPixels > 0, `${name}: ${text.text} must have actual glyph ink`);
      assert.equal(text.visibleInkPixels, text.inkPixels, `${name}: ${text.text} was erased`);
    }
    assert.ok(fiat.rect.h > sats.rect.h && fiat.rect.h > timer.rect.h,
      `${name}: fiat must lead, not share the secondary-label font height`);
  }
});

test('RIC redraw retains same-invoice deadline and resets a new invoice', () => {
  assert.deepEqual(runHarness().invoiceDeadline, {sameInvoiceSeconds: 39, newInvoiceSeconds: 60});
});

test('RIC real Numpad enters both PIN lengths and confirming does not delay', () => {
  const {pinInput, confirming, scenes} = runHarness();
  assert.deepEqual(pinInput, {returnCodes: ['O'.charCodeAt(0), 'O'.charCodeAt(0)], lengths: [4, 6]});
  assert.equal(confirming.delayCalls, 0);
  for (const name of ['pin-4', 'pin-6']) {
    assert.deepEqual(scenes[name].layout.textOverlaps, [], `${name}: overlapping text`);
    assert.deepEqual(scenes[name].layout.clippedText, [], `${name}: clipped text`);
    assert.deepEqual(scenes[name].layout.occludedText, [], `${name}: erased text`);
  }
});
