import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import bcrypt from 'bcryptjs';
import {randomBytes,scryptSync} from 'node:crypto';
test('card payment PIN verifies migrated bcrypt and native scrypt, never malformed input',async()=>{
  assert.ok(fs.existsSync('dist/core/auth/card-pin.js'),'Shared card PIN verification must cover both migrated and new cards');
  const {verifyCardPin}=await import('../dist/core/auth/card-pin.js');
  const salt=randomBytes(16);const native=salt.toString('base64url')+'.'+scryptSync('1357',salt,32).toString('base64url');
  assert.equal(await verifyCardPin('1357',native),true);assert.equal(await verifyCardPin('2468',native),false);
  const old=await bcrypt.hash('1357',10);assert.equal(await verifyCardPin('1357',old),true);assert.equal(await verifyCardPin('2468',old),false);
  for(const pin of ['','123','12345','abcd'])assert.equal(await verifyCardPin(pin,native),false);
});
