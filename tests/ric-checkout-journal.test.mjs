import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

for (const source of ['ric-checkout-journal.cpp', 'ric-checkout-journal-policy.cpp'])
  test('RIC durable checkout journal: ' + source, t => {
    const dir = mkdtempSync(join(tmpdir(), 'ric-checkout-journal-'));
    try {
      const exe = join(dir, 'test');
      const sanitizerFlags = process.env.RIC_JOURNAL_SANITIZERS === '1'
        ? ['-O1', '-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer'] : [];
      const build = spawnSync('g++', [
        '-std=c++11', '-Wall', '-Wextra', '-Werror', '-pedantic', ...sanitizerFlags,
        '-I', 'tests/ric-checkout-journal-shim', '-I', 'firmware/esp32-pos/src',
        'tests/' + source, '-o', exe,
      ], {encoding: 'utf8', timeout: 120_000});
      assert.equal(build.status, 0, build.error?.message || build.stdout + build.stderr);
      const run = spawnSync(exe, [], {encoding: 'utf8', timeout: 30_000});
      assert.equal(run.status, 0, run.error?.message || run.stdout + run.stderr);
      t.diagnostic(run.stdout.trim());
    } finally { rmSync(dir, {recursive: true, force: true}); }
  });
