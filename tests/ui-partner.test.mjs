import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const html = fs.readFileSync('artifacts/web/index.html', 'utf8');

test('partner portal shows balance, payout controls, history and the device fleet', () => {
  const start = html.indexOf('/* ---- PARTNER ---- */');
  const end = html.indexOf('/* ---- ADMIN PAYMENTS');
  assert.ok(start >= 0 && end > start, 'partner section markers intact');
  const src = html.slice(start, end);
  assert.ok(src.includes('Available'), 'balance card present');
  assert.ok(src.includes('0.3% of sales'), 'revenue share rate stated');
  assert.ok(src.includes('dashboard'), 'dashboard endpoint used');
  assert.ok(src.includes('payout-address'), 'payout address editor present');
  assert.ok(src.includes('/payouts'), 'payout request call present');
  assert.ok(src.includes('Request payout'), 'payout button present');
  assert.ok(src.includes('Payout history'), 'payout history table present');
  assert.ok(src.includes('Earnings ledger'), 'earnings ledger present');
  assert.ok(src.includes('Your RICs'), 'registered device list present');
  assert.ok(src.includes('ricFlashModal({partner:'), 'flasher opens in partner mode');
  assert.ok(!html.includes('\u2153'), 'the old one-third-of-fee copy is gone');
  assert.ok(html.includes("localStorage.setItem('openln_partner_token'"), 'login stores the partner token');
  assert.ok(html.includes("Authorization:'Bearer '+ptok()"), 'partner API calls send the partner token');
});

test('partner flasher registers the device MAC to the partner after flashing', () => {
  const start = html.indexOf('function ricFlashModal');
  const end = html.indexOf('function ricLinkModal');
  assert.ok(start >= 0 && end > start, 'flash modal present');
  const src = html.slice(start, end);
  assert.ok(src.includes('readMac'), 'MAC is read from the chip');
  assert.ok(src.includes("fetch('/api/posbox/devices'"), 'registration call goes to the devices endpoint');
  assert.ok(src.includes('partner.claimCode'), 'registration sends the partner claim code');
  assert.ok(/Registe(red|r) to/.test(src), 'success copy confirms the registration');
  assert.ok(src.includes('first-wins'), 'binding semantics documented in the modal code');
});

test('partner boot path skips the merchant session gate', () => {
  assert.ok(html.includes("if(VIEW==='partner')return render();"), 'boot must not require a merchant session for /partner');
  assert.ok(html.includes("if(tok())startLiveUpdates();"), 'no merchant SSE for partners');
  assert.ok(html.includes("const mb=$('#menuBtn');if(mb)mb.style.display='none';"), 'merchant drawer hidden in the partner portal');
});

test('claim codes stay invisible: the partner only flashes', () => {
  assert.ok(!html.includes('pCodeBox'), 'no claim code box in the portal');
  assert.ok(!html.includes('pCodeToggle'), 'no claim code toggle in the portal');
  assert.ok(!html.includes('#pcopy'), 'no claim code copy control');
  assert.ok(!html.includes('Claim code copied'), 'no claim code toast');
  assert.ok(html.includes('/api/partner/${pid}/claim-code'), 'claim code still issued silently for registration');
});

test('merchant flash path is unchanged for non-partner flows', () => {
  const start = html.indexOf('function ricFlashModal');
  const end = html.indexOf('function ricLinkModal');
  const src = html.slice(start, end);
  assert.ok(src.includes("const partner=opts.partner||null;"), 'partner mode is opt-in');
  assert.ok(src.includes('use "Link device" to connect it to your account over Bluetooth'), 'merchant success copy intact');
  const callsite = html.slice(html.indexOf("#ricFlashTile').onclick"), html.indexOf("#ricFlashTile').onclick") + 60);
  assert.ok(callsite.includes('ricFlashModal()'), 'merchant tile opens the modal without partner mode');
});
