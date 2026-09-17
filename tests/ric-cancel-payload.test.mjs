import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('RIC cancellation has transport error diagnostics without logging credentials',()=>{
 const s=fs.readFileSync('firmware/esp32-pos/src/api/BitposClient.cpp','utf8');
 assert.ok(s.includes('RIC cancel transport: http='),'cancel errors must distinguish HTTP status from ambiguous callback outcome');
 assert.ok(s.includes('RIC TLS retry: fd='),'log reconnect context for socket-lifetime diagnosis');
});
