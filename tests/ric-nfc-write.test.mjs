import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

// Compile the installed write method and actual APDU capacity guard, not copies.
const source=readFileSync('firmware/esp32-pos/lib/Adafruit-PN532-NTAG424/Adafruit_PN532_NTAG424.cpp','utf8');
const header=readFileSync('firmware/esp32-pos/lib/Adafruit-PN532-NTAG424/Adafruit_PN532_NTAG424.h','utf8');
const write=source.match(/^bool Adafruit_PN532::ntag424_ISOUpdateBinary\([\s\S]*?^}/m)?.[0];
assert.ok(write);
const apdu=source.slice(source.indexOf('uint8_t Adafruit_PN532::ntag424_apdu_send('));
const policy=apdu.slice(apdu.indexOf('  uint8_t apdu[128]'),apdu.indexOf('  uint8_t apdusize'));
const names=['PN532_PACKBUFFSIZ','NTAG424_COM_ISOCLA','NTAG424_CMD_ISOUPDATEBINARY','NTAG424_COMM_MODE_PLAIN','NTAG424_COMM_MODE_MAC','NTAG424_COMM_MODE_FULL'];
const constants=names.map(n=>{const m=(header+'\n'+source).match(new RegExp(`^#define ${n} .*`,'m'));assert.ok(m,n);return m[0];}).join('\n');
const dir=mkdtempSync(join(tmpdir(),'ric-nfc-write-'));
try {
 writeFileSync(join(dir,'installed.inc'),constants+'\nint capacity(uint8_t cmd_header_length,uint8_t cmd_data_length,uint8_t comm_mode){\n'+policy+'return required;\n}\n'+write);
 const exe=join(dir,'probe');
 const build=spawnSync('g++',['-std=c++17','-Wall','-Wextra','-Werror','-I'+dir,'tests/ric-nfc-write.cpp','-o',exe],{encoding:'utf8'});
 assert.equal(build.status,0,build.stdout+build.stderr);
 for(const name of ['plain-54-capacity','full-capacity-bounds','short-write','full-chunk-write','multi-chunk-write','failure-first','failure-middle','failure-last','status-first','status-middle','short-response','empty-write','null-write']) {
  test(name,()=>{const run=spawnSync(exe,[name],{encoding:'utf8',timeout:5000});assert.equal(run.status,0,run.stdout+run.stderr);});
 }
} finally { process.on('exit',()=>rmSync(dir,{recursive:true,force:true})); }
