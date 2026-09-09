import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
test('RIC factory image is explicitly identified and the flasher rejects a different chip',()=>{
  const bytes=fs.readFileSync('firmware/posbox-latest.bin');assert.equal(bytes[0x1000],0xe9);assert.equal(bytes[0x10000],0xe9);assert.equal(bytes.readUInt16LE(0x10000+12),0,'Current image is classic ESP32, not ESP32-S3');
  assert.ok(fs.existsSync('firmware/manifest.json'),'Firmware must declare board, image kind, offset, and SHA256');
  const manifest=JSON.parse(fs.readFileSync('firmware/manifest.json'));assert.equal(manifest.chip,'ESP32');assert.equal(manifest.address,0);assert.equal(manifest.kind,'factory');
  const html=fs.readFileSync('artifacts/web/index.html','utf8');assert.ok(html.includes('manifest.chip'),'Browser must compare detected chip with the manifest before writing');
});
