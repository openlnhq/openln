import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('NTAG424 FULL APDU capacity includes worst-case padded payload and MAC',()=>{
 const source=readFileSync('firmware/esp32-pos/lib/Adafruit-PN532-NTAG424/Adafruit_PN532_NTAG424.cpp','utf8');
 const start=source.indexOf('uint8_t Adafruit_PN532::ntag424_apdu_send(');
 const body=source.slice(start,source.indexOf('  uint8_t offset = 0;',start));
 assert.match(body,/uint8_t apdu\[128\]/,'old variable-sized APDU allocates unpadded payload then overflows when FULL padding is appended');
 assert.match(body,/required > sizeof\(apdu\)/);
 const dir=mkdtempSync(join(tmpdir(),'ric-apdu-'));
 try {
 const sizePolicy=body.slice(body.indexOf('  uint8_t apdu[128]'),body.indexOf('  uint8_t apdusize'));
 const code='#include <cstdint>\n#include <cstddef>\n#include <cassert>\n#define NTAG424_COMM_MODE_FULL 2\n#define NTAG424_COMM_MODE_PLAIN 0\nint capacity(uint8_t cmd_header_length,uint8_t cmd_data_length,uint8_t comm_mode){'+sizePolicy+'return required;}\nint main(){assert(capacity(7,25,2)==55);assert(capacity(200,100,2)==0);assert(capacity(1,15,2)==33);}\n';
 writeFileSync(join(dir,'test.cpp'),code);const exe=join(dir,'test');const compile=spawnSync('g++',['-std=c++17','-Wall','-Wextra','-Werror',join(dir,'test.cpp'),'-o',exe],{encoding:'utf8'});assert.equal(compile.status,0,compile.stdout+compile.stderr);const run=spawnSync(exe,[],{encoding:'utf8'});assert.equal(run.status,0,run.stdout+run.stderr);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
