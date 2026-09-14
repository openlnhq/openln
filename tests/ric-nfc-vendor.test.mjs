import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('vendored PN532 rejects malformed RF/ISO frames without memory corruption',()=>{
 const scenarios=['finite-command','valid-ndef','valid-uid','nlen-zero','nlen-high-byte','uid-destination-capacity','uid-library-source-capacity','ndef-small-buffer','ndef-short-header','ndef-short-page','read-failed-i2c','read-failed-spi','read-short-uart','exchange-short-frame','exchange-long-frame','exchange-checksum','exchange-small-buffer'];
 const r=spawnSync(process.execPath,['tests/ric-nfc-library-repro.mjs',...scenarios],{encoding:'utf8',timeout:120000});
 assert.equal(r.status,0,r.error?.message||r.stdout+r.stderr);
 const summary=JSON.parse(r.stdout.trim().split('\n').at(-1));assert.equal(summary.probes,scenarios.length);assert.equal(summary.failed,0);
});
