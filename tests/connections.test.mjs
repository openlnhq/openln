// Saved wallet connections: capability matrix, resolution chains, labels and
// the secret-free public view (pure unit checks; no network, no DB).
import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionCapabilities, connectionKindLabel, connectionDisplayLabel, nextConnectionLabel, connectionPublicView, deriveConnectionLabel, uniqueConnectionLabel, providerFromHost } from '../dist/core/money/connections.js';
import { connectionChainForPurpose } from '../dist/core/money/walletSource.js';

test('capabilities by kind: half-capable wallets gate each direction; unknown kinds stay inert', () => {
  assert.deepEqual(connectionCapabilities('nwc'), { send: true, receive: true });
  assert.deepEqual(connectionCapabilities('blink'), { send: true, receive: true });
  assert.deepEqual(connectionCapabilities('lnaddress'), { send: false, receive: true });
  assert.deepEqual(connectionCapabilities('noffer'), { send: false, receive: true });
  assert.deepEqual(connectionCapabilities('ndebit'), { send: true, receive: false });
  // Unknown kinds stay inert until they get their own capability entry.
  assert.deepEqual(connectionCapabilities('mystery'), { send: false, receive: false });
});

test('resolution chain: direction assignment first, default fallback, de-duplicated', () => {
  const account = { defaultConnectionId: 'd', ricReceiveConnectionId: 'r', ricSendConnectionId: 's', cardsReceiveConnectionId: null, cardsSendConnectionId: null };
  assert.deepEqual(connectionChainForPurpose(account, 'ric_receive'), ['r', 'd']);
  assert.deepEqual(connectionChainForPurpose(account, 'ric_send'), ['s', 'd']);
  assert.deepEqual(connectionChainForPurpose(account, 'cards_receive'), ['d']);
  assert.deepEqual(connectionChainForPurpose(account, 'cards_send'), ['d']);
  assert.deepEqual(connectionChainForPurpose(account, 'default'), ['d']);
  assert.deepEqual(connectionChainForPurpose({ ...account, ricReceiveConnectionId: 'd' }, 'ric_receive'), ['d'], 'the same id in both spots never repeats');
  assert.deepEqual(connectionChainForPurpose({ defaultConnectionId: null, ricReceiveConnectionId: null, ricSendConnectionId: null, cardsReceiveConnectionId: null, cardsSendConnectionId: null }, 'ric_send'), []);
});

test('public view never carries stored secrets and names kinds in human terms', () => {
  const view = connectionPublicView({ id: '1', kind: 'lnaddress', label: null, lightningAddress: 'alice@ln.test', createdAt: new Date('2026-10-01T00:00:00Z') });
  assert.deepEqual(view, { id: '1', kind: 'lnaddress', label: 'Lightning Address', capabilities: { send: false, receive: true }, address: 'alice@ln.test', createdAt: new Date('2026-10-01T00:00:00Z') });
  assert.ok(!/nwc_url|api_key|encrypted|secret/i.test(JSON.stringify(view)), 'no store fields leak into the API view');
  assert.equal(connectionKindLabel('nwc'), 'Nostr Wallet Connect');
  assert.equal(connectionKindLabel('blink'), 'Blink');
  assert.equal(connectionKindLabel('noffer'), 'CLINK Offer');
  assert.equal(connectionKindLabel('ndebit'), 'CLINK Debit');
  assert.equal(connectionDisplayLabel('nwc', '  My Hub '), 'My Hub');
  assert.equal(connectionDisplayLabel('nwc', ''), 'Nostr Wallet Connect');
});

test('auto labels number repeat kinds', () => {
  assert.equal(nextConnectionLabel([], 'nwc'), 'Nostr Wallet Connect');
  assert.equal(nextConnectionLabel([{ kind: 'nwc' }], 'nwc'), 'Nostr Wallet Connect 2');
  assert.equal(nextConnectionLabel([{ kind: 'nwc' }, { kind: 'nwc' }], 'nwc'), 'Nostr Wallet Connect 3');
  assert.equal(nextConnectionLabel([{ kind: 'nwc' }], 'lnaddress'), 'Lightning Address');
});

test('provider naming: names come from what the wallet itself declares', () => {
  const nwc = (q) => 'nostr+walletconnect://' + 'a'.repeat(64) + '?' + q + '&secret=' + 'b'.repeat(64);
  assert.equal(deriveConnectionLabel('nwc', nwc('lud16=user%40coinos.io&relay=wss%3A%2F%2Frelay.example')), 'Coinos NWC');
  assert.equal(deriveConnectionLabel('nwc', nwc('relay=wss%3A%2F%2Frelay.coinos.io')), 'Coinos NWC');
  assert.equal(deriveConnectionLabel('nwc', nwc('relay=wss%3A%2F%2Frelay.getalby.com%2Fv1')), 'Alby NWC');
  assert.equal(deriveConnectionLabel('nwc', nwc('relay=ws%3A%2F%2F127.0.0.1%3A7777&relay=wss%3A%2F%2Funknown.example')), 'Nostr Wallet Connect');
  assert.equal(deriveConnectionLabel('lnaddress', 'alice@blink.sv'), 'Blink');
  assert.equal(deriveConnectionLabel('lnaddress', 'pay@walletofsatoshi.com'), 'Wallet of Satoshi');
  assert.equal(deriveConnectionLabel('lnaddress', 'someone@unknown.example'), 'Lightning Address');
  assert.equal(deriveConnectionLabel('blink', null), 'Blink');
  assert.equal(providerFromHost('relay.coinos.io'), 'Coinos');
  assert.equal(providerFromHost('random.example'), null);
});

test('unique names: repeats get a number, existing names are respected', () => {
  assert.equal(uniqueConnectionLabel([], 'Coinos NWC'), 'Coinos NWC');
  assert.equal(uniqueConnectionLabel([{ kind: 'nwc', label: 'Coinos NWC' }], 'Coinos NWC'), 'Coinos NWC 2');
  assert.equal(uniqueConnectionLabel([{ kind: 'nwc', label: null }, { kind: 'lnaddress', label: 'Coinos NWC' }], 'Coinos NWC'), 'Coinos NWC 2');
});
