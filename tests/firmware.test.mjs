import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import crypto from 'node:crypto';
test('RIC factory image is explicitly identified and the flasher rejects a different chip',()=>{
  const bytes=fs.readFileSync('firmware/posbox-latest.bin');assert.equal(bytes[0x1000],0xe9);
  // A/B OTA partition table (partitions.csv): app slot 0 lives at 0x20000.
  assert.equal(bytes[0x8000],0xaa,'partition table present');assert.equal(bytes[0x20000],0xe9,'OTA-layout app image at 0x20000');
  assert.equal(bytes.readUInt16LE(0x20000+12),0,'Current image is classic ESP32, not ESP32-S3');
  assert.ok(fs.existsSync('firmware/manifest.json'),'Firmware must declare board, image kind, offset, and SHA256');
  const manifest=JSON.parse(fs.readFileSync('firmware/manifest.json'));assert.equal(manifest.chip,'ESP32');assert.equal(manifest.address,0);assert.equal(manifest.kind,'factory');
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),manifest.sha256,'manifest sha256 must match the served image');
  assert.equal(manifest.bytes,bytes.length,'manifest bytes must match the served image');
  const html=fs.readFileSync('artifacts/web/index.html','utf8');assert.ok(html.includes('manifest.chip'),'Browser must compare detected chip with the manifest before writing');
});
test('OTA app image and version metadata agree with the manifest line',()=>{
  const ota=fs.readFileSync('firmware/ric-ota.bin');assert.equal(ota[0],0xe9);assert.equal(ota.readUInt16LE(12),0,'OTA image is classic ESP32');
  const meta=JSON.parse(fs.readFileSync('firmware/ric-version.json','utf8'));assert.match(meta.version,/^\d+\.\d+\.\d+$/);
  assert.equal(JSON.parse(fs.readFileSync('firmware/manifest.json','utf8')).version,meta.version,'webflasher manifest and OTA endpoint must advertise the same version');
  const factory=fs.readFileSync('firmware/posbox-latest.bin');assert.ok(factory.includes(Buffer.from('RIC')),'factory image carries the RIC name (BLE advertise string, kept by the compiler even when Serial debug is stripped)');
  assert.ok(factory.includes(Buffer.from('openLN')),'factory image carries the openLN branding');
  assert.ok(!factory.includes(Buffer.from('posBOX'))&&!factory.includes(Buffer.from('bitPOS')),'factory image carries no legacy brand strings');
});
