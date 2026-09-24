// Funding-source classification + seam mapping (pure, no network/DB reads).
import test from 'node:test';
import assert from 'node:assert/strict';
const {detectFunding} = await import('../dist/core/money/fundingInput.js');
const {isBlinkApiKey} = await import('../dist/core/money/blink.js');
const {merchantFundingFromSource} = await import('../dist/core/money/walletSource.js');

test('detectFunding: classifies the three funding-source shapes', () => {
  assert.deepEqual(detectFunding('nostr+walletconnect://abc?relay=wss%3A%2F%2Fr.example&secret=deadbeef'), {kind:'nwc'});
  assert.deepEqual(detectFunding('NOSTR+walletconnect://X'), {kind:'nwc'});
  assert.deepEqual(detectFunding('blink_abcdefghijklmnop1234'), {kind:'blink', apiKey:'blink_abcdefghijklmnop1234'});
  assert.deepEqual(detectFunding('Alice@Blink.sv'), {kind:'lnaddress', address:'alice@blink.sv'});
  assert.equal(detectFunding('   '), null);
  assert.equal(detectFunding('not a wallet'), null);
  assert.equal(detectFunding('alice@@example.com'), null);
});

test('isBlinkApiKey: prefix + minimum length window', () => {
  assert.equal(isBlinkApiKey('blink_' + 'a'.repeat(10)), true);
  assert.equal(isBlinkApiKey('blink_' + 'a'.repeat(9)), false);
  assert.equal(isBlinkApiKey('Blink_' + 'a'.repeat(20)), false);
  assert.equal(isBlinkApiKey('blink_has spaces here'), false);
});

test('merchantFundingFromSource: maps each source to the mint-seam input', () => {
  assert.deepEqual(
    merchantFundingFromSource({kind:'nwc', nwcUrl:'nostr+walletconnect://x', mode:'custom'}),
    {kind:'nwc', nwcUrl:'nostr+walletconnect://x'});
  assert.deepEqual(
    merchantFundingFromSource({kind:'lnaddress', address:'a@b.co'}),
    {kind:'lnaddress', address:'a@b.co'});
  assert.deepEqual(
    merchantFundingFromSource({kind:'blink', apiKey:'blink_x', walletId:'w1', currency:'BTC'}),
    {kind:'blink', apiKey:'blink_x', walletId:'w1'});
  assert.equal(merchantFundingFromSource({kind:'none'}), null);
});
