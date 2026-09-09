import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {execFileSync} from 'node:child_process';
test('dev provisioning links never default to production',()=>{
 assert.ok(fs.existsSync('dist/core/domain.js'),'Domain selection must be shared across all routes');
 for(const [port,expected] of [['3147','dev.openln.com'],['3160','openln.com']]){const env={...process.env,PORT:port};delete env.DOMAIN;const got=execFileSync(process.execPath,['--input-type=module','-e','import {DOMAIN} from "./dist/core/domain.js";console.log(DOMAIN)'],{env,encoding:'utf8'}).trim();assert.equal(got,expected)}
});
