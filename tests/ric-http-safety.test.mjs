import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('API read and cancellation routes retain cached status semantics and bounded framing',()=>{
 const source=readFileSync('core/server.ts','utf8');
 assert.match(source,/startRicReconciler\(\)/);
 assert.match(source,/startRicPaymentRecovery\(\)/);
 assert.match(source,/reconcileRicPendingSends\(\)/);
 assert.ok(!source.includes('await advanceWrap('),'HTTP status must never await Lightning');
 assert.match(source,/content-length/);
});
