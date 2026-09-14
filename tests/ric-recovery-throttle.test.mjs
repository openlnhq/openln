import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
test('background recovery is serialized and relay-throttled',()=>{const s=fs.readFileSync('core/ric-reconcile.ts','utf8');assert.match(s,/MAX_RECOVERY_CONCURRENCY=1/);assert.match(s,/MIN_RECOVERY_INTERVAL_MS=15_000/);assert.match(s,/setInterval\(\(\)=>void sweep\(\),15000\)/);});
