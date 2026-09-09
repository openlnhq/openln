import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
test('packaged Cards preview is part of the same ship pipeline',()=>{
 assert.ok(fs.existsSync('scripts/install-cards-shop.py'),'Cards artifact must install through deploy.sh, never hand edits on VPS');
 assert.ok(fs.readFileSync('scripts/deploy.sh','utf8').includes('install-cards-shop.py'));
 assert.ok(fs.readFileSync('core/server.ts','utf8').includes('handleCardsPreview'));
});
