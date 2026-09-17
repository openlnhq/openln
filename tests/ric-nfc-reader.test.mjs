import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cases = ['v106-pn532-policy', 'begin-failure', 'sam-failure', 'failed-rebegin',
  'five-read-attempts', 'first-attempt-success', 'second-attempt-success', 'fifth-attempt-success', 'card-removed',
  'invalid-uid-0', 'invalid-uid-8', 'invalid-uid-255', 'retry-uid-0', 'retry-uid-8', 'retry-uid-255',
  'valid-uid-4', 'valid-uid-7', 'private-ndef-logging']
  .filter(name => !process.env.RIC_NFC_CASE || new RegExp(process.env.RIC_NFC_CASE).test(name));
assert.ok(cases.length, 'RIC_NFC_CASE must match a real test');
for (const sanitize of [false, true]) {
  test(`RIC real NfcReader methods${sanitize ? ' (ASan/UBSan)' : ''}`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'ric-nfc-'));
    try {
      const exe = join(dir, 'reader');
      const args = ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-g',
        '-Itests/ric-nfc-host', '-Ifirmware/esp32-pos/src',
        'tests/ric-nfc-reader.cpp', 'tests/ric-nfc-host/HostNfc.cpp',
        'firmware/esp32-pos/src/nfc/NfcReader.cpp', '-o', exe];
      if (sanitize) args.unshift('-fsanitize=address,undefined', '-fno-omit-frame-pointer');
      const build = spawnSync(process.env.CXX || 'g++', args, { encoding: 'utf8', timeout: 60000 });
      assert.equal(build.status, 0, build.error?.message || build.stdout + build.stderr);
      for (const name of cases) await t.test(name, () => {
        const result = spawnSync(exe, [name], {
          encoding: 'utf8', timeout: 15000,
          env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=1:halt_on_error=1', UBSAN_OPTIONS: 'halt_on_error=1' },
        });
        assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
