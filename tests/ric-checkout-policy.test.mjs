import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('RIC checkout uses a ten-minute wrap-safe deadline',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ric-checkout-'));
  try {
    const exe=join(dir,'test');
    const build=spawnSync('g++',['-std=c++17','-Wall','-Wextra','-Werror','-I','firmware/esp32-pos/src','tests/ric-checkout-policy.cpp','-o',exe],{encoding:'utf8'});
    assert.equal(build.status,0,build.error?.message||build.stdout+build.stderr);
    const run=spawnSync(exe,[],{encoding:'utf8'});
    assert.equal(run.status,0,run.stdout+run.stderr);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
