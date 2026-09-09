import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
test('deploy uses the current script after a target updates from an older commit',()=>{const s=fs.readFileSync('scripts/ship.sh','utf8');assert.ok(s.includes("'bash -s dev' < scripts/deploy.sh"));assert.ok(s.includes("'OPENLN_BRANCH=production-candidate bash -s prod' < scripts/deploy.sh"))});
