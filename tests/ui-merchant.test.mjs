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
  assert.ok(send.includes("import('/media/zxing.mjs')"),'the zxing-wasm decoder is vendored and lazily loaded');
  assert.ok(send.includes('readBarcodes'),'software decoding runs through the zxing-wasm reader');
  assert.ok(send.includes('ImageCapture')&&send.includes('sndShotRun'),'close-up still capture path is wired');
  assert.ok(send.includes("'/api/wallet/scan-debug'")&&send.includes('sndZoomToggle'),'smooth-focus: zoom assist + self-uploading diagnostics');
  assert.ok(send.includes('sndSweepInit')&&send.includes('focusDistance')&&send.includes('grabFrame'),'manual-focus devices get a focusDistance sweep and freeze-proof grabFrame stills');
  assert.ok(send.includes('sndDbgPaint')&&send.includes('sd=1'),'scanner has the ?sd=1 diagnostic overlay');
  assert.ok(send.includes('sndLabStart')&&send.includes('sd=2'),'scanner has the ?sd=2 camera calibration lab');
  assert.ok(send.includes('sndPickCamera')&&send.includes('deviceId:{exact:'),'scanner explicitly selects the main back camera (aux-camera trap)');
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

test('card setup hands off to the openLN Card Writer app or the RIC',()=>{
  const helper=html.slice(html.indexOf('/* ---- OPENLN CARD WRITER APP'),html.indexOf('/* ---- RIC (flash + link + manage devices) ---- */'));
  assert.ok(helper.includes('getInstalledRelatedApps'),'The handoff checks whether the writer app is installed');
  assert.ok(helper.includes('scheme=openlnwriter'),'Deep links use the openlnwriter scheme');
  assert.ok(helper.includes('S.browser_fallback_url'),'A missing app falls back to the APK download');
  assert.ok(helper.includes("'/media/card-writer-"),'The APK is served from the staged /media path');
  assert.ok(!html.includes('cardWritePane')&&!html.includes('cardWipeReaderPane')&&!html.includes('cardBridgeFind'),'The USB reader bridge is gone; the phone app and RIC are the write paths');
  const issue=html.slice(html.indexOf('function showIssuedCard('),html.indexOf('function cardsConfigModal()'));
  assert.ok(issue.includes('openWriterApp')&&issue.includes('downloadCardWriter'),'The issue dialog offers Open the app and the APK download');
  assert.ok(issue.includes('With the openLN app'),'The phone tab names the openLN app');
  assert.ok(!issue.includes('computerTab'),'No This computer tab remains');
  const wipe=html.slice(html.indexOf('function vCardWipe('),html.indexOf('function vCardEditForm('));
  assert.ok(wipe.includes('openWriterWipe'),'The wipe dialog can hand off to the app');
  assert.ok(!wipe.includes('wipeReader'),'The wipe dialog no longer probes for a USB reader');
  const detail=html.slice(html.indexOf('function vCardDetail('),html.indexOf('function vCardWipe('));
  assert.ok(!detail.includes('writeCardHere')&&detail.includes('setupCard'),'Card detail drops Write to card and keeps Set up card');
});
