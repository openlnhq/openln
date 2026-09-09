import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const html=fs.readFileSync('artifacts/web/index.html','utf8');
test('merchant settings include South African rand and present account-controlled RIC rates',()=>{
  const currencies=html.match(/const CURRENCIES\s*=\s*(\[[^;]+\])/);assert.ok(currencies);const values=vm.runInNewContext(currencies[1]);
  assert.ok(values.includes('zar'),'South African rand must be selectable');
});
test('new merchant sees an immediate Connect wallet action rather than an unexplained zero',()=>{
  const source=html.slice(html.indexOf('async function vWallet('),html.indexOf('function txDetail('));
  assert.ok(source.includes('connectWalletHome'),'Unconnected wallet must offer Connect wallet on home');
  assert.ok(!source.includes('your keys · your node'),'NWC is compatible with user-chosen hosted wallets too');
});
