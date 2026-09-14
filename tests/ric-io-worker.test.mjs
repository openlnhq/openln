import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('RIC real FreeRTOS I/O worker (native adapters)', async t => {
  assert.ok(existsSync(join(root, 'firmware/esp32-pos/src/core/RicIoWorker.h')),
    'Persistent RicIoWorker implementation is missing');
  const dir = mkdtempSync(join(tmpdir(), 'ric-io-worker-'));
  try {
    const exe = join(dir, 'test');
    const sanitizer = process.env.RIC_IO_SANITIZER;
    assert.ok(!sanitizer || ['address,undefined', 'thread', 'undefined'].includes(sanitizer),
      'RIC_IO_SANITIZER must be address,undefined, thread, or undefined');
    const flags = sanitizer ? [`-fsanitize=${sanitizer}`, '-fno-omit-frame-pointer', '-g'] : [];
    const build = spawnSync(process.env.CXX || 'g++', [
      '-std=c++11', '-O1', '-pthread', '-Wall', '-Wextra', '-Werror', ...flags,
      '-I', resolve(root, 'tests/ric-io-worker/adapters'),
      '-I', resolve(root, 'firmware/esp32-pos/src'),
      resolve(root, 'tests/ric-io-worker/native.cpp'),
      resolve(root, 'tests/ric-io-worker/host_freertos.cpp'), '-o', exe,
    ], {encoding: 'utf8', timeout: 60000});
    assert.equal(build.status, 0, build.error?.message || build.stdout + build.stderr);
    const listing = spawnSync(exe, ['--list'], {encoding: 'utf8', timeout: 10000});
    assert.equal(listing.status, 0, listing.error?.message || listing.stdout + listing.stderr);
    const cases = listing.stdout.trim().split('\n').filter(Boolean);
    assert.ok(cases.length > 0, 'No native worker cases were registered');
    for (const name of cases) await t.test(name, () => {
      const run = spawnSync(exe, [name], {encoding: 'utf8', timeout: 15000});
      assert.equal(run.status, 0, run.error?.message || run.stdout + run.stderr);
      const lines = run.stdout.trim().split('\n');
      assert.equal(lines.pop(), `PASS ${name}`);
      for (const line of lines) {
        assert.ok(line.startsWith('METRIC '), `Unexpected native output: ${line}`);
        t.diagnostic(line);
      }
    });
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
