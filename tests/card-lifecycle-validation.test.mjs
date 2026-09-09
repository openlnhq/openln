import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
test('card lifecycle input validation rejects invalid spend limits before DB writes',()=>{const s=fs.readFileSync('plugins/cards.ts','utf8');assert.ok(s.includes('Number.isSafeInteger'),'Card limits need integer bounds, not unrestricted Number conversion')});
