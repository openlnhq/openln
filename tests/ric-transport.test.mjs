import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const json=join(root,'firmware/esp32-pos/.pio/libdeps/esp32dev/ArduinoJson/src');
const flags=['-std=c++17','-Wall','-Wextra','-Werror','-DARDUINOJSON_ENABLE_ARDUINO_STRING=1','-DARDUINOJSON_ENABLE_ARDUINO_STREAM=0','-DARDUINOJSON_ENABLE_ARDUINO_PRINT=0','-DARDUINOJSON_ENABLE_PROGMEM=0','-Itests/ric-transport-shim','-Ifirmware/esp32-pos/src','-I'+json];
if(process.env.RIC_TRANSPORT_SANITIZERS==='1')flags.push('-fsanitize=address,undefined','-fno-omit-frame-pointer','-g');
for(const source of ['ric-transport-api.cpp','ric-transport.cpp']){
 if(!existsSync(join(root,'tests',source)))continue;
 test('real RIC transport: '+source,()=>{
  const dir=mkdtempSync(join(tmpdir(),'ric-transport-'));
  try{
   const exe=join(dir,'test');
   const sources=['tests/'+source];if(source==='ric-transport.cpp')sources.push('firmware/esp32-pos/src/api/BitposClient.cpp');
   const build=spawnSync('g++',[...flags,...sources,'-o',exe],{cwd:root,encoding:'utf8'});
   assert.equal(build.status,0,build.error?.message||build.stdout+build.stderr);
   const run=spawnSync(exe,[],{cwd:root,encoding:'utf8',timeout:60000});
   assert.equal(run.status,0,run.error?.message||run.stdout+run.stderr);
   process.stdout.write(run.stdout);
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
}
