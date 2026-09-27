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
  assert.ok(modal.includes("inp.setAttribute('type',isAddr?'text':'password')"),'Lightning Address input is plain text; NWC and API keys stay masked');
});
test('every inline script in index.html parses (a syntax error blanks the whole app)',()=>{
  const blocks=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
  assert.ok(blocks.length>=2,'index.html is expected to keep its inline scripts');
  for(const [i,block] of blocks.entries()) assert.doesNotThrow(()=>new vm.Script(block,{filename:`index.html script ${i}`}),`inline script ${i} must compile`);
});
test('POS ships an item pad, numpad, checkout and a wallet entry point',()=>{
  const pos=html.slice(html.indexOf('/* ---- POS ---- */'),html.indexOf('/* ---- RECEIVE ---- */'));
  assert.ok(pos.includes('async function vPos('),'POS view exists');
  assert.ok(pos.includes("api('/api/pos/items'"),'POS loads the item catalog');
  assert.ok(pos.includes('openln_pos_launch'),'Launch preference is stored per device');
  assert.ok(pos.includes("purpose:'sale'"),'POS charges create sale invoices');
  assert.ok(pos.includes("'/status'"),'POS polls the sale status');
  assert.ok(pos.includes('posShrinkImage('),'Item photos are downscaled before saving');
  assert.ok(pos.includes('posUnitSegHTML')&&pos.includes('posEnteredSats'),'POS custom amount toggles sats and fiat');
  const wallet=html.slice(html.indexOf('async function vWallet('),html.indexOf('function txDetail('));
  assert.ok(wallet.includes('id="bpos"'),'Wallet dashboard has the POS button');
  assert.ok(html.includes("['wallet','ric','cards','books','pos','settings','partner','adminpayments'].includes(view)"),'pos is a routable view');
  assert.ok(html.includes("localStorage.getItem('openln_pos_launch')==='1'?'pos':'wallet'"),'Open POS at launch is honored on load');
});
test('send opens a camera-first scanner with Paste, Keyboard and Images for every lightning code',()=>{
  const send=html.slice(html.indexOf('/* ---- SEND ---- */'),html.indexOf('/* ---- WALLET CONNECT ---- */'));
  assert.ok(html.includes('st.connected?sendScan:walletModal'),'Send opens the fullscreen scanner, not a form');
  assert.ok(send.includes('function sendScan('),'fullscreen scanner exists');
  assert.ok(send.includes('sndVid')&&send.includes('getUserMedia'),'scanner attaches the live camera');
  assert.ok(send.includes('sndPaste')&&send.includes('Clipboard'),'Paste button reads the clipboard');
  assert.ok(send.includes('sndKeys')&&send.includes('sndInput'),'Keyboard button opens the text entry sheet');
  assert.ok(send.includes('sndGallery')&&send.includes('sndDecodeImage'),'Images button loads a QR from the gallery');
  assert.ok(send.includes("import('/media/jsqr.mjs')"),'fallback decoder is vendored and lazy-loaded');
  assert.ok(send.includes("api('/api/wallet/resolve'"),'scans resolve through the target endpoint');
  assert.ok(send.includes("api('/api/wallet/pay'"),'paying reuses the wallet pay route');
  assert.ok(send.includes('lnurl_withdraw')&&html.includes('receiveWithdrawModal'),'withdraw codes explain and hand off to Receive');
  assert.ok(send.includes('openln_addr_book'),'the address book is device-local');
  assert.ok(send.includes('sndUnitSeg')&&send.includes('amtUnitPref'),'Send amount toggles sats and fiat');
  assert.ok(send.includes('sndBookSave(')&&send.includes('sndBookRemove('),'addresses can be saved and removed');
});

test('receive uses the same numpad entry as send, with a sats and fiat toggle',()=>{
  const source=html.slice(html.indexOf('function receiveModal('),html.indexOf('/* ---- SEND ---- */'));
  assert.ok(source.includes('posnumpad')&&source.includes('data-rkey'),'Receive enters amounts on the same numpad as Send');
  assert.ok(source.includes('rUnitWrap')&&source.includes('amtUnitPref'),'Receive toggles between sats and fiat');
  assert.ok(source.includes("api('/api/pos/invoice'"),'Receive still creates invoices through the pos route');
});

test('cards can be written and wiped inside the app through a local reader bridge',()=>{
  const writer=html.slice(html.indexOf('async function cardBridgeFind('),html.indexOf('/* ---- RIC (flash + link + manage devices) ---- */'));
  assert.ok(writer.includes('cardWritePane')&&writer.includes('cardWipeReaderPane'),'Write and wipe run in the card writer section');
  assert.ok(writer.includes("cmd:'transceive'"),'Card commands travel through the reader bridge');
  assert.ok(writer.includes("'/card-writer/app-glue.js'"),'The NTAG424 engine loads from the served card-writer assets');
  assert.ok(writer.includes('cardSetupBoxHTML'),'A missing reader helper offers a one-button setup');
  const detail=html.slice(html.indexOf('function vCardDetail('),html.indexOf('function vCardWipe('));
  assert.ok(detail.includes('writeCardHere'),'Card detail offers Write to card');
  const issue=html.slice(html.indexOf('function showIssuedCard('),html.indexOf('function cardsConfigModal()'));
  assert.ok(issue.includes('computerTab')&&issue.includes('cardWritePane'),'The issue flow opens on writing from this computer');
  const wipe=html.slice(html.indexOf('function vCardWipe('),html.indexOf('function vCardEditForm('));
  assert.ok(wipe.includes('cardWipeReaderPane'),'The wipe dialog can erase with the reader');
});
