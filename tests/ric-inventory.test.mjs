import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync('artifacts/web/index.html','utf8');
const start=source.indexOf('async function renderRicDevices()'),end=source.indexOf('\nfunction ricStepRow',start);
const healthStart=source.indexOf('const RIC_RESET_LABELS'),healthEnd=source.indexOf('let RIC_ACCOUNT_ID',healthStart);
test('RIC inventory shows installed version and actual last OTA result, not offered version',async()=>{
 const box={isConnected:true,innerHTML:'',querySelectorAll:()=>[]};
 const fixtures={'/api/me':{account:{id:'owner'}},'/api/accounts/owner/device-tokens':[{id:'device1',label:'Counter',createdAt:'2026-09-11',lastUsedAt:'2026-09-11'}],'/api/ric/devices':{devices:[{deviceId:'device1',firmwareVersion:'1.0.4',rssi:-72,resetReason:'brownout',bootCount:9,wifiDrops:2,wifiDropsTotal:14,runningPartition:'app0',ota:{state:'failed',code:'digest_mismatch',targetVersion:'1.0.5'}}]}};
 const context={$:()=>box,api:async p=>{assert.ok(p in fixtures,p);return fixtures[p]},ricIsOnline:()=>true,ricFmtDate:()=>'',esc:s=>String(s),prose:s=>String(s)};
 vm.createContext(context);
 vm.runInContext(source.slice(healthStart,healthEnd),context);   // RIC_RESET_LABELS + ricHealthLine
 vm.runInContext(source.slice(start,end),context);await vm.runInContext('renderRicDevices()',context);
 assert.match(box.innerHTML,/Installed v1\.0\.4/);assert.match(box.innerHTML,/digest_mismatch/);assert.doesNotMatch(box.innerHTML,/Installed v1\.0\.5/);
 assert.match(box.innerHTML,/WiFi -72 dBm \(weak\)/,'signal strength renders in dBm with a quality word');
 assert.match(box.innerHTML,/last start: brownout \(power dip\)/,'restart cause renders in plain words');
 assert.match(box.innerHTML,/WiFi drops 14 total · 2 since restart/,'drop counters render, lifetime and since-boot');
 assert.match(box.innerHTML,/boots 9/,'boot count renders');
});
