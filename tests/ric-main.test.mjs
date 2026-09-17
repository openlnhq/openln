import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const names = [
  'frozen-tls', 'frozen-nfc', 'callback-paid-only', 'callback-timeout-once',
  'wifi-preserve-hash', 'boot-receive-unsent', 'boot-receive-dispatched',
  'boot-withdraw-unsent', 'boot-withdraw-dispatched', 'receive-window-600',
  'receive-expiry-qr', 'receive-expiry-card', 'typed-pin-retry', 'send-shared-k1',
  'journal-before-expose', 'maintenance-gate', 'pin-timeout-not-rejection', 'cancel-while-detecting',
  'boot-corrupt-journal', 'boot-unavailable-journal', 'invoice-journal-save-failure',
  'worker-network-unavailable', 'worker-nfc-unavailable', 'cancel-retry-after-pending', 'send-timeout-once',
  'insufficient-balance', 'insufficient-balance-pending', 'insufficient-balance-paid-wins',
  'insufficient-balance-lost-reply',
  'cancel-receive-pending-cadence', 'cancel-send-pending-cadence',
  'insufficient-balance-repeated-proof',
  'boot-receive-unsent-expiry', 'boot-receive-dispatched-expiry',
  'safe-stage-trace',
];
let report, buildError;
function harness() {
  if (buildError) throw buildError;
  if (report) return report;
  const args = [join(root, 'tests/ric-main-shim/run.py')];
  if (process.env.RIC_MAIN_REVISION) args.push('--revision', process.env.RIC_MAIN_REVISION);
  if (process.env.RIC_MAIN_OUT) args.push('--out', process.env.RIC_MAIN_OUT);
  const result = spawnSync('python3', args, {cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 16*1024*1024});
  try {
    assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
    const output = JSON.parse(result.stdout);
    report = JSON.parse(readFileSync(resolve(root, output.report), 'utf8'));
    assert.equal(report.provenance.byteIdentical, true, 'actual main.cpp must be byte-identical, not extracted logic');
    assert.deepEqual(report.provenance.transportCanary, {passed: true, deniedCalls: 4}, 'network deny wrappers must actually reject all four canary calls');
    assert.deepEqual(report.scenarios.map(s => s.scenario), names, 'do not silently skip a named scenario');
  } catch (error) { buildError = error; throw error; }
  return report;
}
for (const name of names) {
  test(`RIC actual main.cpp: ${name}`, () => {
    const result = harness().scenarios.find(s => s.scenario === name);
    assert.equal(result.passed, true, `${result.error}; state=${result.state}; source=${harness().provenance.sourceSha256}`);
    assert.equal(result.returnCode, 0);
    assert.equal(result.socketAttempts, 0, 'NO live network/payment traffic is allowed');
  });
}
