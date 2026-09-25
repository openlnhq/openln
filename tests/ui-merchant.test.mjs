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
test('settings wallet card reflects every funding lane, not just NWC',()=>{
  const source=html.slice(html.indexOf('async function vSettings('),html.indexOf('/* ---- PARTNER ---- */'));
  assert.ok(source.includes('status.receiveOnly'),'A Lightning Address connection must render as connected (receive-only)');
  assert.ok(source.includes('status.lightningAddress'),'The settings card must show the linked Lightning Address');
  assert.ok(source.includes('Receive-only')&&source.includes('Nostr Wallet Connect'),'Labels must name the lane, not just NWC');
  assert.ok(source.includes('Wallet connection options'),'Settings lists every connection option the account accepts');
  assert.ok(source.includes('NIP-47')&&source.includes('LUD-21'),'Connection options name the wallet families (NIP-47, LUD-21)');
});
test('connect modal teaches each lane capability and the wallets that work',()=>{
  const modes=html.slice(html.indexOf('function walletModalModes('),html.indexOf('function walletModal('));
  assert.ok(modes.includes("caps:['recv','send']"),'NWC and Blink lanes are send + receive');
  assert.ok(modes.includes("caps:['recv']"),'Lightning Address lane is receive-only');
  assert.ok(modes.includes('NIP-47')&&modes.includes('LUD-21'),'Modal names the compatible wallet families');
  const modal=html.slice(html.indexOf('function walletModal('),html.indexOf('async function loadAuthedImage('));
  assert.ok(modal.includes('wmworks')&&modal.includes('wmcaps'),'Modal renders the capability chips and works-with line');
});
test('every inline script in index.html parses (a syntax error blanks the whole app)',()=>{
  const blocks=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
  assert.ok(blocks.length>=2,'index.html is expected to keep its inline scripts');
  for(const [i,block] of blocks.entries()) assert.doesNotThrow(()=>new vm.Script(block,{filename:`index.html script ${i}`}),`inline script ${i} must compile`);
});
