import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
for(const source of ['ric-policy.cpp','ric-retry-policy.cpp'])test('RIC native policy: '+source,()=>{
 const dir=mkdtempSync(join(tmpdir(),'ric-policy-'));
 try{
  const exe=join(dir,'test');
  const build=spawnSync('g++',['-std=c++17','-Wall','-Wextra','-Werror','-I','firmware/esp32-pos/src','tests/'+source,'-o',exe],{encoding:'utf8'});
  assert.equal(build.status,0,build.error?.message||build.stdout+build.stderr);
  const result=spawnSync(exe,[],{encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
